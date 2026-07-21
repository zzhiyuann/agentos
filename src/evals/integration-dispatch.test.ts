/**
 * End-to-end integration eval for the dispatch lifecycle.
 *
 * Exercises real dispatch pipeline logic (handleDispatch) with mocked I/O
 * (Linear API, tmux, agent spawning). Validates the full system integration:
 *
 *   dispatch → validate → dedup → circuit-breaker → capacity → start/queue
 *   HANDOFF.md parsing → status transition → monitor detection
 *
 * Key scenarios:
 *   1. Successful dispatch (full pipeline)
 *   2. Capacity exhaustion → queue
 *   3. Circuit breaker trip → blocked
 *   4. Dedup protection (same role+issue < 60s)
 *   5. Handoff between agents
 *   6. HANDOFF.md parsing + status intent resolution
 *   7. Monitor state reconciliation (DB ↔ tmux)
 *
 * Run: npx vitest run src/evals/integration-dispatch.test.ts
 */

// Align team key with the 'RYA-*' issue keys used throughout this file so the
// cross-team guard in handleDispatch() doesn't reject every dispatch.
// (vitest.setup.ts defaults AOS_LINEAR_TEAM_KEY='TEST'; must be overridden
// before any module reads it via getConfig().)
process.env.AOS_LINEAR_TEAM_KEY = 'RYA';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertTrajectory, evalTag, mockAttempt } from './framework.js';
import type { TrajectoryStep } from './framework.js';

// ─── Mock Setup ─────────────────────────────────────────────────────────────
// Mock all external I/O before importing real modules.
// The dispatch pipeline calls: persona, linear, db, queue, router, tmux, agent start.

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn((role: string) => ['cto', 'lead-engineer', 'cpo'].includes(role)),
  loadAgentConfig: vi.fn(() => ({
    baseModel: 'cc',
    maxParallel: 2,
    linearUserId: 'user-uuid-123',
  })),
  getAgentLinearToken: vi.fn(() => 'mock-agent-token'),
  loadPersona: vi.fn(() => ({ config: { baseModel: 'cc' }, memories: [] })),
  listAgents: vi.fn(() => ['cto', 'lead-engineer', 'cpo']),
  getAgentsDir: vi.fn(() => '/tmp/test-agents'),
}));

vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(async (key: string) => ({
    id: `issue-uuid-${key}`,
    identifier: key,
    title: `Test issue ${key}`,
    description: 'Test description',
    labels: [],
    project: 'TestProject',
    assigneeId: null,
    state: { name: 'In Progress' },
  })),
  addComment: vi.fn(async () => ({ id: 'comment-uuid' })),
  emitActivity: vi.fn(async () => {}),
  dismissAgentSession: vi.fn(async () => {}),
  getAgentClient: vi.fn(() => ({
    updateIssue: vi.fn(async () => {}),
  })),
  getRecentCommentBodies: vi.fn(async () => []),
  addLabelToIssue: vi.fn(async () => {}),
  updateIssueState: vi.fn(async () => {}),
}));

vi.mock('../core/db.js', () => ({
  getActiveAttempt: vi.fn(() => null),
  getActiveAttempts: vi.fn(() => []),
  getActiveSessions: vi.fn(() => []),
  getIdleAttempts: vi.fn(() => []),
  getAttemptsByIssue: vi.fn(() => []),
  createAttempt: vi.fn(),
  updateAttemptStatus: vi.fn(),
  logEvent: vi.fn(),
  wasRecentlyCompletedByRole: vi.fn(() => false),
  getCompletedWithTmux: vi.fn(() => []),
  clearAttemptTmuxSession: vi.fn(),
  getBreakerState: vi.fn(() => undefined),
  bumpBreakerState: vi.fn((issueKey: string, role: string, reason: string) => ({
    issue_key: issueKey, agent_role: role, tripped_at: Date.now(), reopen_count: 0, last_reason: reason,
  })),
  clearBreakerState: vi.fn(),
}));

vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
  dequeue: vi.fn(() => null),
  cancelQueued: vi.fn(() => 0),
  cancelQueuedByRole: vi.fn(() => 0),
  getQueueItems: vi.fn(() => []),
  getQueueLength: vi.fn(() => 0),
  setCooldown: vi.fn(),
  isInCooldown: vi.fn(() => false),
  cleanupQueue: vi.fn(),
  completeQueueItem: vi.fn(),
}));

