import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  gcStateMaps,
  handledSessions,
  followUpMeta,
  activeFollowUpLock,
  dispatchDedup,
  reportedHandoffs,
  trustPromptHandled,
  autoDispatchFailures,
  reactivatedAt,
  reactivationContext,
  discordSourceContext,
  spawnClaims,
  dispatchRetries,
  autoRoutedSpawns,
  claimSpawnSlot,
  releaseSpawnSlot,
  DISCORD_SOURCE_TTL_MS,
  FOLLOW_UP_TTL_MS,
  AUTO_ROUTE_OVERRIDE_WINDOW_MS,
} from './state.js';

describe('gcStateMaps', () => {
  beforeEach(() => {
    // Clear all maps before each test
    handledSessions.clear();
    followUpMeta.clear();
    activeFollowUpLock.clear();
    dispatchDedup.clear();
    reportedHandoffs.clear();
    trustPromptHandled.clear();
    autoDispatchFailures.clear();
    reactivatedAt.clear();
    reactivationContext.clear();
    discordSourceContext.clear();
    spawnClaims.clear();
    dispatchRetries.clear();
    autoRoutedSpawns.clear();
  });

  it('prunes handledSessions older than 5 minutes', () => {
    const old = Date.now() - 6 * 60_000;
    const recent = Date.now() - 1 * 60_000;
    handledSessions.set('old-key', old);
    handledSessions.set('recent-key', recent);

    gcStateMaps();

    expect(handledSessions.has('old-key')).toBe(false);
    expect(handledSessions.has('recent-key')).toBe(true);
  });

  it('prunes followUpMeta older than TTL + 5 min', () => {
    const old = Date.now() - (FOLLOW_UP_TTL_MS + 6 * 60_000);
    const recent = Date.now();
    followUpMeta.set('old', { createdAt: old });
    followUpMeta.set('recent', { createdAt: recent });

    gcStateMaps();

    expect(followUpMeta.has('old')).toBe(false);
    expect(followUpMeta.has('recent')).toBe(true);
  });

  it('prunes reactivatedAt/reactivationContext older than 1 hour (no size gate)', () => {
    const old = Date.now() - 61 * 60_000;
    reactivatedAt.set('old', old);
    reactivationContext.set('old', 'some context');
    reactivatedAt.set('recent', Date.now());
    reactivationContext.set('recent', 'other context');

    // Only 2 entries — old code required size > 50 before GC
    expect(reactivatedAt.size).toBe(2);

    gcStateMaps();

    expect(reactivatedAt.has('old')).toBe(false);
    expect(reactivationContext.has('old')).toBe(false);
    expect(reactivatedAt.has('recent')).toBe(true);
    expect(reactivationContext.has('recent')).toBe(true);
  });

  it('prunes discordSourceContext older than TTL (no size gate)', () => {
    const old = Date.now() - DISCORD_SOURCE_TTL_MS - 1000;
    discordSourceContext.set('old', { channelId: 'c', messageId: 'm', createdAt: old });
    discordSourceContext.set('recent', { channelId: 'c', messageId: 'm', createdAt: Date.now() });

    // Only 2 entries — old code required size > 20 before GC
    expect(discordSourceContext.size).toBe(2);

    gcStateMaps();

    expect(discordSourceContext.has('old')).toBe(false);
    expect(discordSourceContext.has('recent')).toBe(true);
  });

  it('prunes dispatchRetries older than 10 minutes', () => {
    dispatchRetries.set('old', { count: 2, createdAt: Date.now() - 11 * 60_000 });
    dispatchRetries.set('recent', { count: 1, createdAt: Date.now() });

    gcStateMaps();

    expect(dispatchRetries.has('old')).toBe(false);
    expect(dispatchRetries.has('recent')).toBe(true);
  });

  it('caps reportedHandoffs and trustPromptHandled at 500', () => {
    for (let i = 0; i < 501; i++) reportedHandoffs.add(`h-${i}`);
    for (let i = 0; i < 501; i++) trustPromptHandled.add(`t-${i}`);

    gcStateMaps();

    expect(reportedHandoffs.size).toBe(0);
    expect(trustPromptHandled.size).toBe(0);
  });

  it('does not clear reportedHandoffs/trustPromptHandled under 500', () => {
    reportedHandoffs.add('a');
    trustPromptHandled.add('b');

    gcStateMaps();

    expect(reportedHandoffs.size).toBe(1);
    expect(trustPromptHandled.size).toBe(1);
  });

  it('prunes activeFollowUpLock older than 2 minutes', () => {
    activeFollowUpLock.set('old', Date.now() - 3 * 60_000);
    activeFollowUpLock.set('recent', Date.now());

    gcStateMaps();

    expect(activeFollowUpLock.has('old')).toBe(false);
    expect(activeFollowUpLock.has('recent')).toBe(true);
  });

  it('prunes dispatchDedup older than 10 minutes', () => {
    dispatchDedup.set('old', Date.now() - 11 * 60_000);
    dispatchDedup.set('recent', Date.now());

    gcStateMaps();

    expect(dispatchDedup.has('old')).toBe(false);
    expect(dispatchDedup.has('recent')).toBe(true);
  });

  it('prunes autoRoutedSpawns older than the override window (RYA-1139)', () => {
    autoRoutedSpawns.set('RYA-old', { role: 'coo', at: Date.now() - AUTO_ROUTE_OVERRIDE_WINDOW_MS - 1000 });
    autoRoutedSpawns.set('RYA-recent', { role: 'coo', at: Date.now() });

    gcStateMaps();

    expect(autoRoutedSpawns.has('RYA-old')).toBe(false);
    expect(autoRoutedSpawns.has('RYA-recent')).toBe(true);
  });
});

