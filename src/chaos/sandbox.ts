/**
 * Sandbox mode for chaos drills.
 *
 * Hard rule: drills NEVER touch production Linear unless `--i-confirm-live`
 * is passed AND the COO has acknowledged via env or sentinel file. The
 * sandbox is the default and the runner refuses to leave it without an
 * explicit override.
 *
 * Sandbox mechanism:
 *   - Issue keys are namespaced TEST-* or CHAOS-*.
 *   - Linear API is mocked: an in-memory event bus records what would have
 *     been sent to Linear without actually calling it.
 *   - Sandbox state persisted to /tmp/aos-chaos/<run-id>/ — never touches
 *     ~/.aos/state.db.
 */

import { ObservedEvent, DrillScenario, DrillInjection } from './types.js';

const TEST_KEY_RE = /^(TEST|CHAOS)-\d+$/;

export function isSandboxKey(key: string): boolean {
  return TEST_KEY_RE.test(key);
}

/**
 * Throws if a non-sandbox key would be touched in sandbox mode.
 * Call this BEFORE any Linear-bound operation.
 */
export function assertSandboxKey(key: string, sandbox: boolean): void {
  if (!sandbox) return;
  if (!isSandboxKey(key)) {
    throw new Error(
      `Sandbox guard: refusing to touch non-test key "${key}" in sandbox mode. ` +
      `Use TEST-* or CHAOS-* keys, or run with --i-confirm-live.`,
    );
  }
}

/**
 * Live mode confirmation. Two checks must pass:
 *   1. AOS_CHAOS_LIVE_ACK env var set (typically by COO before authorising)
 *   2. Caller passed --i-confirm-live (translates to confirm=true here)
 */
export function assertLiveAuthorized(confirm: boolean): void {
  if (!confirm) {
    throw new Error('Live drill requires --i-confirm-live flag.');
  }
  if (!process.env.AOS_CHAOS_LIVE_ACK) {
    throw new Error(
      'Live drill requires AOS_CHAOS_LIVE_ACK env var (set by COO acknowledgement). ' +
      'Defaulting to sandbox is the safe path.',
    );
  }
}

/**
 * In-memory bus for sandbox events. The injector publishes synthetic events
 * representing the perturbation; the observer subscribes to classify them.
 */
export class SandboxBus {
  private subscribers: ((e: ObservedEvent) => void)[] = [];
  private events: ObservedEvent[] = [];

  publish(event: ObservedEvent): void {
    this.events.push(event);
    for (const sub of this.subscribers) sub(event);
  }

  subscribe(fn: (e: ObservedEvent) => void): void {
    this.subscribers.push(fn);
  }

  drain(): ObservedEvent[] {
    const out = [...this.events];
    this.events.length = 0;
    return out;
  }
}

/**
 * Synthesize the inject events for a drill scenario. Real injection in live
 * mode would actually trigger rate limits, kill tmux, etc. In sandbox the
 * injection is purely synthetic — we publish the events that WOULD be
 * generated, and let the observer classify them as if real.
 */
export function synthesizeInjectEvents(scenario: DrillScenario, startTs: number): ObservedEvent[] {
  const { injection } = scenario;
  const events: ObservedEvent[] = [];
  const spacing = injection.windowMs / Math.max(1, injection.count);

  for (let i = 0; i < injection.count; i++) {
    const ts = startTs + Math.round(spacing * i);
    events.push({
      ts,
      channel: injectChannel(injection.type),
      kind: 'inject',
      message: injectMessage(injection.type, i),
      tags: ['inject', injection.type],
    });
  }
  return events;
}

function injectChannel(type: DrillInjection['type']): ObservedEvent['channel'] {
  switch (type) {
    case 'rate-limit':       return 'logs';
    case 'auth-failure':     return 'logs';
    case 'dispatch-drop':    return 'linear-status';
    case 'handoff-loss':     return 'logs';
    case 'zombie-spawn':     return 'session-state';
    case 'memory-corruption':return 'logs';
    case 'concurrent-kill':  return 'session-state';
    case 'silent-error':     return 'logs';
  }
}

function injectMessage(type: DrillInjection['type'], idx: number): string {
  switch (type) {
    case 'rate-limit':       return `429 Too Many Requests (chaos-inject #${idx + 1})`;
    case 'auth-failure':     return `401 Unauthorized (chaos-inject #${idx + 1})`;
    case 'dispatch-drop':    return `Issue created without dispatch (chaos-inject #${idx + 1})`;
    case 'handoff-loss':     return `no handoff context found (chaos-inject #${idx + 1})`;
    case 'zombie-spawn':     return `tmux session dead (chaos-inject #${idx + 1})`;
    case 'memory-corruption':return `stale memory reference (chaos-inject #${idx + 1})`;
    case 'concurrent-kill':  return `concurrent session kill (chaos-inject #${idx + 1})`;
    case 'silent-error':     return `[Error] silent catch (chaos-inject #${idx + 1})`;
  }
}