vi.mock('../core/router.js', () => ({
  canSpawnAgent: vi.fn(() => ({ allowed: true })),
  getAgentDefinition: vi.fn(() => ({ maxConcurrent: 4, label: 'agent:cc', host: 'localhost' })),
  getAgentRegistry: vi.fn(() => ({
    cc: { label: 'agent:cc', command: 'claude', host: 'localhost', capabilities: [], maxConcurrent: 4 },
  })),
  resolveAgentRole: vi.fn(() => 'lead-engineer'),
  resolveAgentType: vi.fn(() => 'cc'),
}));

vi.mock('../commands/agent.js', () => ({
  agentStartCommand: vi.fn(async () => 'started'),
}));

// RYA-1298: mock effort-rules so tests don't depend on ~/.aos/effort-rules.json.
// resolveEffortRuleAsync is the dispatch entry point; default to sonnet for tests.
vi.mock('../core/effort-rules.js', () => ({
  resolveEffortRuleAsync: vi.fn(() => Promise.resolve({ model: 'claude-sonnet-4-6', reason: 'mock' })),
  loadEffortRules: vi.fn(() => ({ rules: [], default: 'claude-sonnet-4-6' })),
}));

vi.mock('../serve/helpers.js', () => ({
  postToGroupChat: vi.fn(async () => true),
  isPermanentIssueError: vi.fn(() => false),
  handoffContentHash: vi.fn(() => 'hash-abc'),
  isHandoffAlreadyPosted: vi.fn(() => false),
  countConsecutiveRateLimitFailures: vi.fn(() => 0),
  getRateLimitBackoffMs: vi.fn(() => 0),
  RATE_LIMIT_ESCALATION_MARKER: 'Rate limit escalation',
}));

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => true),
  killSession: vi.fn(),
  capturePane: vi.fn(() => ''),
  sendKeys: vi.fn(),
  readFileOnRemote: vi.fn(() => null),
  writeFileOnRemote: vi.fn(),
  listSessionsByPrefix: vi.fn(() => []),
  suspendSession: vi.fn(),
  resumeSessionProcess: vi.fn(),
}));

vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn(() => ({
    updateIssue: vi.fn(async () => ({})),
  })),
}));

// ─── Import real modules (with mocks applied) ──────────────────────────────

