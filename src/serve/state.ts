/** Shared mutable state for serve subsystems. Centralizes dedup maps, cooldowns, and locks. */

import { dedupCheck as dbDedupCheck, recordDedup as dbRecordDedup, gcDedupKeys } from '../core/db.js';

/** A1.3: persistence is disabled under vitest (real-DB writes with fixed issue
 *  keys would make rapid test re-runs flake on 60s dedup windows). Tests that
 *  exercise the DB backstop explicitly opt back in via AOS_TEST_PERSIST_DEDUP=1. */
function dedupPersistenceEnabled(): boolean {
  return process.env.VITEST !== 'true' || process.env.AOS_TEST_PERSIST_DEDUP === '1';
}

export const DEDUP_WINDOW_MS = 60_000;
export const FOLLOW_UP_TTL_MS = 10 * 60_000;
export const FOLLOW_UP_LOCK_TTL_MS = 30_000;

/** Dedup: track recently handled sessions/issues to prevent spam loops */
export const handledSessions = new Map<string, number>();

/** Follow-up tracking: attemptId → meta for server-side threaded replies (Linear) and Discord replies */
export interface FollowUpMeta {
  createdAt: number;
  /** Linear comment ID for threaded replies */
  commentId?: string;
  /** Discord channel ID — present when follow-up was triggered from Discord */
  discordChannelId?: string;
  /** Discord message ID to reply to */
  discordMessageId?: string;
}
export const followUpMeta = new Map<string, FollowUpMeta>();

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

/** Track when attempts were last reactivated from idle — used for warmup grace period.
 *  Without this, reactivated sessions get immediately re-idled because `created_at`
 *  (hours old) makes `alreadyMature` true, skipping the warmup grace. */
export const reactivatedAt = new Map<string, number>();

/** Track follow-up prompt for reactivated sessions — used when rate limit kills a
 *  reactivated session and we need to re-enqueue with the original follow-up context. */
export const reactivationContext = new Map<string, string>();

/** Discord source context: tracks which Discord message triggered an issue dispatch.
 *  Key: issueKey, Value: Discord channel + message ID for reply-to on completion. */
export interface DiscordSourceContext {
  channelId: string;
  messageId: string;
  createdAt: number;
}
export const discordSourceContext = new Map<string, DiscordSourceContext>();
export const DISCORD_SOURCE_TTL_MS = 60 * 60_000; // 1 hour

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

/** Release a spawn claim so a superseding spawn can re-claim it within the window.
 *  Used when an explicit dispatch overrides an auto-routed spawn (RYA-1139). */
export function releaseSpawnSlot(issueKey: string): void {
  spawnClaims.delete(issueKey);
}

/** Auto-routed creator-default spawns (RYA-1139). When an agent creates an issue,
 *  serve auto-routes it to the creator role within seconds. An explicit
 *  `dispatch <other-role>` arriving inside the override window must supersede
 *  that spawn instead of silently losing to the per-issue spawn claim.
 *  Key: issueKey. */
export interface AutoRouteRecord {
  role: string;
  at: number;
}
export const autoRoutedSpawns = new Map<string, AutoRouteRecord>();
export const AUTO_ROUTE_OVERRIDE_WINDOW_MS = 5 * 60_000;

/** A1.3: write-through dedup — in-memory map is the fast path, dedup_keys table
 *  is the restart-surviving backstop (serve restarts on every auto-deploy).
 *  Returns true if the key was seen within `windowMs` (memory OR db); otherwise
 *  records it in both and returns false. DB failures degrade to memory-only. */
export function checkAndRecordDedup(
  map: Map<string, number>,
  mapKey: string,
  dbKey: string,
  windowMs: number,
): boolean {
  const now = Date.now();
  const last = map.get(mapKey);
  if (last && now - last < windowMs) return true;
  if (!dedupPersistenceEnabled()) {
    map.set(mapKey, now);
    return false;
  }
  try {
    if (dbDedupCheck(dbKey, windowMs)) return true;
    map.set(mapKey, now);
    dbRecordDedup(dbKey);
  } catch (err) {
    console.debug('[state] persistent dedup unavailable, memory-only:', (err as Error).message);
    map.set(mapKey, now);
  }
  return false;
}

