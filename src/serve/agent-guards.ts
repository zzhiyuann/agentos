/**
 * A4.3: Agent guards — cost-velocity pause and loop detection.
 *
 * (a) Cost velocity: per-role attributed spend over the last rolling hour
 *     (attempt_attributions, last_seen_at window). When a role exceeds
 *     AOS_COST_VELOCITY_USD_PER_HR (default $15/hr), a pause marker is
 *     recorded in dedup_keys (`cost-pause:{role}`, window AOS_COST_PAUSE_MS,
 *     default 1h) and a single group-chat alert is posted. The scheduler
 *     consults isRolePaused() before drainQueue/autoDispatch spawns.
 *
 * (b) Loop detection: the monitor feeds each attempt's captured pane output
 *     (the SAME capture Case 3.5 already made — no second capture) into
 *     trackPaneOutput. An identical pane hash for AOS_LOOP_THRESHOLD
 *     (default 6) consecutive ticks while actively working triggers one
 *     [SYSTEM] nudge; another threshold-worth of identical ticks fails the
 *     attempt (which then flows into the circuit breaker).
 */

import { createHash } from 'crypto';
import { createLogger } from '../core/logger.js';
import { getRoleAttributedCostSince } from '../core/db.js';
import { persistentDedupCheck, persistentDedupRecord } from './state.js';
import { postToGroupChat } from './helpers.js';

const log = createLogger('agent-guards');

// ─── Cost velocity ───────────────────────────────────────────────────────────