import { handleDispatch } from '../serve/dispatch.js';
import { dispatchDedup, gcStateMaps } from '../serve/state.js';
import {
  parseStatusIntent, parseHandoffActions,
  shouldSkipReview, hasActiveHandoff, isTransientApiErrorOutput,
} from '../serve/monitor.js';
import { checkCircuitBreaker } from '../serve/circuit-breaker.js';
import { canSpawnAgent } from '../core/router.js';
import { agentStartCommand } from '../commands/agent.js';
import { enqueue } from '../core/queue.js';
import { getAttemptsByIssue, updateAttemptStatus, logEvent, getActiveAttempt, getActiveAttempts } from '../core/db.js';
import { addComment } from '../core/linear.js';
import { isPermanentIssueError } from '../serve/helpers.js';

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 1: Successful Dispatch — Full Pipeline
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Integration: successful dispatch exercises full pipeline end-to-end',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('dispatches agent through validate → dedup → cb → capacity → start', async () => {
    const result = await handleDispatch({
      role: 'lead-engineer',
      issueKey: 'RYA-100',
      message: 'Implement feature X',
    });

    const steps: TrajectoryStep[] = [
      {
        label: 'Validate role exists',
        check: () => result.action !== 'error' || !result.detail?.includes('not found'),
      },
      {
        label: 'Validate issueKey format',
        check: () => result.action !== 'error' || !result.detail?.includes('Invalid issue key'),
      },
      {
        label: 'Pass dedup check (first dispatch)',
        check: () => result.action !== 'error' || !result.detail?.includes('Already dispatched'),
      },
      {
        label: 'Pass circuit breaker check',
        check: () => result.action !== 'error' || !result.detail?.includes('Circuit breaker'),
      },
      {
        label: 'Capacity available — start agent',
        check: () => result.ok && result.action === 'started',
      },
      {
        label: 'agentStartCommand called with correct args',
        check: () => {
          expect(agentStartCommand).toHaveBeenCalledWith(
            'lead-engineer', 'RYA-100', { claudeModel: 'claude-sonnet-4-6' },
          );
          return true;
        },
      },
      {
        label: 'Dedup entry recorded for future checks',
        check: () => dispatchDedup.has('lead-engineer:RYA-100'),
      },
    ];

    const trajectory = await assertTrajectory('successful-dispatch-e2e', steps);
    expect(trajectory.success).toBe(true);
    expect(trajectory.completionRatio).toBe(1);
    expect(result).toEqual({
      ok: true,
      action: 'started',
      detail: 'lead-engineer started on RYA-100',
    });
  });

  it('dispatch returns structured response with all required fields', async () => {
    const result = await handleDispatch({
      role: 'cto',
      issueKey: 'RYA-200',
    });

    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('action');
    expect(['started', 'queued', 'piped', 'error']).toContain(result.action);
    if (result.ok) {
      expect(result.detail).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 2: Validation Failures — Bad Input Rejection
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Integration: dispatch rejects invalid inputs at validation stage',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('rejects missing role', async () => {
    const result = await handleDispatch({ role: '', issueKey: 'RYA-1' });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('error');
    expect(result.detail).toContain('Missing role');
  });

  it('rejects missing issueKey', async () => {
    const result = await handleDispatch({ role: 'cto', issueKey: '' });
    expect(result.ok).toBe(false);
    expect(result.action).toBe('error');
  });

  it('rejects unknown agent role', async () => {
    const result = await handleDispatch({ role: 'nonexistent-agent', issueKey: 'RYA-1' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('rejects invalid issue key format', async () => {
    const result = await handleDispatch({ role: 'cto', issueKey: 'bad-format' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Invalid issue key');
  });

  it('rejects cross-team issue keys', async () => {
    const result = await handleDispatch({ role: 'cto', issueKey: 'OTHER-1' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Cross-team');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 3: Dedup Protection — Same Role+Issue Within Window
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Integration: dedup prevents duplicate dispatch within 60s window',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('second dispatch within 60s is rejected as duplicate', async () => {
    const first = await handleDispatch({ role: 'cto', issueKey: 'RYA-10' });
    expect(first.ok).toBe(true);
    expect(first.action).toBe('started');

    const second = await handleDispatch({ role: 'cto', issueKey: 'RYA-10' });
    expect(second.ok).toBe(false);
    expect(second.action).toBe('error');
    expect(second.detail).toContain('Already dispatched');
  });

  it('different roles on same issue are NOT deduped', async () => {
    const first = await handleDispatch({ role: 'cto', issueKey: 'RYA-11' });
    expect(first.ok).toBe(true);

    const second = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-11' });
    expect(second.ok).toBe(true);
  });

  it('same role on different issues are NOT deduped', async () => {
    const first = await handleDispatch({ role: 'cto', issueKey: 'RYA-12' });
    expect(first.ok).toBe(true);

    const second = await handleDispatch({ role: 'cto', issueKey: 'RYA-13' });
    expect(second.ok).toBe(true);
  });

  it('dedup expires after window', async () => {
    dispatchDedup.set('cto:RYA-14', Date.now() - 61_000);

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-14' });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 4: Capacity Exhaustion → Queue
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Integration: capacity exhaustion enqueues instead of starting',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('enqueues when canSpawnAgent returns not allowed', async () => {
    vi.mocked(canSpawnAgent).mockReturnValueOnce({
      allowed: false,
      reason: 'Max concurrent cc sessions reached (4/4)',
    });

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-20' });

    const steps: TrajectoryStep[] = [
      {
        label: 'Dispatch validated and dedup passed',
        check: () => result.action !== 'error' || !result.detail?.includes('Already dispatched'),
      },
      {
        label: 'Capacity check returned NOT allowed',
        check: () => result.action === 'queued',
      },
      {
        label: 'Item enqueued (not started)',
        check: () => {
          expect(enqueue).toHaveBeenCalled();
          return true;
        },
      },
      {
        label: 'Agent NOT started',
        check: () => {
          expect(agentStartCommand).not.toHaveBeenCalled();
          return true;
        },
      },
      {
        label: 'Response indicates queued with reason',
        check: () => {
          expect(result.ok).toBe(true);
          expect(result.detail).toContain('Max concurrent');
          return true;
        },
      },
    ];

    const trajectory = await assertTrajectory('capacity-exhaustion-queue', steps);
    expect(trajectory.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 5: Circuit Breaker Trip → Blocked
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'recovery',
  severity: 'critical',
  behavior: 'Integration: circuit breaker blocks dispatch after consecutive failures',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('blocks dispatch when circuit breaker is tripped', async () => {
    // Seed 3 consecutive failed attempts in mock DB
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      { ...mockAttempt({ status: 'failed', issue_key: 'RYA-30', agent_type: 'cto' }), created_at: new Date().toISOString() },
      { ...mockAttempt({ status: 'failed', issue_key: 'RYA-30', agent_type: 'cto' }), created_at: new Date().toISOString() },
      { ...mockAttempt({ status: 'failed', issue_key: 'RYA-30', agent_type: 'cto' }), created_at: new Date().toISOString() },
    ] as any);

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-30' });

    const steps: TrajectoryStep[] = [
      {
        label: 'Validation and dedup pass',
        check: () => !result.detail?.includes('Missing') && !result.detail?.includes('Already dispatched'),
      },
      {
        label: 'Circuit breaker check detects 3 consecutive failures',
        check: () => result.detail?.includes('Circuit breaker') ?? false,
      },
      {
        label: 'Dispatch blocked with error',
        check: () => !result.ok && result.action === 'error',
      },
      {
        label: 'Agent NOT started',
        check: () => {
          expect(agentStartCommand).not.toHaveBeenCalled();
          return true;
        },
      },
      {
        label: 'No item enqueued',
        check: () => {
          expect(enqueue).not.toHaveBeenCalled();
          return true;
        },
      },
    ];

    const trajectory = await assertTrajectory('circuit-breaker-blocks-dispatch', steps);
    expect(trajectory.success).toBe(true);
  });

  it('circuit breaker check logic: consecutive failures counted correctly', () => {
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      { status: 'failed', agent_type: 'cto', created_at: new Date().toISOString() },
      { status: 'failed', agent_type: 'cto', created_at: new Date().toISOString() },
      { status: 'completed', agent_type: 'cto', created_at: new Date().toISOString() },
    ] as any);

    const result = checkCircuitBreaker('RYA-31', 'cto');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(2);
    expect(result.backoffMs).toBeGreaterThan(0);
  });

  it('circuit breaker resets on successful completion', () => {
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      { status: 'completed', agent_type: 'cto', created_at: new Date().toISOString() },
      { status: 'failed', agent_type: 'cto', created_at: new Date().toISOString() },
      { status: 'failed', agent_type: 'cto', created_at: new Date().toISOString() },
      { status: 'failed', agent_type: 'cto', created_at: new Date().toISOString() },
    ] as any);

    const result = checkCircuitBreaker('RYA-32', 'cto');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 6: Handoff Between Agents
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Integration: handoff dispatch completes current attempt and starts new agent',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('handoff marks current attempt completed before starting new agent', async () => {
    vi.mocked(getActiveAttempt).mockReturnValueOnce({
      id: 'attempt-current',
      issue_key: 'RYA-40',
      agent_type: 'cto',
      status: 'running',
      agent_session_id: 'session-123',
      tmux_session: 'aos-cto-rya40',
    } as any);

    const result = await handleDispatch({
      role: 'lead-engineer',
      issueKey: 'RYA-40',
      handoff: true,
      from: 'cto',
      message: 'Continue implementation',
    });

    const steps: TrajectoryStep[] = [
      {
        label: 'Current attempt found and running',
        check: () => {
          expect(getActiveAttempt).toHaveBeenCalledWith('RYA-40');
          return true;
        },
      },
      {
        label: 'Current attempt marked as completed with handoff reason',
        check: () => {
          expect(updateAttemptStatus).toHaveBeenCalledWith(
            'attempt-current', 'completed', 'Handed off to lead-engineer',
          );
          return true;
        },
      },
      {
        label: 'Handoff event logged',
        check: () => {
          expect(logEvent).toHaveBeenCalledWith(
            'attempt-current', 'handoff',
            expect.objectContaining({ to: 'lead-engineer' }),
          );
          return true;
        },
      },
      {
        label: 'New agent started on same issue',
        check: () => {
          expect(agentStartCommand).toHaveBeenCalledWith(
            'lead-engineer', 'RYA-40', { claudeModel: 'claude-sonnet-4-6' },
          );
          return result.ok && result.action === 'started';
        },
      },
    ];

    const trajectory = await assertTrajectory('handoff-dispatch-e2e', steps);
    expect(trajectory.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 7: Transient Error → Retry with Backoff
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'recovery',
  severity: 'critical',
  behavior: 'Integration: transient agent start failure triggers retry with backoff',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('transient failure enqueues with exponential backoff', async () => {
    vi.mocked(agentStartCommand).mockRejectedValueOnce(new Error('Connection refused'));

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-50' });

    // Transient retry branch returns ok=false (distinct from capacity-queued which returns ok=true)
    // because the dispatcher hit an error — the enqueue is a recovery side-effect, not a success path.
    expect(result.ok).toBe(false);
    expect(result.action).toBe('queued');
    expect(result.detail).toContain('Retry 1/2');
    expect(result.detail).toContain('15s');

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_key: 'RYA-50',
        agent_role: 'cto',
        delay_until: expect.any(String),
      }),
    );
  });

  it('permanent failure returns immediate error (no retry)', async () => {
    vi.mocked(isPermanentIssueError).mockReturnValueOnce(true);
    vi.mocked(agentStartCommand).mockRejectedValueOnce(new Error('Issue not found'));

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-51' });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('error');
    expect(result.detail).toBe('Issue not found');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 8: HANDOFF.md Parsing — Status Intent Resolution
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'state',
  severity: 'critical',
  behavior: 'Integration: HANDOFF.md parsing extracts structured actions correctly',
}), () => {
  it('parses full HANDOFF.md with all action types', () => {
    const handoff = `---
status_intent: in-review
reason: "Feature complete, needs CEO review"
delegate: lead-engineer
parent_status: in-progress
dispatches:
  - role: lead-engineer
    issue: RYA-42
    context: "Implement the design"
  - role: cpo
    new_issue:
      title: "Review UX flow"
      description: "Check the new dashboard layout"
      priority: 2
      parent: RYA-40
    context: "UX review needed"
---
# HANDOFF — RYA-99

## Summary
Completed architecture design for the new dispatch system.
`;

    const actions = parseHandoffActions(handoff);

    expect(actions.statusIntent).toEqual({
      status: 'in-review',
      reason: 'Feature complete, needs CEO review',
    });

    expect(actions.dispatches).toHaveLength(2);
    expect(actions.dispatches[0]).toEqual({
      role: 'lead-engineer',
      issue: 'RYA-42',
      context: 'Implement the design',
    });
    expect(actions.dispatches[1].role).toBe('cpo');
    expect(actions.dispatches[1].new_issue?.title).toBe('Review UX flow');
    expect(actions.dispatches[1].new_issue?.parent).toBe('RYA-40');

    expect(actions.delegate).toBe('lead-engineer');
    expect(actions.parentStatus).toBe('in-progress');
  });

  it('parseStatusIntent handles all valid intents', () => {
    const intents = ['done', 'in-review', 'in-progress', 'todo', 'no-change'];
    for (const intent of intents) {
      const result = parseStatusIntent(`---\nstatus_intent: ${intent}\n---\n# HANDOFF`);
      expect(result?.status).toBe(intent);
    }
  });

  it('parseStatusIntent returns null for missing/invalid intent', () => {
    expect(parseStatusIntent('# No front matter')).toBeNull();
    expect(parseStatusIntent('---\nfoo: bar\n---')).toBeNull();
    expect(parseStatusIntent('---\nstatus_intent: invalid\n---')).toBeNull();
  });

  it('shouldSkipReview identifies trivial tasks with success signals', () => {
    expect(shouldSkipReview('Fix typo in README', 'All tests passing')).toBe(true);
    expect(shouldSkipReview('Cleanup dead code', 'Verified, works correctly')).toBe(true);
    expect(shouldSkipReview('Hotfix: auth redirect', 'Fixed and confirmed')).toBe(true);

    expect(shouldSkipReview('Implement new auth system', 'Tests pass')).toBe(false);

    expect(shouldSkipReview('Fix lint errors', 'Had some issues')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 9: Monitor State Reconciliation
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'state',
  severity: 'critical',
  behavior: 'Integration: monitor detects active handoff and prevents premature status change',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hasActiveHandoff detects another agent on same issue', () => {
    vi.mocked(getActiveAttempts).mockReturnValueOnce([
      { id: 'attempt-1', issue_key: 'RYA-60', status: 'running', agent_type: 'cto' },
      { id: 'attempt-2', issue_key: 'RYA-60', status: 'running', agent_type: 'lead-engineer' },
    ] as any);

    expect(hasActiveHandoff('RYA-60', 'attempt-1')).toBe(true);
  });

  it('hasActiveHandoff returns false when no other agent is running', () => {
    vi.mocked(getActiveAttempts).mockReturnValueOnce([
      { id: 'attempt-1', issue_key: 'RYA-61', status: 'running', agent_type: 'cto' },
    ] as any);

    expect(hasActiveHandoff('RYA-61', 'attempt-1')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 10: Full Lifecycle Trajectory — Dispatch → Work → HANDOFF → Transition
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'dispatch',
  severity: 'critical',
  behavior: 'Integration: full lifecycle trajectory from dispatch to status transition',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('traces complete dispatch → HANDOFF.md → status transition lifecycle', async () => {
    // Phase 1: Dispatch
    const dispatchResult = await handleDispatch({
      role: 'lead-engineer',
      issueKey: 'RYA-70',
      message: 'Build feature Y',
      from: 'cto',
    });

    // Phase 2: Simulate agent writing HANDOFF.md
    const handoffContent = `---
status_intent: in-review
reason: "Feature complete with tests"
---
# HANDOFF — RYA-70

## Summary
Implemented feature Y with full test coverage.

## Files Changed
- src/features/y.ts (new)
- src/features/y.test.ts (new)

## Testing
All tests pass. Verified end-to-end.
`;

    // Phase 3: Monitor parses HANDOFF.md
    const actions = parseHandoffActions(handoffContent);

    // Phase 4: Determine status transition
    const skipReview = shouldSkipReview('Build feature Y', handoffContent);

    // Assert full trajectory
    const steps: TrajectoryStep[] = [
      {
        label: 'Dispatch: agent started successfully',
        check: () => dispatchResult.ok && dispatchResult.action === 'started',
      },
      {
        label: 'Agent work: HANDOFF.md written with valid front matter',
        check: () => actions.statusIntent !== null,
      },
      {
        label: 'Monitor: status intent parsed as in-review',
        check: () => actions.statusIntent?.status === 'in-review',
      },
      {
        label: 'Monitor: reason captured for audit',
        check: () => actions.statusIntent?.reason === 'Feature complete with tests',
      },
      {
        label: 'Status: non-trivial task requires CEO review (not auto-closed)',
        check: () => !skipReview,
      },
      {
        label: 'Lifecycle: dispatch comment posted for audit trail',
        check: () => vi.mocked(addComment).mock.calls.length > 0,
      },
    ];

    const trajectory = await assertTrajectory('full-dispatch-lifecycle-e2e', steps);
    expect(trajectory.success).toBe(true);
    expect(trajectory.completionRatio).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 11: Transient API Error Detection
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'recovery',
  severity: 'important',
  behavior: 'Integration: transient API error patterns detected correctly',
}), () => {
  it('detects all transient API error patterns', () => {
    // Should detect
    expect(isTransientApiErrorOutput('API Error: 500 Internal Server Error')).toBe(true);
    expect(isTransientApiErrorOutput('API Error: 503 Service Unavailable')).toBe(true);
    expect(isTransientApiErrorOutput('Error: overloaded_error')).toBe(true);
    expect(isTransientApiErrorOutput('internal server error')).toBe(true);
    expect(isTransientApiErrorOutput('service unavailable')).toBe(true);

    // Should NOT detect (not transient)
    expect(isTransientApiErrorOutput('Rate limit exceeded')).toBe(false);
    expect(isTransientApiErrorOutput('Authentication failed')).toBe(false);
    expect(isTransientApiErrorOutput('Normal output with no errors')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scenario 12: Dispatch Dedup Cleanup — Memory Leak Prevention
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  category: 'state',
  severity: 'important',
  behavior: 'Integration: dispatch dedup map cleans up old entries to prevent memory leak',
}), () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('gcStateMaps prunes dedup entries older than the 10-min window', () => {
    // Fill with entries past the 10-min prune cutoff used by gcStateMaps for dispatchDedup
    const oldTimestamp = Date.now() - 11 * 60_000;
    for (let i = 0; i < 101; i++) {
      dispatchDedup.set(`old-role:RYA-${i}`, oldTimestamp);
    }
    // Fresh entry should survive the prune
    dispatchDedup.set('cto:RYA-999', Date.now());
    expect(dispatchDedup.size).toBe(102);

    gcStateMaps();

    expect(dispatchDedup.has('cto:RYA-999')).toBe(true);
    expect(dispatchDedup.size).toBe(1);
  });
});
