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
import { createLogger } from '../core/logger.js';
import { followUpMeta } from './state.js';
import { wrapFollowUpMessage } from './helpers.js';

const log = createLogger('session-manager');

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

  // ─── 1. Circuit breaker ───
  const cb = checkCircuitBreaker(issueKey, role);
  if (!cb.allowed) {
    log.warn('Circuit breaker tripped', { issueKey, role, reason: cb.reason });
    return { action: 'rejected', reason: cb.reason || 'circuit breaker tripped' };
  }

  // ─── 2. Active running session on this issue? → pipe message in ───
  const activeAttempt = getActiveAttempt(issueKey);
  if (activeAttempt?.tmux_session && activeAttempt.status === 'running' && sessionExists(activeAttempt.tmux_session)) {
    log.debug('Piping into running session', { tmux: activeAttempt.tmux_session, issueKey });
    try {
      // RYA-331: Wrap with follow-up instructions so agent posts a visible Linear comment
      const wrappedPrompt = opts.commentId
        ? wrapFollowUpMessage(issueKey, prompt, opts.commentId)
        : prompt;
      sendKeys(activeAttempt.tmux_session, wrappedPrompt);
      if (opts.webhookSessionId) {
        updateAttemptAgentSession(activeAttempt.id, opts.webhookSessionId);
      }
      // RYA-331: Track follow-up meta so monitor can post threaded reply as fallback
      if (opts.commentId) {
        followUpMeta.set(activeAttempt.id, { createdAt: Date.now(), commentId: opts.commentId });
      }
      return { action: 'piped', tmuxSession: activeAttempt.tmux_session, attemptId: activeAttempt.id };
    } catch (err) {
      // RYA-300: sendKeys failure means the message was NOT delivered.
      // Don't return 'piped' — fall through to spawn a fresh session instead.
      // RYA-467: Record the lost message so it can be recovered/audited
      log.warn('Pipe failed, will spawn fresh', { issueKey, error: (err as Error).message, lostMessageLength: prompt.length });
      updateAttemptStatus(activeAttempt.id, 'completed', 'Pipe failed — session unresponsive');
      logEvent(activeAttempt.id, 'reclaimed', { reason: 'pipe_failed', lostMessage: prompt.substring(0, 500) });
    }
  }

  // ─── 3. Idle session on this issue? → reactivate ───
  const idleAttempt = getIdleAttempt(issueKey);
  if (idleAttempt) {
    if (idleAttempt.tmux_session && sessionExists(idleAttempt.tmux_session)) {
      // tmux alive — inject message and mark running
      log.info('Reactivating idle session', { tmux: idleAttempt.tmux_session, issueKey });
      try {
        // RYA-331: Wrap with follow-up instructions so agent posts a visible Linear comment
        const wrappedPrompt = opts.commentId
          ? wrapFollowUpMessage(issueKey, prompt, opts.commentId)
          : prompt;
        sendKeys(idleAttempt.tmux_session, wrappedPrompt);
        updateAttemptStatus(idleAttempt.id, 'running');
        logEvent(idleAttempt.id, 'reactivated', { reason: 'resolve_session', commentId: opts.commentId });
        if (opts.webhookSessionId) {
          updateAttemptAgentSession(idleAttempt.id, opts.webhookSessionId);
        }
        // RYA-331: Track follow-up meta so monitor can post threaded reply as fallback
        if (opts.commentId) {
          followUpMeta.set(idleAttempt.id, { createdAt: Date.now(), commentId: opts.commentId });
        }
        return { action: 'reactivated', tmuxSession: idleAttempt.tmux_session, attemptId: idleAttempt.id };
      } catch (err) {
        // RYA-300: sendKeys failure means the message was NOT delivered.
        // Mark idle session as completed and fall through to spawn fresh.
        // RYA-467: Record the lost message so it can be recovered/audited
        log.warn('Reactivation failed, will spawn fresh', { issueKey, error: (err as Error).message, lostMessageLength: prompt.length });
        updateAttemptStatus(idleAttempt.id, 'completed', 'Reactivation failed — session unresponsive');
        logEvent(idleAttempt.id, 'reclaimed', { reason: 'reactivation_failed', lostMessage: prompt.substring(0, 500) });
      }
    } else {
      // tmux dead — mark as completed, fall through to spawn fresh
      log.debug('Idle session tmux dead, will spawn fresh', { issueKey });
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
      log.info('Resumed suspended session', { issueKey });
      // Inject the prompt into the woken session
      // RYA-331: Wrap with follow-up instructions when commentId is present
      if (suspendedAttempt.tmux_session) {
        const wrappedPrompt = opts.commentId
          ? wrapFollowUpMessage(issueKey, prompt, opts.commentId)
          : prompt;
        try { sendKeys(suspendedAttempt.tmux_session, wrappedPrompt); } catch (err) { log.debug('sendKeys failed after resume', { issueKey, error: (err as Error).message }); }
        if (opts.commentId) {
          followUpMeta.set(suspendedAttempt.id, { createdAt: Date.now(), commentId: opts.commentId });
        }
      }
      return { action: 'resumed', tmuxSession: suspendedAttempt.tmux_session || '', attemptId: suspendedAttempt.id };
    }
    // Wake failed (tmux died during hibernation) — fall through to spawn
    log.debug('Suspended session wake failed, spawning fresh', { issueKey });
  }

  // ─── 5. No session → need to spawn ───

  // 5a. Check capacity
  if (hasCapacity(role)) {
    return spawnDecision(issueKey);
  }

  // 5b. No capacity → try to evict (may need multiple rounds)
  log.warn('At capacity, attempting eviction', { role, issueKey });
  const MAX_EVICT_ROUNDS = 3;
  for (let i = 0; i < MAX_EVICT_ROUNDS; i++) {
    const evicted = pickToEvict(role, issueKey);
    if (!evicted) break;
    log.info('Evicted session', { type: evicted.type, evictedIssue: evicted.attempt.issue_key, evictedRole: evicted.attempt.agent_type });
    // Re-check capacity after eviction — the freed slot might not help this role
    if (hasCapacity(role)) {
      return spawnDecision(issueKey);
    }
  }

  // 5c. Can't evict → enqueue
  const queueId = randomUUID();
  log.warn('No capacity, no eviction target — queueing', { issueKey, role });
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
    log.debug('Workspace has prior history — will use --continue', { issueKey });
  }
  return { action: 'spawn', useContinue };
}
