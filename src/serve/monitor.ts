/** Session monitor: detect completion, quality gate, trust prompt, rate limit, batch completion. */

// ─── Re-exports from extracted modules (backward compat) ────────────────────
export type { StatusIntent, DispatchAction, HandoffActions, ReviewLevel } from './handoff-executor.js';
export {
  parseStatusIntent, hasStickyInProgressIntent, parseDispatchesFromFrontMatter, parseHandoffActions,
  hasActiveHandoff, executeHandoffActions, createSubIssueFromAction,
} from './handoff-executor.js';
export { classifyReviewLevel, detectReviewerFromDescription, autoDispatchReviewer } from './review-dispatcher.js';

// ─── Imports ─────────────────────────────────────────────────────────────────

import { createLogger } from '../core/logger.js';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getConfig, resolveStatePath, getIssueStateDir } from '../core/config.js';
import {
  hasAgentAccess, emitActivity, addComment, getIssue,
  updateIssueState, createIssueDocument, createIssueAttachment, dismissAgentSession,
  generateHandoffSummary, getRecentCommentBodies,
  closeActiveSessionsForIssue, getAgentCommentCountSince, addLabelToIssue,
} from '../core/linear.js';
import {
  Attempt, getActiveAttempts, getActiveAttempt, getIdleAttempts, getAttemptsByIssue,
  updateAttemptStatus, logEvent,
  getCompletedWithTmux, clearAttemptTmuxSession,
} from '../core/db.js';
import {
  readFileOnRemote, sessionExists, capturePane, killSession, sendKeys, sendEnterKey,
  listAgentSessions, recoverPhantomInput,
} from '../core/tmux.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';
import { enqueue, setCooldown, cancelQueuedByRole, getQueueItems } from '../core/queue.js';
import { WORKFLOW_STATES, AGENT_LABELS } from '../types.js';
import { broadcastCompletion } from '../core/team-context.js';

import {
  reportedHandoffs, trustPromptHandled, followUpMeta, FOLLOW_UP_TTL_MS,
  reactivatedAt, reactivationContext,
  discordSourceContext, DISCORD_SOURCE_TTL_MS,
  gcStateMaps, persistentDedupCheck, persistentDedupRecord,
} from './state.js';
import {
  postToGroupChat, handoffContentHash, isHandoffAlreadyPosted,
  countConsecutiveRateLimitFailures, getRateLimitBackoffMs,
  RATE_LIMIT_ESCALATION_MARKER, isPermanentIssueError,
} from './helpers.js';
import { checkCircuitBreaker, tripCircuitBreaker } from './circuit-breaker.js';
import { evaluateHandoff, qualityGateMode, qualityGateDecision, formatGateFailures } from './quality-gate.js';
import { validateHandoffActions, formatRejectedActions, RejectedAction } from './handoff-validate.js';
import { graderMode, gradeAttempt, gradeFails, shouldGradeIssue, takeGraderBounce } from './grader.js';
import { trackPaneOutput, clearLoopState, gcLoopStates, runCostVelocityChecks, LOOP_NUDGE_MESSAGE } from './agent-guards.js';
import { tryWakeHibernatedSession, monitorHibernatedSessions } from './concurrency.js';
import { handleDispatch } from './dispatch.js';
import {
  journalPendingActions, ackPendingActions, listPendingActions,
  PENDING_ACTIONS_MAX_AGE_MS, PendingActionsEntry,
} from './action-journal.js';
import { sendDiscordReply } from './discord-bot.js';
import { agentStartCommand } from '../commands/agent.js';
import { reapIdleChatSessions } from './chat-session.js';
import { getDependentIssues, isBlocked } from '../core/linear-relations.js';
import {
  isSessionLimitModal, parseSessionLimitResetMs, sessionLimitNextAction,
  recordSessionLimitHit, fireSessionLimitFleetAlert, currentFleetHitKeys,
  SessionLimitWaitState, SESSION_LIMIT_DEFAULT_WAIT_MS, SESSION_LIMIT_RESUME_MESSAGE,
} from './session-limit.js';
import {
  PhantomInputState, phantomInputNextAction, extractUnsubmittedInput,
} from './phantom-input.js';
import {
  parseHandoffActions, executeHandoffActions, createSubIssueFromAction, hasActiveHandoff,
} from './handoff-executor.js';
import { autoDispatchReviewer } from './review-dispatcher.js';
import { runEvalsAsync } from './eval-runner.js';

const log = createLogger('monitor');

/** Parse SQLite datetime (UTC without 'Z') into epoch ms. */
function parseUtcTimestamp(ts: string): number {
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime();
}

// Content-hash dedup: prevent same HANDOFF.md from being posted multiple times
// for the same issue when session replacement creates new attempt IDs
const reportedHandoffHashes = new Set<string>();
const MAX_RATE_LIMIT_RETRIES = 3;

// Rate limit confirmation: require 2 consecutive detections before killing.
// RYA-335: false positives from agents reviewing code containing rate-limit keywords.
const rateLimitSuspects = new Map<string, number>(); // attempt ID → first detection epoch
const RATE_LIMIT_CONFIRM_MS = 30_000; // must see rate-limit again within 30s to confirm

// RYA-1258: bad-model respawn tracking — record which attempts have already been
// respawned due to an inaccessible model, to prevent infinite respawn loops.
const badModelRespawned = new Set<string>(); // attempt IDs already respawned

// Idle detection: track when sessions first appear at prompt
// We dismiss the Linear AgentSession (stop "Working") but keep tmux alive for context.
const idleTimers = new Map<string, number>();
const IDLE_DISMISS_MS = 300_000; // 5min idle at prompt → dismiss AgentSession (not kill)
const FOLLOW_UP_IDLE_DISMISS_MS = 60_000; // 1min for follow-up conversations — they finish fast
const WARMUP_GRACE_MS = 120_000; // 2min grace period — new sessions need time to load CLAUDE.md, read context, and plan
const dismissedSessions = new Set<string>(); // attempt IDs already dismissed for idle

// Stuck session detection: nudge agents that are "running" but haven't produced
// any output (no HANDOFF, no comments) for an extended period.
const STUCK_THRESHOLD_MS = 30 * 60_000; // 30 min with no comments → nudge
const stuckNudged = new Set<string>(); // attempt IDs already nudged

// Transient API error retry: for 500/503/overloaded errors from Anthropic,
// keep the session alive and periodically send a retry message instead of failing.
// The agent's full context is preserved — no re-spawn needed.
interface TransientRetryState {
  firstSeen: number;      // epoch ms when error first detected
  lastRetryAt: number;    // epoch ms of last retry attempt
  retryCount: number;
}
const transientRetryMap = new Map<string, TransientRetryState>(); // keyed by attempt ID
export const TRANSIENT_RETRY_DELAY_MS = 60_000;           // wait 60s between retries
export const TRANSIENT_RETRY_MAX_DURATION_MS = 2 * 60 * 60 * 1000; // give up after 2 hours

// RYA-443: Rate limit in-place retry — same pattern as transient errors.
// Instead of killing the session and losing context, keep it alive and wait.
const rateLimitRetryMap = new Map<string, TransientRetryState>(); // keyed by attempt ID
export const RATE_LIMIT_RETRY_DELAY_MS = 120_000;          // wait 2 min between retries (rate limits need longer cooldown)
export const RATE_LIMIT_RETRY_MAX_DURATION_MS = 30 * 60_000; // give up after 30 min (then kill + re-enqueue with backoff)
const MAX_RATE_LIMIT_IN_PLACE_RETRIES = 5;                 // max in-place retries before killing

// RYA-1243: Sessions paused at the /rate-limit-options modal (session limit).
// Keyed by attempt ID. While an attempt is here, loop/idle failure paths are
// suppressed — the session is intentionally parked until the limit resets.
const sessionLimitWaitMap = new Map<string, SessionLimitWaitState>();
const SESSION_LIMIT_WAIT_MAX_AGE_MS = 8 * 60 * 60_000; // safety GC: nothing waits >8h

// RYA-1251: Panes showing typed-but-never-submitted input (phantom paste, or
// a human-typed message whose Enter was eaten). Keyed by tmux SESSION NAME,
// not attempt ID — the sweep covers every aos-* pane, including chat sessions
// and messages typed directly by the CEO.
const phantomInputStates = new Map<string, PhantomInputState>();

// Active-work signals (subagents, thinking, streaming) — shared by the
// session-limit recovery (Case 2.9) and Case 3.5 idle/loop detection.
const ACTIVE_WORK_RE = /Flowing|Running \d+ agent|thinking|streaming|Searching|Fetching|Reading|Creating|Doodling|Gusting|Crunching|Garnishing|Deciphering|Saut|Exploring|Writing|Editing|Analyzing|thought for/i;

/**
 * GC monitor-local Maps/Sets that aren't exported through state.ts.
 * Called every monitor cycle (~15s) to prevent unbounded growth.
 */
function gcMonitorLocalMaps(): void {
  const now = Date.now();

  // reportedHandoffHashes: only needed while attempt is active, cap size
  if (reportedHandoffHashes.size > 500) reportedHandoffHashes.clear();

  // rateLimitSuspects: 30s confirmation window, prune anything > 2 min
  if (rateLimitSuspects.size > 0) {
    const cutoff = now - 2 * 60_000;
    for (const [k, v] of rateLimitSuspects) {
      if (v < cutoff) rateLimitSuspects.delete(k);
    }
  }

  // idleTimers: prune entries > 1 hour (sessions won't be idle that long)
  if (idleTimers.size > 0) {
    const cutoff = now - 60 * 60_000;
    for (const [k, v] of idleTimers) {
      if (v < cutoff) idleTimers.delete(k);
    }
  }

  // dismissedSessions: cap size (entries are attempt IDs for terminated sessions)
  if (dismissedSessions.size > 500) dismissedSessions.clear();

  // stuckNudged: cap size
  if (stuckNudged.size > 500) stuckNudged.clear();

  // transientRetryMap: prune entries past max duration
  if (transientRetryMap.size > 0) {
    for (const [k, v] of transientRetryMap) {
      if (now - v.firstSeen > TRANSIENT_RETRY_MAX_DURATION_MS) transientRetryMap.delete(k);
    }
  }

  // rateLimitRetryMap: prune entries past max duration
  if (rateLimitRetryMap.size > 0) {
    for (const [k, v] of rateLimitRetryMap) {
      if (now - v.firstSeen > RATE_LIMIT_RETRY_MAX_DURATION_MS) rateLimitRetryMap.delete(k);
    }
  }

  // sessionLimitWaitMap: safety net — no session-limit wait should outlive 8h
  if (sessionLimitWaitMap.size > 0) {
    for (const [k, v] of sessionLimitWaitMap) {
      if (now - v.firstSeenMs > SESSION_LIMIT_WAIT_MAX_AGE_MS) sessionLimitWaitMap.delete(k);
    }
  }
}

/**
 * RYA-1258: Detect the "inaccessible model" boot error emitted by claude when the
 * configured model is not accessible. The session dies at startup; the monitor
 * kills it and respawns with a fallback model.
 */
export function isBadModelOutput(output: string): boolean {
  return /There is an issue with the selected model|may not exist or you may not have access to it/i.test(output);
}

/**
 * Classify whether pane output contains a transient API error (500/503/overloaded)
 * that should be retried in-place rather than immediately failing.
 */
export function isTransientApiErrorOutput(output: string): boolean {
  return (
    /API Error: 50[023]/i.test(output) ||
    /overloaded_error/i.test(output) ||
    /internal[\s._]server[\s._]error/i.test(output) ||
    /service[\s._]unavailable/i.test(output)
  );
}