/** Read-only variant for call sites that record conditionally later. */
export function persistentDedupCheck(dbKey: string, windowMs: number): boolean {
  if (!dedupPersistenceEnabled()) return false;
  try { return dbDedupCheck(dbKey, windowMs); } catch (err) {
    console.debug('[state] persistent dedup check failed:', (err as Error).message);
    return false;
  }
}

/** Record-only variant (pairs with persistentDedupCheck). */
export function persistentDedupRecord(dbKey: string): void {
  if (!dedupPersistenceEnabled()) return;
  try { dbRecordDedup(dbKey); } catch (err) {
    console.debug('[state] persistent dedup record failed:', (err as Error).message);
  }
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

/** Track per-issue dispatch retry counts (for backoff / circuit-breaker decisions).
 *  Key: issueKey or `${role}:${issueKey}`. Pruned by gcStateMaps after 10 minutes. */
export interface DispatchRetryRecord {
  count: number;
  createdAt: number;
}
export const dispatchRetries = new Map<string, DispatchRetryRecord>();

/** Centralized GC pass — invoked once per monitor tick to prune stale dedup state.
 *
 *  Each map has its own retention policy expressed below; tests in `state.test.ts`
 *  pin the exact thresholds so any drift is caught at CI time.
 */
export function gcStateMaps(): void {
  const now = Date.now();

  // handledSessions: short-window dedup, 5 min retention
  for (const [k, v] of handledSessions) {
    if (now - v > 5 * 60_000) handledSessions.delete(k);
  }

  // followUpMeta: covers the follow-up TTL plus a 5-minute grace
  for (const [k, meta] of followUpMeta) {
    if (now - meta.createdAt > FOLLOW_UP_TTL_MS + 5 * 60_000) followUpMeta.delete(k);
  }

  // activeFollowUpLock: short cross-handler coordination window (2 min)
  for (const [k, v] of activeFollowUpLock) {
    if (now - v > 2 * 60_000) activeFollowUpLock.delete(k);
  }

  // dispatchDedup: 10-min retention to absorb rapid re-dispatch attempts
  for (const [k, v] of dispatchDedup) {
    if (now - v > 10 * 60_000) dispatchDedup.delete(k);
  }

  // dispatchRetries: matches dispatchDedup window
  for (const [k, rec] of dispatchRetries) {
    if (now - rec.createdAt > 10 * 60_000) dispatchRetries.delete(k);
  }

  // reactivatedAt / reactivationContext: paired maps, 1-hour retention, NO size gate.
  for (const [k, v] of reactivatedAt) {
    if (now - v > 60 * 60_000) {
      reactivatedAt.delete(k);
      reactivationContext.delete(k);
    }
  }

  // discordSourceContext: TTL-based, NO size gate
  for (const [k, ctx] of discordSourceContext) {
    if (now - ctx.createdAt > DISCORD_SOURCE_TTL_MS) discordSourceContext.delete(k);
  }

  // reportedHandoffs / trustPromptHandled: bounded sets, hard cap at 500
  if (reportedHandoffs.size > 500) reportedHandoffs.clear();
  if (trustPromptHandled.size > 500) trustPromptHandled.clear();

  // autoDispatchFailures: trim aggressively old entries (30 min)
  for (const [k, v] of autoDispatchFailures) {
    if (now - v > 30 * 60_000) autoDispatchFailures.delete(k);
  }

  // autoRoutedSpawns: entries are only actionable inside the override window
  for (const [k, rec] of autoRoutedSpawns) {
    if (now - rec.at > AUTO_ROUTE_OVERRIDE_WINDOW_MS) autoRoutedSpawns.delete(k);
  }

  // dedup_keys table: 24h retention (best effort — GC must never break the tick)
  try { gcDedupKeys(); } catch (err) {
    console.debug('[state] dedup GC failed:', (err as Error).message);
  }
}
