import { describe, it, expect } from 'vitest';
import {
  isSandboxKey, assertSandboxKey, assertLiveAuthorized,
  SandboxBus, synthesizeInjectEvents,
} from './sandbox.js';
import { generateDrill } from './generator.js';
import { FailureMode } from './types.js';

const mode: FailureMode = {
  id: 'm', title: 'M', description: 'd',
  surface: 'rate-limit', severity: 'important',
  symptoms: [{ channel: 'logs', pattern: '429', required: true }],
  expectedRecovery: 'r',
};

describe('sandbox guards', () => {
  it('isSandboxKey accepts TEST-* and CHAOS-*', () => {
    expect(isSandboxKey('TEST-1')).toBe(true);
    expect(isSandboxKey('CHAOS-9999')).toBe(true);
    expect(isSandboxKey('RYA-1')).toBe(false);
    expect(isSandboxKey('test-1')).toBe(false);
  });

  it('assertSandboxKey throws on production keys when sandbox=true', () => {
    expect(() => assertSandboxKey('RYA-1', true)).toThrow(/refusing to touch/);
    expect(() => assertSandboxKey('TEST-1', true)).not.toThrow();
  });

  it('assertSandboxKey is a no-op when sandbox=false', () => {
    expect(() => assertSandboxKey('RYA-1', false)).not.toThrow();
  });

  it('assertLiveAuthorized requires both confirm and env ack', () => {
    const orig = process.env.AOS_CHAOS_LIVE_ACK;
    delete process.env.AOS_CHAOS_LIVE_ACK;
    try {
      expect(() => assertLiveAuthorized(false)).toThrow(/--i-confirm-live/);
      expect(() => assertLiveAuthorized(true)).toThrow(/AOS_CHAOS_LIVE_ACK/);
      process.env.AOS_CHAOS_LIVE_ACK = '1';
      expect(() => assertLiveAuthorized(true)).not.toThrow();
    } finally {
      if (orig !== undefined) process.env.AOS_CHAOS_LIVE_ACK = orig;
      else delete process.env.AOS_CHAOS_LIVE_ACK;
    }
  });
});

describe('SandboxBus', () => {
  it('publishes events to subscribers and stores them', () => {
    const bus = new SandboxBus();
    const seen: string[] = [];
    bus.subscribe(e => seen.push(e.message));
    bus.publish({ ts: 1, channel: 'logs', kind: 'inject', message: 'hello' });
    bus.publish({ ts: 2, channel: 'logs', kind: 'org', message: 'world' });
    expect(seen).toEqual(['hello', 'world']);
    expect(bus.drain().length).toBe(2);
    expect(bus.drain().length).toBe(0);
  });
});

describe('synthesizeInjectEvents', () => {
  it('produces injection.count events spaced across windowMs', () => {
    const scenario = generateDrill(mode, { seed: 42, now: new Date('2026-05-03T00:00:00Z') });
    scenario.injection.count = 5;
    scenario.injection.windowMs = 10_000;
    const events = synthesizeInjectEvents(scenario, 0);
    expect(events.length).toBe(5);
    expect(events[0].ts).toBe(0);
    expect(events[events.length - 1].ts).toBeLessThanOrEqual(10_000);
    for (const e of events) expect(e.kind).toBe('inject');
  });

  it('messages encode the injection type', () => {
    const scenario = generateDrill(mode, { seed: 42 });
    scenario.injection.type = 'rate-limit';
    const events = synthesizeInjectEvents(scenario, 0);
    expect(events[0].message).toContain('429');
  });
});
