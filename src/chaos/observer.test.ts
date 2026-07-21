import { describe, it, expect } from 'vitest';
import { Observer, classifyEvents } from './observer.js';
import { generateDrill } from './generator.js';
import { FailureMode, ObservedEvent } from './types.js';

const mode: FailureMode = {
  id: 'silent-failure-swallow',
  title: 'Silent failure',
  description: 'd',
  surface: 'recovery',
  severity: 'critical',
  symptoms: [
    { channel: 'logs', pattern: 'Error', required: true },
    { channel: 'linear-status', pattern: 'failed', required: false },
  ],
  expectedRecovery: 'recovers',
};

describe('chaos observer', () => {
  function build() {
    const scenario = generateDrill(mode, { seed: 1, now: new Date('2026-05-03T00:00:00Z') });
    const start = new Date(scenario.generatedAt).getTime();
    return { scenario, start };
  }

  it('classifies detected_recovered when detection symptom present and no human marker', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      { ts: start + 100, channel: 'logs', kind: 'inject', message: 'inject' },
      { ts: start + 5_000, channel: 'logs', kind: 'org', message: '[Error] caught' },
      { ts: start + 10_000, channel: 'linear-status', kind: 'org', message: 'failed' },
    ];
    const o = new Observer(scenario, start);
    o.recordAll(events);
    const outcome = o.classify(start + 60_000);
    expect(outcome.outcomeClass).toBe('detected_recovered');
    expect(outcome.mttrMs).toBe(4_900);
  });

  it('classifies detected_human_rescue when human marker present', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
      { ts: start + 3_000, channel: 'logs', kind: 'org', message: '[Error] caught' },
      { ts: start + 8_000, channel: 'linear-comments', kind: 'org', message: 'human intervention required' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + 60_000);
    expect(outcome.outcomeClass).toBe('detected_human_rescue');
  });

  it('classifies undetected_recovered on quiet aftermath', () => {
    const { scenario, start } = build();
    // No detection events, no errors after window — silent self-heal.
    const events: ObservedEvent[] = [
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
      { ts: start + scenario.injection.windowMs + 1_000, channel: 'logs', kind: 'org', message: 'queue drained' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + scenario.injection.windowMs * 2);
    expect(outcome.outcomeClass).toBe('undetected_recovered');
  });

  it('classifies undetected_failed when errors continue without detection', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
      // Symptom pattern mismatch ("error" not "Error" matching, but still ongoing failures).
      // Using a different message that doesn't contain "Error" at all.
      { ts: start + scenario.injection.windowMs + 5_000, channel: 'logs', kind: 'org', message: 'pipeline stalled' },
      { ts: start + scenario.injection.windowMs + 10_000, channel: 'logs', kind: 'org', message: 'still failing' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + scenario.injection.windowMs * 2);
    // The "Error" pattern (case-insensitive) actually matches "stalled"? No — let's check.
    // Patterns are escaped substrings; "Error" matches only events containing "error" (case-insensitive).
    // Neither message contains "error" so this should be undetected_failed.
    expect(outcome.outcomeClass).toBe('undetected_failed');
  });

  it('classifies false_positive when no inject events occur', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      // Detection-shaped event but no inject preceded.
      { ts: start + 1_000, channel: 'logs', kind: 'org', message: '[Error] background noise' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + 60_000);
    expect(outcome.outcomeClass).toBe('false_positive');
  });

  it('records MTTR null when undetected', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + scenario.injection.windowMs * 2);
    expect(outcome.mttrMs).toBeNull();
  });

  it('marks deviation when MTTR exceeds target', () => {
    const { scenario, start } = build();
    // Critical severity → target ≤30s. Detection at 60s should violate.
    const events: ObservedEvent[] = [
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
      { ts: start + 60_000, channel: 'logs', kind: 'org', message: '[Error] detected late' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + 120_000);
    expect(outcome.outcomeClass).toBe('detected_recovered');
    expect(outcome.matchedExpectation).toBe(false);
    expect(outcome.notes.some(n => n.includes('exceeded target'))).toBe(true);
  });

  it('only matches symptoms after first inject (timing matters)', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      // Pre-inject "Error" that should NOT count as detection.
      { ts: start - 1_000, channel: 'logs', kind: 'org', message: '[Error] before drill' },
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
    ];
    const outcome = classifyEvents(scenario, events, start - 5_000, start + 60_000);
    expect(outcome.outcomeClass).toBe('undetected_failed');
  });

  it('respects channel of symptom — wrong channel does not match', () => {
    const { scenario, start } = build();
    const events: ObservedEvent[] = [
      { ts: start, channel: 'logs', kind: 'inject', message: 'inject' },
      // "Error" but on wrong channel (linear-comments, not logs).
      { ts: start + 5_000, channel: 'linear-comments', kind: 'org', message: '[Error] wrong channel' },
    ];
    const outcome = classifyEvents(scenario, events, start, start + 60_000);
    expect(outcome.outcomeClass).toBe('undetected_failed');
  });
});
