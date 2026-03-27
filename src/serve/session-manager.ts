/**
 * Unified session resolver — single entry point for all session lifecycle decisions.
 *
 * Replaces scattered logic across webhook.ts, comments.ts, and agent.ts:
 *
 *   resolveSession(role, issueKey, prompt)
 *     1. Circuit breaker blocked?  → rejected
 *     2. Active running session?   → pipe message in
 *     3. Idle session (tmux alive)? → reactivate with message
 *     4. Suspended (hibernated)?   → SIGCONT + mark running
 *     5. No session → hasCapacity(role)?
 *          YES → spawn (with --continue if workspace has prior history)
 *          NO  → pickToEvict(role):
 *                 a. Reclaim idle sessions (dead tmux first, then oldest idle)
 *                 b. Suspend lowest-priority active (never CEO-pinned)
 *                 c. All fail → enqueue (priority + FIFO)
 */

import chalk from 'chalk';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  getActiveAttempt, getActiveAttempts, getIdleAttempt, getIdleAttempts,
  getHibernatedAttempts, getAttemptsByIssue,
  updateAttemptStatus, updateAttemptAgentSession, logEvent,
  type Attempt,
} from '../core/db.js';
import { sessionExists, sendKeys, killSession } from '../core/tmux.js';
import { agentExists, loadAgentConfig, listAgents } from '../core/persona.js';
import { resolveWorkspace, getIssueStateDir } from '../core/config.js';
import { checkCircuitBreaker } from './circuit-breaker.js';
import {
  hasCapacity, getRunningSessionCount, GLOBAL_MAX_SESSIONS,
  pickToEvict, reclaimSession, hibernateSession, wakeSession,
} from './concurrency.js';
import { enqueue, getRolePriority } from '../core/queue.js';
import { randomUUID } from 'crypto';

// ─── Types ───

export type ResolveAction =
  | { action: 'piped'; tmuxSession: string; attemptId: string }
  | { action: 'reactivated'; tmuxSession: string; attemptId: string }
  | { action: 'resumed'; tmuxSession: string; attemptId: string }
  | { action: 'spawn'; useContinue: boolean }
  | { action: 'queued'; queueId: string }
  | { action: 'rejected'; reason: string };

export interface ResolveSessionOpts {
  role: string;
  issueKey: string;
  issueId: string;
  prompt: string;
  webhookSessionId?: string;
  commentId?: string;
}

// ─── Main entry point ───

/**
 * Resolve the best action for an incoming request (webhook, comment, or manual dispatch).
 *
 * This is the BRAIN of the concurrency system. It decides whether to pipe into
 * an existing session, reactivate an idle one, resume a suspended one, spawn fresh,
 * evict to make room, or queue for later.
 *
 * Does NOT spawn — returns a decision. The caller (webhook/comments/agent) executes.
 * This keeps session-manager free of Linear API / adapter dependencies.
 */
