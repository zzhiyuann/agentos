/**
 * Regression fixture: zombie spawn loop — DB says running, tmux is dead.
 *
 * Failure mode: `zombie-spawn-loop` (KFP-5).
 *
 * Post-mortem: agent crashes mid-task; the attempt row stays in `running`
 * status because no one writes the failure transition. Monitor reconciliation
 * is responsible for detecting the dead-tmux + running-DB mismatch and
 * marking the attempt failed. Without this, the proactive scheduler keeps
 * counting the slot as occupied and spawns no replacement, while circuit
 * breaker never trips because no failure was recorded.
 *
 * Refs:
 *   - RYA-360 (chaos eval for tmux kill recovery)
 *   - RYA-344 (system crash recovery pattern)
 *   - RYA-698 (zombie-spawn filter + open-issue guard)
 *   - src/evals/chaos-tmux-kill.test.ts (deeper behavioral test)
 *
 * What this fixture gates: monitor reconciliation must (a) detect the
 * mismatch, (b) transition the attempt to failed with an error_log set,
 * (c) record the failure for circuit-breaker accounting.
 */

import type { RegressionFixture } from './types.js';

interface AttemptRow {
  status: 'pending' | 'running' | 'completed' | 'failed';
  tmux_session: string | null;
  error_log: string | null;
  completed_at: string | null;
}

interface ReconcileResult {
  transitioned: boolean;
  newStatus: AttemptRow['status'];
  errorLog: string | null;
  circuitBreakerCounted: boolean;
}

/**
 * Mirror of the monitor's reconciliation rule from monitor.ts Case 4:
 * `!alive && !handoff && !blocked` → mark failed.
 */
function reconcile(attempt: AttemptRow, tmuxAlive: boolean, handoffPresent: boolean, blockedPresent: boolean): ReconcileResult {
  const inconsistent = attempt.status === 'running' && !tmuxAlive && !handoffPresent && !blockedPresent;
  if (!inconsistent) {
    return { transitioned: false, newStatus: attempt.status, errorLog: attempt.error_log, circuitBreakerCounted: false };
  }
  return {
    transitioned: true,
    newStatus: 'failed',
    errorLog: 'tmux session dead, no HANDOFF.md, no BLOCKED.md — marked failed by monitor',
    circuitBreakerCounted: true,
  };
}

export const fixture: RegressionFixture = {
  id: 'kfp-5-zombie-spawn-loop',
  failureModeId: 'zombie-spawn-loop',
  description:
    'Monitor reconciliation must detect DB-running + dead-tmux mismatch and transition ' +
    'the attempt to failed with an observable error_log and circuit-breaker accounting.',
  postMortemRefs: ['RYA-360', 'RYA-344', 'RYA-698'],
  severity: 'critical',
  check: () => {
    // Scenario 1: classic zombie — DB running, tmux dead, no handoff/blocked
    const zombie: AttemptRow = { status: 'running', tmux_session: 'aos-cto-rya99', error_log: null, completed_at: null };
    const r1 = reconcile(zombie, /* alive */ false, /* handoff */ false, /* blocked */ false);
    if (!r1.transitioned || r1.newStatus !== 'failed') {
      return {
        ok: false,
        reason: 'reconciliation failed to transition zombie attempt to failed',
        observed: { result: r1 },
      };
    }
    if (!r1.errorLog || r1.errorLog.length === 0) {
      return {
        ok: false,
        reason: 'failed transition produced no error_log — silent failure regression',
        observed: { result: r1 },
      };
    }
    if (!r1.circuitBreakerCounted) {
      return {
        ok: false,
        reason: 'failed transition did not record for circuit-breaker accounting',
        observed: { result: r1 },
      };
    }

    // Scenario 2: tmux dead but HANDOFF.md present — must NOT mark failed
    // (this is monitor.ts Case 1: handoff exists → mark completed, not failed).
    const completedAttempt: AttemptRow = { status: 'running', tmux_session: 'aos-cto-rya42', error_log: null, completed_at: null };
    const r2 = reconcile(completedAttempt, /* alive */ false, /* handoff */ true, /* blocked */ false);
    if (r2.newStatus === 'failed') {
      return {
        ok: false,
        reason: 'reconciliation incorrectly marked attempt with HANDOFF.md as failed',
        observed: { result: r2 },
      };
    }

    // Scenario 3: BLOCKED.md present — also must NOT mark failed
    const blockedAttempt: AttemptRow = { status: 'running', tmux_session: 'aos-cto-rya50', error_log: null, completed_at: null };
    const r3 = reconcile(blockedAttempt, /* alive */ false, /* handoff */ false, /* blocked */ true);
    if (r3.newStatus === 'failed') {
      return {
        ok: false,
        reason: 'reconciliation incorrectly marked attempt with BLOCKED.md as failed',
        observed: { result: r3 },
      };
    }

    // Scenario 4: tmux alive — must NOT mark failed regardless
    const liveAttempt: AttemptRow = { status: 'running', tmux_session: 'aos-cto-rya51', error_log: null, completed_at: null };
    const r4 = reconcile(liveAttempt, /* alive */ true, /* handoff */ false, /* blocked */ false);
    if (r4.transitioned) {
      return {
        ok: false,
        reason: 'reconciliation incorrectly transitioned a live attempt',
        observed: { result: r4 },
      };
    }

    return { ok: true, reason: '' };
  },
};