describe('releaseSpawnSlot (RYA-1139)', () => {
  beforeEach(() => {
    spawnClaims.clear();
  });

  it('allows an immediate re-claim after release within the claim window', () => {
    expect(claimSpawnSlot('RYA-1138')).toBe(true);
    expect(claimSpawnSlot('RYA-1138')).toBe(false); // still inside window

    releaseSpawnSlot('RYA-1138');

    expect(claimSpawnSlot('RYA-1138')).toBe(true); // superseding spawn re-claims
  });

  it('is a no-op for unclaimed issues', () => {
    releaseSpawnSlot('RYA-9999');
    expect(claimSpawnSlot('RYA-9999')).toBe(true);
  });
});

describe('checkAndRecordDedup (A1.3 persistent dedup)', async () => {
  const { checkAndRecordDedup, persistentDedupCheck, persistentDedupRecord } = await import('./state.js');
  const { randomUUID } = await import('crypto');

  // These tests exercise the DB backstop — opt back into persistence (disabled
  // by default under vitest so other suites' fixed issue keys don't flake).
  beforeEach(() => { process.env.AOS_TEST_PERSIST_DEDUP = '1'; });
  afterEach(() => { delete process.env.AOS_TEST_PERSIST_DEDUP; });

  it('returns false first, true on repeat (memory fast path)', () => {
    const map = new Map<string, number>();
    const id = randomUUID();
    expect(checkAndRecordDedup(map, id, `test:card:${id}`, 60_000)).toBe(false);
    expect(checkAndRecordDedup(map, id, `test:card:${id}`, 60_000)).toBe(true);
    expect(map.has(id)).toBe(true);
  });

  it('survives a simulated restart (memory wiped, db backstop hits)', () => {
    const map = new Map<string, number>();
    const id = randomUUID();
    expect(checkAndRecordDedup(map, id, `test:card:${id}`, 60_000)).toBe(false);
    map.clear(); // simulate serve restart wiping in-memory state
    expect(checkAndRecordDedup(map, id, `test:card:${id}`, 60_000)).toBe(true);
  });

  it('persistentDedupCheck/Record pair works for conditional-set call sites', () => {
    const id = randomUUID();
    expect(persistentDedupCheck(`test:pair:${id}`, 60_000)).toBe(false);
    persistentDedupRecord(`test:pair:${id}`);
    expect(persistentDedupCheck(`test:pair:${id}`, 60_000)).toBe(true);
  });
});
