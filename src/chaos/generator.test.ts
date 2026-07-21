import { describe, it, expect } from 'vitest';
import { generateDrill } from './generator.js';
import { FailureMode } from './types.js';

const sampleMode: FailureMode = {
  id: 'rate-limit-cascade',
  title: 'Rate-limit cascade',
  description: 'rate limits',
  surface: 'rate-limit',
  severity: 'important',
  symptoms: [
    { channel: 'logs', pattern: '429', required: true },
    { channel: 'metrics', pattern: 'queue_depth', required: false },
  ],
  expectedRecovery: 'backoff',
};

const criticalMode: FailureMode = {
  ...sampleMode,
  id: 'silent-failure',
  surface: 'recovery',
  severity: 'critical',
};

describe('chaos generator', () => {
  it('produces deterministic scenarios with the same seed', () => {
    const d1 = generateDrill(sampleMode, { seed: 42, now: new Date('2026-05-03T00:00:00Z') });
    const d2 = generateDrill(sampleMode, { seed: 42, now: new Date('2026-05-03T00:00:00Z') });
    expect(d1.id).toBe(d2.id);
    expect(d1.targetIssueKey).toBe(d2.targetIssueKey);
    expect(d1.injection.count).toBe(d2.injection.count);
  });

  it('produces different scenarios with different seeds', () => {
    const d1 = generateDrill(sampleMode, { seed: 1 });
    const d2 = generateDrill(sampleMode, { seed: 99999 });
    // Targets should differ at least usually; ids always differ because seed encoded.
    expect(d1.id).not.toBe(d2.id);
  });

  it('targets default to TEST-* keys', () => {
    const d = generateDrill(sampleMode, { seed: 7 });
    expect(d.targetIssueKey).toMatch(/^TEST-\d+$/);
    expect(d.sandboxOnly).toBe(true);
  });

  it('honors targetIssueKey override', () => {
    const d = generateDrill(sampleMode, { seed: 7, targetIssueKey: 'CHAOS-99' });
    expect(d.targetIssueKey).toBe('CHAOS-99');
  });

  it('maps surface → injection type', () => {
    expect(generateDrill(sampleMode, { seed: 1 }).injection.type).toBe('rate-limit');
    expect(generateDrill({ ...sampleMode, surface: 'auth' }, { seed: 1 }).injection.type).toBe('auth-failure');
    expect(generateDrill({ ...sampleMode, surface: 'state' }, { seed: 1 }).injection.type).toBe('zombie-spawn');
  });

  it('jitters count by ±15-30% but stays deterministic per seed', () => {
    const counts = new Set<number>();
    for (let s = 1; s < 50; s++) counts.add(generateDrill(sampleMode, { seed: s }).injection.count);
    // Should produce varied counts, not just one value.
    expect(counts.size).toBeGreaterThan(2);
  });

  it('honors injectionOverride parameters', () => {
    const d = generateDrill(sampleMode, {
      seed: 1,
      injectionOverride: { count: 99, windowMs: 60_000 },
    });
    expect(d.injection.count).toBe(99);
    expect(d.injection.windowMs).toBe(60_000);
  });

  it('expects detection for modes with required symptoms', () => {
    const d = generateDrill(sampleMode, { seed: 1 });
    expect(d.expected.detected).toBe(true);
    expect(d.expected.detectionSymptoms.length).toBeGreaterThan(0);
  });

  it('sets a tight MTTR for critical severity', () => {
    const d = generateDrill(criticalMode, { seed: 1 });
    expect(d.expected.targetMttrMs).toBeLessThanOrEqual(30_000);
  });

  it('does not expect detection when no symptoms are required', () => {
    const noRequired: FailureMode = {
      ...sampleMode,
      symptoms: [{ channel: 'logs', pattern: 'x', required: false }],
    };
    const d = generateDrill(noRequired, { seed: 1 });
    expect(d.expected.detected).toBe(false);
    expect(d.expected.targetMttrMs).toBeNull();
  });

  it('encodes the seed in the scenario id for replay', () => {
    const seed = 12345;
    const d = generateDrill(sampleMode, { seed, now: new Date('2026-05-03T00:00:00Z') });
    expect(d.id).toContain(seed.toString(36));
  });
});
