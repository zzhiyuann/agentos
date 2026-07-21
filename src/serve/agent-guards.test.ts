import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  costVelocityUsdPerHr, costPauseMs, isRolePaused, checkCostVelocity,
  runCostVelocityChecks, __resetCostCheckThrottleForTests,
  loopThreshold, trackPaneOutput, clearLoopState, gcLoopStates,
  LOOP_NUDGE_MESSAGE, RoleCostFn, PauseStore,
} from './agent-guards.js';

const ENV_KEYS = [
  'AOS_COST_VELOCITY_USD_PER_HR', 'AOS_COST_PAUSE_MS', 'AOS_LOOP_THRESHOLD',
  'AOS_TEST_PERSIST_DEDUP',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function uniqueRole(): string {
  return `test-guard-${randomUUID().slice(0, 12)}`;
}

/** Hermetic in-memory pause store — the real dedup_keys table is shared with
 *  concurrent suites (db.test.ts runs gcDedupKeys) and would flake here. */
function memoryPauseStore(): PauseStore & { paused: Set<string> } {
  const paused = new Set<string>();
  return {
    paused,
    isPaused: (role) => paused.has(role),
    recordPause: (role) => { paused.add(role); },
  };
}

// ─── knob defaults ───────────────────────────────────────────────────

describe('agent-guard knobs', () => {
  it('costVelocityUsdPerHr defaults to 100', () => {
    expect(costVelocityUsdPerHr()).toBe(100);
    process.env.AOS_COST_VELOCITY_USD_PER_HR = '25.5';
    expect(costVelocityUsdPerHr()).toBe(25.5);
    process.env.AOS_COST_VELOCITY_USD_PER_HR = 'junk';
    expect(costVelocityUsdPerHr()).toBe(100);
  });

  it('costPauseMs defaults to 1 hour', () => {
    expect(costPauseMs()).toBe(60 * 60_000);
    process.env.AOS_COST_PAUSE_MS = '120000';
    expect(costPauseMs()).toBe(120_000);
  });

  it('loopThreshold defaults to 6 and rejects nonsense', () => {
    expect(loopThreshold()).toBe(6);
    process.env.AOS_LOOP_THRESHOLD = '3';
    expect(loopThreshold()).toBe(3);
    process.env.AOS_LOOP_THRESHOLD = '1'; // below minimum of 2
    expect(loopThreshold()).toBe(6);
    process.env.AOS_LOOP_THRESHOLD = 'banana';
    expect(loopThreshold()).toBe(6);
  });
});

// ─── cost velocity ───────────────────────────────────────────────────

describe('checkCostVelocity', () => {
  it('does not pause a role under the limit', () => {
    const store = memoryPauseStore();
    const role = uniqueRole();
    const getCost: RoleCostFn = () => 5;
    const result = checkCostVelocity(role, getCost, store);
    expect(result.paused).toBe(false);
    expect(result.newlyPaused).toBe(false);
    expect(result.costUsd).toBe(5);
    expect(result.limitUsd).toBe(100);
    expect(store.paused.size).toBe(0);
  });

  it('pauses a role over the limit and records the pause', () => {
    const store = memoryPauseStore();
    const role = uniqueRole();
    const getCost: RoleCostFn = () => 150;

    const first = checkCostVelocity(role, getCost, store);
    expect(first.paused).toBe(true);
    expect(first.newlyPaused).toBe(true);
    expect(store.paused.has(role)).toBe(true);

    // Second check: still paused, but not newly — the alert must fire only once
    const second = checkCostVelocity(role, getCost, store);
    expect(second.paused).toBe(true);
    expect(second.newlyPaused).toBe(false);
  });

  it('respects a custom AOS_COST_VELOCITY_USD_PER_HR', () => {
    process.env.AOS_COST_VELOCITY_USD_PER_HR = '100';
    const store = memoryPauseStore();
    const result = checkCostVelocity(uniqueRole(), () => 99, store);
    expect(result.paused).toBe(false);
    expect(result.limitUsd).toBe(100);
  });

  it('fails open when the cost lookup throws', () => {
    const store = memoryPauseStore();
    const role = uniqueRole();
    const getCost: RoleCostFn = () => { throw new Error('db gone'); };
    const result = checkCostVelocity(role, getCost, store);
    expect(result.paused).toBe(false);
    expect(result.newlyPaused).toBe(false);
  });

  it('default-store isRolePaused is false for unknown roles', () => {
    expect(isRolePaused(uniqueRole())).toBe(false);
  });
});

describe('runCostVelocityChecks', () => {
  function notifySpy() {
    const calls: Array<{ role: string; message: string }> = [];
    const notify = async (role: string, message: string) => {
      calls.push({ role, message });
      return true;
    };
    return { calls, notify };
  }

  it('alerts exactly once per newly-paused role', async () => {
    const store = memoryPauseStore();
    const role = uniqueRole();
    const { calls, notify } = notifySpy();
    const getCost: RoleCostFn = () => 150;

    __resetCostCheckThrottleForTests();
    await runCostVelocityChecks([role, role], getCost, notify, store);
    expect(calls).toHaveLength(1);
    expect(calls[0].role).toBe(role);
    expect(calls[0].message).toContain('Cost guard');

    // Re-run (bypassing the throttle): role already paused — no second alert
    __resetCostCheckThrottleForTests();
    await runCostVelocityChecks([role], getCost, notify, store);
    expect(calls).toHaveLength(1);
  });

  it('does not alert for roles under the limit', async () => {
    const store = memoryPauseStore();
    const { calls, notify } = notifySpy();
    __resetCostCheckThrottleForTests();
    await runCostVelocityChecks([uniqueRole()], () => 1, notify, store);
    expect(calls).toHaveLength(0);
  });

  it('is throttled between passes', async () => {
    const store = memoryPauseStore();
    const { calls, notify } = notifySpy();
    __resetCostCheckThrottleForTests();
    await runCostVelocityChecks([], () => 0, notify, store);
    // Immediately after a pass, another over-limit role is NOT checked
    await runCostVelocityChecks([uniqueRole()], () => 99, notify, store);
    expect(calls).toHaveLength(0);
  });
});

// ─── loop detection ──────────────────────────────────────────────────

describe('trackPaneOutput', () => {
  function attemptId(): string {
    return `attempt-${randomUUID()}`;
  }

  it('never fires while the pane output keeps changing', () => {
    const id = attemptId();
    for (let i = 0; i < 30; i++) {
      expect(trackPaneOutput(id, `output tick ${i}`, true)).toBe('none');
    }
    clearLoopState(id);
  });

  it('nudges on the Nth consecutive identical tick (default 6)', () => {
    const id = attemptId();
    const actions: string[] = [];
    for (let i = 0; i < 6; i++) {
      actions.push(trackPaneOutput(id, 'same output', true));
    }
    expect(actions).toEqual(['none', 'none', 'none', 'none', 'none', 'nudge']);
    clearLoopState(id);
  });

  it('fails after another threshold-worth of identical ticks post-nudge', () => {
    const id = attemptId();
    for (let i = 0; i < 6; i++) trackPaneOutput(id, 'same', true); // → nudge on 6th
    const actions: string[] = [];
    for (let i = 0; i < 6; i++) {
      actions.push(trackPaneOutput(id, 'same', true));
    }
    expect(actions).toEqual(['none', 'none', 'none', 'none', 'none', 'fail']);
    // State cleared on fail — counting starts over
    expect(trackPaneOutput(id, 'same', true)).toBe('none');
    clearLoopState(id);
  });

  it('a hash change resets the count but the nudge stays consumed', () => {
    const id = attemptId();
    for (let i = 0; i < 6; i++) trackPaneOutput(id, 'loop-a', true); // nudge consumed
    expect(trackPaneOutput(id, 'something else', true)).toBe('none'); // reset
    const actions: string[] = [];
    for (let i = 0; i < 6; i++) {
      actions.push(trackPaneOutput(id, 'loop-b', true));
    }
    // No second nudge — goes straight to fail
    expect(actions[5]).toBe('fail');
    clearLoopState(id);
  });

  it('non-active ticks reset the streak', () => {
    const id = attemptId();
    for (let i = 0; i < 5; i++) trackPaneOutput(id, 'same', true);
    expect(trackPaneOutput(id, 'same', false)).toBe('none'); // resets
    const actions: string[] = [];
    for (let i = 0; i < 5; i++) {
      actions.push(trackPaneOutput(id, 'same', true));
    }
    expect(actions.every(a => a === 'none')).toBe(true);
    clearLoopState(id);
  });

  it('respects AOS_LOOP_THRESHOLD', () => {
    process.env.AOS_LOOP_THRESHOLD = '3';
    const id = attemptId();
    expect(trackPaneOutput(id, 'x', true)).toBe('none');
    expect(trackPaneOutput(id, 'x', true)).toBe('none');
    expect(trackPaneOutput(id, 'x', true)).toBe('nudge');
    clearLoopState(id);
  });

  it('clearLoopState makes a fresh nudge possible again', () => {
    process.env.AOS_LOOP_THRESHOLD = '2';
    const id = attemptId();
    trackPaneOutput(id, 'y', true);
    expect(trackPaneOutput(id, 'y', true)).toBe('nudge');
    clearLoopState(id);
    trackPaneOutput(id, 'y', true);
    expect(trackPaneOutput(id, 'y', true)).toBe('nudge'); // not fail — state was cleared
    clearLoopState(id);
  });

  it('tracks attempts independently', () => {
    process.env.AOS_LOOP_THRESHOLD = '2';
    const a = attemptId();
    const b = attemptId();
    trackPaneOutput(a, 'same', true);
    trackPaneOutput(b, 'same', true);
    expect(trackPaneOutput(a, 'same', true)).toBe('nudge');
    expect(trackPaneOutput(b, 'same', true)).toBe('nudge');
    clearLoopState(a);
    clearLoopState(b);
  });

  it('gcLoopStates is callable (bounded maps)', () => {
    expect(() => gcLoopStates()).not.toThrow();
  });

  it('exports a [SYSTEM] nudge message', () => {
    expect(LOOP_NUDGE_MESSAGE.startsWith('[SYSTEM] You appear to be repeating the same operation')).toBe(true);
  });
});