/** AOS_COST_VELOCITY_USD_PER_HR, default 100 — high ceiling sized to Fable 5 burn: runaway-loop backstop, not a spend brake (CEO, 2026-07-20). */
export function costVelocityUsdPerHr(): number {
  const n = parseFloat(process.env.AOS_COST_VELOCITY_USD_PER_HR || '');
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** AOS_COST_PAUSE_MS, default 1 hour. */
export function costPauseMs(): number {
  const n = parseInt(process.env.AOS_COST_PAUSE_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60_000;
}

/**
 * Pause-marker storage. Production uses the persistent dedup_keys table
 * (survives serve restarts); tests inject an in-memory store so concurrent
 * suites that GC dedup_keys can't flake them.
 */
export interface PauseStore {
  isPaused: (role: string) => boolean;
  recordPause: (role: string) => void;
}

const defaultPauseStore: PauseStore = {
  // Fail-open: any storage error reads as "not paused" / "not recorded".
  isPaused: (role) => {
    try {
      return persistentDedupCheck(`cost-pause:${role}`, costPauseMs());
    } catch {
      return false;
    }
  },
  recordPause: (role) => {
    try {
      persistentDedupRecord(`cost-pause:${role}`);
    } catch (err) {
      log.debug('Failed to record cost pause', { role, error: (err as Error).message });
    }
  },
};

/** Is the role currently paused by the cost guard? Consumed by the scheduler. */
export function isRolePaused(role: string): boolean {
  return defaultPauseStore.isPaused(role);
}

export type RoleCostFn = (role: string, sinceIso: string) => number;

export interface CostVelocityResult {
  role: string;
  costUsd: number;
  limitUsd: number;
  paused: boolean;
  /** True only on the check that recorded the pause — gates the one-time alert. */
  newlyPaused: boolean;
}

/**
 * Check one role's rolling spend over the last hour against the velocity
 * limit. Records the pause marker when the limit is newly exceeded.
 */
export function checkCostVelocity(
  role: string,
  getCost: RoleCostFn = getRoleAttributedCostSince,
  store: PauseStore = defaultPauseStore,
): CostVelocityResult {
  const limitUsd = costVelocityUsdPerHr();
  const sinceIso = new Date(Date.now() - 60 * 60_000).toISOString();

  let costUsd = 0;
  try {
    costUsd = getCost(role, sinceIso) || 0;
  } catch (err) {
    log.debug('Cost lookup failed (skipping velocity check)', { role, error: (err as Error).message });
    return { role, costUsd: 0, limitUsd, paused: store.isPaused(role), newlyPaused: false };
  }

  if (costUsd <= limitUsd) {
    return { role, costUsd, limitUsd, paused: store.isPaused(role), newlyPaused: false };
  }

  const alreadyPaused = store.isPaused(role);
  if (!alreadyPaused) {
    store.recordPause(role);
  }
  return { role, costUsd, limitUsd, paused: true, newlyPaused: !alreadyPaused };
}

const COST_CHECK_INTERVAL_MS = 5 * 60_000; // re-check at most every 5 min
let lastCostCheckAt = 0;

/** Test-only reset for the internal throttle. */
export function __resetCostCheckThrottleForTests(): void {
  lastCostCheckAt = 0;
}

export type GroupNotifier = (role: string, message: string) => Promise<boolean>;

/**
 * Run the cost-velocity check for the given roles (deduplicated), posting a
 * single group-chat alert per newly-recorded pause. Internally throttled to
 * one pass per 5 minutes — safe to call every monitor tick.
 */
export async function runCostVelocityChecks(
  roles: Iterable<string>,
  getCost: RoleCostFn = getRoleAttributedCostSince,
  notify: GroupNotifier = postToGroupChat,
  store: PauseStore = defaultPauseStore,
): Promise<void> {
  const now = Date.now();
  if (now - lastCostCheckAt < COST_CHECK_INTERVAL_MS) return;
  lastCostCheckAt = now;

  for (const role of new Set(roles)) {
    const result = checkCostVelocity(role, getCost, store);
    if (!result.newlyPaused) continue;
    log.warn('Cost velocity limit exceeded — pausing role', {
      role, costUsd: result.costUsd.toFixed(2), limitUsd: result.limitUsd, pauseMin: Math.round(costPauseMs() / 60_000),
    });
    try {
      await notify(
        role,
        `🛑 **Cost guard**: \`${role}\` spent $${result.costUsd.toFixed(2)} in the last hour ` +
        `(limit $${result.limitUsd}/hr). Pausing new dispatches for this role for ` +
        `${Math.round(costPauseMs() / 60_000)} min. Running sessions are unaffected.`,
      );
    } catch (err) {
      log.debug('Cost pause alert failed', { role, error: (err as Error).message });
    }
  }
}

// ─── Loop detection ──────────────────────────────────────────────────────────

/** AOS_LOOP_THRESHOLD, default 6 consecutive identical ticks. */
export function loopThreshold(): number {
  const n = parseInt(process.env.AOS_LOOP_THRESHOLD || '', 10);
  return Number.isFinite(n) && n >= 2 ? n : 6;
}

export const LOOP_NUDGE_MESSAGE =
  '[SYSTEM] You appear to be repeating the same operation without making progress. ' +
  'Stop, reassess your approach, and either try a different strategy or write BLOCKED.md ' +
  'explaining what is blocking you.';

export type LoopAction = 'none' | 'nudge' | 'fail';

interface LoopState {
  lastHash: string;
  repeats: number;
}

const loopStates = new Map<string, LoopState>();
const loopNudged = new Set<string>(); // attempts already nudged (once per attempt)

/**
 * Feed one tick of captured pane output for an attempt.
 *
 * Returns:
 *  - 'nudge' when the pane hash has been identical for loopThreshold()
 *    consecutive ticks while actively working (fires at most once per attempt)
 *  - 'fail'  when, after the nudge, another threshold-worth of identical
 *    ticks accumulates — the caller should fail the attempt
 *  - 'none'  otherwise
 */
export function trackPaneOutput(
  attemptId: string,
  paneOutput: string,
  isActivelyWorking: boolean,
): LoopAction {
  if (!isActivelyWorking) {
    // Only loops during active work count — idle prompts have their own handling.
    loopStates.delete(attemptId);
    return 'none';
  }

  const hash = createHash('sha1').update(paneOutput.trimEnd()).digest('hex');
  const state = loopStates.get(attemptId);

  if (!state || state.lastHash !== hash) {
    loopStates.set(attemptId, { lastHash: hash, repeats: 1 });
    return 'none';
  }

  state.repeats++;
  if (state.repeats < loopThreshold()) return 'none';

  if (!loopNudged.has(attemptId)) {
    loopNudged.add(attemptId);
    state.repeats = 0; // start counting the post-nudge window
    return 'nudge';
  }

  clearLoopState(attemptId);
  return 'fail';
}

/** Drop all loop-tracking state for an attempt (session ended / failed). */
export function clearLoopState(attemptId: string): void {
  loopStates.delete(attemptId);
  loopNudged.delete(attemptId);
}

/** Bound the in-memory maps — called from the monitor GC pass. */
export function gcLoopStates(): void {
  if (loopStates.size > 500) loopStates.clear();
  if (loopNudged.size > 500) loopNudged.clear();
}