/**
 * Determine if an issue should skip CEO review and go directly to Done.
 * Trivial issues (tests, fixes, hotfixes, QA, typos, lint, cleanup) don't need review
 * if the agent's HANDOFF.md indicates success.
 */
export function shouldSkipReview(issueTitle: string, handoff: string): boolean {
  const trivialPatterns = /\b(test|fix|hotfix|bug\s*fix|typo|lint|cleanup|clean-?up|rename|bump|patch|chore|refactor|nit)\b/i;
  if (!trivialPatterns.test(issueTitle)) return false;

  // Only auto-close if handoff indicates success (tests pass, verified, etc.)
  const successSignals = /\b(pass|passing|verified|confirmed|fixed|resolved|done|works|succeed|success|green|✅)\b/i;
  return successSignals.test(handoff);
}

/**
 * Detect whether an issue is a non-code deliverable (strategy, research doc, etc.)
 * These tasks produce documents/reports rather than code changes, so quality checks
 * should look for deliverable evidence instead of file diffs and test runs.
 */
export function isNonCodeDeliverable(title: string, labels: string[]): boolean {
  // Title bracket tags: [Strategy], [Research], [Analysis], [Report], [Exploration]
  if (/\[(strategy|research|analysis|report|exploration|investigation)\]/i.test(title)) return true;

  // Labels indicating non-code work
  if (labels.some(l => /^(strategy|research|analysis|report|exploration|investigation)$/i.test(l))) return true;

  // Compound title keywords that clearly indicate document deliverables
  if (/\b(strategy|strategic\s+plan|research\s+report|market\s+analysis|business\s+plan|landscape\s+scan|competitive\s+analysis)\b/i.test(title)) return true;

  return false;
}

/**
 * RYA-1206: replay handoff actions that were journaled but never acked — the
 * serve process died mid-completion (auto-deploy restart, crash) after the
 * actions were persisted but before they were executed. Called once at serve
 * startup. Delivery is at-least-once: handleDispatch's persistent 60s dedup,
 * the `handoff-actions-exec:<attemptId>:<contentHash>` marker (recorded right
 * after executeHandoffActions — RYA-1207), and the
 * `handoff-actions:<attemptId>:<contentHash>` marker (recorded at ack) keep
 * replays idempotent per attempt+handoff. Status recovery is NOT replayed
 * here — the scheduler reconciler owns that path (RYA-1204).
 */
export async function replayPendingHandoffActions(): Promise<void> {
  let entries: PendingActionsEntry[];
  try {
    entries = listPendingActions();
  } catch (err) {
    log.debug('Pending-actions journal unreadable', { error: (err as Error).message });
    return;
  }
  for (const entry of entries) {
    try {
      // Crash landed between execution and ack — actions already applied.
      const entryHash = handoffContentHash(entry.handoff);
      const appliedMarker = `handoff-actions:${entry.attemptId}:${entryHash}`;
      if (persistentDedupCheck(appliedMarker, PENDING_ACTIONS_MAX_AGE_MS)) {
        ackPendingActions(entry.attemptId);
        continue;
      }
      log.warn('Replaying handoff actions lost to mid-completion restart', {
        issueKey: entry.issueKey, role: entry.agentType,
        dispatches: entry.actions.dispatches.length,
        delegate: entry.actions.delegate, parentStatus: entry.actions.parentStatus,
      });
      logEvent(entry.attemptId, 'handoff_actions_replayed', {
        dispatches: entry.actions.dispatches.length,
        delegate: entry.actions.delegate,
        parentStatus: entry.actions.parentStatus,
        reviewDispatch: entry.actions.reviewDispatch,
      });

      const agentTok = getAgentLinearToken(entry.agentType) || undefined;
      const attemptLike = {
        id: entry.attemptId,
        issue_key: entry.issueKey,
        issue_id: entry.issueId,
        agent_type: entry.agentType,
      } as Attempt;

      if (entry.actions.dispatches.length > 0 || entry.actions.delegate || entry.actions.parentStatus) {
        // RYA-1207: the exec-half marker is recorded right after
        // executeHandoffActions in the normal flow. If it's present, the
        // crash landed between execution and the reviewer-settled ack —
        // re-running here would duplicate sub-issues (new_issue dispatches
        // have no idempotency on createIssue). Skip straight to the
        // reviewer half, which IS safely re-runnable (handleDispatch dedup).
        const execMarker = `handoff-actions-exec:${entry.attemptId}:${entryHash}`;
        if (persistentDedupCheck(execMarker, PENDING_ACTIONS_MAX_AGE_MS)) {
          log.info('Skipping already-executed action half on replay', { issueKey: entry.issueKey });
        } else {
          try {
            await executeHandoffActions(entry.actions, attemptLike, agentTok);
          } catch (err) {
            // Mirror the normal completion flow: action failures are logged, not retried
            log.warn('Replayed handoff actions failed', { issueKey: entry.issueKey, error: (err as Error).message });
          }
          // Same crash window exists during replay itself — mark before the
          // reviewer half so a second replay can't double-execute either.
          persistentDedupRecord(execMarker);
        }
      }

      // Reviewer half — same gating as the normal flow (grader state is lost
      // with the process; skipping it on replay is fail-open, matching A2.3).
      if (!entry.isFollowUp) {
        const effectiveStatus = entry.actions.statusIntent?.status || 'in-review';
        if (effectiveStatus === 'in-review') {
          try {
            await autoDispatchReviewer(
              entry.issueKey, entry.issueId, '',
              entry.agentType, entry.actions, agentTok, entry.handoff,
            );
          } catch (err) {
            log.debug('Replayed reviewer dispatch failed', { issueKey: entry.issueKey, error: (err as Error).message });
          }
        }
      }

      persistentDedupRecord(appliedMarker);
      ackPendingActions(entry.attemptId);
    } catch (err) {
      // Leave the entry un-acked — retried on the next startup, expires after 24h
      log.warn('Pending-actions replay error (entry kept for next start)', { issueKey: entry.issueKey, error: (err as Error).message });
    }
  }
}

/** Validate handoff quality before accepting completion */

/**
 * When an issue completes, check if it was blocking other issues.
 * For each dependent that is now fully unblocked (all blockers resolved),
 * dispatch it if it has an assigned agent and is in Backlog/Todo.
 */
export async function unblockDependents(completedIssueKey: string): Promise<void> {
  const ts = new Date().toLocaleTimeString();
  try {
    const dependents = await getDependentIssues(completedIssueKey);
    if (dependents.length === 0) return;

    log.info('Checking dependents of completed issue', { issueKey: completedIssueKey, count: dependents.length });

    for (const dep of dependents) {
      // Only consider issues that are waiting to be worked on
      const depState = dep.issueState.toLowerCase();
      if (depState !== 'backlog' && depState !== 'todo') continue;

      // Check if the dependent is now fully unblocked
      const blockStatus = await isBlocked(dep.issueKey);
      if (blockStatus.blocked) {
        const remainingBlockers = blockStatus.blockers.map(b => b.issueKey).join(', ');
        log.debug('Issue still blocked', { issueKey: dep.issueKey, blockedBy: remainingBlockers });
        continue;
      }

      log.info('Issue now unblocked, checking for auto-dispatch', { issueKey: dep.issueKey });

      // Try to resolve the assigned agent and dispatch
      try {
        const issue = await getIssue(dep.issueKey);

        // Re-check state is still dispatchable (guards against TOCTOU race)
        const freshState = ((issue as any).state?.name || '').toLowerCase();
        if (freshState !== 'backlog' && freshState !== 'todo') {
          log.debug('Issue state changed, skipping dispatch', { issueKey: dep.issueKey, state: freshState });
          continue;
        }

        // Guard: skip if this issue already has a running agent session
        const existingSession = getActiveAttempts().find(a => a.issue_key === dep.issueKey && a.status === 'running');
        if (existingSession) {
          log.debug('Issue already has a running session, skipping', { issueKey: dep.issueKey });
          continue;
        }

        let targetRole: string | null = null;

        // Check delegate first, then assignee
        const { listAgents, loadAgentConfig } = await import('../core/persona.js');
        const delegateId = (issue as any).delegateId as string | undefined;
        if (delegateId) {
          for (const role of listAgents()) {
            const cfg = loadAgentConfig(role);
            if (cfg.linearUserId === delegateId) {
              targetRole = role;
              break;
            }
          }
        }
        if (!targetRole && issue.assigneeId) {
          for (const role of listAgents()) {
            const cfg = loadAgentConfig(role);
            if (cfg.linearUserId === issue.assigneeId) {
              targetRole = role;
              break;
            }
          }
        }

        if (targetRole) {
          log.info('Auto-dispatching unblocked issue', { issueKey: dep.issueKey, role: targetRole });
          await handleDispatch({
            role: targetRole,
            issueKey: dep.issueKey,
            message: `Blocker ${completedIssueKey} completed. This issue is now unblocked and ready for work.`,
            from: 'system',
          });
        } else {
          log.debug('Issue unblocked but no agent assigned, skipping auto-dispatch', { issueKey: dep.issueKey });
        }
      } catch (err) {
        log.debug('Failed to dispatch issue', { issueKey: dep.issueKey, error: (err as Error).message });
      }
    }
  } catch (err) {
    log.debug('unblockDependents error', { error: (err as Error).message });
  }
}

/**
 * RYA-1251: Sweep every aos-* pane for phantom unsubmitted input — `❯ <text>`
 * that has sat unchanged past the idle threshold. Bare Enter can never submit
 * a phantom render (the real input buffer is empty), so recovery re-TYPEs the
 * visible text as literal keystrokes (core/tmux.ts recoverPhantomInput).
 * Session-name keyed, independent of attempts: it also rescues messages typed
 * into panes by humans (the research-lead case was a CEO message stuck ~40h).
 */
export function sweepPhantomInput(): void {
  const sessions = listAgentSessions();
  // GC state for panes that no longer exist
  for (const name of phantomInputStates.keys()) {
    if (!sessions.includes(name)) phantomInputStates.delete(name);
  }
  const now = Date.now();
  for (const session of sessions) {
    try {
      const pane = capturePane(session, 25);
      if (!pane) continue;
      const text = extractUnsubmittedInput(pane);
      if (!text) { phantomInputStates.delete(session); continue; }
      if (isSessionLimitModal(pane)) continue; // parked — modal recovery (Case 2.9) owns this pane
      const state = phantomInputStates.get(session);
      if (!state || state.lastText !== text) {
        // New sighting, or the text changed (someone is typing) — restart the clock.
        phantomInputStates.set(session, { firstSeenMs: now, lastText: text, recoveryCount: 0, lastRecoveryAtMs: 0 });
        continue;
      }
      const action = phantomInputNextAction(state, ACTIVE_WORK_RE.test(pane), now);
      if (action === 'recover') {
        state.recoveryCount++;
        state.lastRecoveryAtMs = now;
        log.warn('Unsubmitted input idle — literal retype recovery', {
          session,
          idleMin: Math.round((now - state.firstSeenMs) / 60_000),
          attempt: state.recoveryCount,
          preview: text.slice(0, 80),
        });
        if (recoverPhantomInput(session, text)) {
          log.info('Phantom input recovered', { session });
          phantomInputStates.delete(session);
        }
      } else if (action === 'give-up' && !state.gaveUp) {
        state.gaveUp = true;
        log.error('Phantom input recovery exhausted — pane needs manual attention', {
          session, preview: text.slice(0, 80),
        });
      }
    } catch (err) {
      log.debug('Phantom input sweep failed for session', { session, error: (err as Error).message });
    }
  }
}

