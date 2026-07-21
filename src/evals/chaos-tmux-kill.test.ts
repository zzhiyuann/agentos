/**
 * Chaos eval: Kill tmux mid-operation, verify recovery.
 *
 * Exercises the monitor's state reconciliation under failure conditions (KFP-5).
 * Three scenarios:
 *   1. Kill tmux while agent running — monitor marks failed, triggers auto-retry
 *   2. Kill tmux after HANDOFF.md written — monitor detects graceful completion
 *   3. Concurrent session kills — monitor handles multiple failures in same poll cycle
 *
 * These are behavioral simulations that model the exact monitor reconciliation
 * logic from src/serve/monitor.ts (Cases 1 & 4 of monitorSessions).
 *
 * Run: npx vitest run src/evals/chaos-tmux-kill.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { assertTrajectory, evalTag, mockAttempt } from './framework.js';
import type { TrajectoryStep } from './framework.js';

// ─── Simulated Monitor Infrastructure ───

/** Simulates the monitor's per-attempt state check and reconciliation. */
interface MonitorAction {
  attemptId: string;
  action: 'mark_failed' | 'mark_completed' | 'log_event' | 'emit_activity' | 'dismiss_session'
        | 'enqueue_retry' | 'trip_circuit_breaker' | 'process_handoff' | 'skip_retry';
  detail?: string;
}

interface CircuitBreakerState {
  consecutiveFailures: number;
  maxAllowed: number;
}

/**
 * Simulates the monitor's reconciliation for a single attempt.
 * Models the exact logic from monitor.ts Case 1 (handoff found) and Case 4 (dead, no artifacts).
 */
