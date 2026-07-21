/**
 * Circuit breaker: prevent runaway retry loops for failed agent sessions.
 *
 * Checks consecutive failed attempts for an issue (optionally per-agent) within
 * a rolling time window. When the failure threshold is reached, cancels queued
 * entries, posts a Linear comment, and marks the issue as blocked.
 */

import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { getAttemptsByIssue, getBreakerState, bumpBreakerState, clearBreakerState } from '../core/db.js';
import { addComment, getRecentCommentBodies, addLabelToIssue } from '../core/linear.js';
import { getAgentLinearToken } from '../core/persona.js';
import { cancelQueued, enqueue } from '../core/queue.js';
import { AGENT_LABELS } from '../types.js';

/** Default max consecutive failures before circuit breaker trips */
export const DEFAULT_MAX_RETRIES = 3;

/** Only count failures within this rolling window (2 hours) */
export const CIRCUIT_BREAKER_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Base backoff for first retry (60s). Doubles each retry: 60s, 120s, 240s */
export const BASE_BACKOFF_MS = 60_000;

/** Maximum backoff cap (30 minutes) */
export const MAX_BACKOFF_MS = 30 * 60_000;

/** Marker string to prevent duplicate circuit breaker comments */
export const CIRCUIT_BREAKER_MARKER = 'Circuit breaker triggered';

// A1.1: half-open recovery knobs. After a trip, a delayed retry is scheduled
// automatically (cooldown), up to MAX_REOPENS times; only then is the issue
// permanently blocked behind the agent:blocked label. Kill switch: AOS_CB_AUTOREOPEN=0.
export function cbCooldownMs(): number {
  return parseInt(process.env.AOS_CB_COOLDOWN_MS || '', 10) || 45 * 60_000;
}
export function cbMaxReopens(): number {
  const n = parseInt(process.env.AOS_CB_MAX_REOPENS || '', 10);
  return Number.isFinite(n) ? n : 2;
}
export function cbAutoReopenEnabled(): boolean {
  return process.env.AOS_CB_AUTOREOPEN !== '0';
}

export interface CircuitBreakerResult {
  /** Whether the issue is allowed to be retried */
  allowed: boolean;
  /** Number of consecutive recent failures */
  consecutiveFailures: number;
  /** Human-readable reason if not allowed */
  reason?: string;
  /** Suggested backoff before next retry (ms), 0 if no backoff needed */
  backoffMs: number;
  /** A1.1: true when allowed via half-open recovery (cooldown elapsed after a trip) */
  halfOpen?: boolean;
}

/**
 * Check whether an issue has hit its retry limit.
 *
 * Counts consecutive failed attempts (most recent first) within the time window.
 * A successful completion resets the failure chain.
 *
 * @param issueKey - Linear issue identifier (e.g., "RYA-201")
 * @param agentRole - Optional: only count failures for this agent role
 * @param maxRetries - Maximum consecutive failures allowed (default 3)
 */
export function checkCircuitBreaker(
  issueKey: string,
  agentRole?: string,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): CircuitBreakerResult {
  const attempts = getAttemptsByIssue(issueKey); // sorted by attempt_number DESC
  const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;

  let consecutiveFailures = 0;

  for (const attempt of attempts) {
    // Filter by agent role if specified
    if (agentRole && attempt.agent_type !== agentRole) continue;

    // Only count within time window
    const attemptTime = new Date(attempt.created_at.endsWith('Z') ? attempt.created_at : attempt.created_at + 'Z').getTime();
    if (attemptTime < cutoff) break;

    if (attempt.status === 'failed') {
      consecutiveFailures++;
    } else if (attempt.status === 'completed') {
      // A success resets the failure chain
      break;
    } else if (attempt.status === 'idle') {
      // Idle = agent worked but is waiting. Not a failure, not a success.
      // Break the consecutive failure chain — the agent DID run without failing.
      break;
    }
    // 'running', 'pending', 'blocked', 'hibernated' don't break the chain — skip
  }

  if (consecutiveFailures >= maxRetries) {
    // A1.1: half-open recovery — after the cooldown, allow exactly one probe
    // retry per trip, bounded by cbMaxReopens(). The breaker_state row is
    // written by tripCircuitBreaker; reopen_count counts trips beyond the first.
    if (cbAutoReopenEnabled()) {
      const state = getBreakerState(issueKey);
      if (state
          && state.reopen_count < cbMaxReopens()
          && Date.now() - state.tripped_at >= cbCooldownMs()) {
        return {
          allowed: true,
          consecutiveFailures,
          backoffMs: 0,
          halfOpen: true,
        };
      }
    }
    return {
      allowed: false,
      consecutiveFailures,
      reason: `${issueKey} failed ${consecutiveFailures} consecutive times (limit: ${maxRetries})`,
      backoffMs: 0,
    };
  }

  // A success/idle reset the failure chain — clear any stale breaker state so
  // a future trip starts a fresh reopen budget.
  if (consecutiveFailures === 0) {
    try { clearBreakerState(issueKey); } catch (err) {
      console.debug('[circuit-breaker] clearBreakerState failed:', (err as Error).message);
    }
  }

  // Calculate exponential backoff for the next retry
  const backoffMs = consecutiveFailures > 0
    ? Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_MS)
    : 0;

  return {
    allowed: true,
    consecutiveFailures,
    backoffMs,
  };
}