/** Monitor active sessions — detect completion via HANDOFF.md or session death */
export async function monitorSessions(): Promise<void> {
  // RYA-1251: backstop for stuck input on ANY aos-* pane, attempts or not.
  try { sweepPhantomInput(); } catch (err) {
    log.debug('Phantom input sweep skipped', { error: (err as Error).message });
  }

  // Also monitor idle sessions — detect reactivation or tmux death
  const idleAttempts = getIdleAttempts();
  for (const idle of idleAttempts) {
    if (!idle.tmux_session) continue;
    if (!sessionExists(idle.tmux_session)) {
      // tmux died while idle — mark as completed (not failed, since idle is a clean state)
      updateAttemptStatus(idle.id, 'completed', 'Session ended while idle');
      logEvent(idle.id, 'completed', { reason: 'idle_session_death' });
      const ts = new Date().toLocaleTimeString();
      log.debug('Idle session ended', { issueKey: idle.issue_key, role: idle.agent_type });
      continue;
    }
    // Check if an idle session started working again (agent received piped input)
    try {
      const output = capturePane(idle.tmux_session, 10);
      const isActivelyWorking = /Flowing|Running \d+ agent|thinking|streaming|Searching|Fetching|Reading|Creating|Writing|Editing|Analyzing|thought for/i.test(output);
      if (isActivelyWorking) {
        updateAttemptStatus(idle.id, 'running');
        dismissedSessions.delete(idle.id);
        idleTimers.delete(`idle:${idle.id}`); // Reset idle timer so it can go idle again later
        reactivatedAt.set(idle.id, Date.now()); // Fresh warmup grace period
        logEvent(idle.id, 'reactivated', { reason: 'activity_detected' });
        const ts = new Date().toLocaleTimeString();
        log.info('Reactivated idle session', { issueKey: idle.issue_key, role: idle.agent_type });
      }
    } catch (err) { log.error('Failed to check idle session', { issueKey: idle.issue_key, error: (err as Error).message }); }
  }

  const attempts = getActiveAttempts();
  if (attempts.length === 0) return;

  for (const attempt of attempts) {
    if (!attempt.tmux_session || !attempt.workspace_path) continue;

    const alive = sessionExists(attempt.tmux_session);
    // Read state files from per-issue state dir (RYA-246), with workspace fallback for in-flight sessions
    const handoffPath = resolveStatePath(attempt.issue_key, attempt.workspace_path, 'HANDOFF.md');
    const blockedPath = resolveStatePath(attempt.issue_key, attempt.workspace_path, 'BLOCKED.md');
    const handoff = readFileOnRemote(handoffPath);
    const blocked = readFileOnRemote(blockedPath);

    // Copy-on-read: if HANDOFF/BLOCKED was read from workspace (fallback), copy to state dir
    // for isolation. Prevents shared-workspace crosstalk on subsequent reads.
    if (handoff && handoffPath === join(attempt.workspace_path, 'HANDOFF.md')) {
      try {
        const stateDir = getIssueStateDir(attempt.issue_key);
        const stateCopy = join(stateDir, 'HANDOFF.md');
        writeFileSync(stateCopy, handoff);
      } catch (err) { log.error('Failed to copy HANDOFF.md to state dir', { issueKey: attempt.issue_key, error: (err as Error).message }); }
    }
    if (blocked && blockedPath === join(attempt.workspace_path, 'BLOCKED.md')) {
      try {
        const stateDir = getIssueStateDir(attempt.issue_key);
        const stateCopy = join(stateDir, 'BLOCKED.md');
        writeFileSync(stateCopy, blocked);
      } catch (err) { log.error('Failed to copy BLOCKED.md to state dir', { issueKey: attempt.issue_key, error: (err as Error).message }); }
    }

    const handoffKey = `${attempt.id}:handoff`;
    const ts = new Date().toLocaleTimeString();

    // Auto-approve trust prompts for sessions < 120s old (or until first successful detection)
    if (alive && attempt.tmux_session && !trustPromptHandled.has(attempt.tmux_session)) {
      const ageMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      if (ageMs < 120_000) {
        try {
          const paneOutput = capturePane(attempt.tmux_session, 10);
          if (/trust|Trust|Yes, I trust|trust this folder|Trust this workspace|Yes, continue|proceed|Press enter to confirm|Do you trust|security check/i.test(paneOutput || '')) {
            const { execSync: ex } = await import('child_process');
            const config = getConfig();
            ex(
              `tmux send-keys -t ${attempt.tmux_session} Enter 2>/dev/null`,
              { encoding: 'utf-8', timeout: 5_000 }
            );
            trustPromptHandled.add(attempt.tmux_session);
            log.debug('Auto-approved trust prompt', { issueKey: attempt.issue_key });
          }
        } catch (err) { log.error('Failed to auto-approve trust prompt', { issueKey: attempt.issue_key, error: (err as Error).message }); }
      }
    }

    // Case 1: HANDOFF.md appeared (CC finished, session may still be alive for observation)
    if (handoff && !reportedHandoffs.has(handoffKey)) {
      reportedHandoffs.add(handoffKey);

      // Content-hash dedup: skip if same HANDOFF content was already posted for this issue
      // This prevents duplicate posts when session replacement creates a new attempt
      const contentHash = handoffContentHash(handoff);
      const issueContentKey = `${attempt.issue_key}:${contentHash}`;
      // A1.3: persistent check covers serve restarts (HANDOFF.md persists on disk,
      // so a restarted serve would otherwise re-post the same completion).
      if (reportedHandoffHashes.has(issueContentKey) || persistentDedupCheck(`handoff:${issueContentKey}`, 24 * 60 * 60_000)) {
        log.debug('Skipping duplicate HANDOFF (content already posted)', { issueKey: attempt.issue_key, attempt: attempt.attempt_number });
        updateAttemptStatus(attempt.id, 'completed');
        logEvent(attempt.id, 'completed', { hasHandoff: true, deduplicated: true });
        // Dismiss the Linear AgentSession so "Working" indicator clears
        if (attempt.agent_session_id) {
          const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
          try { await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} completed.`); } catch (err) { log.error('Failed to dismiss agent session', { issueKey: attempt.issue_key, error: (err as Error).message }); }
        }
        continue;
      }

      // A2.1: quality gate — evaluate BEFORE any completion side-effects.
      // Runs before the content-hash claim so an enforce-mode bounce can let the
      // agent rewrite HANDOFF.md and have it re-evaluated on a later tick.
      // Follow-up (conversation) handoffs are exempt — they are answers, not work.
      if (!followUpMeta.has(attempt.id)) {
        try {
          const qg = evaluateHandoff(attempt, handoff, attempt.workspace_path);
          if (!qg.pass) {
            const qgMode = qualityGateMode();
            const qgBounceKey = `qgate:${attempt.id}`;
            const qgAction = qualityGateDecision(
              qg.failures, qgMode, persistentDedupCheck(qgBounceKey, 24 * 60 * 60_000), qg.critical,
            );
            if (qgAction === 'bounce') {
              persistentDedupRecord(qgBounceKey);
              log.warn('Quality gate bounce — handoff rejected', { issueKey: attempt.issue_key, role: attempt.agent_type, failures: qg.failures, critical: qg.critical });
              // Remove the rejected HANDOFF.md (state-dir copy + the file we read)
              const rejectedPaths = new Set([join(getIssueStateDir(attempt.issue_key), 'HANDOFF.md'), handoffPath]);
              for (const p of rejectedPaths) {
                try { if (existsSync(p)) unlinkSync(p); } catch (err) { log.debug('Quality gate: failed to remove HANDOFF.md', { path: p, error: (err as Error).message }); }
              }
              // Allow re-detection of the rewritten handoff
              reportedHandoffs.delete(handoffKey);
              if (alive && attempt.tmux_session) {
                try {
                  if (qg.critical) {
                    // Critical: wrong-prompt delivery failure. Re-deliver the task instead
                    // of asking the agent to fix its HANDOFF — it can't fix a wrong prompt.
                    const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
                    await addComment(attempt.issue_id,
                      `⚠️ Quality gate: prompt delivery failure detected on attempt #${attempt.attempt_number}. ` +
                      `HANDOFF indicated no task was received. Re-delivering task to the session.`, agentTok).catch(() => {/**/});
                    // Inject the task context directly so the agent can restart work
                    const { buildTaskPrompt } = await import('../core/persona.js');
                    let issueTitle = attempt.issue_key;
                    try {
                      const { getIssue } = await import('../core/linear.js');
                      const issue = await getIssue(attempt.issue_key);
                      issueTitle = `${issue.identifier}: ${issue.title}`;
                      const taskPrompt = buildTaskPrompt(attempt.agent_type, issue.identifier, issue.title, issue.description, attempt.workspace_path ?? undefined, issue.state);
                      sendKeys(attempt.tmux_session, taskPrompt);
                    } catch (err) {
                      // Fallback: inject minimal task context
                      sendKeys(attempt.tmux_session,
                        `[SYSTEM] Prompt delivery failure detected. Your actual task is ${issueTitle}. ` +
                        `Please re-read the issue in Linear and complete the work, then write HANDOFF.md.`);
                    }
                  } else {
                    sendKeys(
                      attempt.tmux_session,
                      `[SYSTEM] Quality gate rejected your HANDOFF.md:\n${formatGateFailures(qg.failures)}\nFix these issues (write/index memory files, describe how you verified the work, and reference issue keys for every follow-up bullet), then rewrite HANDOFF.md.`,
                    );
                  }
                } catch (err) { log.warn('Quality gate: failed to send fix instruction', { issueKey: attempt.issue_key, error: (err as Error).message }); }
              }
              logEvent(attempt.id, 'quality_gate_bounce', { failures: qg.failures, critical: qg.critical });
              continue;
            }
            if (qgAction === 'warn') {
              log.warn('Quality gate failures (proceeding)', { issueKey: attempt.issue_key, mode: qgMode, failures: qg.failures });
              logEvent(attempt.id, 'quality_gate_warn', { failures: qg.failures });
              try {
                const qgTok = getAgentLinearToken(attempt.agent_type) || undefined;
                await addComment(
                  attempt.issue_id,
                  `⚠️ Quality gate — handoff accepted with warnings:\n${formatGateFailures(qg.failures)}`,
                  qgTok,
                );
              } catch (err) { log.debug('Quality gate: warn comment failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
            }
          }
        } catch (err) {
          // Fail-open: gate errors must never block completions
          log.debug('Quality gate evaluation failed (fail-open)', { issueKey: attempt.issue_key, error: (err as Error).message });
        }
      }

      // Race fix: claim the hash BEFORE the async Linear API call.
      // If a concurrent monitor cycle reaches here for the same content,
      // it will hit the check above and skip — preventing duplicate posts.
      reportedHandoffHashes.add(issueContentKey);
      persistentDedupRecord(`handoff:${issueContentKey}`);

      const isFollowUp = followUpMeta.has(attempt.id);

      // Parse all structured actions from HANDOFF front matter.
      // A2.2: validate the agent-declared actions before any are executed.
      // Rejected actions are dropped individually; valid ones proceed.
      // RYA-1207: nothing between the hash claim above and the journal write
      // below may await — a restart landing in an await there drops the
      // actions (the restarted monitor takes the dedup early-exit at the top
      // and the journal never got the entry). The rejected-actions comment is
      // therefore posted after journaling.
      let actions = parseHandoffActions(handoff);
      let rejectedActions: RejectedAction[] = [];
      try {
        const actionValidation = validateHandoffActions(actions, listAgents());
        actions = actionValidation.valid;
        rejectedActions = actionValidation.rejected;
        if (rejectedActions.length > 0) {
          log.warn('Handoff actions rejected by validation', { issueKey: attempt.issue_key, rejected: rejectedActions });
          logEvent(attempt.id, 'handoff_actions_rejected', { rejected: rejectedActions });
        }
      } catch (err) {
        // Fail-open: validation errors must not block the completion flow
        log.debug('Handoff action validation failed (using unvalidated actions)', { issueKey: attempt.issue_key, error: (err as Error).message });
      }

      // RYA-1206: journal the actions to disk BEFORE any completion side effects.
      // An auto-deploy restart can kill this process anywhere in the sequence
      // below — after the content-hash claim above, a restarted monitor takes
      // the dedup early-exit and would never execute these actions. Un-acked
      // entries are replayed on startup (replayPendingHandoffActions). The
      // reviewer half is journaled too: any non-follow-up completion heading
      // to In Review may auto-dispatch a reviewer.
      const hasReplayableActions =
        actions.dispatches.length > 0 || !!actions.delegate || !!actions.parentStatus
        || (!isFollowUp && (actions.statusIntent?.status || 'in-review') === 'in-review');
      if (hasReplayableActions) {
        try {
          journalPendingActions({
            version: 1,
            attemptId: attempt.id,
            issueKey: attempt.issue_key,
            issueId: attempt.issue_id,
            agentType: attempt.agent_type,
            isFollowUp,
            actions,
            handoff,
            createdAt: Date.now(),
          });
        } catch (err) {
          // Fail-open: journaling is a safety net, never a completion blocker
          log.warn('Failed to journal pending handoff actions', { issueKey: attempt.issue_key, error: (err as Error).message });
        }
      }

      // Secondary dedup: check if Linear already has this content as a comment
      const alreadyPosted = await isHandoffAlreadyPosted(attempt.issue_id, handoff);
      if (alreadyPosted) {
        log.debug('Skipping duplicate HANDOFF (already in Linear comments)', { issueKey: attempt.issue_key, attempt: attempt.attempt_number });
        updateAttemptStatus(attempt.id, 'completed');
        logEvent(attempt.id, 'completed', { hasHandoff: true, deduplicated: true });
        // RYA-1207: drop the entry journaled above. The content already being
        // in Linear means a prior attempt's completion flow executed (or
        // journaled) these same actions — a phantom entry left here would
        // replay them on next startup for an attempt that never ran them.
        ackPendingActions(attempt.id);
        // Dismiss the Linear AgentSession so "Working" indicator clears
        if (attempt.agent_session_id) {
          const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
          try { await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} completed.`); } catch (err) { log.error('Failed to dismiss agent session', { issueKey: attempt.issue_key, error: (err as Error).message }); }
        }
        continue;
      }
      log.info(isFollowUp ? 'Follow-up answered' : 'Task completed', { issueKey: attempt.issue_key, attempt: attempt.attempt_number });

      // Use the agent's own token so state changes show their name
      const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;

      // Deferred from the validation block above (RYA-1207): post the
      // rejected-actions comment only now that the journal entry is on disk.
      if (rejectedActions.length > 0) {
        try {
          await addComment(
            attempt.issue_id,
            `⚠️ Handoff actions rejected by validation:\n${formatRejectedActions(rejectedActions)}`,
            agentTok,
          );
        } catch (err) { log.debug('Failed to post rejected-actions comment', { issueKey: attempt.issue_key, error: (err as Error).message }); }
      }

      // For follow-ups: post HANDOFF.md content as a threaded reply under the user's comment
      if (isFollowUp) {
        const meta = followUpMeta.get(attempt.id)!;
        followUpMeta.delete(attempt.id);

        // Guard: don't post hollow responses — these aren't real answers
        const trimmed = handoff.trim()
          .replace(/^#.*\n*/gm, '')           // strip markdown headers
          .replace(/^---+\n*/gm, '')          // strip horizontal rules
          .replace(/^(Agent|Status|Date|Issue|Summary|Files Changed|Verification|Memory Updated|Remaining Issues):.*\n*/gim, '') // strip template labels
          .replace(/^\[.*?\]\s*\n*/gm, '')    // strip template placeholders like [1-3 sentences]
          .replace(/^[-•]\s*\n*/gm, '')       // strip empty bullets
          .trim();
        const isHollow =
          // Exact hollow phrases
          /^(done\.?|completed\.?|n\/a\.?|no further action\.?|task completed\.?|already (done|completed|addressed)\.?|no changes (needed|required)\.?|nothing to do\.?)$/i.test(trimmed) ||
          // Too short to be substantive (under 30 chars after stripping)
          trimmed.length < 30;
        if (isHollow) {
          log.warn('Suppressed hollow follow-up reply', { issueKey: attempt.issue_key, preview: trimmed.substring(0, 50) });
        } else {
          // Post to Linear as threaded reply (if commentId is present)
          if (meta.commentId) {
            try {
              await addComment(attempt.issue_id, handoff, agentTok, meta.commentId);
              log.info('Posted threaded reply', { issueKey: attempt.issue_key });
            } catch (err) {
              log.warn('Threaded reply failed, posting top-level', { error: (err as Error).message });
              try { await addComment(attempt.issue_id, handoff, agentTok); } catch (err2) { log.error('Fallback comment also failed', { issueKey: attempt.issue_key, error: (err2 as Error).message }); }
            }
          }

          // Reply in Discord (if follow-up was triggered from Discord)
          if (meta.discordChannelId) {
            try {
              const sent = await sendDiscordReply(
                meta.discordChannelId,
                trimmed.substring(0, 1900),
                attempt.agent_type,
                meta.discordMessageId,
              );
              if (sent) {
                log.info('Replied in Discord', { issueKey: attempt.issue_key });
              } else {
                log.warn('Discord reply failed', { issueKey: attempt.issue_key });
              }
            } catch (err) {
              log.warn('Discord reply error', { error: (err as Error).message });
            }
          }
        }
      } else {
        // B.4: when the task came from Discord, the source reply below covers it —
        // posting the near-identical group-chat notification too was the CEO's
        // "duplicate spam" complaint. Group-chat post only for non-Discord tasks.
        const discordCtx = discordSourceContext.get(attempt.issue_key);
        // Normal task: system-level completion notification with HANDOFF.md summary
        if (!discordCtx) try {
          let issueTitle = attempt.issue_key;
          try {
            const issueInfo = await getIssue(attempt.issue_key);
            issueTitle = issueInfo.title;
          } catch (err) { log.error('Failed to fetch issue title', { issueKey: attempt.issue_key, error: (err as Error).message }); }

          // Build clean Discord completion message with doc links
          const docBaseUrl = `http://${getConfig().imacHost}:3848/docs`;
          let summary = '';

          // Extract summary section from HANDOFF.md
          const summaryMatch = handoff.match(/## Summary\n([\s\S]*?)(?=\n## |\n---|$)/);
          if (summaryMatch) {
            summary = summaryMatch[1].trim().substring(0, 300);
          } else {
            const lines = handoff.split('\n').filter(l => {
              const t = l.trim();
              return t && !t.startsWith('#') && !t.startsWith('---') && !/^(status_intent|reason|dispatches|delegate|parent_status):/i.test(t);
            });
            summary = lines.slice(0, 2).join(' ').substring(0, 300) || 'Task completed.';
          }

          // Find deliverable file paths and convert to clickable links
          const homeDir = process.env.HOME || '';
          const homeDirPattern = homeDir ? `(?:${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/|~\\/)` : '(?:~\\/)';
          const fileRefs = handoff.match(new RegExp(`(?:${homeDirPattern})[^\\s,)]+\\.md`, 'g')) || [];
          const docLinks = fileRefs.slice(0, 3).map(p => {
            const relative = homeDir ? p.replace(new RegExp(`^${homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`), '').replace(/^~\//, '') : p.replace(/^~\//, '');
            const name = p.split('/').pop()!.replace('.md', '');
            return `• [${name}](${docBaseUrl}/${relative})`;
          }).join('\n');

          const msg = [
            `✅ **${attempt.issue_key}**: ${issueTitle}`,
            ``,
            summary,
            docLinks ? `\n${docLinks}` : '',
          ].filter(Boolean).join('\n');

          await postToGroupChat(attempt.agent_type, msg);
        } catch (err) { log.error('Failed to post Discord completion', { issueKey: attempt.issue_key, error: (err as Error).message }); }

        // Reply to original Discord message (if task was triggered from Discord)
        if (discordCtx) {
          discordSourceContext.delete(attempt.issue_key);
          // Only reply if context isn't stale (within TTL)
          if (Date.now() - discordCtx.createdAt < DISCORD_SOURCE_TTL_MS) {
            try {
              // B.4: one tight, human-readable line — details live in Linear.
              const summaryMatch = handoff.match(/## Summary\n([\s\S]*?)(?=\n## |\n---|$)/);
              const firstSentence = summaryMatch
                ? summaryMatch[1].trim().split(/\n/)[0].substring(0, 300)
                : '';
              const replyText = firstSentence
                ? `✅ **${attempt.issue_key}** 完成 — ${firstSentence}`
                : `✅ **${attempt.issue_key}** 完成`;
              const sent = await sendDiscordReply(
                discordCtx.channelId,
                replyText,
                attempt.agent_type,
                discordCtx.messageId,
              );
              if (sent) {
                log.info('Replied to Discord source', { issueKey: attempt.issue_key });
              } else {
                log.warn('Discord source reply failed', { issueKey: attempt.issue_key });
              }
            } catch (err) {
              log.warn('Discord source reply error', { error: (err as Error).message });
            }
          }
        }

        // Create document FIRST so we can link it in the comment
        let handoffDocUrl: string | null = null;
        if (!isFollowUp) {
          handoffDocUrl = await createIssueDocument(attempt.issue_id, `Handoff #${attempt.attempt_number}`, handoff, agentTok);
        }

        // Post a short summary comment (not the full HANDOFF) + link to document
        {
          const summary = generateHandoffSummary(handoff, 500);
          let commentBody = `**Completed** — ${summary}`;
          if (handoffDocUrl) {
            commentBody += `\n\n📄 [Full handoff](${handoffDocUrl})`;
            await createIssueAttachment(
              attempt.issue_id, handoffDocUrl,
              `📄 Handoff #${attempt.attempt_number}`,
              `${attempt.agent_type} — task handoff`,
              agentTok,
            );
          }
          try {
            await addComment(attempt.issue_id, commentBody, agentTok);
            log.info('Posted handoff summary', { issueKey: attempt.issue_key });
          } catch (err) {
            log.error('Failed to post handoff summary', { issueKey: attempt.issue_key, error: (err as Error).message });
          }
        }
      }

      // Run infrastructure evals asynchronously (fire-and-forget — posts warning if they fail)
      if (!isFollowUp) {
        runEvalsAsync(attempt.issue_id, attempt.issue_key, agentTok);
      }

      updateAttemptStatus(attempt.id, 'completed');
      const durationMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      const durationMin = Math.round(durationMs / 60_000);
      logEvent(attempt.id, 'completed', { hasHandoff: true, isFollowUp, durationMin });
      log.debug('Session duration', { durationMin, role: attempt.agent_type, issueKey: attempt.issue_key });

      if (attempt.agent_session_id) {
        // Use dismissAgentSession for all paths — it posts a terminal 'response' activity
        // and tracks the session ID to prevent duplicate dismissals (via globalDismissedSessions).
        const summary = generateHandoffSummary(handoff);
        try {
          await dismissAgentSession(attempt.agent_session_id, agentTok, summary);
        } catch (err) {
          log.error('Failed to dismiss session', { issueKey: attempt.issue_key, error: (err as Error).message });
        }
      }
      // Close ALL remaining agent sessions for this issue (catches orphaned/duplicate sessions
      // that weren't tracked in the attempt record — prevents stuck "Working" indicators)
      if (agentTok) {
        closeActiveSessionsForIssue(attempt.issue_key, agentTok, 'Task completed').catch(() => {});
      }
      // Structured actions were parsed + validated + journaled above (RYA-1206),
      // before any side effects — `actions` is already the validated set here.

      // Determine target status — agent intent first, then heuristic fallback
      // A2.3: when the grader bounces, the status update is skipped (issue stays
      // In Progress) and the builder is re-dispatched with the critique.
      let graderBounced = false;
      try {
        const currentIssue = await getIssue(attempt.issue_key);
        if (currentIssue.state !== 'Done') {
          const intent = actions.statusIntent;

          // A2.3: headless grading at the status-transition point.
          const gMode = graderMode();
          if (gMode !== 'off') {
            try {
              const trivial = shouldSkipReview(currentIssue.title, handoff);
              const effectiveStatus = intent
                ? intent.status
                : (hasActiveHandoff(attempt.issue_key, attempt.id)
                  ? 'in-progress'
                  : (trivial ? 'done' : 'in-review'));
              if (shouldGradeIssue({ effectiveStatus, trivial, labels: currentIssue.labels || [], isFollowUp })) {
                if (gMode === 'shadow') {
                  // Shadow: grade + record only, fire-and-forget — no flow changes.
                  gradeAttempt({ attempt, handoff, issue: currentIssue })
                    .then(g => log.info('Grader (shadow)', { issueKey: attempt.issue_key, verdict: g.verdict, score: g.score }))
                    .catch(err => log.debug('Shadow grading failed', { issueKey: attempt.issue_key, error: (err as Error).message }));
                } else {
                  // Enforce: grade synchronously; on fail consume the bounce budget.
                  const grade = await gradeAttempt({ attempt, handoff, issue: currentIssue });
                  if (gradeFails(grade)) {
                    if (takeGraderBounce(attempt.issue_key)) {
                      graderBounced = true;
                      log.warn('Grader bounce — keeping issue In Progress', { issueKey: attempt.issue_key, verdict: grade.verdict, score: grade.score });
                      logEvent(attempt.id, 'grader_bounce', { verdict: grade.verdict, score: grade.score });
                      try {
                        await addComment(
                          attempt.issue_id,
                          `🔍 **Grader rejected completion** (score: ${grade.score ?? 'n/a'}/10). Keeping the issue In Progress and re-dispatching ${attempt.agent_type}.\n\n${grade.critique}`,
                          agentTok,
                        );
                      } catch (err) { log.debug('Grader bounce comment failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
                      try {
                        await handleDispatch({
                          role: attempt.agent_type,
                          issueKey: attempt.issue_key,
                          message: `The completion grader rejected your previous handoff (score: ${grade.score ?? 'n/a'}/10). Address this critique, then complete the issue again with a fresh HANDOFF.md:\n\n${grade.critique}`,
                          from: 'monitor:grader',
                          skipCompletionCheck: true,
                        });
                      } catch (err) { log.warn('Grader re-dispatch failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
                    } else {
                      // Bounce budget exhausted — proceed, but record the critique.
                      log.warn('Grader fail with exhausted bounce budget — proceeding', { issueKey: attempt.issue_key, score: grade.score });
                      try {
                        await addComment(
                          attempt.issue_id,
                          `🔍 **Grader critique** (bounce budget exhausted — proceeding to review):\n\n${grade.critique}`,
                          agentTok,
                        );
                      } catch (err) { log.debug('Grader critique comment failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
                    }
                  }
                }
              }
            } catch (err) {
              // Fail-open: grading errors must never block status transitions
              log.debug('Grader integration failed (fail-open)', { issueKey: attempt.issue_key, error: (err as Error).message });
            }
          }

          if (graderBounced) {
            log.info('Issue status unchanged (grader bounce)', { issueKey: attempt.issue_key });
          } else if (intent) {
            log.debug('Status intent received', { role: attempt.agent_type, status: intent.status, reason: intent.reason });
            const intentToState: Record<string, string | null> = {
              'done': WORKFLOW_STATES.DONE,
              'in-review': WORKFLOW_STATES.IN_REVIEW,
              'in-progress': null,
              'todo': WORKFLOW_STATES.TODO,
              'no-change': null,
            };
            const targetState = intentToState[intent.status];
            if (targetState) {
              await updateIssueState(attempt.issue_id, targetState, agentTok);
              log.info('Issue status updated', { issueKey: attempt.issue_key, targetState, intent: intent.status });
            } else {
              log.debug('Issue status unchanged', { issueKey: attempt.issue_key, intent: intent.status });
            }
          } else {
            if (hasActiveHandoff(attempt.issue_key, attempt.id)) {
              log.debug('Keeping issue In Progress, handoff to another agent active', { issueKey: attempt.issue_key });
            } else if (shouldSkipReview(currentIssue.title, handoff)) {
              await updateIssueState(attempt.issue_id, WORKFLOW_STATES.DONE, agentTok);
              log.info('Auto-closed issue as Done (trivial, tests pass)', { issueKey: attempt.issue_key });
            } else {
              await updateIssueState(attempt.issue_id, WORKFLOW_STATES.IN_REVIEW, agentTok);
            }
          }
        }
      } catch (err) { log.error('Failed to update issue status', { issueKey: attempt.issue_key, error: (err as Error).message }); }

      // Execute structured actions (dispatches, delegate, parent_status)
      if (actions.dispatches.length > 0 || actions.delegate || actions.parentStatus) {
        try {
          await executeHandoffActions(actions, attempt, agentTok);
        } catch (err) {
          log.warn('Handoff actions failed', { error: (err as Error).message });
        }
        // RYA-1207: mark the executed half immediately — the full ack below
        // waits on the reviewer dispatch (seconds). A crash in that window
        // would otherwise re-run executeHandoffActions on replay, and
        // new_issue dispatches create sub-issues with no idempotency
        // (a second createIssue call mints a duplicate with a fresh key).
        // Recorded even on failure: action errors are logged, not retried,
        // matching the existing ack-on-failure semantics.
        try {
          persistentDedupRecord(`handoff-actions-exec:${attempt.id}:${contentHash}`);
        } catch (err) {
          log.debug('Failed to record exec marker', { issueKey: attempt.issue_key, error: (err as Error).message });
        }
      }

      // Auto-dispatch reviewer if issue is now In Review and has a designated reviewer
      // Skip for follow-ups (conversation mode), for issues already going to Done,
      // and for grader bounces (A2.3 — the issue stays In Progress with the builder)
      let reviewerSettled: Promise<unknown> = Promise.resolve();
      if (!isFollowUp && !graderBounced) {
        const effectiveStatus = actions.statusIntent?.status || 'in-review';
        if (effectiveStatus === 'in-review') {
          reviewerSettled = autoDispatchReviewer(
            attempt.issue_key, attempt.issue_id, '',
            attempt.agent_type, actions, agentTok, handoff,
          ).catch(err => {
            log.debug('autoDispatchReviewer failed', { issueKey: attempt.issue_key, error: (err as Error).message });
          });
        }
      }

      // RYA-1206: ack the pending-actions journal only after every action side
      // effect has been attempted. The reviewer dispatch is fire-and-forget,
      // so the ack chains on it instead of blocking the monitor tick. The
      // persistent marker covers the crash window between execution and ack.
      if (hasReplayableActions) {
        void reviewerSettled.finally(() => {
          try {
            // Marker is scoped to attempt + content so a grader-bounced attempt
            // that completes again with a rewritten HANDOFF still replays.
            persistentDedupRecord(`handoff-actions:${attempt.id}:${contentHash}`);
            ackPendingActions(attempt.id);
          } catch (err) {
            log.debug('Failed to ack pending handoff actions', { issueKey: attempt.issue_key, error: (err as Error).message });
          }
        });
      }

      // Check if this completed issue was blocking other issues — dispatch them if unblocked
      unblockDependents(attempt.issue_key).catch(err => {
        log.debug('unblockDependents failed', { issueKey: attempt.issue_key, error: (err as Error).message });
      });

      // Broadcast completion to active agents on sibling issues (RYA-315)
      const completionSummary = generateHandoffSummary(handoff, 200);
      broadcastCompletion(attempt.issue_key, attempt.agent_type, completionSummary).catch(err => {
        log.debug('broadcastCompletion failed', { issueKey: attempt.issue_key, error: (err as Error).message });
      });

      // A session completed — try waking a hibernated session for the freed slot
      tryWakeHibernatedSession();
      continue;
    }

    // Case 2: BLOCKED.md appeared (read from per-issue state dir — RYA-246)
    if (blocked && !reportedHandoffs.has(`${attempt.id}:blocked`)
        && !persistentDedupCheck(`blocked:${attempt.id}`, 24 * 60 * 60_000)) {
      reportedHandoffs.add(`${attempt.id}:blocked`);
      persistentDedupRecord(`blocked:${attempt.id}`);
      log.error('Agent blocked', { issueKey: attempt.issue_key });

      updateAttemptStatus(attempt.id, 'blocked', blocked.substring(0, 500));
      logEvent(attempt.id, 'failed', { blocked: true });

      const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
      if (attempt.agent_session_id) {
        await emitActivity(attempt.agent_session_id, { type: 'elicitation', body: blocked }, false, agentTok);
        await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} blocked. See BLOCKED.md for details.`);
      }
      continue;
    }

    // Case 2.9 (RYA-1243): /rate-limit-options modal — interactive session-limit
    // dialog. Runs BEFORE Case 3 and before the warmup guard: a session spawned
    // while the fleet is limited shows the modal immediately, and the generic
    // rate-limit path can't recover it (sendKeys pastes text into a select-list
    // that accepts none). While an attempt is parked here we `continue`, which
    // suppresses Case 3/3.5 — including the loop detector that failed 12 stuck
    // sessions overnight on 2026-06-10.
    if (alive && attempt.tmux_session) {
      try {
        const paneTail = capturePane(attempt.tmux_session, 25);
        const modalVisible = isSessionLimitModal(paneTail);
        let slState = sessionLimitWaitMap.get(attempt.id);

        if (modalVisible && !slState) {
          // New detection — park the attempt and dismiss the modal.
          const now = Date.now();
          const resetAtMs = parseSessionLimitResetMs(paneTail, now) ?? now + SESSION_LIMIT_DEFAULT_WAIT_MS;
          slState = { firstSeenMs: now, resetAtMs, lastEnterAtMs: 0, nudgeCount: 0, lastNudgeAtMs: 0 };
          sessionLimitWaitMap.set(attempt.id, slState);
          // Neutralize competing detectors: the parked session is not looping
          // and not inline-rate-limited.
          clearLoopState(attempt.id);
          rateLimitSuspects.delete(attempt.id);
          rateLimitRetryMap.delete(attempt.id);
          log.warn('Session-limit modal detected — selecting "Stop and wait"', {
            issueKey: attempt.issue_key, role: attempt.agent_type,
            resetAt: new Date(resetAtMs).toISOString(),
          });
          logEvent(attempt.id, 'session_limit_wait', { resetAtMs });

          if (attempt.agent_session_id) {
            const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
            await emitActivity(attempt.agent_session_id, {
              type: 'progress',
              body: `Claude session limit hit. Monitor selected "Stop and wait" (never auto-selects paid options) and will send a resume nudge after the stated reset (~${new Date(resetAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}). Session context preserved.`,
            }, false, agentTok);
          }

          // Fleet alert: >2 sessions limited within 10 min → Telegram + Discord.
          const fleet = recordSessionLimitHit(attempt.issue_key, resetAtMs, now);
          if (fleet.shouldAlert) {
            const result = await fireSessionLimitFleetAlert(fleet.count, fleet.latestResetAtMs, currentFleetHitKeys(now));
            log.warn('Session-limit fleet alert fired', { count: fleet.count, telegramOk: result.telegramOk, discordOk: result.discordOk });
          }
        }

        if (slState) {
          const now = Date.now();
          const activelyWorking = ACTIVE_WORK_RE.test(paneTail);
          const action = sessionLimitNextAction(slState, modalVisible, activelyWorking, now);

          if (action === 'dismiss-modal') {
            slState.lastEnterAtMs = now;
            // Re-parse on every sighting — the modal may restate a later reset.
            const reparsed = parseSessionLimitResetMs(paneTail, now);
            if (reparsed) slState.resetAtMs = reparsed;
            try {
              sendEnterKey(attempt.tmux_session);
              log.info('Sent Enter to dismiss session-limit modal', { issueKey: attempt.issue_key });
            } catch (err) {
              log.warn('Failed to dismiss session-limit modal', { issueKey: attempt.issue_key, error: (err as Error).message });
            }
          } else if (action === 'send-resume-nudge') {
            slState.lastNudgeAtMs = now;
            slState.nudgeCount++;
            try {
              sendKeys(attempt.tmux_session, SESSION_LIMIT_RESUME_MESSAGE);
              log.info('Sent session-limit resume nudge', { issueKey: attempt.issue_key, nudgeCount: slState.nudgeCount });
            } catch (err) {
              log.warn('Failed to send session-limit resume nudge', { issueKey: attempt.issue_key, error: (err as Error).message });
            }
          } else if (action === 'recovered') {
            sessionLimitWaitMap.delete(attempt.id);
            log.info('Recovered from session limit', { issueKey: attempt.issue_key, waitedMin: Math.round((now - slState.firstSeenMs) / 60000) });
            logEvent(attempt.id, 'session_limit_recovered', { waitedMs: now - slState.firstSeenMs });
          } else if (action === 'give-up') {
            sessionLimitWaitMap.delete(attempt.id);
            log.warn('Session-limit resume nudges exhausted', { issueKey: attempt.issue_key, nudges: slState.nudgeCount });
            // Modal still up after all nudges → session cannot self-recover.
            // Kill it to prevent the give-up → re-detect → new-wait-state loop.
            if (modalVisible && attempt.tmux_session) {
              log.warn('Session-limit modal persists — force-killing stuck session', {
                issueKey: attempt.issue_key, role: attempt.agent_type, nudges: slState.nudgeCount,
              });
              try { killSession(attempt.tmux_session); } catch (killErr) {
                log.warn('Failed to kill stuck session-limit tmux', { issueKey: attempt.issue_key, error: (killErr as Error).message });
              }
              updateAttemptStatus(attempt.id, 'completed', 'Session-limit timeout — killed after nudges exhausted');
              logEvent(attempt.id, 'session_limit_killed', { nudges: slState.nudgeCount });
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              if (attempt.agent_session_id) {
                await dismissAgentSession(attempt.agent_session_id, agentTok,
                  `Session limit — killed ${attempt.issue_key} after ${slState.nudgeCount} nudges`);
              }
              continue; // skip normal monitoring — attempt is done
            }
          }
          // 'wait' falls through to continue below.

          // Park the attempt for this tick (also right after recovery/give-up —
          // normal monitoring picks it up next tick with fresh pane state).
          continue;
        }
      } catch (err) { log.error('Session-limit modal check failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
    }

    // Case 3: Check for rate limiting in running sessions
    // Guard: skip during warmup — pane still shows issue description/prompt text
    // which may contain "rate limit" keywords as content, not as actual API errors.
    // Use reactivation time if available — reactivated sessions get a fresh grace period.
    if (alive && attempt.tmux_session) {
      const effectiveStartMs = reactivatedAt.get(attempt.id) ?? parseUtcTimestamp(attempt.created_at);
      const rateLimitAgeMs = Date.now() - effectiveStartMs;
      if (rateLimitAgeMs < WARMUP_GRACE_MS) {
        // Skip rate limit check — session is still loading
      } else try {
        // Only check the LAST 5 lines — real API errors appear at the bottom,
        // not in the initial prompt/issue description area higher up.
        const rawOutput = capturePane(attempt.tmux_session, 5);

        // RYA-335: Filter out lines that look like code content being VIEWED
        // (Read tool output, grep results, code blocks). These caused false
        // positives when agents reviewed agentos source code containing
        // rate-limit keywords like 'Rate limited', '429', 'error.*rate'.
        const output = rawOutput.split('\n').filter(line => {
          // Read tool output: "   123→	code" or "  1045→  code"
          if (/^\s*\d+→/.test(line)) return false;
          // Grep/search results with file paths
          if (/^\s*[\w/.-]+\.(ts|js|py|rs|go|md):\d+/.test(line)) return false;
          // Indented code (4+ spaces or tab prefix — typical code blocks)
          if (/^(\s{4,}|\t)/.test(line)) return false;
          // String literals containing rate-limit text (e.g., 'Rate limited' in code)
          if (/['"`].*(?:rate.?limit|429).*['"`]/i.test(line)) return false;
          return true;
        }).join('\n');

        // Use specific patterns that require error context — plain keywords in
        // issue descriptions or code comments should NOT trigger this.
        const isRateLimited =
          /(?:error|failed|err(?:or)?)[:\s].*(?:rate.?limit|429|too many requests|usage.?limit)/i.test(output) ||
          /(?:rate.?limit|429|too many requests|usage.?limit).*(?:error|failed|retry|exceeded|reached)/i.test(output) ||
          /overloaded_error|APIStatusError.*429|RateLimitError|UsageLimitError/i.test(output);
        if (isRateLimited) {
          // RYA-335: Require confirmation — two consecutive detections within 30s.
          // Single false positives from code scrolling won't kill the session.
          const firstSeen = rateLimitSuspects.get(attempt.id);
          if (!firstSeen) {
            rateLimitSuspects.set(attempt.id, Date.now());
            log.debug('Rate limit suspect, need confirmation', { issueKey: attempt.issue_key });
            continue; // Don't kill yet — wait for next cycle to confirm
          }
          if (Date.now() - firstSeen > RATE_LIMIT_CONFIRM_MS) {
            // Stale suspect — reset and require fresh confirmation
            rateLimitSuspects.set(attempt.id, Date.now());
            log.debug('Rate limit suspect reset (stale)', { issueKey: attempt.issue_key });
            continue;
          }
          // Confirmed: seen twice within 30s — this is a real rate limit
          rateLimitSuspects.delete(attempt.id);

          // RYA-443: In-place retry — keep session alive to preserve context.
          // Only kill after exhausting in-place retries.
          const rlRetryState = rateLimitRetryMap.get(attempt.id);
          const now = Date.now();

          if (!rlRetryState) {
            // First confirmed rate limit — start in-place retry tracking
            rateLimitRetryMap.set(attempt.id, { firstSeen: now, lastRetryAt: 0, retryCount: 0 });
            log.warn('Rate limited (confirmed), starting in-place retry', { issueKey: attempt.issue_key, retryDelaySec: RATE_LIMIT_RETRY_DELAY_MS / 1000 });
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await emitActivity(attempt.agent_session_id, {
                type: 'progress',
                body: `Rate limit detected. Will auto-retry in-place every ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s (max ${MAX_RATE_LIMIT_IN_PLACE_RETRIES} retries). Session context preserved.`,
              }, false, agentTok);
            }
            continue;
          }

          // Check if in-place retries are exhausted
          const rlExhausted = rlRetryState.retryCount >= MAX_RATE_LIMIT_IN_PLACE_RETRIES
            || (now - rlRetryState.firstSeen > RATE_LIMIT_RETRY_MAX_DURATION_MS);

          if (!rlExhausted && now - rlRetryState.lastRetryAt >= RATE_LIMIT_RETRY_DELAY_MS) {
            // Time to send a retry message — agent resumes from where it left off
            rlRetryState.lastRetryAt = now;
            rlRetryState.retryCount++;
            try {
              sendKeys(attempt.tmux_session, 'The previous API call was rate limited. The rate limit should have cleared by now. Please continue your work from where you left off.');
              log.info('Sent rate limit retry', { issueKey: attempt.issue_key, retryCount: rlRetryState.retryCount });
            } catch (err) {
              log.warn('Failed to send rate limit retry', { issueKey: attempt.issue_key, error: (err as Error).message });
            }
            continue;
          }

          if (!rlExhausted) {
            // Still within retry window, waiting for next retry interval
            continue;
          }

          // In-place retries exhausted — fall through to kill + re-enqueue
          rateLimitRetryMap.delete(attempt.id);
          log.warn('Rate limit in-place retries exhausted, killing session', { issueKey: attempt.issue_key, retries: rlRetryState.retryCount });

          const { killSession } = await import('../core/tmux.js');
          killSession(attempt.tmux_session);
          updateAttemptStatus(attempt.id, 'failed', 'Rate limited');
          logEvent(attempt.id, 'failed', { reason: 'rate_limit' });

          // Dismiss Linear AgentSession to clear "Working" state
          if (attempt.agent_session_id) {
            try {
              const agentTok = attempt.agent_type ? getAgentLinearToken(attempt.agent_type) : null;
              await dismissAgentSession(attempt.agent_session_id, agentTok || undefined, `${attempt.issue_key} rate limited — pausing after ${rlRetryState.retryCount} in-place retries.`);
            } catch (err) { log.error('Failed to dismiss agent session on rate limit', { issueKey: attempt.issue_key, error: (err as Error).message }); }
          }

          const issueAttempts = getAttemptsByIssue(attempt.issue_key);
          const consecutiveFailures = countConsecutiveRateLimitFailures(issueAttempts, attempt.agent_type);

          if (consecutiveFailures >= MAX_RATE_LIMIT_RETRIES) {
            cancelQueuedByRole(attempt.issue_key, attempt.agent_type);
            const rateLimitAgentTok = attempt.agent_type ? (getAgentLinearToken(attempt.agent_type) || undefined) : undefined;
            try {
              await addLabelToIssue(attempt.issue_id, AGENT_LABELS.BLOCKED, rateLimitAgentTok);
            } catch (err) { log.error('Failed to add blocked label', { issueKey: attempt.issue_key, error: (err as Error).message }); }

            const recentBodies = await getRecentCommentBodies(attempt.issue_id, 10);
            if (!recentBodies.some((body) => body.includes(RATE_LIMIT_ESCALATION_MARKER))) {
              await addComment(
                attempt.issue_id,
                `**Automatic retries paused**\n\n${RATE_LIMIT_ESCALATION_MARKER} ` +
                `${attempt.issue_key} hit provider rate limits ${consecutiveFailures} times in a row. ` +
                `The issue is marked as blocked. Remove the \`agent:blocked\` label to retry.`,
                rateLimitAgentTok,
              );
            }
            continue;
          }

          const backoffMs = getRateLimitBackoffMs(consecutiveFailures);
          const followUpPrompt = reactivationContext.get(attempt.id);
          enqueue({
            id: randomUUID(),
            issue_id: attempt.issue_id,
            issue_key: attempt.issue_key,
            agent_role: attempt.agent_type,
            agent_session_id: attempt.agent_session_id ?? undefined,
            follow_up_prompt: followUpPrompt,
            delay_until: new Date(Date.now() + backoffMs).toISOString(),
          });
          // Clean up reactivation state for this attempt
          reactivatedAt.delete(attempt.id);
          reactivationContext.delete(attempt.id);
          setCooldown(backoffMs, attempt.agent_type);
          continue;
        } else {
          // Not rate-limited this cycle — clear any pending suspect and retry state
          rateLimitSuspects.delete(attempt.id);
          if (rateLimitRetryMap.has(attempt.id)) {
            log.info('Recovered from rate limit', { issueKey: attempt.issue_key });
            rateLimitRetryMap.delete(attempt.id);
          }
        }
      } catch (err) { log.error('Rate limit check failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
    }

    // Case 3.5: Session alive — detect idle prompt or errors.
    // Interactive session architecture: idle sessions transition to 'idle' status
    // (NOT 'completed') — they stay alive in tmux and can be reactivated when
    // new messages arrive. We dismiss the Linear AgentSession to clear "Working".
    if (alive && !handoff && !blocked && attempt.tmux_session) {
      // Warm-up grace period: new sessions need time to load CLAUDE.md, read context, and plan.
      // Skip idle detection entirely until the session has been alive for WARMUP_GRACE_MS.
      // Use reactivation time if available — reactivated sessions get a fresh grace period
      // to prevent the monitor from immediately re-idling a just-reactivated session.
      const effectiveStartMs = reactivatedAt.get(attempt.id) ?? parseUtcTimestamp(attempt.created_at);
      const sessionAgeMs = Date.now() - effectiveStartMs;
      // During warmup, error detection still runs (a session that crashes in its
      // first 2 minutes must be visible) — only idle/stuck-prompt transitions are
      // suppressed, since fresh sessions legitimately sit at prompts while loading.
      const inWarmup = sessionAgeMs < WARMUP_GRACE_MS;

      try {
        const output = capturePane(attempt.tmux_session, 10);
        const idleKey = `idle:${attempt.id}`;

        // Detect API errors in pane output — use specific patterns to avoid
        // false positives from issue descriptions containing error keywords
        const errorMatch = output.match(/API Error: (\d+).*?({.*?})/s)
          || output.match(/(?:error|failed)[:\s].*(rate.?limit|429|too many requests)/i)
          || output.match(/(overloaded_error|APIStatusError|RateLimitError)/i);

        // RYA-1258: detect "inaccessible model" boot error — claude exits at startup with
        // "There is an issue with the selected model ... It may not exist or you may not
        // have access to it." This is NOT a transient error; respawn with fallback model.
        const isBadModelError = isBadModelOutput(output);

        // Classify error: transient (500, 503, overloaded) vs non-transient (rate limit, auth)
        const isTransientApiError = errorMatch && isTransientApiErrorOutput(output);

        // Detect active work signals (subagents, thinking, streaming)
        const isActivelyWorking = ACTIVE_WORK_RE.test(output);

        // If agent is actively working again, clear any retry tracking
        if (isActivelyWorking) {
          if (transientRetryMap.has(attempt.id)) {
            log.info('Recovered from transient error', { issueKey: attempt.issue_key });
            transientRetryMap.delete(attempt.id);
          }
          if (rateLimitRetryMap.has(attempt.id)) {
            log.info('Recovered from rate limit (active work detected)', { issueKey: attempt.issue_key });
            rateLimitRetryMap.delete(attempt.id);
          }
        }

        // A4.3: loop detection — reuses the SAME captured output above (no second
        // capture). Identical pane hash for AOS_LOOP_THRESHOLD consecutive ticks
        // while actively working → one nudge; another threshold-worth → fail.
        try {
          const loopAction = trackPaneOutput(attempt.id, output, isActivelyWorking);
          if (loopAction === 'nudge') {
            log.warn('Loop suspected — nudging agent', { issueKey: attempt.issue_key, role: attempt.agent_type });
            logEvent(attempt.id, 'loop_nudge', {});
            try {
              sendKeys(attempt.tmux_session, LOOP_NUDGE_MESSAGE);
            } catch (err) { log.warn('Loop nudge sendKeys failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
          } else if (loopAction === 'fail') {
            log.error('Loop persisted after nudge — failing attempt', { issueKey: attempt.issue_key, role: attempt.agent_type });
            updateAttemptStatus(attempt.id, 'failed', 'Loop detected: identical pane output persisted after nudge');
            logEvent(attempt.id, 'failed', { reason: 'loop_detected' });
            clearLoopState(attempt.id);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              try {
                await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} failed — agent appeared stuck repeating the same operation.`);
              } catch (err) { log.error('Failed to dismiss looping session', { issueKey: attempt.issue_key, error: (err as Error).message }); }
            }
            continue;
          }
        } catch (err) { log.debug('Loop detection failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }

        // Detect idle prompt (❯ with nothing after it) — but NOT if actively working
        const isIdlePrompt = !isActivelyWorking && /^[❯>]\s*$/m.test(output);

        // Detect permission/interactive prompts (stuck waiting for user input)
        const isStuckAtPrompt = !isActivelyWorking && /Do you want to|Yes, allow all|Esc to cancel|❯ \d+\./m.test(output);

        // Restart-resistant idle detection: if session age already exceeds
        // WARMUP + IDLE threshold, we can transition to idle immediately on
        // first detection instead of waiting for an in-memory timer.
        // This prevents auto-deploy restart storms from blocking idle cleanup.
        // Follow-up sessions use shorter idle threshold for faster "Working" dismissal.
        const baseIdleMs = followUpMeta.has(attempt.id) ? FOLLOW_UP_IDLE_DISMISS_MS : IDLE_DISMISS_MS;
        const alreadyMature = sessionAgeMs > (WARMUP_GRACE_MS + baseIdleMs);

        if (isTransientApiError && !dismissedSessions.has(attempt.id)) {
          // Transient API error (500/503/overloaded) — retry in-place instead of failing.
          // The agent's tmux session stays alive, preserving full context.
          const retryState = transientRetryMap.get(attempt.id);
          const now = Date.now();

          if (!retryState) {
            // First detection — start tracking
            transientRetryMap.set(attempt.id, { firstSeen: now, lastRetryAt: 0, retryCount: 0 });
            const errorDetail = errorMatch![0].substring(0, 200);
            log.warn('Transient API error, will retry', { issueKey: attempt.issue_key, retryDelaySec: TRANSIENT_RETRY_DELAY_MS / 1000, maxDurationHrs: TRANSIENT_RETRY_MAX_DURATION_MS / 3600000, error: errorDetail.substring(0, 80) });
            // Post a single informational comment (not an error dismissal)
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await emitActivity(attempt.agent_session_id, {
                type: 'progress',
                body: `Transient API error detected (Anthropic 500/503). Will automatically retry every ~${TRANSIENT_RETRY_DELAY_MS / 1000}s for up to ${TRANSIENT_RETRY_MAX_DURATION_MS / 3600000}h.\n\`${errorDetail.substring(0, 120)}\``,
              }, false, agentTok);
            }
          } else if (now - retryState.firstSeen > TRANSIENT_RETRY_MAX_DURATION_MS) {
            // Exceeded max retry duration — give up, fail normally
            transientRetryMap.delete(attempt.id);
            dismissedSessions.add(attempt.id);
            const errorDetail = errorMatch![0].substring(0, 200);
            log.error('Transient retry exhausted', { issueKey: attempt.issue_key, retryCount: retryState.retryCount, elapsedMin: Math.round((now - retryState.firstSeen) / 60000) });
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await emitActivity(attempt.agent_session_id, {
                type: 'error',
                body: `Transient API error persisted for ${Math.round((now - retryState.firstSeen) / 60000)}min (${retryState.retryCount} retries). Giving up.\n${errorDetail}`,
              }, false, agentTok);
              await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} transient error retry exhausted.`);
            }
            updateAttemptStatus(attempt.id, 'failed', `Transient error retry exhausted after ${retryState.retryCount} retries`);
            idleTimers.delete(idleKey);
          } else if (now - retryState.lastRetryAt >= TRANSIENT_RETRY_DELAY_MS) {
            // Time to retry — send a resume message to the tmux session
            retryState.lastRetryAt = now;
            retryState.retryCount++;
            try {
              sendKeys(attempt.tmux_session, 'The previous API call failed with a transient error (Anthropic 500/503). Please continue your work from where you left off.');
              log.info('Sent transient retry', { issueKey: attempt.issue_key, retryCount: retryState.retryCount, elapsedMin: Math.round((now - retryState.firstSeen) / 60000) });
            } catch (err) {
              log.warn('Failed to send retry', { issueKey: attempt.issue_key, error: (err as Error).message });
            }
          }
          // Skip idle detection while retrying transient errors
        } else if (isBadModelError && !badModelRespawned.has(attempt.id) && !dismissedSessions.has(attempt.id)) {
          // RYA-1258: inaccessible model at boot — kill zombie and respawn with fallback.
          // Only attempt one respawn per session to prevent loops.
          badModelRespawned.add(attempt.id);
          dismissedSessions.add(attempt.id);
          log.warn('Inaccessible model error detected — respawning with fallback model', {
            issueKey: attempt.issue_key, role: attempt.agent_type,
          });
          logEvent(attempt.id, 'failed', { reason: 'inaccessible_model' });
          updateAttemptStatus(attempt.id, 'failed', 'Inaccessible model at boot — respawning with fallback');
          idleTimers.delete(idleKey);
          try { killSession(attempt.tmux_session); } catch (err) { log.debug('Bad-model session kill failed (already dead)', { issueKey: attempt.issue_key, error: (err as Error).message }); }
          const fallbackModel = process.env.AOS_FALLBACK_CLAUDE_MODEL ?? 'claude-sonnet-4-6';
          void agentStartCommand(attempt.agent_type, attempt.issue_key, { claudeModel: fallbackModel })
            .catch(err => log.error('Bad-model respawn failed', { issueKey: attempt.issue_key, error: (err as Error).message }));
        } else if (errorMatch && !isTransientApiError && !dismissedSessions.has(attempt.id)) {
          // Non-transient error (rate limit, auth, etc.) — fail immediately as before
          dismissedSessions.add(attempt.id);
          const errorDetail = errorMatch[0].substring(0, 200);
          log.warn('Error detected in session', { issueKey: attempt.issue_key, role: attempt.agent_type, error: errorDetail.substring(0, 80) });

          if (attempt.agent_session_id) {
            const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
            await emitActivity(attempt.agent_session_id, {
              type: 'error',
              body: `Agent encountered an error:\n${errorDetail}`,
            }, false, agentTok);
            await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} encountered an error.`);
          }
          // Mark attempt done but DON'T kill tmux — context preserved
          updateAttemptStatus(attempt.id, 'failed', `Error: ${errorDetail.substring(0, 100)}`);
          idleTimers.delete(idleKey);
        } else if (inWarmup) {
          // Warm-up: session is still loading context — suppress idle/ambiguous
          // transitions entirely. Error detection above already ran.
        } else if (isIdlePrompt || isStuckAtPrompt) {
          // Agent at idle prompt or stuck at permission prompt — accumulate timer.
          // After IDLE_DISMISS_MS, dismiss Linear AgentSession to stop "Working" indicator,
          // but keep tmux alive so context is preserved for resume.
          // Follow-up conversations use a shorter timeout (FOLLOW_UP_IDLE_DISMISS_MS)
          // since they finish quickly and shouldn't show "Working" for 5 min after replying.
          const isFollowUpSession = followUpMeta.has(attempt.id);
          const effectiveIdleMs = isFollowUpSession ? FOLLOW_UP_IDLE_DISMISS_MS : IDLE_DISMISS_MS;
          const idleStart = idleTimers.get(idleKey);
          if (alreadyMature && !dismissedSessions.has(attempt.id)) {
            // Session is old enough — transition to idle immediately
            dismissedSessions.add(attempt.id);
            const reason = isStuckAtPrompt ? 'Stuck at permission prompt' : 'Idle at prompt';
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason });
            log.debug('Session idle, awaiting reactivation', { issueKey: attempt.issue_key, role: attempt.agent_type, reason });
            idleTimers.delete(idleKey);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              const dismissMsg = isStuckAtPrompt
                ? 'Agent paused — waiting for permission prompt. Resume with a follow-up comment.'
                : 'Idle — send a comment to reactivate.';
              await dismissAgentSession(attempt.agent_session_id, agentTok, dismissMsg);
            }
          } else if (!idleStart) {
            idleTimers.set(idleKey, Date.now());
            if (isStuckAtPrompt) {
              log.debug('Stuck at prompt, starting idle timer', { issueKey: attempt.issue_key, role: attempt.agent_type });
            }
          } else if (Date.now() - idleStart > effectiveIdleMs && !dismissedSessions.has(attempt.id)) {
            dismissedSessions.add(attempt.id);
            const reason = isStuckAtPrompt ? 'Stuck at permission prompt' : (isFollowUpSession ? 'Follow-up idle at prompt' : 'Idle at prompt');
            // Transition to 'idle' — NOT 'completed'. Session stays alive for reactivation.
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason });
            log.debug('Session idle, awaiting reactivation', { issueKey: attempt.issue_key, role: attempt.agent_type, reason, isFollowUp: isFollowUpSession });
            idleTimers.delete(idleKey);
            // Dismiss Linear AgentSession to clear "Working" indicator
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              const dismissMsg = isStuckAtPrompt
                ? 'Agent paused — waiting for permission prompt. Resume with a follow-up comment.'
                : 'Idle — send a comment to reactivate.';
              await dismissAgentSession(attempt.agent_session_id, agentTok, dismissMsg);
            }
          }
        } else if (isActivelyWorking) {
          // Agent actively working — reset idle timer, clear dismissed flag if re-activated
          idleTimers.delete(idleKey);
          dismissedSessions.delete(attempt.id);
        } else {
          // Ambiguous state: not idle, not error, not actively working, not at a known prompt.
          // Don't reset idle timer — let it accumulate. After effectiveIdleMs, dismiss.
          // Same restart-resistant logic: if session is old enough, transition immediately.
          // Follow-up sessions use shorter timeout (same as idle prompt detection above).
          const isFollowUpSession = followUpMeta.has(attempt.id);
          const effectiveIdleMs = isFollowUpSession ? FOLLOW_UP_IDLE_DISMISS_MS : IDLE_DISMISS_MS;
          const idleStart = idleTimers.get(idleKey);
          if (alreadyMature && !dismissedSessions.has(attempt.id)) {
            dismissedSessions.add(attempt.id);
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason: 'no_activity' });
            log.debug('No activity, session idle', { issueKey: attempt.issue_key, role: attempt.agent_type });
            idleTimers.delete(idleKey);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await dismissAgentSession(attempt.agent_session_id, agentTok, 'Idle — send a comment to reactivate.');
            }
          } else if (!idleStart) {
            idleTimers.set(idleKey, Date.now());
          } else if (Date.now() - idleStart > effectiveIdleMs && !dismissedSessions.has(attempt.id)) {
            dismissedSessions.add(attempt.id);
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason: isFollowUpSession ? 'follow_up_no_activity' : 'no_activity' });
            log.debug('No activity, session idle', { issueKey: attempt.issue_key, role: attempt.agent_type, isFollowUp: isFollowUpSession });
            idleTimers.delete(idleKey);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await dismissAgentSession(attempt.agent_session_id, agentTok, 'Idle — send a comment to reactivate.');
            }
          }
        }
      } catch (err) { log.error('Idle detection failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
    }

    // Case 3.6: Stuck session detection — running > 30 min with no Linear comments.
    // Nudge once via tmux; if still stuck after another 30 min, log a warning.
    if (alive && !handoff && !blocked && attempt.tmux_session && !stuckNudged.has(attempt.id)) {
      const sessionAgeMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      if (sessionAgeMs > STUCK_THRESHOLD_MS) {
        try {
          const agentConfig = loadAgentConfig(attempt.agent_type);
          const agentUserId = agentConfig.linearUserId;
          if (agentUserId) {
            const commentCount = await getAgentCommentCountSince(attempt.issue_id, agentUserId, attempt.created_at);
            if (commentCount === 0) {
              stuckNudged.add(attempt.id);
              log.warn('Stuck session detected', { issueKey: attempt.issue_key, role: attempt.agent_type, ageMin: Math.round(sessionAgeMs / 60_000) });
              // Nudge via tmux if at prompt
              try {
                const output = capturePane(attempt.tmux_session, 5);
                if (/^[❯>]\s*$/m.test(output)) {
                  sendKeys(attempt.tmux_session, `[SYSTEM] You have been working for ${Math.round(sessionAgeMs / 60_000)} minutes without posting any progress comments. Post a brief status update on the Linear issue, then continue your work.`);
                }
              } catch (err) { log.error('Failed to nudge stuck session', { issueKey: attempt.issue_key, error: (err as Error).message }); }
            }
          }
        } catch (err) { log.error('Stuck session check failed', { issueKey: attempt.issue_key, error: (err as Error).message }); }
      }
    }

    // Clean up tracking when session ends
    if (!alive && attempt.tmux_session) {
      trustPromptHandled.delete(attempt.tmux_session);
      idleTimers.delete(`idle:${attempt.id}`);
      dismissedSessions.delete(attempt.id);
      transientRetryMap.delete(attempt.id);
      rateLimitRetryMap.delete(attempt.id);
      rateLimitSuspects.delete(attempt.id);
      clearLoopState(attempt.id);
    }

    // Case 4: Session died without any artifacts — auto-retry with circuit breaker
    if (!alive && !handoff && !blocked) {
      updateAttemptStatus(attempt.id, 'failed', 'Session ended without handoff');
      logEvent(attempt.id, 'failed', { reason: 'no artifacts' });

      if (attempt.agent_session_id) {
        await emitActivity(attempt.agent_session_id, {
          type: 'error',
          body: 'Agent session ended without HANDOFF.md or BLOCKED.md.',
        });
        await dismissAgentSession(attempt.agent_session_id, undefined, `${attempt.issue_key} session ended unexpectedly.`);
      }

      // Verify issue still exists before retrying — deleted issues should not be re-enqueued
      let issueStillExists = true;
      try {
        await getIssue(attempt.issue_key);
      } catch (err) {
        if (isPermanentIssueError(err)) {
          issueStillExists = false;
          log.warn('Skipping retry, issue no longer exists in Linear', { issueKey: attempt.issue_key });
        }
      }

      if (!issueStillExists) continue;

      // RYA-443: Session recovery — read PROGRESS.md from crashed session's state dir
      // to provide context to the re-spawned session about what was already done.
      let recoveryContext: string | undefined;
      try {
        const progressPath = join(getIssueStateDir(attempt.issue_key), 'PROGRESS.md');
        if (existsSync(progressPath)) {
          const progress = readFileSync(progressPath, 'utf-8').trim();
          if (progress.length > 0) {
            recoveryContext = `[RECOVERY] Previous session crashed mid-work. Here is its last progress report:\n\n${progress.substring(0, 2000)}\n\nPlease continue from where the previous session left off. Do not repeat already-completed work.`;
            log.info('Recovered progress context for retry', { issueKey: attempt.issue_key, progressLen: progress.length });
          }
        }
      } catch (err) { log.debug('Could not read PROGRESS.md for recovery', { issueKey: attempt.issue_key, error: (err as Error).message }); }

      // Circuit breaker check (re-check after marking this attempt as failed)
      const cb = checkCircuitBreaker(attempt.issue_key, attempt.agent_type);
      if (cb.allowed) {
        const backoffMs = Math.max(cb.backoffMs, 30_000); // at least 30s
        log.warn('Auto-retrying session', { issueKey: attempt.issue_key, backoffSec: Math.round(backoffMs / 1000), failures: cb.consecutiveFailures + 1, hasRecoveryContext: !!recoveryContext });

        enqueue({
          id: randomUUID(),
          issue_id: attempt.issue_id,
          issue_key: attempt.issue_key,
          agent_role: attempt.agent_type,
          agent_session_id: attempt.agent_session_id ?? undefined,
          follow_up_prompt: recoveryContext || reactivationContext.get(attempt.id),
          delay_until: new Date(Date.now() + backoffMs).toISOString(),
        });
      } else {
        log.error('Circuit breaker tripped', { reason: cb.reason });
        await tripCircuitBreaker(attempt.issue_key, attempt.issue_id, attempt.agent_type, cb.consecutiveFailures);
      }
      // A session failed — try waking a hibernated session for the freed slot
      tryWakeHibernatedSession();
    }

    // Case 5: Follow-up session exceeded TTL — force-kill and dismiss
    if (alive && followUpMeta.has(attempt.id)) {
      const meta = followUpMeta.get(attempt.id)!;
      if (Date.now() - meta.createdAt > FOLLOW_UP_TTL_MS) {
        log.warn('Follow-up TTL exceeded, force-killing', { issueKey: attempt.issue_key });
        killSession(attempt.tmux_session);
        updateAttemptStatus(attempt.id, 'failed', 'Follow-up TTL exceeded');
        logEvent(attempt.id, 'failed', { reason: 'follow_up_ttl' });
        followUpMeta.delete(attempt.id);

        if (attempt.agent_session_id) {
          try {
            const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
            await dismissAgentSession(attempt.agent_session_id, agentTok, `${attempt.issue_key} follow-up timed out.`);
          } catch (err) { log.error('Failed to dismiss follow-up session', { issueKey: attempt.issue_key, error: (err as Error).message }); }
        }
      }
    }
  }

  // A4.3: cost-velocity guard — pause roles burning tokens too fast.
  // Internally throttled to one pass per 5 min; alert fires once per pause.
  try {
    await runCostVelocityChecks(attempts.map(a => a.agent_type));
  } catch (err) { log.debug('Cost velocity checks failed', { error: (err as Error).message }); }

  // Monitor hibernated sessions — detect if their tmux sessions died while frozen
  monitorHibernatedSessions();

  // ─── GC all state maps (exported + monitor-local) ───
  gcStateMaps();
  gcMonitorLocalMaps();
  gcLoopStates();

  // B: reap idle Discord chat sessions (30min TTL)
  try { reapIdleChatSessions(); } catch (err) {
    log.debug('Chat session reap failed', { error: (err as Error).message });
  }

  // RYA-319: Clean up zombie tmux sessions for completed attempts.
  // When monitor marks an attempt as 'completed' (HANDOFF.md detected), the tmux session
  // is kept alive for observation. But these accumulate and waste resources (~500MB each).
  // Kill tmux sessions that have been completed for 2+ minutes.
  try {
    const zombies = getCompletedWithTmux(2);
    for (const z of zombies) {
      if (sessionExists(z.tmux_session)) {
        killSession(z.tmux_session);
        const ts2 = new Date().toLocaleTimeString();
        log.debug('Cleaned up zombie tmux', { issueKey: z.issue_key, role: z.agent_type });
      }
      // Clear tmux_session from the record so we don't check again
      clearAttemptTmuxSession(z.id);
    }
  } catch (err) { log.error('Zombie tmux cleanup failed', { error: (err as Error).message }); }
}