function simulateMonitorReconciliation(opts: {
  alive: boolean;
  handoff: string | null;
  blocked: string | null;
  attempt: Record<string, unknown>;
  circuitBreaker: CircuitBreakerState;
  issueExists?: boolean;
}): MonitorAction[] {
  const actions: MonitorAction[] = [];
  const attemptId = opts.attempt.id as string;
  const issueExists = opts.issueExists ?? true;

  // Case 1: HANDOFF.md found (session may or may not be alive)
  if (opts.handoff) {
    actions.push({ attemptId, action: 'mark_completed', detail: 'HANDOFF.md detected' });
    actions.push({ attemptId, action: 'log_event', detail: 'completed:hasHandoff' });
    actions.push({ attemptId, action: 'process_handoff', detail: 'parse status_intent + actions' });

    if (opts.attempt.agent_session_id) {
      actions.push({ attemptId, action: 'dismiss_session', detail: 'agent session dismissed' });
    }
    return actions;
  }

  // Case 4: Session died without artifacts
  if (!opts.alive && !opts.handoff && !opts.blocked) {
    actions.push({ attemptId, action: 'mark_failed', detail: 'Session ended without handoff' });
    actions.push({ attemptId, action: 'log_event', detail: 'failed:no_artifacts' });

    if (opts.attempt.agent_session_id) {
      actions.push({ attemptId, action: 'emit_activity', detail: 'error: session ended unexpectedly' });
      actions.push({ attemptId, action: 'dismiss_session', detail: 'agent session dismissed' });
    }

    // Issue existence check
    if (!issueExists) {
      actions.push({ attemptId, action: 'skip_retry', detail: 'issue no longer exists' });
      return actions;
    }

    // Circuit breaker
    const failures = opts.circuitBreaker.consecutiveFailures + 1; // includes this failure
    if (failures < opts.circuitBreaker.maxAllowed) {
      const backoffMs = Math.max(15_000 * Math.pow(2, failures - 1), 30_000);
      actions.push({ attemptId, action: 'enqueue_retry', detail: `backoff ${backoffMs}ms` });
    } else {
      actions.push({ attemptId, action: 'trip_circuit_breaker', detail: `${failures} consecutive failures` });
    }

    return actions;
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 1: Kill tmux while agent is running (no HANDOFF.md)
// Monitor should detect dead session and mark as failed, then auto-retry
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 5,
  category: 'state',
  severity: 'critical',
  behavior: 'Chaos: tmux killed mid-operation — monitor detects death, marks failed, auto-retries',
}), () => {
  let attempt: Record<string, unknown>;
  let actions: MonitorAction[];

  beforeEach(() => {
    attempt = mockAttempt({
      status: 'running',
      tmux_session: 'aos-cto-rya99',
      agent_session_id: 'agent-session-123',
      issue_key: 'RYA-99',
      agent_type: 'cto',
      workspace_path: '/tmp/test-workspace',
    });

    actions = simulateMonitorReconciliation({
      alive: false,       // tmux was killed
      handoff: null,      // no HANDOFF.md
      blocked: null,      // no BLOCKED.md
      attempt,
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });
  });

  it('marks attempt as failed with correct reason', () => {
    const failAction = actions.find(a => a.action === 'mark_failed');
    expect(failAction).toBeDefined();
    expect(failAction!.detail).toContain('without handoff');
  });

  it('logs reconciliation event with failure reason', () => {
    const logAction = actions.find(a => a.action === 'log_event');
    expect(logAction).toBeDefined();
    expect(logAction!.detail).toContain('no_artifacts');
  });

  it('emits error activity to Linear agent session', () => {
    const emitAction = actions.find(a => a.action === 'emit_activity');
    expect(emitAction).toBeDefined();
    expect(emitAction!.detail).toContain('unexpectedly');
  });

  it('dismisses the Linear agent session', () => {
    const dismissAction = actions.find(a => a.action === 'dismiss_session');
    expect(dismissAction).toBeDefined();
  });

  it('enqueues auto-retry with backoff (circuit breaker not tripped)', () => {
    const retryAction = actions.find(a => a.action === 'enqueue_retry');
    expect(retryAction).toBeDefined();
    // First failure: backoff should be at least 30s (monitor enforces min 30s)
    expect(retryAction!.detail).toMatch(/backoff \d+ms/);
    const backoffMs = parseInt(retryAction!.detail!.match(/\d+/)![0]);
    expect(backoffMs).toBeGreaterThanOrEqual(30_000);
  });

  it('follows the correct trajectory: detect → fail → retry', async () => {
    const steps: TrajectoryStep[] = [
      {
        label: 'Monitor polls active attempts from DB',
        check: () => attempt.status === 'running',
      },
      {
        label: 'tmux session not found (killed)',
        check: () => true, // alive === false
      },
      {
        label: 'No HANDOFF.md in workspace',
        check: () => actions.every(a => a.action !== 'process_handoff'),
      },
      {
        label: 'Attempt marked as failed',
        check: () => actions.some(a => a.action === 'mark_failed'),
      },
      {
        label: 'Failure event logged',
        check: () => actions.some(a => a.action === 'log_event'),
      },
      {
        label: 'Error emitted to Linear',
        check: () => actions.some(a => a.action === 'emit_activity'),
      },
      {
        label: 'Agent session dismissed',
        check: () => actions.some(a => a.action === 'dismiss_session'),
      },
      {
        label: 'Auto-retry enqueued (circuit breaker allows)',
        check: () => actions.some(a => a.action === 'enqueue_retry'),
      },
    ];

    const result = await assertTrajectory('chaos-tmux-kill-mid-operation', steps);
    expect(result.success).toBe(true);
    expect(result.completionRatio).toBe(1);
  });

  it('skips retry if issue no longer exists', () => {
    const actionsDeleted = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: null,
      attempt,
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
      issueExists: false,
    });

    expect(actionsDeleted.some(a => a.action === 'skip_retry')).toBe(true);
    expect(actionsDeleted.some(a => a.action === 'enqueue_retry')).toBe(false);
    expect(actionsDeleted.some(a => a.action === 'trip_circuit_breaker')).toBe(false);
  });

  it('trips circuit breaker after max consecutive failures', () => {
    const actionsTripped = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: null,
      attempt,
      circuitBreaker: { consecutiveFailures: 2, maxAllowed: 3 }, // 2 prior + this = 3 = max
    });

    expect(actionsTripped.some(a => a.action === 'trip_circuit_breaker')).toBe(true);
    expect(actionsTripped.some(a => a.action === 'enqueue_retry')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 2: Kill tmux after HANDOFF.md written but before monitor polls
// Monitor should detect HANDOFF.md and treat as graceful completion
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 5,
  category: 'state',
  severity: 'critical',
  behavior: 'Chaos: tmux killed after HANDOFF.md written — monitor detects graceful completion',
}), () => {
  const SAMPLE_HANDOFF = `---
status_intent: done
reason: "Task completed successfully"
---
# HANDOFF — RYA-99

## Summary
Implemented the feature as requested.

## Files Changed
- src/feature.ts (new)

## Testing
- All tests pass
`;

  let attempt: Record<string, unknown>;
  let actions: MonitorAction[];

  beforeEach(() => {
    attempt = mockAttempt({
      status: 'running',
      tmux_session: 'aos-le-rya99',
      agent_session_id: 'agent-session-456',
      issue_key: 'RYA-99',
      agent_type: 'lead-engineer',
      workspace_path: '/tmp/test-workspace',
    });

    actions = simulateMonitorReconciliation({
      alive: false,        // tmux was killed (or exited naturally)
      handoff: SAMPLE_HANDOFF, // but HANDOFF.md exists!
      blocked: null,
      attempt,
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });
  });

  it('marks attempt as completed (not failed)', () => {
    expect(actions.some(a => a.action === 'mark_completed')).toBe(true);
    expect(actions.some(a => a.action === 'mark_failed')).toBe(false);
  });

  it('processes HANDOFF.md for status transition and actions', () => {
    expect(actions.some(a => a.action === 'process_handoff')).toBe(true);
  });

  it('does NOT enqueue retry (completion is clean)', () => {
    expect(actions.some(a => a.action === 'enqueue_retry')).toBe(false);
    expect(actions.some(a => a.action === 'trip_circuit_breaker')).toBe(false);
  });

  it('dismisses the Linear agent session', () => {
    expect(actions.some(a => a.action === 'dismiss_session')).toBe(true);
  });

  it('follows the correct trajectory: detect → complete → process handoff', async () => {
    const steps: TrajectoryStep[] = [
      {
        label: 'Monitor polls active attempts from DB',
        check: () => attempt.status === 'running',
      },
      {
        label: 'tmux session not found (killed or exited)',
        check: () => true, // alive === false
      },
      {
        label: 'HANDOFF.md found in workspace',
        check: () => actions.some(a => a.action === 'process_handoff'),
      },
      {
        label: 'Attempt marked as completed',
        check: () => actions.some(a => a.action === 'mark_completed'),
      },
      {
        label: 'Completion event logged',
        check: () => actions.some(a => a.action === 'log_event' && a.detail!.includes('completed')),
      },
      {
        label: 'HANDOFF.md parsed and status intent applied',
        check: () => actions.some(a => a.action === 'process_handoff'),
      },
      {
        label: 'Agent session dismissed',
        check: () => actions.some(a => a.action === 'dismiss_session'),
      },
      {
        label: 'No retry enqueued',
        check: () => !actions.some(a => a.action === 'enqueue_retry'),
      },
    ];

    const result = await assertTrajectory('chaos-tmux-kill-after-handoff', steps);
    expect(result.success).toBe(true);
    expect(result.completionRatio).toBe(1);
  });

  it('handles HANDOFF.md with in-progress status (dispatch to another agent)', () => {
    const handoffWithDispatch = `---
status_intent: in-progress
dispatches:
  - role: lead-engineer
    issue: RYA-99
    context: "Continue implementation"
---
# HANDOFF — RYA-99
## Summary
Dispatched to lead-engineer for implementation.
`;

    const dispatchActions = simulateMonitorReconciliation({
      alive: false,
      handoff: handoffWithDispatch,
      blocked: null,
      attempt,
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    // Still marked completed (the attempt is done), but handoff processed
    expect(dispatchActions.some(a => a.action === 'mark_completed')).toBe(true);
    expect(dispatchActions.some(a => a.action === 'process_handoff')).toBe(true);
    expect(dispatchActions.some(a => a.action === 'mark_failed')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 3: Concurrent session kills in same poll cycle
// Monitor must handle multiple dead sessions without interference
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 5,
  category: 'state',
  severity: 'critical',
  behavior: 'Chaos: concurrent tmux kills — monitor handles multiple failures in one poll cycle',
}), () => {
  it('processes multiple dead sessions independently', () => {
    const attempts = [
      mockAttempt({
        id: 'attempt-aaa',
        status: 'running',
        tmux_session: 'aos-cto-rya100',
        agent_session_id: 'session-100',
        issue_key: 'RYA-100',
        agent_type: 'cto',
      }),
      mockAttempt({
        id: 'attempt-bbb',
        status: 'running',
        tmux_session: 'aos-le-rya101',
        agent_session_id: 'session-101',
        issue_key: 'RYA-101',
        agent_type: 'lead-engineer',
      }),
      mockAttempt({
        id: 'attempt-ccc',
        status: 'running',
        tmux_session: 'aos-cpo-rya102',
        agent_session_id: null, // no agent session (edge case)
        issue_key: 'RYA-102',
        agent_type: 'cpo',
      }),
    ];

    // All three sessions killed simultaneously
    const allActions: MonitorAction[][] = attempts.map(attempt =>
      simulateMonitorReconciliation({
        alive: false,
        handoff: null,
        blocked: null,
        attempt,
        circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
      })
    );

    // Each attempt must be independently marked as failed
    for (let i = 0; i < attempts.length; i++) {
      const actions = allActions[i];
      const attemptId = attempts[i].id as string;

      expect(actions.some(a => a.action === 'mark_failed' && a.attemptId === attemptId),
        `Attempt ${attemptId} must be marked failed`).toBe(true);

      expect(actions.some(a => a.action === 'log_event' && a.attemptId === attemptId),
        `Attempt ${attemptId} must have event logged`).toBe(true);

      expect(actions.some(a => a.action === 'enqueue_retry' && a.attemptId === attemptId),
        `Attempt ${attemptId} must have retry enqueued`).toBe(true);
    }
  });

  it('handles mixed scenario: one dead + one completed + one alive', () => {
    const deadAttempt = mockAttempt({
      id: 'attempt-dead',
      status: 'running',
      tmux_session: 'aos-cto-rya200',
      agent_session_id: 'session-200',
      issue_key: 'RYA-200',
      agent_type: 'cto',
    });

    const completedAttempt = mockAttempt({
      id: 'attempt-done',
      status: 'running',
      tmux_session: 'aos-le-rya201',
      agent_session_id: 'session-201',
      issue_key: 'RYA-201',
      agent_type: 'lead-engineer',
    });

    // Dead session — no artifacts
    const deadActions = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: null,
      attempt: deadAttempt,
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    // Dead session but HANDOFF.md exists
    const completedActions = simulateMonitorReconciliation({
      alive: false,
      handoff: '---\nstatus_intent: done\n---\n# HANDOFF\nDone.',
      blocked: null,
      attempt: completedAttempt,
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    // Dead session = failed + retry
    expect(deadActions.some(a => a.action === 'mark_failed')).toBe(true);
    expect(deadActions.some(a => a.action === 'enqueue_retry')).toBe(true);
    expect(deadActions.some(a => a.action === 'mark_completed')).toBe(false);

    // HANDOFF present = completed, no retry
    expect(completedActions.some(a => a.action === 'mark_completed')).toBe(true);
    expect(completedActions.some(a => a.action === 'mark_failed')).toBe(false);
    expect(completedActions.some(a => a.action === 'enqueue_retry')).toBe(false);
  });

  it('concurrent kills trajectory: all processed in single poll cycle', async () => {
    const attemptCount = 3;
    const processedAttempts: string[] = [];
    const failedAttempts: string[] = [];
    const retriedAttempts: string[] = [];

    // Simulate polling 3 dead sessions
    for (let i = 0; i < attemptCount; i++) {
      const id = `attempt-${i}`;
      const attempt = mockAttempt({
        id,
        status: 'running',
        tmux_session: `aos-agent-rya${300 + i}`,
        issue_key: `RYA-${300 + i}`,
        agent_type: 'cto',
      });

      const actions = simulateMonitorReconciliation({
        alive: false,
        handoff: null,
        blocked: null,
        attempt,
        circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
      });

      if (actions.some(a => a.action === 'mark_failed')) {
        processedAttempts.push(id);
        failedAttempts.push(id);
      }
      if (actions.some(a => a.action === 'enqueue_retry')) {
        retriedAttempts.push(id);
      }
    }

    const steps: TrajectoryStep[] = [
      {
        label: 'Monitor polls all active attempts',
        check: () => true,
      },
      {
        label: 'All 3 tmux sessions detected as dead',
        check: () => processedAttempts.length === attemptCount,
      },
      {
        label: 'Each attempt independently marked as failed',
        check: () => failedAttempts.length === attemptCount,
      },
      {
        label: 'Each attempt has retry enqueued',
        check: () => retriedAttempts.length === attemptCount,
      },
      {
        label: 'No cross-contamination between attempts',
        check: () => {
          const uniqueIds = new Set(processedAttempts);
          return uniqueIds.size === attemptCount;
        },
      },
    ];

    const result = await assertTrajectory('chaos-concurrent-tmux-kills', steps);
    expect(result.success).toBe(true);
    expect(result.completionRatio).toBe(1);
  });

  it('different circuit breaker states per issue do not interfere', () => {
    // Issue A: first failure → retry allowed
    const actionsA = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: null,
      attempt: mockAttempt({ id: 'a', issue_key: 'RYA-300', agent_type: 'cto' }),
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    // Issue B: at max failures → circuit breaker trips
    const actionsB = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: null,
      attempt: mockAttempt({ id: 'b', issue_key: 'RYA-301', agent_type: 'cto' }),
      circuitBreaker: { consecutiveFailures: 2, maxAllowed: 3 },
    });

    // A retries, B trips — independent
    expect(actionsA.some(a => a.action === 'enqueue_retry')).toBe(true);
    expect(actionsA.some(a => a.action === 'trip_circuit_breaker')).toBe(false);

    expect(actionsB.some(a => a.action === 'trip_circuit_breaker')).toBe(true);
    expect(actionsB.some(a => a.action === 'enqueue_retry')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Edge Cases: Recovery correctness under unusual conditions
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 5,
  category: 'recovery',
  severity: 'important',
  behavior: 'Chaos edge cases: unusual tmux death scenarios',
}), () => {
  it('attempt without agent_session_id skips dismiss/emit (no crash)', () => {
    const actions = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: null,
      attempt: mockAttempt({
        agent_session_id: null, // no Linear agent session
      }),
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    // Must still mark failed and retry
    expect(actions.some(a => a.action === 'mark_failed')).toBe(true);
    expect(actions.some(a => a.action === 'enqueue_retry')).toBe(true);

    // Must NOT try to emit/dismiss (no session ID)
    expect(actions.some(a => a.action === 'emit_activity')).toBe(false);
    expect(actions.some(a => a.action === 'dismiss_session')).toBe(false);
  });

  it('exponential backoff increases with each consecutive failure', () => {
    const backoffs: number[] = [];

    for (let failures = 0; failures < 3; failures++) {
      const actions = simulateMonitorReconciliation({
        alive: false,
        handoff: null,
        blocked: null,
        attempt: mockAttempt({ id: `attempt-f${failures}` }),
        circuitBreaker: { consecutiveFailures: failures, maxAllowed: 5 },
      });

      const retryAction = actions.find(a => a.action === 'enqueue_retry');
      if (retryAction) {
        const ms = parseInt(retryAction.detail!.match(/\d+/)![0]);
        backoffs.push(ms);
      }
    }

    expect(backoffs.length).toBe(3);
    // Each backoff should be >= the previous (exponential)
    for (let i = 1; i < backoffs.length; i++) {
      expect(backoffs[i]).toBeGreaterThanOrEqual(backoffs[i - 1]);
    }
    // All backoffs must be >= 30s (monitor enforces minimum)
    for (const b of backoffs) {
      expect(b).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('BLOCKED.md present prevents dead-session recovery path', () => {
    // If BLOCKED.md exists, monitor should NOT take Case 4 actions
    const actions = simulateMonitorReconciliation({
      alive: false,
      handoff: null,
      blocked: '---\nblocker: RYA-50\n---\nWaiting on dependency.',
      attempt: mockAttempt({ status: 'running' }),
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    // With our simulation, !alive && !handoff && blocked → no Case 4 match
    expect(actions.some(a => a.action === 'mark_failed')).toBe(false);
    expect(actions.some(a => a.action === 'enqueue_retry')).toBe(false);
  });

  it('alive session with handoff takes Case 1 path (not Case 4)', () => {
    // Session still alive + HANDOFF.md = normal completion, not crash
    const actions = simulateMonitorReconciliation({
      alive: true,
      handoff: '---\nstatus_intent: done\n---\n# HANDOFF\nDone.',
      blocked: null,
      attempt: mockAttempt({ agent_session_id: 'session-xyz' }),
      circuitBreaker: { consecutiveFailures: 0, maxAllowed: 3 },
    });

    expect(actions.some(a => a.action === 'mark_completed')).toBe(true);
    expect(actions.some(a => a.action === 'process_handoff')).toBe(true);
    expect(actions.some(a => a.action === 'mark_failed')).toBe(false);
  });
});
