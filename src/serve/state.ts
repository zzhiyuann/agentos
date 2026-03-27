/** Shared mutable state for serve subsystems. Centralizes dedup maps, cooldowns, and locks. */

export const DEDUP_WINDOW_MS = 60_000;
export const FOLLOW_UP_TTL_MS = 10 * 60_000;
export const FOLLOW_UP_LOCK_TTL_MS = 30_000;

/** Dedup: track recently handled sessions/issues to prevent spam loops */
export const handledSessions = new Map<string, number>();

/** Follow-up tracking: attemptId → { commentId, createdAt } for server-side threaded replies */
export const followUpMeta = new Map<string, { commentId: string; createdAt: number }>();

/** Cross-handler coordination: handleWebhook owns follow-up spawning, handleCommentCreated defers */
export const activeFollowUpLock = new Map<string, number>();

/** Dedup for dispatch requests */
export const dispatchDedup = new Map<string, number>();

/** Prevent duplicate HANDOFF reporting */
export const reportedHandoffs = new Set<string>();

/** Prevent duplicate trust prompt handling */
export const trustPromptHandled = new Set<string>();

/** Track consecutive rate-limit failures per agent */
export const autoDispatchFailures = new Map<string, number>();

/** Track progress-comment nudge state per attempt.
 *  Supports recurring nudges (every 15 min) and escalation after 3+ nudges. */
export const progressNudgedAttempts = new Map<string, { lastNudgeTime: number; nudgeCount: number }>();

/** Per-issue spawn dedup: prevents double-spawn from racing webhook + comment handlers.
 *  Key: issueKey, Value: timestamp of most recent spawn claim. */
export const spawnClaims = new Map<string, number>();
export const SPAWN_CLAIM_WINDOW_MS = 30_000;

/**
 * Atomically claim the right to spawn an agent for an issue.
 * Returns true if this caller "wins" the spawn slot, false if another handler already claimed it.
 *
 * Must be called synchronously (no await between check and set) to be atomic in single-threaded Node.js.
 */
export function claimSpawnSlot(issueKey: string): boolean {
  const lastClaim = spawnClaims.get(issueKey);
  if (lastClaim && Date.now() - lastClaim < SPAWN_CLAIM_WINDOW_MS) {
    return false; // Another handler already claimed this spawn
  }
  spawnClaims.set(issueKey, Date.now());
  // GC old entries
  if (spawnClaims.size > 50) {
    const cutoff = Date.now() - SPAWN_CLAIM_WINDOW_MS * 2;
    for (const [k, v] of spawnClaims) {
      if (v < cutoff) spawnClaims.delete(k);
    }
  }
  return true;
}

/** Cleanup old entries from a Map<string, number> */
export function cleanupMap(map: Map<string, number>, maxSize: number, maxAgeMs: number): void {
  if (map.size > maxSize) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [k, v] of map) {
      if (v < cutoff) map.delete(k);
    }
  }
}