/**
 * Trip the circuit breaker: cancel queued items, post a Linear comment, mark issue as blocked.
 *
 * This is idempotent — checks for an existing circuit breaker comment before posting.
 *
 * @param issueKey - Linear issue identifier
 * @param issueId - Linear issue UUID (for API calls)
 * @param agentRole - The agent that was failing
 * @param failures - Number of consecutive failures
 */
export async function tripCircuitBreaker(
  issueKey: string,
  issueId: string,
  agentRole: string,
  failures: number,
): Promise<void> {
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.red(`[${ts}] Circuit breaker tripped: ${issueKey} (${failures} failures, agent: ${agentRole})`));

  // Cancel all queued entries for this issue
  cancelQueued(issueKey);

  const agentToken = getAgentLinearToken(agentRole) || undefined;

  // A1.1: record the trip and decide between scheduling a half-open retry
  // (auto-recovery, bounded) and permanently blocking (reopen budget exhausted).
  let state;
  try {
    state = bumpBreakerState(issueKey, agentRole, `${failures} consecutive failures`);
  } catch (err) {
    console.debug('[circuit-breaker] bumpBreakerState failed:', (err as Error).message);
  }
  const willAutoRetry = cbAutoReopenEnabled() && !!state && state.reopen_count < cbMaxReopens();

  if (willAutoRetry) {
    const retryAt = new Date(Date.now() + cbCooldownMs());
    enqueue({
      id: randomUUID(),
      issue_id: issueId,
      issue_key: issueKey,
      agent_role: agentRole,
      follow_up_prompt: `Automatic half-open retry after circuit breaker trip (${failures} consecutive failures). Review the previous attempts' errors before retrying the same approach.`,
      delay_until: retryAt.toISOString(),
    });
    console.log(chalk.yellow(`[${ts}] Circuit breaker: half-open retry for ${issueKey} scheduled at ${retryAt.toLocaleTimeString()} (reopen ${state!.reopen_count + 1}/${cbMaxReopens()})`));

    try {
      const recentBodies = await getRecentCommentBodies(issueId, 10);
      const stamp = `auto-retry #${state!.reopen_count + 1}`;
      if (!recentBodies.some(body => body.includes(stamp))) {
        await addComment(
          issueId,
          `**${CIRCUIT_BREAKER_MARKER}** (${stamp})\n\n` +
          `${issueKey} has failed ${failures} consecutive times. An automatic retry is scheduled for ${retryAt.toLocaleTimeString()} ` +
          `(${Math.round(cbCooldownMs() / 60000)} min cooldown, retry ${state!.reopen_count + 1} of ${cbMaxReopens()}).\n\n` +
          `**Last agent:** ${agentRole}\n` +
          `No action needed unless you want to intervene sooner.`,
          agentToken,
        );
      }
    } catch (err) {
      console.log(chalk.dim(`[circuit-breaker] comment failed for ${issueKey}: ${(err as Error).message}`));
    }
    return;
  }

  // Reopen budget exhausted (or auto-reopen disabled) — permanent block.
  try {
    await addLabelToIssue(issueId, AGENT_LABELS.BLOCKED, agentToken);
  } catch (err) {
    console.log(chalk.dim(`[circuit-breaker] label add failed for ${issueKey}: ${(err as Error).message}`));
  }

  // Post comment — but only if we haven't already posted one recently
  try {
    const recentBodies = await getRecentCommentBodies(issueId, 10);
    if (!recentBodies.some(body => body.includes('Automatic retries are paused'))) {
      await addComment(
        issueId,
        `**${CIRCUIT_BREAKER_MARKER}**\n\n` +
        `${issueKey} has failed ${failures} consecutive times` +
        (state && state.reopen_count > 0 ? ` (after ${state.reopen_count} automatic ${state.reopen_count === 1 ? 'retry' : 'retries'})` : '') +
        `. Automatic retries are paused.\n\n` +
        `**Last agent:** ${agentRole}\n` +
        `**Action needed:** Investigate the root cause, then remove the \`agent:blocked\` label to retry.\n` +
        `**To reset:** A successful completion will reset the failure counter.`,
        agentToken,
      );
    }
  } catch (err) {
    console.log(chalk.dim(`[circuit-breaker] comment failed for ${issueKey}: ${(err as Error).message}`));
  }
}
