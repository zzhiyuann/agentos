import { describe, it, expect } from 'vitest';
import { runDrill, formatRunReport } from './runner.js';
import { ObservedEvent } from './types.js';

describe('runDrill', () => {
  it('runs a sandbox drill end-to-end with seed taxonomy', async () => {
    let now = 1_700_000_000_000;
    const run = await runDrill({
      modeId: 'rate-limit-cascade',
      generate: { seed: 1, now: new Date(now) },
      now: () => now,
    });
    expect(run.scenario.failureModeId).toBe('rate-limit-cascade');
    expect(run.scenario.targetIssueKey).toMatch(/^TEST-/);
    expect(run.events.length).toBeGreaterThan(0);
    expect(run.outcome.scenarioId).toBe(run.scenario.id);
  });

  it('refuses non-TEST keys when sandbox=true', async () => {
    await expect(runDrill({
      modeId: 'rate-limit-cascade',
      generate: { seed: 1, targetIssueKey: 'RYA-9999' },
    })).rejects.toThrow(/sandbox/i);
  });

  it('refuses live mode without --i-confirm-live', async () => {
    await expect(runDrill({
      modeId: 'rate-limit-cascade',
      sandbox: false,
    })).rejects.toThrow(/i-confirm-live/);
  });

  it('refuses live mode without AOS_CHAOS_LIVE_ACK', async () => {
    const orig = process.env.AOS_CHAOS_LIVE_ACK;
    delete process.env.AOS_CHAOS_LIVE_ACK;
    try {
      await expect(runDrill({
        modeId: 'rate-limit-cascade',
        sandbox: false,
        confirmLive: true,
      })).rejects.toThrow(/AOS_CHAOS_LIVE_ACK/);
    } finally {
      if (orig !== undefined) process.env.AOS_CHAOS_LIVE_ACK = orig;
    }
  });

  it('accepts replayOrgEvents and classifies the drill outcome', async () => {
    const start = 1_700_000_000_000;
    const orgEvents: ObservedEvent[] = [
      { ts: start + 5_000, channel: 'logs', kind: 'org', message: '429 detected by monitor' },
    ];
    const run = await runDrill({
      modeId: 'rate-limit-cascade',
      generate: { seed: 1, now: new Date(start) },
      replayOrgEvents: orgEvents,
      now: () => start,
    });
    expect(['detected_recovered', 'detected_human_rescue']).toContain(run.outcome.outcomeClass);
  });

  it('formatRunReport produces a multi-line report', async () => {
    const start = 1_700_000_000_000;
    const run = await runDrill({
      modeId: 'rate-limit-cascade',
      generate: { seed: 1, now: new Date(start) },
      now: () => start,
    });
    const report = formatRunReport(run);
    expect(report).toContain('Drill Run');
    expect(report).toContain('Mode:');
    expect(report).toContain('Outcome:');
  });
});
