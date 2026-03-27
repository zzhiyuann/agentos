/**
 * Circuit breaker: prevent runaway retry loops for failed agent sessions.
 *
 * Checks consecutive failed attempts for an issue (optionally per-agent) within
 * a rolling time window. When the failure threshold is reached, cancels queued
 * entries, posts a Linear comment, and moves the issue back to Todo.
 */

import chalk from 'chalk';
import { getAttemptsByIssue } from '../core/db.js';
import { addComment, updateIssueState, getRecentCommentBodies } from '../core/linear.js';
import { cancelQueued } from '../core/queue.js';
import { WORKFLOW_STATES } from '../types.js';

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

export interface CircuitBreakerResult {
  /** Whether the issue is allowed to be retried */
  allowed: boolean;
  /** Number of consecutive recent failures */
  consecutiveFailures: number;
  /** Human-readable reason if not allowed */
  reason?: string;
  /** Suggested backoff before next retry (ms), 0 if no backoff needed */
  backoffMs: number;
}

/**
 * Check whether an issue has hit its retry limit.
 *
 * Counts consecutive failed attempts (most recent first) within the time window.
 * A successful completion resets the failure chain.
 *
 * @param issueKey - Linear issue identifier (e.g., "ENG-201")
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
    return {
      allowed: false,
      consecutiveFailures,
      reason: `${issueKey} failed ${consecutiveFailures} consecutive times (limit: ${maxRetries})`,
      backoffMs: 0,
    };
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
 * Trip the circuit breaker: cancel queued items, post a Linear comment, move issue to Todo.
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

  // Move issue back to Todo for manual intervention
  try {
    await updateIssueState(issueId, WORKFLOW_STATES.TODO);
  } catch { /**/ }

  // Post comment — but only if we haven't already posted one recently
  try {
    const recentBodies = await getRecentCommentBodies(issueId, 10);
    if (!recentBodies.some(body => body.includes(CIRCUIT_BREAKER_MARKER))) {
      await addComment(
        issueId,
        `**${CIRCUIT_BREAKER_MARKER}**\n\n` +
        `${issueKey} has failed ${failures} consecutive times. Automatic retries are paused.\n\n` +
        `**Last agent:** ${agentRole}\n` +
        `**Action needed:** Investigate the root cause, then move back to Todo to retry.\n` +
        `**To reset:** A successful completion will reset the failure counter.`,
      );
    }
  } catch { /**/ }
}
