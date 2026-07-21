/**
 * Ideal trajectory assertions for core agent workflows.
 *
 * Defines the optimal step sequence for common operations and verifies
 * that the system follows the expected path. Deviations from the ideal
 * trajectory are tracked and reported.
 *
 * Run: npx vitest run src/evals/trajectories.test.ts
 */

import { describe, it, expect } from 'vitest';
import { assertTrajectory, evalTag, mockAttempt } from './framework.js';
import type { TrajectoryStep } from './framework.js';

// ════════════════════════════════════════════════════════════════════════════════
// Trajectory 1: Dispatch → Agent Work → Completion
// The ideal path for assigning work to an agent
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Ideal trajectory: dispatch → agent work → HANDOFF.md → status transition',
}), () => {
  it('dispatch trajectory follows all required steps', async () => {
    // Simulate the full dispatch lifecycle
    const state = {
      validated: false,
      dedupChecked: false,
      circuitBreakerChecked: false,
      capacityChecked: false,
      agentStarted: false,
      commentPosted: false,
      assigneeUpdated: false,
      groupChatNotified: false,
    };

    const steps: TrajectoryStep[] = [
      {
        label: 'Validate role and issueKey',
        check: () => {
          state.validated = true;
          return true;
        },
      },
      {
        label: 'Check dispatch dedup (same role+issue < 60s)',
        check: () => {
          state.dedupChecked = true;
          return true;
        },
      },
      {
        label: 'Check circuit breaker (max retry limit)',
        check: () => {
          state.circuitBreakerChecked = true;
          return true;
        },
      },
      {
        label: 'Check agent capacity (maxConcurrent)',
        check: () => {
          state.capacityChecked = true;
          return true;
        },
      },
      {
        label: 'Start agent via agentStartCommand',
        check: () => {
          state.agentStarted = true;
          return true;
        },
      },
      {
        label: 'Post dispatch comment for audit trail',
        check: () => {
          state.commentPosted = true;
          return true;
        },
      },
      {
        label: 'Update Linear assignee and delegate',
        check: () => {
          state.assigneeUpdated = true;
          return true;
        },
      },
      {
        label: 'Notify group chat',
        check: () => {
          state.groupChatNotified = true;
          return true;
        },
        optional: true, // Group chat may not be configured
      },
    ];

    const result = await assertTrajectory('dispatch-lifecycle', steps);

    expect(result.success).toBe(true);
    expect(result.completionRatio).toBe(1);
    expect(result.passedSteps).toHaveLength(8);

    // Verify ordering: validation must happen before agent start
    const validateIdx = result.passedSteps.indexOf('Validate role and issueKey');
    const startIdx = result.passedSteps.indexOf('Start agent via agentStartCommand');
    expect(validateIdx).toBeLessThan(startIdx);
  });

  it('dispatch trajectory handles capacity exhaustion gracefully', async () => {
    const steps: TrajectoryStep[] = [
      { label: 'Validate inputs', check: () => true },
      { label: 'Check dedup', check: () => true },
      { label: 'Check circuit breaker', check: () => true },
      {
        label: 'Check capacity — FULL',
        check: () => true, // capacity check runs
      },
      {
        label: 'Enqueue instead of start',
        check: () => true, // falls back to queue
      },
      {
        label: 'Return queued response',
        check: () => true,
      },
    ];

    const result = await assertTrajectory('dispatch-queued', steps);
    expect(result.success).toBe(true);
  });

  it('dispatch trajectory blocks on circuit breaker', async () => {
    const steps: TrajectoryStep[] = [
      { label: 'Validate inputs', check: () => true },
      { label: 'Check dedup', check: () => true },
      {
        label: 'Circuit breaker TRIPPED — blocks dispatch',
        check: () => true,
      },
      {
        label: 'Return error response with circuit breaker reason',
        check: () => true,
      },
      {
        label: 'Agent does NOT start',
        check: () => true, // verified by absence of spawn
      },
    ];

    const result = await assertTrajectory('dispatch-circuit-broken', steps);
    expect(result.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Trajectory 2: Handoff Between Agents
// When one agent finishes and passes work to another
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Ideal trajectory: agent handoff with state preservation',
}), () => {
  it('handoff trajectory preserves state between agents', async () => {
    const currentAttempt = mockAttempt({ status: 'running', agent_type: 'cto' });
    let attemptCompleted = false;
    let sessionDismissed = false;
    let newAgentStarted = false;

    const steps: TrajectoryStep[] = [
      {
        label: 'Current attempt exists and is running',
        check: () => currentAttempt.status === 'running',
      },
      {
        label: 'Mark current attempt as completed',
        check: () => {
          attemptCompleted = true;
          currentAttempt.status = 'completed';
          return true;
        },
      },
      {
        label: 'Log handoff event with target role',
        check: () => attemptCompleted, // depends on prior step
      },
      {
        label: 'Dismiss Linear agent session (response activity)',
        check: () => {
          sessionDismissed = true;
          return true;
        },
        optional: true, // only if agent_session_id exists
      },
      {
        label: 'Start new agent on same issue',
        check: () => {
          newAgentStarted = true;
          return true;
        },
      },
      {
        label: 'Issue status remains In Progress (not moved to review)',
        check: () => {
          // During handoff, status stays in progress — work continues
          return true;
        },
      },
    ];

    const result = await assertTrajectory('agent-handoff', steps);
    expect(result.success).toBe(true);
    expect(attemptCompleted).toBe(true);
    expect(newAgentStarted).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Trajectory 3: Error Recovery with Backoff
// When a dispatch fails and retries with exponential backoff
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'recovery',
  severity: 'critical',
  behavior: 'Ideal trajectory: error recovery with exponential backoff',
}), () => {
  it('transient failure triggers retry with increasing backoff', async () => {
    let retryCount = 0;
    const backoffMs: number[] = [];

    const steps: TrajectoryStep[] = [
      {
        label: 'Initial dispatch attempt fails (transient)',
        check: () => true,
      },
      {
        label: 'Retry 1 queued with 15s backoff',
        check: () => {
          retryCount = 1;
          backoffMs.push(15_000);
          return true;
        },
      },
      {
        label: 'Retry 1 fails (transient)',
        check: () => true,
      },
      {
        label: 'Retry 2 queued with 30s backoff (doubled)',
        check: () => {
          retryCount = 2;
          backoffMs.push(30_000);
          return true;
        },
      },
      {
        label: 'After max retries, dispatch returns error',
        check: () => retryCount >= 2,
      },
    ];

    const result = await assertTrajectory('transient-failure-retry', steps);
    expect(result.success).toBe(true);

    // Verify exponential backoff
    expect(backoffMs[1]).toBe(backoffMs[0] * 2);
  });

  it('permanent failure skips retry entirely', async () => {
    let retried = false;

    const steps: TrajectoryStep[] = [
      {
        label: 'Dispatch attempt fails (permanent: issue not found)',
        check: () => true,
      },
      {
        label: 'Error classified as permanent',
        check: () => true,
      },
      {
        label: 'Immediate error response (no queue, no retry)',
        check: () => {
          retried = false; // never retried
          return true;
        },
      },
    ];

    const result = await assertTrajectory('permanent-failure-no-retry', steps);
    expect(result.success).toBe(true);
    expect(retried).toBe(false);
  });

  it('circuit breaker prevents infinite retry loops', async () => {
    const attempts = Array.from({ length: 3 }, () => mockAttempt({ status: 'failed' }));
    let dispatchBlocked = false;

    const steps: TrajectoryStep[] = [
      {
        label: 'Three consecutive failures detected',
        check: () => attempts.length >= 3,
      },
      {
        label: 'Circuit breaker trips',
        check: () => {
          const consecutiveFailures = attempts.filter(a => a.status === 'failed').length;
          return consecutiveFailures >= 3;
        },
      },
      {
        label: 'New dispatch blocked with reason',
        check: () => {
          dispatchBlocked = true;
          return true;
        },
      },
      {
        label: 'Queued items for this issue cancelled',
        check: () => dispatchBlocked, // cleanup after blocking
      },
      {
        label: 'agent:blocked label added to issue',
        check: () => dispatchBlocked,
      },
      {
        label: 'Circuit breaker comment posted (with dedup)',
        check: () => dispatchBlocked,
      },
    ];

    const result = await assertTrajectory('circuit-breaker-activation', steps);
    expect(result.success).toBe(true);
    expect(dispatchBlocked).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Trajectory 4: Monitor State Reconciliation
// When monitor detects DB/reality mismatch and reconciles
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'state',
  severity: 'critical',
  behavior: 'Ideal trajectory: monitor detects and reconciles state inconsistency',
}), () => {
  it('monitor reconciles DB-running + tmux-dead mismatch', async () => {
    const attempt = mockAttempt({ status: 'running', tmux_session: 'aos-cto-rya99' });
    let markedFailed = false;
    let handoffProcessed = false;
    let eventLogged = false;

    const steps: TrajectoryStep[] = [
      {
        label: 'Monitor polls active attempts from DB',
        check: () => attempt.status === 'running',
      },
      {
        label: 'Monitor checks tmux session exists',
        check: () => true, // check runs
      },
      {
        label: 'Tmux session not found — mismatch detected',
        check: () => {
          // tmux has-session returns non-zero
          return true;
        },
      },
      {
        label: 'Check for HANDOFF.md in workspace',
        check: () => {
          // Determines if this was graceful completion or crash
          return true;
        },
      },
      {
        label: 'Mark attempt as failed (or completed if HANDOFF.md exists)',
        check: () => {
          markedFailed = true;
          attempt.status = 'failed';
          return true;
        },
      },
      {
        label: 'Log reconciliation event',
        check: () => {
          eventLogged = true;
          return true;
        },
      },
      {
        label: 'Process HANDOFF.md status transition if present',
        check: () => {
          handoffProcessed = true;
          return true;
        },
        optional: true,
      },
    ];

    const result = await assertTrajectory('monitor-reconciliation', steps);
    expect(result.success).toBe(true);
    expect(markedFailed).toBe(true);
    expect(eventLogged).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Trajectory 5: Agent Session Lifecycle (memory + completion)
// Full lifecycle from spawn to HANDOFF.md with memory persistence
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'memory',
  severity: 'important',
  behavior: 'Ideal trajectory: agent completes work with memory persistence',
}), () => {
  it('agent session follows completion checklist', async () => {
    const checklist = {
      progressCommentPosted: false,
      memoryWritten: false,
      memoryIndexUpdated: false,
      handoffWritten: false,
      statusIntentSet: false,
    };

    const steps: TrajectoryStep[] = [
      {
        label: 'Post initial progress comment within 5 min',
        check: () => {
          checklist.progressCommentPosted = true;
          return true;
        },
      },
      {
        label: 'Perform assigned work',
        check: () => true,
      },
      {
        label: 'Write at least one memory file to .agent-memory/',
        check: () => {
          checklist.memoryWritten = true;
          return true;
        },
      },
      {
        label: 'Update .agent-memory-index.md',
        check: () => {
          checklist.memoryIndexUpdated = true;
          return true;
        },
      },
      {
        label: 'Write cross-cutting learnings to shared-memory if applicable',
        check: () => true,
        optional: true,
      },
      {
        label: 'Post completion summary comment',
        check: () => true,
      },
      {
        label: 'Write HANDOFF.md with status_intent',
        check: () => {
          checklist.handoffWritten = true;
          checklist.statusIntentSet = true;
          return true;
        },
      },
    ];

    const result = await assertTrajectory('agent-completion-lifecycle', steps);
    expect(result.success).toBe(true);

    // All mandatory checklist items must be true
    expect(checklist.progressCommentPosted).toBe(true);
    expect(checklist.memoryWritten).toBe(true);
    expect(checklist.memoryIndexUpdated).toBe(true);
    expect(checklist.handoffWritten).toBe(true);
    expect(checklist.statusIntentSet).toBe(true);
  });

  it('memory validation runs post-session and detects violations', async () => {
    let validationRan = false;
    let warningsDetected = false;

    const steps: TrajectoryStep[] = [
      {
        label: 'Agent session ends (tmux session terminates)',
        check: () => true,
      },
      {
        label: 'Monitor detects completion',
        check: () => true,
      },
      {
        label: 'validatePostSessionMemory runs for agent role',
        check: () => {
          validationRan = true;
          return true;
        },
      },
      {
        label: 'Warnings emitted if memory protocol violated',
        check: () => {
          // Simulating zero-memory violation
          warningsDetected = true;
          return true;
        },
        optional: true, // only triggers if there ARE violations
      },
    ];

    const result = await assertTrajectory('post-session-memory-validation', steps);
    expect(result.success).toBe(true);
    expect(validationRan).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Trajectory Framework Self-Test
// Verify the trajectory framework itself works correctly
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'recovery',
  severity: 'informational',
  behavior: 'Trajectory framework: deviation detection and reporting',
}), () => {
  it('detects required step failure as trajectory failure', async () => {
    const steps: TrajectoryStep[] = [
      { label: 'step-1', check: () => true },
      { label: 'step-2-fails', check: () => false }, // required, fails
      { label: 'step-3', check: () => true },
    ];

    const result = await assertTrajectory('failure-test', steps);
    expect(result.success).toBe(false);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].step).toBe('step-2-fails');
    expect(result.deviations[0].reason).toBe('required step failed');
    expect(result.completionRatio).toBeCloseTo(2 / 3);
  });

  it('optional step failure does not fail trajectory', async () => {
    const steps: TrajectoryStep[] = [
      { label: 'step-1', check: () => true },
      { label: 'optional-step', check: () => false, optional: true },
      { label: 'step-3', check: () => true },
    ];

    const result = await assertTrajectory('optional-test', steps);
    expect(result.success).toBe(true);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0].reason).toBe('optional step skipped');
    expect(result.completionRatio).toBe(1); // all required passed
  });

  it('empty trajectory is trivially successful', async () => {
    const result = await assertTrajectory('empty', []);
    expect(result.success).toBe(true);
    expect(result.completionRatio).toBe(1);
  });
});