export function resolveSession(opts: ResolveSessionOpts): ResolveAction {
  const { role, issueKey, prompt } = opts;
  const ts = new Date().toLocaleTimeString();

  // ─── 1. Circuit breaker ───
  const cb = checkCircuitBreaker(issueKey, role);
  if (!cb.allowed) {
    console.log(chalk.yellow(`[${ts}] [resolve] Circuit breaker: ${cb.reason}`));
    return { action: 'rejected', reason: cb.reason || 'circuit breaker tripped' };
  }

  // ─── 2. Active running session on this issue? → pipe message in ───
  const activeAttempt = getActiveAttempt(issueKey);
  if (activeAttempt?.tmux_session && activeAttempt.status === 'running' && sessionExists(activeAttempt.tmux_session)) {
    console.log(chalk.dim(`[${ts}] [resolve] Piping into running ${activeAttempt.tmux_session} for ${issueKey}`));
    try {
      sendKeys(activeAttempt.tmux_session, prompt);
      if (opts.webhookSessionId) {
        updateAttemptAgentSession(activeAttempt.id, opts.webhookSessionId);
      }
    } catch (err) {
      console.log(chalk.dim(`[${ts}] [resolve] Pipe failed: ${(err as Error).message}`));
    }
    return { action: 'piped', tmuxSession: activeAttempt.tmux_session, attemptId: activeAttempt.id };
  }

  // ─── 3. Idle session on this issue? → reactivate ───
  const idleAttempt = getIdleAttempt(issueKey);
  if (idleAttempt) {
    if (idleAttempt.tmux_session && sessionExists(idleAttempt.tmux_session)) {
      // tmux alive — inject message and mark running
      console.log(chalk.green(`[${ts}] [resolve] Reactivating idle ${idleAttempt.tmux_session} for ${issueKey}`));
      try {
        sendKeys(idleAttempt.tmux_session, prompt);
        updateAttemptStatus(idleAttempt.id, 'running');
        logEvent(idleAttempt.id, 'reactivated', { reason: 'resolve_session', commentId: opts.commentId });
        if (opts.webhookSessionId) {
          updateAttemptAgentSession(idleAttempt.id, opts.webhookSessionId);
        }
      } catch (err) {
        console.log(chalk.dim(`[${ts}] [resolve] Reactivation failed: ${(err as Error).message}`));
      }
      return { action: 'reactivated', tmuxSession: idleAttempt.tmux_session, attemptId: idleAttempt.id };
    } else {
      // tmux dead — mark as completed, fall through to spawn fresh
      console.log(chalk.dim(`[${ts}] [resolve] Idle session tmux dead for ${issueKey} — will spawn fresh`));
      updateAttemptStatus(idleAttempt.id, 'completed', 'Tmux session ended while idle');
      logEvent(idleAttempt.id, 'reclaimed', { reason: 'tmux_dead_on_reactivate' });
      // Fall through to spawn
    }
  }

  // ─── 4. Suspended (hibernated) session on this issue? → wake ───
  const hibernated = getHibernatedAttempts();
  const suspendedAttempt = hibernated.find(a => a.issue_key === issueKey);
  if (suspendedAttempt) {
    if (wakeSession(suspendedAttempt.id)) {
      console.log(chalk.green(`[${ts}] [resolve] Resumed suspended session for ${issueKey}`));
      // Inject the prompt into the woken session
      if (suspendedAttempt.tmux_session) {
        try { sendKeys(suspendedAttempt.tmux_session, prompt); } catch { /* best effort */ }
      }
      return { action: 'resumed', tmuxSession: suspendedAttempt.tmux_session || '', attemptId: suspendedAttempt.id };
    }
    // Wake failed (tmux died during hibernation) — fall through to spawn
    console.log(chalk.dim(`[${ts}] [resolve] Suspended session wake failed for ${issueKey} — spawning fresh`));
  }

  // ─── 5. No session → need to spawn ───

  // 5a. Check capacity
  if (hasCapacity(role)) {
    return spawnDecision(issueKey);
  }

  // 5b. No capacity → try to evict (may need multiple rounds)
  console.log(chalk.yellow(`[${ts}] [resolve] ${role} at capacity — attempting eviction`));
  const MAX_EVICT_ROUNDS = 3;
  for (let i = 0; i < MAX_EVICT_ROUNDS; i++) {
    const evicted = pickToEvict(role, issueKey);
    if (!evicted) break;
    console.log(chalk.blue(`[${ts}] [resolve] Evicted ${evicted.type}: ${evicted.attempt.issue_key} (${evicted.attempt.agent_type})`));
    // Re-check capacity after eviction — the freed slot might not help this role
    if (hasCapacity(role)) {
      return spawnDecision(issueKey);
    }
  }

  // 5c. Can't evict → enqueue
  const queueId = randomUUID();
  console.log(chalk.yellow(`[${ts}] [resolve] No capacity, no eviction target — queueing ${issueKey}`));
  enqueue({
    id: queueId,
    issue_id: opts.issueId,
    issue_key: issueKey,
    agent_role: role,
    agent_session_id: opts.webhookSessionId,
  });
  return { action: 'queued', queueId };
}

// ─── Helpers ───

/**
 * Check if workspace has prior Claude Code conversation history.
 * If so, spawning with --continue will restore the conversation.
 */
function hasWorkspaceHistory(issueKey: string, project?: string): boolean {
  const workspace = resolveWorkspace(issueKey, project);
  // Claude Code stores conversation state — if .claude/ exists with prior settings,
  // the workspace was used before and --continue can recover context
  const claudeDir = join(workspace, '.claude');
  const claudeMd = join(claudeDir, 'CLAUDE.md');
  return existsSync(claudeMd);
}

function spawnDecision(issueKey: string): ResolveAction {
  const useContinue = hasWorkspaceHistory(issueKey);
  if (useContinue) {
    console.log(chalk.dim(`  Workspace has prior history — will use --continue`));
  }
  return { action: 'spawn', useContinue };
}
