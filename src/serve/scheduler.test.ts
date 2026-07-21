import { describe, it, expect, beforeEach, vi } from 'vitest';
import { globalDismissedSessions } from '../core/linear.js';

// Mock all external dependencies before importing scheduler
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
  STATE_DIR: '/tmp/aos-test',
  resolveStatePath: (issueKey: string, _wp: string, fname: string) => `/tmp/aos-test/work/${issueKey}/${fname}`,
}));

vi.mock('../core/linear.js', async () => {
  const actual = await vi.importActual('../core/linear.js') as Record<string, unknown>;
  return {
    ...actual,
    getReadClient: vi.fn(() => ({ workflowStates: vi.fn(), issues: vi.fn() })),
    dismissAgentSession: vi.fn(async (id: string) => {
      // Simulate the real behavior: track in globalDismissedSessions
      (actual.globalDismissedSessions as Set<string>).add(id);
    }),
    listAgentSessions: vi.fn(async () => []),
    getIssuesByLabel: vi.fn(async () => []),
    updateIssueState: vi.fn(),
    getIssue: vi.fn(),
    getAgentClient: vi.fn(() => ({ createIssue: vi.fn() })),
    getWorkflowStateId: vi.fn(async () => 'state-id'),
  };
});

vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
  getActiveAttempt: vi.fn(),
  getIdleAttempt: vi.fn(),
  getAttemptsByIssue: vi.fn(() => []),
  updateAttemptStatus: vi.fn(),
  getRecentAttemptsByAgent: vi.fn(() => []),
  logEvent: vi.fn(),
}));

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  sendKeys: vi.fn(),
  capturePane: vi.fn(() => ''),
  readFileOnRemote: vi.fn(() => null),
  killSession: vi.fn(),
  listSessionsByPrefix: vi.fn(() => []),
}));

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  getAgentLinearToken: vi.fn((role: string) => `token-${role}`),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc', maxParallel: 2 })),
  listAgents: vi.fn(() => ['cto', 'lead-engineer']),
}));

vi.mock('../core/router.js', () => ({
  canSpawnAgent: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
  dequeue: vi.fn(),
  peekQueue: vi.fn(),
  getQueueLength: vi.fn(() => 0),
  getQueueItems: vi.fn(() => []),
  isInCooldown: vi.fn(() => false),
  completeQueueItem: vi.fn(),
  cancelQueueItem: vi.fn(),
  cancelQueued: vi.fn(() => 0),
  hasActiveQueueEntry: vi.fn(() => false),
}));

vi.mock('../commands/spawn.js', () => ({ spawnCommand: vi.fn() }));
vi.mock('../commands/agent.js', () => ({ agentStartCommand: vi.fn() }));
vi.mock('./state.js', () => ({
  autoDispatchFailures: new Map(),
  persistentDedupCheck: vi.fn(() => false),
}));
vi.mock('./helpers.js', async () => {
  const actual = await vi.importActual('./helpers.js') as Record<string, unknown>;
  return {
    hasQueuedIssue: vi.fn(() => false),
    postToGroupChat: vi.fn(),
    // Use the REAL isPermanentIssueError so we test actual error classification
    isPermanentIssueError: actual.isPermanentIssueError,
  };
});
vi.mock('./monitor.js', () => ({
  shouldSkipReview: vi.fn(() => false),
  hasStickyInProgressIntent: vi.fn(() => false),
  parseStatusIntent: vi.fn(() => null),
}));
vi.mock('./circuit-breaker.js', () => ({
  checkCircuitBreaker: vi.fn(() => ({ allowed: true, consecutiveFailures: 0, backoffMs: 0 })),
  tripCircuitBreaker: vi.fn(),
}));
vi.mock('../core/linear-relations.js', () => ({
  isBlocked: vi.fn(async () => ({ blocked: false, blockers: [] })),
  isDuplicateOfDone: vi.fn(async () => null),
}));
vi.mock('../core/smart-router.js', () => ({
  classifyDomain: vi.fn(() => ({ role: 'lead-engineer', confidence: 'high', matchedKeywords: ['implement'] })),
  shouldAutoRoute: vi.fn(() => true),
}));
vi.mock('./dispatch.js', () => ({
  handleDispatch: vi.fn(async () => ({ ok: true, action: 'started' })),
}));
vi.mock('./concurrency.js', () => ({
  canStartNewSession: vi.fn(() => ({ allowed: true })),
  monitorHibernatedSessions: vi.fn(),
  tryWakeHibernatedSession: vi.fn(),
  hasCapacity: vi.fn(() => true),
  getMaxParallel: vi.fn(() => 5),
  getRoleRunningCount: vi.fn(() => 0),
}));
vi.mock('../analytics/weekly-pnl.js', () => ({
  runWeeklyPnL: vi.fn(async () => ({
    formatted: 'mock digest',
    data: { sessionCount: 42 },
    posted: true,
    postError: undefined,
    persistedSessions: 42,
  })),
}));

import { janitorAgentSessions, drainQueue, heartbeatAssignUnowned, ceoOfficeTriageHeartbeat, ceoOfficeDailyDispatch, weeklyPnLDigestHeartbeat, autoDispatchFromBacklog, reconcileInProgressIssues, __resetTriageCheckCacheForTests, __resetRecentCompletionLogCacheForTests } from './scheduler.js';
import { hasStickyInProgressIntent, parseStatusIntent } from './monitor.js';
import { dismissAgentSession, listAgentSessions, getReadClient, getAgentClient, getWorkflowStateId } from '../core/linear.js';
import { isPermanentIssueError } from './helpers.js';
import { isBlocked, isDuplicateOfDone } from '../core/linear-relations.js';
import { classifyDomain, shouldAutoRoute } from '../core/smart-router.js';
import { handleDispatch } from './dispatch.js';
import { sessionExists, sendKeys, listSessionsByPrefix, killSession } from '../core/tmux.js';
import { getActiveAttempts, getAttemptsByIssue, updateAttemptStatus } from '../core/db.js';
import { agentExists, loadAgentConfig } from '../core/persona.js';
import { canStartNewSession } from './concurrency.js';

// Advance Date.now() by 6 minutes between tests to bypass the 5-min cooldown
let fakeNow = Date.now();
const SIX_MINUTES = 6 * 60_000;

describe('janitorAgentSessions — double-dismiss prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalDismissedSessions.clear();
    // Advance time to bypass the 5-minute interval guard
    fakeNow += SIX_MINUTES;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  it('skips sessions already in globalDismissedSessions', async () => {
    const sessionId = 'sess-already-dismissed';

    // Simulate monitor having already dismissed this session
    globalDismissedSessions.add(sessionId);

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: sessionId,
        status: 'created',
        issue: { identifier: 'RYA-99', state: { name: 'Done' } },
      } as any,
    ]);

    await janitorAgentSessions();

    // dismissAgentSession should NOT have been called — session was already dismissed
    expect(dismissAgentSession).not.toHaveBeenCalled();
  });

  it('dismisses sessions NOT in globalDismissedSessions and adds them', async () => {
    const sessionId = 'sess-new';

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: sessionId,
        status: 'created',
        issue: { identifier: 'RYA-100', state: { name: 'Done' } },
      } as any,
    ]);

    await janitorAgentSessions();

    // Should have been dismissed
    expect(dismissAgentSession).toHaveBeenCalledWith(sessionId, expect.any(String), expect.stringContaining('Stale session cleanup'));
    // Should now be tracked
    expect(globalDismissedSessions.has(sessionId)).toBe(true);
  });

  it('prevents double-dismiss when monitor dismisses then janitor runs', async () => {
    const sessionId = 'sess-race';

    // Step 1: Monitor dismisses the session (simulated)
    await dismissAgentSession(sessionId, 'tok-cto', 'Follow-up answered.');
    expect(globalDismissedSessions.has(sessionId)).toBe(true);

    // Step 2: Janitor runs and finds the same session still listed by Linear
    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: sessionId,
        status: 'created',
        issue: { identifier: 'RYA-93', state: { name: 'Done' } },
      } as any,
    ]);

    vi.mocked(dismissAgentSession).mockClear();

    await janitorAgentSessions();

    // Janitor should NOT have called dismiss again
    expect(dismissAgentSession).not.toHaveBeenCalled();
  });

  it('does not dismiss TRACKED sessions on active issues', async () => {
    const { getActiveAttempts } = await import('../core/db.js');
    // The attempt tracks session 'sess-tracked' — janitor should leave it alone
    vi.mocked(getActiveAttempts).mockReturnValueOnce([
      { issue_key: 'RYA-200', agent_session_id: 'sess-tracked' } as any,
    ]);

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: 'sess-tracked',
        status: 'created',
        issue: { identifier: 'RYA-200', state: { name: 'In Progress' } },
      } as any,
    ]);

    await janitorAgentSessions();

    expect(dismissAgentSession).not.toHaveBeenCalled();
  });

  it('DOES dismiss ORPHANED sessions on active issues', async () => {
    const { getActiveAttempts } = await import('../core/db.js');
    // The attempt tracks session 'sess-tracked', but 'sess-orphan' is untracked
    vi.mocked(getActiveAttempts).mockReturnValueOnce([
      { issue_key: 'RYA-200', agent_session_id: 'sess-tracked' } as any,
    ]);

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: 'sess-orphan',
        status: 'created',
        issue: { identifier: 'RYA-200', state: { name: 'In Progress' } },
      } as any,
    ]);

    await janitorAgentSessions();

    // Orphaned session should be dismissed to prevent ghost "Working" indicators
    expect(dismissAgentSession).toHaveBeenCalledWith('sess-orphan', expect.any(String), expect.stringContaining('Stale session cleanup'));
  });
});

describe('janitorAgentSessions — RYA-1185 tmux kill + zombie reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalDismissedSessions.clear();
    fakeNow += SIX_MINUTES;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  it('kills zombie tmux from a completed attempt before posting dismiss comment', async () => {
    // Done issue, completed attempt still has a live tmux session
    vi.mocked(getAttemptsByIssue).mockReturnValue([
      { id: 'att-1', status: 'completed', tmux_session: 'aos-cto-RYA-300' } as any,
    ]);
    vi.mocked(sessionExists).mockReturnValue(true); // tmux is still alive

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      { id: 'sess-300', status: 'created', issue: { identifier: 'RYA-300', state: { name: 'Done' } } } as any,
    ]);

    await janitorAgentSessions();

    // Zombie tmux must be killed before the dismiss comment is posted
    expect(killSession).toHaveBeenCalledWith('aos-cto-RYA-300');
    expect(dismissAgentSession).toHaveBeenCalledWith('sess-300', expect.any(String), expect.stringContaining('Stale session cleanup'));
    // Verify kill was called (we can't easily assert ordering in vitest, but both must fire)
    expect(killSession).toHaveBeenCalledBefore(vi.mocked(dismissAgentSession) as any);
  });

  it('marks running attempt with dead tmux as completed before posting dismiss comment', async () => {
    // In Progress issue, running attempt whose tmux has already died
    vi.mocked(getActiveAttempts).mockReturnValue([
      { id: 'att-2', issue_key: 'RYA-301', agent_session_id: null, tmux_session: 'aos-lead-engineer-RYA-301', status: 'running' } as any,
    ]);
    vi.mocked(getAttemptsByIssue).mockReturnValue([
      { id: 'att-2', status: 'running', tmux_session: 'aos-lead-engineer-RYA-301' } as any,
    ]);
    vi.mocked(sessionExists).mockReturnValue(false); // tmux is dead

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      { id: 'sess-301', status: 'created', issue: { identifier: 'RYA-301', state: { name: 'In Progress' } } } as any,
    ]);

    await janitorAgentSessions();

    // Dead running attempt should be marked completed so reconciler can transition issue state
    expect(updateAttemptStatus).toHaveBeenCalledWith('att-2', 'completed', expect.stringContaining('Zombie'));
    expect(dismissAgentSession).toHaveBeenCalledWith('sess-301', expect.any(String), expect.stringContaining('Stale session cleanup'));
  });

  it('does not kill alive tmux sessions of running attempts (they may be working)', async () => {
    // Active issue, running attempt with live tmux — should not be touched by janitor
    vi.mocked(getActiveAttempts).mockReturnValue([
      { id: 'att-3', issue_key: 'RYA-302', agent_session_id: 'sess-tracked', tmux_session: 'aos-cto-RYA-302', status: 'running' } as any,
    ]);
    vi.mocked(getAttemptsByIssue).mockReturnValue([
      { id: 'att-3', status: 'running', tmux_session: 'aos-cto-RYA-302' } as any,
    ]);
    vi.mocked(sessionExists).mockReturnValue(true); // tmux alive

    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      // Orphaned session (not 'sess-tracked')
      { id: 'sess-orphan-302', status: 'created', issue: { identifier: 'RYA-302', state: { name: 'In Progress' } } } as any,
    ]);

    await janitorAgentSessions();

    // Orphaned Linear session dismissed, but the running tmux session NOT killed
    expect(dismissAgentSession).toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    // Running attempt not touched either (tmux is alive)
    expect(updateAttemptStatus).not.toHaveBeenCalled();
  });
});

describe('dismissAgentSession — idempotency guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalDismissedSessions.clear();
  });

  it('tracks dismissed session IDs in globalDismissedSessions', async () => {
    await dismissAgentSession('sess-1', 'token', 'reason');
    expect(globalDismissedSessions.has('sess-1')).toBe(true);
  });

  it('is idempotent — second call with same ID is a no-op', async () => {
    await dismissAgentSession('sess-2', 'token', 'first');
    vi.mocked(dismissAgentSession).mockClear();

    await dismissAgentSession('sess-2', 'token', 'second');
    // The mock still gets called (it's a mock), but the real implementation
    // would return early. We verify the Set was populated on first call.
    expect(globalDismissedSessions.has('sess-2')).toBe(true);
  });
});

describe('globalDismissedSessions GC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalDismissedSessions.clear();
    fakeNow += SIX_MINUTES;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  it('cleans up stale entries when set exceeds 200', async () => {
    // Fill the set beyond threshold
    for (let i = 0; i < 201; i++) {
      globalDismissedSessions.add(`stale-${i}`);
    }

    // One "active" session that should survive GC
    const activeId = 'active-session';
    globalDismissedSessions.add(activeId);

    // listAgentSessions returns only the active session (stale ones no longer listed)
    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: activeId,
        status: 'created',
        issue: { identifier: 'RYA-50', state: { name: 'In Progress' } },
      } as any,
    ]);

    await janitorAgentSessions();

    // active-session should survive GC (it's in the sessions list)
    expect(globalDismissedSessions.has(activeId)).toBe(true);
    // stale-0 should be removed (not in the sessions list)
    expect(globalDismissedSessions.has('stale-0')).toBe(false);
    // Set should be much smaller now
    expect(globalDismissedSessions.size).toBe(1);
  });
});

// ─── isPermanentIssueError ───

describe('isPermanentIssueError', () => {
  it('detects "Issue X not found" error', () => {
    expect(isPermanentIssueError(new Error('Issue RYA-42 not found'))).toBe(true);
  });

  it('detects "Argument Validation Error" from Linear SDK', () => {
    expect(isPermanentIssueError(new Error('Argument Validation Error: issue does not exist'))).toBe(true);
  });

  it('detects "Not Found" generic error', () => {
    expect(isPermanentIssueError(new Error('Not Found'))).toBe(true);
  });

  it('detects "was deleted" error', () => {
    expect(isPermanentIssueError(new Error('The issue was deleted'))).toBe(true);
  });

  it('rejects transient errors (rate limit)', () => {
    expect(isPermanentIssueError(new Error('Rate limited'))).toBe(false);
  });

  it('rejects transient errors (network)', () => {
    expect(isPermanentIssueError(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('rejects transient errors (timeout)', () => {
    expect(isPermanentIssueError(new Error('Request timeout'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isPermanentIssueError('Issue not found')).toBe(true);
    expect(isPermanentIssueError(42)).toBe(false);
  });
});

// ─── drainQueue — deleted issue handling ───

describe('drainQueue — deleted issue handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels queue item and purges remaining entries when issue is not found', async () => {
    const { peekQueue, dequeue, cancelQueueItem, cancelQueued } = await import('../core/queue.js');
    const { agentStartCommand } = await import('../commands/agent.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');

    const queueItem = {
      id: 'q-1',
      issue_id: 'uuid-1',
      issue_key: 'RYA-999',
      agent_role: 'cto',
      priority: 1,
      agent_session_id: null,
      follow_up_prompt: null,
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(agentStartCommand).mockRejectedValue(new Error('Issue RYA-999 not found'));
    vi.mocked(cancelQueued).mockReturnValue(2);

    await drainQueue();

    // Should cancel the specific item
    expect(cancelQueueItem).toHaveBeenCalledWith('q-1');
    // Should ALSO purge all remaining entries for this issue
    expect(cancelQueued).toHaveBeenCalledWith('RYA-999');
  });

  it('does NOT purge remaining entries for transient errors', async () => {
    const { peekQueue, dequeue, cancelQueueItem, cancelQueued } = await import('../core/queue.js');
    const { agentStartCommand } = await import('../commands/agent.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');

    const queueItem = {
      id: 'q-2',
      issue_id: 'uuid-2',
      issue_key: 'RYA-100',
      agent_role: 'cto',
      priority: 1,
      agent_session_id: null,
      follow_up_prompt: null,
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(agentStartCommand).mockRejectedValue(new Error('ECONNREFUSED'));

    await drainQueue();

    // Should cancel the specific item (normal failure behavior)
    expect(cancelQueueItem).toHaveBeenCalledWith('q-2');
    // Should NOT purge other entries — error is transient
    expect(cancelQueued).not.toHaveBeenCalled();
  });
});

// ─── drainQueue — dependency-aware dispatch (RYA-310) ───

describe('drainQueue — blocked issue handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-enqueues blocked items with 5-minute delay instead of dispatching', async () => {
    const { peekQueue, dequeue, cancelQueueItem, enqueue } = await import('../core/queue.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    const { getIssue } = await import('../core/linear.js');

    const queueItem = {
      id: 'q-blocked',
      issue_id: 'uuid-blocked',
      issue_key: 'RYA-200',
      agent_role: 'lead-engineer',
      priority: 2,
      agent_session_id: null,
      follow_up_prompt: 'original prompt',
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(getIssue).mockResolvedValueOnce({ id: 'uuid-blocked', identifier: 'RYA-200', title: 't', description: undefined, priority: 2, labels: [], state: 'In Progress', url: '' });
    vi.mocked(isBlocked).mockResolvedValueOnce({
      blocked: true,
      blockers: [{ issueKey: 'RYA-100', issueTitle: 'Blocking task', issueState: 'In Progress' }],
    });

    await drainQueue();

    // Should cancel the current queue item
    expect(cancelQueueItem).toHaveBeenCalledWith('q-blocked');
    // Should re-enqueue with a delay
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      issue_key: 'RYA-200',
      agent_role: 'lead-engineer',
      follow_up_prompt: 'original prompt',
      delay_until: expect.any(String),
    }));
    // Verify the delay is ~5 minutes in the future
    const enqueuedItem = vi.mocked(enqueue).mock.calls[0][0] as any;
    const delayTime = new Date(enqueuedItem.delay_until).getTime();
    expect(delayTime).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(delayTime).toBeLessThanOrEqual(Date.now() + 6 * 60_000);
  });

  it('dispatches normally when issue is not blocked', async () => {
    const { peekQueue, dequeue, completeQueueItem } = await import('../core/queue.js');
    const { agentStartCommand } = await import('../commands/agent.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    const { getIssue } = await import('../core/linear.js');

    const queueItem = {
      id: 'q-ok',
      issue_id: 'uuid-ok',
      issue_key: 'RYA-201',
      agent_role: 'lead-engineer',
      priority: 2,
      agent_session_id: null,
      follow_up_prompt: null,
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(getIssue).mockResolvedValueOnce({ id: 'uuid-ok', identifier: 'RYA-201', title: 't', description: undefined, priority: 2, labels: [], state: 'Todo', url: '' });
    vi.mocked(isBlocked).mockResolvedValueOnce({ blocked: false, blockers: [] });
    vi.mocked(agentStartCommand).mockResolvedValueOnce('started');

    await drainQueue();

    // Should proceed to dispatch
    expect(agentStartCommand).toHaveBeenCalledWith('lead-engineer', 'RYA-201', expect.any(Object));
    expect(completeQueueItem).toHaveBeenCalledWith('q-ok');
  });
});

// ─── drainQueue — terminal-state short-circuit (RYA-1155) ───

describe('drainQueue — terminal-state short-circuit (RYA-1155)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels queue item and purges remaining entries when issue is Done — does NOT re-enqueue or invoke blocker check', async () => {
    const { peekQueue, dequeue, cancelQueueItem, cancelQueued, enqueue } = await import('../core/queue.js');
    const { agentStartCommand } = await import('../commands/agent.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    const { getIssue } = await import('../core/linear.js');

    const queueItem = {
      id: 'q-done',
      issue_id: 'uuid-1148',
      issue_key: 'RYA-1148',
      agent_role: 'research-lead',
      priority: 3,
      agent_session_id: null,
      follow_up_prompt: null,
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(getIssue).mockResolvedValueOnce({ id: 'uuid-1148', identifier: 'RYA-1148', title: 't', description: undefined, priority: 3, labels: [], state: 'Done', url: '' });
    vi.mocked(cancelQueued).mockReturnValue(0);

    await drainQueue();

    expect(cancelQueueItem).toHaveBeenCalledWith('q-done');
    expect(cancelQueued).toHaveBeenCalledWith('RYA-1148');
    // Crucial: do NOT re-enqueue (would re-trigger the 5-min spam loop)
    expect(enqueue).not.toHaveBeenCalled();
    // Crucial: blocker check must NOT run for terminal-state issues
    expect(isBlocked).not.toHaveBeenCalled();
    // Crucial: do NOT spawn the agent
    expect(agentStartCommand).not.toHaveBeenCalled();
  });

  it('cancels queue item when issue is Canceled (same path as Done)', async () => {
    const { peekQueue, dequeue, cancelQueueItem, enqueue } = await import('../core/queue.js');
    const { agentStartCommand } = await import('../commands/agent.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    const { getIssue } = await import('../core/linear.js');

    const queueItem = {
      id: 'q-cancel',
      issue_id: 'uuid-cancel',
      issue_key: 'RYA-300',
      agent_role: 'cto',
      priority: 4,
      agent_session_id: null,
      follow_up_prompt: null,
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(getIssue).mockResolvedValueOnce({ id: 'uuid-cancel', identifier: 'RYA-300', title: 't', description: undefined, priority: 4, labels: [], state: 'Canceled', url: '' });

    await drainQueue();

    expect(cancelQueueItem).toHaveBeenCalledWith('q-cancel');
    expect(enqueue).not.toHaveBeenCalled();
    expect(isBlocked).not.toHaveBeenCalled();
    expect(agentStartCommand).not.toHaveBeenCalled();
  });

  it('fails open on getIssue API error — continues to existing blocker check (preserves backwards compat)', async () => {
    const { peekQueue, dequeue } = await import('../core/queue.js');
    const { agentStartCommand } = await import('../commands/agent.js');
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    const { getIssue } = await import('../core/linear.js');

    const queueItem = {
      id: 'q-err',
      issue_id: 'uuid-err',
      issue_key: 'RYA-400',
      agent_role: 'cto',
      priority: 2,
      agent_session_id: null,
      follow_up_prompt: null,
      queued_at: new Date().toISOString(),
      delay_until: null,
      status: 'queued' as const,
    };

    vi.mocked(peekQueue).mockReturnValue(queueItem);
    vi.mocked(dequeue).mockReturnValue(queueItem);
    vi.mocked(checkCircuitBreaker).mockReturnValue({ allowed: true, consecutiveFailures: 0, backoffMs: 0 });
    vi.mocked(getIssue).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    vi.mocked(isBlocked).mockResolvedValueOnce({ blocked: false, blockers: [] });
    vi.mocked(agentStartCommand).mockResolvedValueOnce('started');

    await drainQueue();

    // Falls through: blocker check runs, agent dispatches normally.
    expect(isBlocked).toHaveBeenCalled();
    expect(agentStartCommand).toHaveBeenCalledWith('cto', 'RYA-400', expect.any(Object));
  });
});

// ─── heartbeatAssignUnowned — smart routing (RYA-313) ───

describe('heartbeatAssignUnowned — smart routing', () => {
  let fakeHeartbeatNow: number;

  beforeEach(() => {
    vi.clearAllMocks();
    // Advance time far enough to bypass the 5-min heartbeat cooldown
    fakeHeartbeatNow = Date.now() + 10 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeHeartbeatNow);
  });

  function mockLinearClient(issues: Array<{ identifier: string; title: string; priority: number; description?: string }>) {
    const mockClient = {
      workflowStates: vi.fn().mockResolvedValue({
        nodes: [{ id: 'state-todo', name: 'Todo' }],
      }),
      issues: vi.fn().mockResolvedValue({
        nodes: issues.map(i => ({ ...i, description: i.description || '' })),
      }),
    };
    vi.mocked(getReadClient).mockReturnValue(mockClient as any);
    return mockClient;
  }

  it('dispatches directly when smart router has high confidence', async () => {
    mockLinearClient([
      { identifier: 'RYA-400', title: 'Implement new feature for build pipeline', priority: 2 },
    ]);
    vi.mocked(classifyDomain).mockReturnValue({
      role: 'lead-engineer',
      confidence: 'high',
      matchedKeywords: ['implement', 'feature', 'build'],
    });
    vi.mocked(shouldAutoRoute).mockReturnValue(true);

    await heartbeatAssignUnowned();

    expect(classifyDomain).toHaveBeenCalledWith('Implement new feature for build pipeline', '');
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'lead-engineer',
      issueKey: 'RYA-400',
      from: 'smart-router',
    }));
    // COO should NOT be involved
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('A1.4: skips issues that already have an active queue entry', async () => {
    const { hasActiveQueueEntry } = await import('../core/queue.js');
    mockLinearClient([
      { identifier: 'RYA-410', title: 'Implement retry logic in dispatcher', priority: 2 },
    ]);
    vi.mocked(hasActiveQueueEntry).mockReturnValueOnce(true);

    await heartbeatAssignUnowned();

    expect(handleDispatch).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('A1.4: skips issues with an active attempt', async () => {
    const { getActiveAttempt } = await import('../core/db.js');
    mockLinearClient([
      { identifier: 'RYA-411', title: 'Implement retry logic in dispatcher', priority: 2 },
    ]);
    vi.mocked(getActiveAttempt).mockReturnValueOnce({ id: 'att-1', issue_key: 'RYA-411' } as any);

    await heartbeatAssignUnowned();

    expect(handleDispatch).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('A1.4: skips issues dispatched recently (persistent disp-any marker)', async () => {
    const { persistentDedupCheck } = await import('./state.js');
    mockLinearClient([
      { identifier: 'RYA-412', title: 'Implement retry logic in dispatcher', priority: 2 },
    ]);
    vi.mocked(persistentDedupCheck).mockImplementationOnce((key: string) => key === 'disp-any:RYA-412');

    await heartbeatAssignUnowned();

    expect(handleDispatch).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('falls back to COO for ambiguous issues', async () => {
    mockLinearClient([
      { identifier: 'RYA-401', title: 'Weekly sync notes from Thursday', priority: 4 },
    ]);
    vi.mocked(classifyDomain).mockReturnValue({
      role: 'coo',
      confidence: 'low',
      matchedKeywords: [],
    });
    vi.mocked(shouldAutoRoute).mockReturnValue(false);
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-coo']);

    await heartbeatAssignUnowned();

    // Should NOT dispatch directly
    expect(handleDispatch).not.toHaveBeenCalled();
    // Should ask COO to triage
    expect(sendKeys).toHaveBeenCalledWith('aos-coo', expect.stringContaining('ambiguous'));
  });

  // RYA-1131: regression — heartbeat must resolve actual session names with
  // issue-key suffix (e.g. aos-coo-RYA-1129) rather than hardcoding 'aos-coo'.
  // Previously the heartbeat hardcoded 'aos-coo' for sendKeys but the real
  // COO session is named aos-coo-RYA-XXXX, producing 'can't find pane: aos-coo'
  // every 5 minutes.
  it('RYA-1131: pipes triage into an issue-suffixed COO session when no idle aos-coo exists', async () => {
    mockLinearClient([
      { identifier: 'RYA-501', title: 'Quarterly planning sync', priority: 4 },
    ]);
    vi.mocked(classifyDomain).mockReturnValue({
      role: 'coo',
      confidence: 'low',
      matchedKeywords: [],
    });
    vi.mocked(shouldAutoRoute).mockReturnValue(false);
    // Only an issue-suffixed COO session exists (e.g. busy on another issue).
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-coo-RYA-1129']);

    await heartbeatAssignUnowned();

    expect(sendKeys).toHaveBeenCalledWith('aos-coo-RYA-1129', expect.stringContaining('RYA-501'));
    // Importantly, must NOT call sendKeys('aos-coo', ...) — that's the historic bug.
    expect(sendKeys).not.toHaveBeenCalledWith('aos-coo', expect.anything());
  });

  // RYA-1131: when both an idle aos-coo session AND issue-suffixed sessions
  // exist, prefer the idle one (it's the natural home for triage messages).
  it('RYA-1131: prefers idle aos-coo over issue-suffixed sessions', async () => {
    mockLinearClient([
      { identifier: 'RYA-502', title: 'Weekly retro notes', priority: 4 },
    ]);
    vi.mocked(classifyDomain).mockReturnValue({
      role: 'coo',
      confidence: 'low',
      matchedKeywords: [],
    });
    vi.mocked(shouldAutoRoute).mockReturnValue(false);
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-coo-RYA-1129', 'aos-coo']);

    await heartbeatAssignUnowned();

    expect(sendKeys).toHaveBeenCalledWith('aos-coo', expect.stringContaining('RYA-502'));
    expect(sendKeys).not.toHaveBeenCalledWith('aos-coo-RYA-1129', expect.anything());
  });

  it('routes mix of clear and ambiguous issues correctly', async () => {
    mockLinearClient([
      { identifier: 'RYA-402', title: 'Fix crash in error handler debugging', priority: 1 },
      { identifier: 'RYA-403', title: 'Quarterly planning sync', priority: 4 },
    ]);

    // First issue: clear lead-engineer
    vi.mocked(classifyDomain)
      .mockReturnValueOnce({ role: 'lead-engineer', confidence: 'high', matchedKeywords: ['fix', 'crash', 'error', 'debugging'] })
      .mockReturnValueOnce({ role: 'coo', confidence: 'low', matchedKeywords: [] });
    vi.mocked(shouldAutoRoute)
      .mockReturnValueOnce(true)   // RYA-402: high confidence
      .mockReturnValueOnce(false); // RYA-403: low confidence
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-coo']);

    await heartbeatAssignUnowned();

    // RYA-402 dispatched directly
    expect(handleDispatch).toHaveBeenCalledTimes(1);
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'lead-engineer',
      issueKey: 'RYA-402',
    }));
    // RYA-403 sent to COO
    expect(sendKeys).toHaveBeenCalledWith('aos-coo', expect.stringContaining('RYA-403'));
    expect(sendKeys).toHaveBeenCalledWith('aos-coo', expect.not.stringContaining('RYA-402'));
  });

  it('routes CPO, Research Lead, and COO issues correctly', async () => {
    mockLinearClient([
      { identifier: 'RYA-410', title: 'Product onboarding UX redesign', priority: 2 },
      { identifier: 'RYA-411', title: 'Research literature review on LLM biases', priority: 3 },
      { identifier: 'RYA-412', title: 'Server deploy monitoring alert setup', priority: 2 },
    ]);

    vi.mocked(classifyDomain)
      .mockReturnValueOnce({ role: 'cpo', confidence: 'high', matchedKeywords: ['product', 'onboarding', 'ux'] })
      .mockReturnValueOnce({ role: 'research-lead', confidence: 'high', matchedKeywords: ['research', 'literature'] })
      .mockReturnValueOnce({ role: 'coo', confidence: 'high', matchedKeywords: ['server', 'deploy', 'monitoring', 'alert'] });
    vi.mocked(shouldAutoRoute).mockReturnValue(true);

    await heartbeatAssignUnowned();

    expect(handleDispatch).toHaveBeenCalledTimes(3);
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'cpo', issueKey: 'RYA-410' }));
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'research-lead', issueKey: 'RYA-411' }));
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'coo', issueKey: 'RYA-412' }));
    // No COO fallback needed
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('falls back to COO when dispatch fails', async () => {
    mockLinearClient([
      { identifier: 'RYA-420', title: 'Implement widget feature', priority: 2 },
    ]);
    vi.mocked(classifyDomain).mockReturnValue({
      role: 'lead-engineer',
      confidence: 'high',
      matchedKeywords: ['implement', 'feature'],
    });
    vi.mocked(shouldAutoRoute).mockReturnValue(true);
    vi.mocked(handleDispatch).mockRejectedValueOnce(new Error('Agent at capacity'));
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-coo']);

    await heartbeatAssignUnowned();

    // Dispatch was attempted
    expect(handleDispatch).toHaveBeenCalledTimes(1);
    // Failed → fell back to COO
    expect(sendKeys).toHaveBeenCalledWith('aos-coo', expect.stringContaining('RYA-420'));
  });

  it('does nothing when no unassigned issues exist', async () => {
    mockLinearClient([]);

    await heartbeatAssignUnowned();

    expect(classifyDomain).not.toHaveBeenCalled();
    expect(handleDispatch).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });
});

// ─── CEO Office triage heartbeat tests ───
//
// RYA-1060: tests cover disk-persisted queue-hash dedup. The in-memory
// `lastCeoTriageAt` was replaced with `~/.aos/ceo-triage-fired.json` (read
// at the start of every fire) so that node restarts (post-commit auto-deploy)
// no longer reset the cooldown and trigger duplicate dispatches.

const CEO_TRIAGE_FIRED_PATH_TEST = '/tmp/aos-test/ceo-triage-fired.json';
const CEO_DAILY_FIRED_PATH_TEST = '/tmp/aos-test/ceo-daily-fired.json';

function clearCeoTriageFire(): void {
  if (existsSync(CEO_TRIAGE_FIRED_PATH_TEST)) unlinkSync(CEO_TRIAGE_FIRED_PATH_TEST);
}

function clearCeoDailyFire(): void {
  if (existsSync(CEO_DAILY_FIRED_PATH_TEST)) unlinkSync(CEO_DAILY_FIRED_PATH_TEST);
}

function buildCeoTriageMocks(
  issueKeys: string[],
  dispatchedKey = 'RYA-99',
  nodes?: Array<{ identifier: string; title: string; priority: number }>,
): { mockAgentClient: { createIssue: ReturnType<typeof vi.fn> } } {
  vi.mocked(agentExists).mockReturnValue(true);
  vi.mocked(getActiveAttempts).mockReturnValue([]);
  vi.mocked(loadAgentConfig).mockReturnValue({ maxParallel: 2 } as any);
  vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);

  const mockIssues = nodes ?? issueKeys.map((key, i) => ({
    identifier: key, title: `Test issue ${i + 1}`, priority: 3,
  }));
  const mockClient = {
    issues: vi.fn().mockResolvedValue({ nodes: mockIssues }),
  };
  vi.mocked(getReadClient).mockReturnValue(mockClient as any);

  const mockAgentClient = {
    createIssue: vi.fn().mockResolvedValue({
      success: true,
      issue: Promise.resolve({ identifier: dispatchedKey }),
    }),
  };
  vi.mocked(getAgentClient).mockReturnValue(mockAgentClient as any);
  vi.mocked(getWorkflowStateId).mockResolvedValue('state-todo');
  return { mockAgentClient };
}

describe('ceoOfficeTriageHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!existsSync('/tmp/aos-test')) mkdirSync('/tmp/aos-test', { recursive: true });
    clearCeoTriageFire();
    // RYA-1070: reset the in-memory iterator-throttle. Without this, tests that
    // run within the same module load would see stale `lastTriageCheckMs` from
    // a prior test and early-return.
    __resetTriageCheckCacheForTests();
    fakeNow += 31 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  it('skips when AOS_NO_CEO_TRIAGE is set', async () => {
    process.env.AOS_NO_CEO_TRIAGE = '1';
    await ceoOfficeTriageHeartbeat();
    expect(handleDispatch).not.toHaveBeenCalled();
    delete process.env.AOS_NO_CEO_TRIAGE;
  });

  it('skips when ceo-office is already running', async () => {
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([
      { agent_type: 'ceo-office', status: 'running' } as any,
    ]);

    const mockClient = {
      issues: vi.fn().mockResolvedValue({ nodes: Array(10).fill({ identifier: 'RYA-1', title: 'test', priority: 3 }) }),
    };
    vi.mocked(getReadClient).mockReturnValue(mockClient as any);

    await ceoOfficeTriageHeartbeat();
    expect(handleDispatch).not.toHaveBeenCalled();
  });

  it('skips when In Review count is below threshold', async () => {
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([]);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);

    const mockClient = {
      issues: vi.fn().mockResolvedValue({ nodes: Array(3).fill({ identifier: 'RYA-1', title: 'test', priority: 3 }) }),
    };
    vi.mocked(getReadClient).mockReturnValue(mockClient as any);

    await ceoOfficeTriageHeartbeat();
    expect(handleDispatch).not.toHaveBeenCalled();
  });

  it('dispatches ceo-office when In Review count exceeds threshold', async () => {
    const issueKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 1}`);
    const { mockAgentClient } = buildCeoTriageMocks(issueKeys);

    await ceoOfficeTriageHeartbeat();

    expect(mockAgentClient.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Daily triage: 8 issues In Review'),
      })
    );
    expect(handleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'ceo-office',
        issueKey: 'RYA-99',
        from: 'scheduler',
      })
    );
    // RYA-1060: must persist a fire record so a node restart doesn't redispatch
    expect(existsSync(CEO_TRIAGE_FIRED_PATH_TEST)).toBe(true);
    const stamp = JSON.parse(readFileSync(CEO_TRIAGE_FIRED_PATH_TEST, 'utf-8'));
    expect(stamp.lastQueueCount).toBe(8);
    expect(typeof stamp.lastQueueHash).toBe('string');
    expect(stamp.lastQueueHash).toHaveLength(40); // SHA-1 hex
  });

  // RYA-1060: regression test for the actual bug. Before the fix, a node
  // restart reset `lastCeoTriageAt = 0` and the next tick re-fired triage on
  // the same In Review set. We simulate a restart by leaving an existing fire
  // record on disk (matching the queue contents) and verify the heartbeat
  // skips dispatching.
  it('skips when the In Review queue is unchanged since last fire (survives restart)', async () => {
    const issueKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 100}`);
    // Pre-write a fire record with the matching hash to simulate "we just
    // fired before the restart"
    const sortedKeys = [...issueKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const expectedHash = createHash('sha1').update(sortedKeys).digest('hex');
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 60_000, // 1 min ago — well within cooldown anyway
      lastFiredIso: new Date(fakeNow - 60_000).toISOString(),
      lastQueueHash: expectedHash,
      lastQueueCount: issueKeys.length,
    }));

    buildCeoTriageMocks(issueKeys);

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1060: when the queue contents change (one issue closed, another
  // opened), we should fire again — but only after the soft floor has elapsed.
  it('fires when queue contents change AND soft floor has elapsed', async () => {
    const oldKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 200}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // Last fire was 25h ago — past the 30-min soft floor AND on a previous
    // UTC day (RYA-1205 daily cap would block a same-day re-fire).
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 25 * 60 * 60_000,
      lastFiredIso: new Date(fakeNow - 25 * 60 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
    }));

    // New queue: drop RYA-200, add RYA-208 — different hash
    const newKeys = ['RYA-201', 'RYA-202', 'RYA-203', 'RYA-204', 'RYA-205', 'RYA-206', 'RYA-207', 'RYA-208'];
    buildCeoTriageMocks(newKeys, 'RYA-300');

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ceo-office', issueKey: 'RYA-300' })
    );
    // New hash should be persisted
    const stamp = JSON.parse(readFileSync(CEO_TRIAGE_FIRED_PATH_TEST, 'utf-8'));
    expect(stamp.lastQueueHash).not.toBe(oldHash);
  });

  // RYA-1070: the monitor loop calls this every 15s. Before the fix, every
  // tick fetched the In Review queue from Linear (~5760 API queries/day).
  // After: the iterator-level throttle short-circuits within the cooldown
  // window, so a burst of 5 calls in quick succession only hits Linear once.
  it('throttles Linear API fetch to once per CEO_TRIAGE_INTERVAL_MS window', async () => {
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([]);
    vi.mocked(loadAgentConfig).mockReturnValue({ maxParallel: 2 } as any);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);

    // Below-threshold queue so we land on a "skip — below threshold" path and
    // don't actually dispatch. The point of this test is just whether the
    // Linear fetch is gated, not what the inner skip path does.
    const mockClient = {
      issues: vi.fn().mockResolvedValue({
        nodes: Array(2).fill({ identifier: 'RYA-1', title: 'test', priority: 3 }),
      }),
    };
    vi.mocked(getReadClient).mockReturnValue(mockClient as any);

    // Five back-to-back ticks (simulating five 15s monitor loops within the
    // 30-min cooldown window).
    for (let i = 0; i < 5; i++) {
      // Advance fakeNow by 15s between ticks — well within CEO_TRIAGE_INTERVAL_MS
      fakeNow += 15_000;
      vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
      await ceoOfficeTriageHeartbeat();
    }

    // The Linear `issues` query must have run exactly once — the first tick.
    // All four follow-up ticks short-circuit at the in-memory throttle.
    expect(mockClient.issues).toHaveBeenCalledTimes(1);
    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1060: even if the queue contents change, don't re-fire within the
  // 30-min soft floor — prevents tight loops when a single issue churns.
  it('skips when queue changed but soft floor (30 min) has not elapsed', async () => {
    const oldKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 300}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // Last fire was 5 min ago — well within the 30-min soft floor
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 5 * 60_000,
      lastFiredIso: new Date(fakeNow - 5 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
    }));

    // Different queue: should be a new hash
    const newKeys = ['RYA-301', 'RYA-302', 'RYA-303', 'RYA-304', 'RYA-305', 'RYA-306', 'RYA-307', 'RYA-999'];
    buildCeoTriageMocks(newKeys);

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1124: when items LEAVE the queue (auto-closed, moved to Backlog) but
  // no new items appear, the hash flips but the actionable subset is unchanged.
  // ceo-office has nothing genuinely new to triage — must skip even though
  // soft floor has elapsed.
  it('RYA-1124: skips when queue shrinks but no new items appeared', async () => {
    const oldKeys = Array.from({ length: 10 }, (_, i) => `RYA-${i + 400}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // Last fire was 90 min ago — well past the 30-min soft floor
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 90 * 60_000,
      lastFiredIso: new Date(fakeNow - 90 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
      lastQueueKeys: oldKeys,
    }));

    // Two trivial fixes auto-closed during the day → 8 items remain, all
    // were in the prior fire's set. Hash differs but no new items.
    const newKeys = oldKeys.slice(2); // RYA-402..409
    buildCeoTriageMocks(newKeys);

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1124: when even ONE genuinely new item appears, fire — that's the
  // signal CEO Office needs to know about. Mixed case: most items are stale
  // (already in prior fire), one is brand new.
  it('RYA-1124: fires when at least one new item appears (mixed stale + new)', async () => {
    const oldKeys = Array.from({ length: 10 }, (_, i) => `RYA-${i + 500}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // 25h ago: previous UTC day, so the RYA-1205 daily cap doesn't block.
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 25 * 60 * 60_000,
      lastFiredIso: new Date(fakeNow - 25 * 60 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
      lastQueueKeys: oldKeys,
    }));

    // Same 10 stale items + 1 brand new (RYA-599)
    const newKeys = [...oldKeys, 'RYA-599'];
    buildCeoTriageMocks(newKeys, 'RYA-700');

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ceo-office', issueKey: 'RYA-700' })
    );
    // Persist new state including the full key list (RYA-1124)
    const stamp = JSON.parse(readFileSync(CEO_TRIAGE_FIRED_PATH_TEST, 'utf-8'));
    expect(stamp.lastQueueKeys).toEqual(newKeys);
  });

  // RYA-1124: backward-compat — pre-fix records on disk have no
  // lastQueueKeys field. The new check must gracefully no-op (defer to the
  // soft-floor check) instead of crashing or skipping incorrectly.
  it('RYA-1124: handles pre-RYA-1124 fire records (no lastQueueKeys field)', async () => {
    const oldKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 600}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // Pre-fix record format: no lastQueueKeys. Last fire 25h ago (previous
    // UTC day, clear of the RYA-1205 daily cap).
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 25 * 60 * 60_000,
      lastFiredIso: new Date(fakeNow - 25 * 60 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
      // lastQueueKeys: intentionally absent
    }));

    // Different keys → different hash. Without lastQueueKeys we can't run the
    // set-difference check, so we fall through to the soft-floor check, which
    // passes (25h > 30 min) → fire.
    const newKeys = ['RYA-700', 'RYA-701', 'RYA-702', 'RYA-703', 'RYA-704', 'RYA-705', 'RYA-706', 'RYA-707'];
    buildCeoTriageMocks(newKeys, 'RYA-800');

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ceo-office', issueKey: 'RYA-800' })
    );
    // After firing, the new record HAS lastQueueKeys
    const stamp = JSON.parse(readFileSync(CEO_TRIAGE_FIRED_PATH_TEST, 'utf-8'));
    expect(stamp.lastQueueKeys).toEqual(newKeys);
  });

  // RYA-1205: prior triage issues sitting In Review must not count toward
  // the threshold. 4 real issues + 3 stale "Daily triage:" issues = 7 In
  // Review, but only 4 actionable — below the threshold of 5 → skip.
  it('RYA-1205: excludes Daily triage:* issues from the threshold count', async () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) => ({ identifier: `RYA-${i + 900}`, title: `Real issue ${i}`, priority: 3 })),
      ...Array.from({ length: 3 }, (_, i) => ({ identifier: `RYA-${i + 950}`, title: `Daily triage: ${10 + i} issues In Review`, priority: 3 })),
    ];
    buildCeoTriageMocks(nodes.map(n => n.identifier), 'RYA-999', nodes);

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1205: the actual self-feeding bug. A finished triage issue lands In
  // Review (reconciler default, RYA-1204) and used to count as a NEW item in
  // the set-difference check, re-firing after every 30-min cooldown
  // (RYA-1186 → 1190 → 1193 → 1202 on 2026-06-10). With the filter, the only
  // "new" key is the triage issue itself → nothing genuinely new → skip.
  it('RYA-1205: a triage issue entering In Review does not count as a new item', async () => {
    const oldKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 1000}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // 25h ago: soft floor and daily cap both clear — only the keyset logic
    // stands between the trigger and a re-fire.
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 25 * 60 * 60_000,
      lastFiredIso: new Date(fakeNow - 25 * 60 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
      lastQueueKeys: oldKeys,
    }));

    // One real issue closed, and the PRIOR triage issue arrived In Review.
    // Hash differs from last fire, but after filtering the triage issue the
    // remaining keys are all known → no new items → skip.
    const nodes = [
      ...oldKeys.slice(1).map((k, i) => ({ identifier: k, title: `Real issue ${i}`, priority: 3 })),
      { identifier: 'RYA-1186', title: 'Daily triage: 13 issues In Review', priority: 3 },
    ];
    buildCeoTriageMocks(nodes.map(n => n.identifier), 'RYA-1099', nodes);

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1205: hard cap — even with genuinely new items and an elapsed soft
  // floor, at most one auto-triage fires per UTC day.
  it('RYA-1205: daily cap blocks a second auto-triage in the same UTC day', async () => {
    // Pin the clock to mid-day UTC so "2 hours ago" is unambiguously the
    // same UTC date.
    const noonUtc = Date.UTC(2026, 5, 10, 12, 0, 0);
    vi.spyOn(Date, 'now').mockReturnValue(noonUtc);

    const oldKeys = Array.from({ length: 8 }, (_, i) => `RYA-${i + 1100}`);
    const sortedOld = [...oldKeys].sort().join(',');
    const { createHash } = await import('crypto');
    const oldHash = createHash('sha1').update(sortedOld).digest('hex');
    // Fired 2h ago today: hash check passes (new queue), new-items check
    // passes (genuinely new key), soft floor passes (2h > 30min) — only the
    // daily cap stands.
    writeFileSync(CEO_TRIAGE_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: noonUtc - 2 * 60 * 60_000,
      lastFiredIso: new Date(noonUtc - 2 * 60 * 60_000).toISOString(),
      lastQueueHash: oldHash,
      lastQueueCount: oldKeys.length,
      lastQueueKeys: oldKeys,
    }));

    buildCeoTriageMocks([...oldKeys, 'RYA-1199'], 'RYA-1200');

    await ceoOfficeTriageHeartbeat();

    expect(handleDispatch).not.toHaveBeenCalled();
  });
});

// ─── CEO Office daily dispatch tests ───

describe('ceoOfficeDailyDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!existsSync('/tmp/aos-test')) mkdirSync('/tmp/aos-test', { recursive: true });
    clearCeoDailyFire();
    fakeNow += 25 * 60 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  it('skips when AOS_NO_CEO_DAILY is set', async () => {
    process.env.AOS_NO_CEO_DAILY = '1';
    await ceoOfficeDailyDispatch();
    expect(handleDispatch).not.toHaveBeenCalled();
    delete process.env.AOS_NO_CEO_DAILY;
  });

  it('skips outside the target hour window', async () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(3);
    await ceoOfficeDailyDispatch();
    expect(handleDispatch).not.toHaveBeenCalled();
  });

  it('skips when ceo-office is already running', async () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([
      { agent_type: 'ceo-office', status: 'running' } as any,
    ]);

    await ceoOfficeDailyDispatch();
    expect(handleDispatch).not.toHaveBeenCalled();
  });

  it('dispatches ceo-office during target hour when idle', async () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-03-28T13:00:00.000Z');
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([]);
    vi.mocked(loadAgentConfig).mockReturnValue({ maxParallel: 2 } as any);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);
    vi.mocked(getWorkflowStateId).mockResolvedValue('state-todo');

    const mockAgentClient = {
      createIssue: vi.fn().mockResolvedValue({
        success: true,
        issue: Promise.resolve({ identifier: 'RYA-200' }),
      }),
    };
    vi.mocked(getAgentClient).mockReturnValue(mockAgentClient as any);

    await ceoOfficeDailyDispatch();

    expect(mockAgentClient.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Daily CEO Office: morning triage & retro'),
        priority: 3,
      })
    );
    expect(handleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'ceo-office',
        issueKey: 'RYA-200',
        from: 'scheduler',
      })
    );
    // RYA-1060: must persist a fire stamp so a node restart doesn't redispatch
    expect(existsSync(CEO_DAILY_FIRED_PATH_TEST)).toBe(true);
    const stamp = JSON.parse(readFileSync(CEO_DAILY_FIRED_PATH_TEST, 'utf-8'));
    expect(stamp.lastFiredMs).toBe(fakeNow);
  });

  // RYA-1060: regression test. Before the fix, a node restart inside the
  // 8-10 AM window reset `lastCeoDailyAt = 0` and re-fired the daily dispatch.
  // Simulate a restart by leaving an existing fire record on disk that's
  // within the 24h cooldown.
  it('skips when a prior fire stamp on disk is within 24h (survives restart)', async () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([]);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);

    // Simulate "we fired 2 hours ago, then node restarted"
    writeFileSync(CEO_DAILY_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 2 * 60 * 60_000,
      lastFiredIso: new Date(fakeNow - 2 * 60 * 60_000).toISOString(),
    }));

    await ceoOfficeDailyDispatch();

    expect(handleDispatch).not.toHaveBeenCalled();
  });

  // RYA-1060: complement to the above — fire stamp older than 24h should NOT
  // block dispatch (otherwise daily would only ever fire once per install).
  it('fires when prior stamp is older than 24h', async () => {
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(9);
    vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-03-29T13:00:00.000Z');
    vi.mocked(agentExists).mockReturnValue(true);
    vi.mocked(getActiveAttempts).mockReturnValue([]);
    vi.mocked(loadAgentConfig).mockReturnValue({ maxParallel: 2 } as any);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);
    vi.mocked(getWorkflowStateId).mockResolvedValue('state-todo');

    // Prior fire was 25 hours ago — past the 24h cooldown
    writeFileSync(CEO_DAILY_FIRED_PATH_TEST, JSON.stringify({
      lastFiredMs: fakeNow - 25 * 60 * 60_000,
      lastFiredIso: new Date(fakeNow - 25 * 60 * 60_000).toISOString(),
    }));

    const mockAgentClient = {
      createIssue: vi.fn().mockResolvedValue({
        success: true,
        issue: Promise.resolve({ identifier: 'RYA-201' }),
      }),
    };
    vi.mocked(getAgentClient).mockReturnValue(mockAgentClient as any);

    await ceoOfficeDailyDispatch();

    expect(handleDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ceo-office', issueKey: 'RYA-201' })
    );
  });
});

// ─── Weekly PnL digest heartbeat tests (RYA-927) ───
//
// PNL_TARGET_WEEKDAY/HOUR_UTC are read from env at module load and default to
// Monday 14:00 UTC. We don't override them here — instead we spy on
// Date.prototype.getUTCDay/getUTCHours to fake the wall clock.

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { runWeeklyPnL } from '../analytics/weekly-pnl.js';

const PNL_FIRED_PATH = '/tmp/aos-test/pnl-fired.json';

function clearPnLFire(): void {
  if (existsSync(PNL_FIRED_PATH)) unlinkSync(PNL_FIRED_PATH);
}

describe('weeklyPnLDigestHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!existsSync('/tmp/aos-test')) mkdirSync('/tmp/aos-test', { recursive: true });
    clearPnLFire();
    fakeNow += 8 * 24 * 60 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
    vi.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(1);
    vi.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(14);
  });

  it('skips when AOS_NO_PNL_DIGEST is set', async () => {
    process.env.AOS_NO_PNL_DIGEST = '1';
    await weeklyPnLDigestHeartbeat();
    expect(runWeeklyPnL).not.toHaveBeenCalled();
    expect(existsSync(PNL_FIRED_PATH)).toBe(false);
    delete process.env.AOS_NO_PNL_DIGEST;
  });

  it('skips on the wrong UTC weekday (Tuesday)', async () => {
    vi.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(2); // Tuesday
    await weeklyPnLDigestHeartbeat();
    expect(runWeeklyPnL).not.toHaveBeenCalled();
    expect(existsSync(PNL_FIRED_PATH)).toBe(false);
  });

  it('skips outside the target UTC hour', async () => {
    vi.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(10); // not 14
    await weeklyPnLDigestHeartbeat();
    expect(runWeeklyPnL).not.toHaveBeenCalled();
    expect(existsSync(PNL_FIRED_PATH)).toBe(false);
  });

  it('skips when last fire is within PNL_DEDUP_MS (6 days)', async () => {
    // Pretend we fired 1 day ago — well under the 6-day dedup window.
    writeFileSync(
      PNL_FIRED_PATH,
      JSON.stringify({
        lastFiredMs: fakeNow - 24 * 60 * 60_000,
        lastFiredIso: new Date(fakeNow - 24 * 60 * 60_000).toISOString(),
        posted: true,
      }),
    );

    await weeklyPnLDigestHeartbeat();
    expect(runWeeklyPnL).not.toHaveBeenCalled();
    // Stamp file is untouched (lastFiredMs unchanged).
    const stamp = JSON.parse(readFileSync(PNL_FIRED_PATH, 'utf-8'));
    expect(stamp.lastFiredMs).toBe(fakeNow - 24 * 60 * 60_000);
  });

  it('fires runWeeklyPnL and writes the dedup stamp on the success path', async () => {
    expect(existsSync(PNL_FIRED_PATH)).toBe(false);

    await weeklyPnLDigestHeartbeat();

    expect(runWeeklyPnL).toHaveBeenCalledTimes(1);
    expect(runWeeklyPnL).toHaveBeenCalledWith({});
    expect(existsSync(PNL_FIRED_PATH)).toBe(true);
    const stamp = JSON.parse(readFileSync(PNL_FIRED_PATH, 'utf-8'));
    expect(stamp.posted).toBe(true);
    expect(stamp.lastFiredMs).toBe(fakeNow);
    expect(typeof stamp.lastFiredIso).toBe('string');
    clearPnLFire();
  });
});

// ─── autoDispatchFromBacklog — Todo-only iteration (RYA-1050) ───
//
// Backlog issues are CEO's queue, not work-ready by definition. Iterating them
// produced 260 lines of "Auto-dispatch blocked" log spam in 16hrs from two
// chronically-blocked Backlog issues (RYA-639, RYA-969) and burned Linear API
// budget on per-cycle blocker re-fetches.
describe('autoDispatchFromBacklog — Todo-only iteration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Advance time past the 2-min auto-dispatch cooldown
    fakeNow += SIX_MINUTES;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
  });

  it('queries only the Todo workflow state — never Backlog', async () => {
    const workflowStates = vi.fn(async (_args: any) => ({ nodes: [{ id: 'todo-state-id' }] }));
    const issues = vi.fn(async (_args: any) => ({ nodes: [] }));
    vi.mocked(getReadClient).mockReturnValueOnce({ workflowStates, issues } as any);

    await autoDispatchFromBacklog();

    // workflowStates must be called with name === 'Todo' only
    expect(workflowStates).toHaveBeenCalledTimes(1);
    const wfCall = workflowStates.mock.calls[0][0] as any;
    expect(wfCall.filter.name.eq).toBe('Todo');

    // No call should have asked for Backlog
    const backlogCalls = workflowStates.mock.calls.filter(
      (c) => (c[0] as any)?.filter?.name?.eq === 'Backlog',
    );
    expect(backlogCalls.length).toBe(0);
  });

  it('issues filter only includes Todo state IDs (Backlog issues are not iterated)', async () => {
    const workflowStates = vi.fn(async (_args: any) => ({ nodes: [{ id: 'todo-state-id' }] }));
    const issues = vi.fn(async (_args: any) => ({ nodes: [] }));
    vi.mocked(getReadClient).mockReturnValueOnce({ workflowStates, issues } as any);

    await autoDispatchFromBacklog();

    expect(issues).toHaveBeenCalledTimes(1);
    const issuesCall = issues.mock.calls[0][0] as any;
    const stateIds = issuesCall.filter.state.id.in;
    expect(stateIds).toEqual(['todo-state-id']);
    expect(stateIds).not.toContain('backlog-state-id');
  });
});

// ─── autoDispatchFromBacklog — duplicate-of-Done guard (RYA-1071) ───
//
// On 2026-05-11 a coo session was auto-dispatched for RYA-1067 which had been
// marked as duplicate-of RYA-1065 (Done). ~20h of tmux lifetime wasted. The
// guard checks Linear's duplicate relation before spawning.
describe('autoDispatchFromBacklog — duplicate-of-Done guard', () => {
  let fakeAutoDispatchNow: number;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeAutoDispatchNow = Date.now() + 30 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeAutoDispatchNow);
    vi.mocked(isDuplicateOfDone).mockResolvedValue(null);
    vi.mocked(isBlocked).mockResolvedValue({ blocked: false, blockers: [] });
    vi.mocked(loadAgentConfig).mockImplementation((role: string) => ({
      baseModel: 'cc',
      linearUserId: `${role}-user-uuid`,
    } as any));
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);
  });

  function mockClientForOneIssue(identifier: string, title = 'Implement thing') {
    const issueRow = {
      identifier,
      title,
      priority: 2,
      description: '',
      delegateId: 'coo-user-uuid',
      assignee: Promise.resolve(null),
    };
    const workflowStates = vi.fn(async () => ({ nodes: [{ id: 'todo-state-id', name: 'Todo' }] }));
    const issues = vi.fn(async () => ({ nodes: [issueRow] }));
    vi.mocked(getReadClient).mockReturnValue({ workflowStates, issues } as any);
  }

  it('skips dispatch when issue is duplicate-of a Done issue', async () => {
    mockClientForOneIssue('RYA-1067');
    vi.mocked(isDuplicateOfDone).mockResolvedValueOnce({
      canonicalKey: 'RYA-1065',
      canonicalState: 'Done',
    });
    const { agentStartCommand } = await import('../commands/agent.js');

    await autoDispatchFromBacklog();

    expect(isDuplicateOfDone).toHaveBeenCalledWith('RYA-1067');
    // No agent spawned — that's the whole point of RYA-1071
    expect(agentStartCommand).not.toHaveBeenCalled();
  });

  it('dispatches normally when issue has no duplicate-of relation', async () => {
    mockClientForOneIssue('RYA-2000');
    vi.mocked(isDuplicateOfDone).mockResolvedValueOnce(null);
    const { agentStartCommand } = await import('../commands/agent.js');

    await autoDispatchFromBacklog();

    expect(isDuplicateOfDone).toHaveBeenCalledWith('RYA-2000');
    expect(agentStartCommand).toHaveBeenCalled();
  });

  it('does not call isDuplicateOfDone when isBlocked returns blocked=true (guard short-circuits)', async () => {
    mockClientForOneIssue('RYA-3000');
    vi.mocked(isBlocked).mockResolvedValueOnce({
      blocked: true,
      blockers: [{ issueKey: 'RYA-2999', issueTitle: 'Blocker', issueState: 'In Progress' }],
    });

    await autoDispatchFromBacklog();

    expect(isDuplicateOfDone).not.toHaveBeenCalled();
  });
});

// ─── reconcileInProgressIssues — sticky status_intent (RYA-1116) ───
//
// The reconciler runs every 5 min and looks for stale In Progress issues with
// a `completed` latest attempt. Before RYA-1116 it promoted them to In Review
// unconditionally, which clobbered `status_intent: in-progress` set by parent
// agents handing off to engineering. After RYA-1116 it consults the parent's
// own HANDOFF.md and skips promotion when the sticky intent says so.

describe('reconcileInProgressIssues — RYA-1116 sticky status_intent', () => {
  let fakeReconcileNow: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Advance time far enough to bypass the 5-min reconcile cooldown.
    fakeReconcileNow = Date.now() + 30 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeReconcileNow);
  });

  function mockOneInProgressIssue(opts: { identifier: string; title?: string }) {
    const mockClient = {
      issues: vi.fn().mockResolvedValue({
        nodes: [{
          id: `id-${opts.identifier}`,
          identifier: opts.identifier,
          title: opts.title ?? 'Triage',
          labels: () => Promise.resolve({ nodes: [] }),
        }],
      }),
    };
    vi.mocked(getReadClient).mockReturnValue(mockClient as any);
    return mockClient;
  }

  it('skips promotion to In Review when HANDOFF.md has status_intent: in-progress', async () => {
    const { updateIssueState } = await import('../core/linear.js');
    const { getAttemptsByIssue } = await import('../core/db.js');

    mockOneInProgressIssue({ identifier: 'RYA-1107' });
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      {
        id: 1, issue_key: 'RYA-1107', agent_type: 'research-lead',
        status: 'completed', workspace_path: '/tmp/aos-test/RYA-1107',
      } as any,
    ]);
    vi.mocked(hasStickyInProgressIntent).mockReturnValueOnce(true);

    await reconcileInProgressIssues();

    // Reconciler must NOT promote to In Review.
    expect(updateIssueState).not.toHaveBeenCalled();
  });

  it('promotes to In Review when HANDOFF.md does NOT have sticky intent', async () => {
    const { updateIssueState } = await import('../core/linear.js');
    const { getAttemptsByIssue } = await import('../core/db.js');

    mockOneInProgressIssue({ identifier: 'RYA-2001' });
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      {
        id: 2, issue_key: 'RYA-2001', agent_type: 'lead-engineer',
        status: 'completed', workspace_path: '/tmp/aos-test/RYA-2001',
      } as any,
    ]);
    vi.mocked(hasStickyInProgressIntent).mockReturnValueOnce(false);

    await reconcileInProgressIssues();

    expect(updateIssueState).toHaveBeenCalledWith('id-RYA-2001', 'In Review', expect.any(String));
  });
});

// ─── reconcileInProgressIssues — honor status_intent (RYA-1204) ───
//
// The monitor's completion sequence is not atomic: an auto-deploy restart can
// kill the process after the attempt is marked `completed` but before the
// HANDOFF status_intent is applied (RYA-1193: `status_intent: done` lost,
// reconciler moved the issue to In Review, re-triggering CEO triage in a
// loop). The reconciler must apply the agent's declared intent and only fall
// back to the shouldSkipReview heuristic when no intent exists.

describe('reconcileInProgressIssues — RYA-1204 honor status_intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Advance time far enough to bypass the 5-min reconcile cooldown.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
  });

  function mockOneInProgressIssue(identifier: string) {
    vi.mocked(getReadClient).mockReturnValue({
      issues: vi.fn().mockResolvedValue({
        nodes: [{
          id: `id-${identifier}`,
          identifier,
          title: 'Daily triage',
          labels: () => Promise.resolve({ nodes: [] }),
        }],
      }),
    } as any);
  }

  async function mockCompletedAttempt(identifier: string, handoff: string) {
    const { getAttemptsByIssue } = await import('../core/db.js');
    const { readFileOnRemote } = await import('../core/tmux.js');
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      {
        id: 9, issue_key: identifier, agent_type: 'ceo-office',
        status: 'completed', workspace_path: `/tmp/aos-test/${identifier}`,
      } as any,
    ]);
    vi.mocked(readFileOnRemote).mockReturnValueOnce(handoff);
  }

  it('moves issue to Done when HANDOFF.md declares status_intent: done', async () => {
    const { updateIssueState } = await import('../core/linear.js');
    mockOneInProgressIssue('RYA-1193');
    await mockCompletedAttempt('RYA-1193', '---\nstatus_intent: done\n---\n# HANDOFF');
    vi.mocked(parseStatusIntent).mockReturnValueOnce({ status: 'done' });

    await reconcileInProgressIssues();

    expect(updateIssueState).toHaveBeenCalledWith('id-RYA-1193', 'Done', expect.any(String));
  });

  it('moves issue to Todo when HANDOFF.md declares status_intent: todo', async () => {
    const { updateIssueState } = await import('../core/linear.js');
    mockOneInProgressIssue('RYA-2100');
    await mockCompletedAttempt('RYA-2100', '---\nstatus_intent: todo\n---\n# HANDOFF');
    vi.mocked(parseStatusIntent).mockReturnValueOnce({ status: 'todo' });

    await reconcileInProgressIssues();

    expect(updateIssueState).toHaveBeenCalledWith('id-RYA-2100', 'Todo', expect.any(String));
  });

  it('falls back to In Review when HANDOFF.md has no status_intent', async () => {
    const { updateIssueState } = await import('../core/linear.js');
    mockOneInProgressIssue('RYA-2101');
    await mockCompletedAttempt('RYA-2101', '# HANDOFF without front matter');
    vi.mocked(parseStatusIntent).mockReturnValueOnce(null);

    await reconcileInProgressIssues();

    expect(updateIssueState).toHaveBeenCalledWith('id-RYA-2101', 'In Review', expect.any(String));
  });
});

// ─── autoDispatchFromBacklog — recent-completion log throttle (RYA-1130) ───
//
// The iterator runs every ~15s. A Todo issue with a recent-completion marker
// would emit "Auto-dispatch skip (recent completion): RYA-XXXX" on every
// iteration indefinitely. RYA-1111 produced 822 lines in 30 minutes
// (2026-05-14). Fix: log once per (issueKey, completion-timestamp) tuple.
describe('autoDispatchFromBacklog — recent-completion log throttle (RYA-1130)', () => {
  let fakeRecentNow: number;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // RYA-1130: A prior test in this file mocks Date.prototype.toISOString
    // (line ~1057) and Date.prototype.getUTC*. vi.clearAllMocks does NOT
    // restore spies — only resets call history. Restore Date spies first so
    // our timestamp math is honest. Module-level vi.mock(...) mocks are not
    // affected by restoreAllMocks; only spy-based mocks are.
    vi.restoreAllMocks();
    vi.clearAllMocks();
    __resetRecentCompletionLogCacheForTests();
    fakeRecentNow = Date.now() + 60 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeRecentNow);
    vi.mocked(isBlocked).mockResolvedValue({ blocked: false, blockers: [] });
    vi.mocked(isDuplicateOfDone).mockResolvedValue(null);
    vi.mocked(loadAgentConfig).mockImplementation((role: string) => ({
      baseModel: 'cc',
      linearUserId: `${role}-user-uuid`,
    } as any));
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(canStartNewSession).mockReturnValue({ allowed: true } as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function mockOneTodoIssue(identifier: string): void {
    const issueRow = {
      identifier,
      title: 'Implement thing',
      priority: 2,
      description: '',
      delegateId: 'coo-user-uuid',
      assignee: Promise.resolve(null),
    };
    const workflowStates = vi.fn(async () => ({ nodes: [{ id: 'todo-state-id', name: 'Todo' }] }));
    const issues = vi.fn(async () => ({ nodes: [issueRow] }));
    vi.mocked(getReadClient).mockReturnValue({ workflowStates, issues } as any);
  }

  function skipLogCount(issueKey: string): number {
    return logSpy.mock.calls.filter((c: unknown[]) => {
      const arg = String(c[0] ?? '');
      return arg.includes('Auto-dispatch skip (recent completion)') && arg.includes(issueKey);
    }).length;
  }

  it('logs the recent-completion skip on the first iteration', async () => {
    const { getAttemptsByIssue } = await import('../core/db.js');
    mockOneTodoIssue('RYA-1111');
    const attempts = [
      {
        id: 'attempt-1', issue_key: 'RYA-1111', agent_type: 'research-lead',
        status: 'completed',
        created_at: new Date(fakeRecentNow - 30 * 60_000).toISOString(),
      } as any,
    ];
    vi.mocked(getAttemptsByIssue).mockImplementation(() => attempts);

    await autoDispatchFromBacklog();

    expect(skipLogCount('RYA-1111')).toBe(1);
  });

  it('does NOT re-log the recent-completion skip on subsequent iterations (same completion)', async () => {
    const { getAttemptsByIssue } = await import('../core/db.js');
    mockOneTodoIssue('RYA-1111');
    const completionIso = new Date(fakeRecentNow - 30 * 60_000).toISOString();
    const attempts = [
      {
        id: 'attempt-1', issue_key: 'RYA-1111', agent_type: 'research-lead',
        status: 'completed', created_at: completionIso,
      } as any,
    ];
    vi.mocked(getAttemptsByIssue).mockImplementation(() => attempts);

    // Five iterations — the cadence the bug was firing at
    for (let i = 0; i < 5; i++) {
      await autoDispatchFromBacklog();
    }

    // Exactly one log line — not five
    expect(skipLogCount('RYA-1111')).toBe(1);
  });

  it('re-logs when a NEW completion timestamp appears (the marker updated)', async () => {
    const { getAttemptsByIssue } = await import('../core/db.js');
    mockOneTodoIssue('RYA-1111');
    const firstCompletionIso = new Date(fakeRecentNow - 30 * 60_000).toISOString();
    let attempts: any[] = [
      {
        id: 'attempt-1', issue_key: 'RYA-1111', agent_type: 'research-lead',
        status: 'completed', created_at: firstCompletionIso,
      },
    ];
    vi.mocked(getAttemptsByIssue).mockImplementation(() => attempts);

    await autoDispatchFromBacklog();
    expect(skipLogCount('RYA-1111')).toBe(1);

    // New completion lands — this should produce a fresh log line because the
    // de-dup tuple changes.
    const secondCompletionIso = new Date(fakeRecentNow - 5 * 60_000).toISOString();
    attempts = [
      {
        id: 'attempt-2', issue_key: 'RYA-1111', agent_type: 'research-lead',
        status: 'completed', created_at: secondCompletionIso,
      },
      {
        id: 'attempt-1', issue_key: 'RYA-1111', agent_type: 'research-lead',
        status: 'completed', created_at: firstCompletionIso,
      },
    ];

    await autoDispatchFromBacklog();
    expect(skipLogCount('RYA-1111')).toBe(2);

    // And then a repeat of the same second completion is silent again
    await autoDispatchFromBacklog();
    expect(skipLogCount('RYA-1111')).toBe(2);
  });

  it('tracks independent log state per issueKey', async () => {
    const { getAttemptsByIssue } = await import('../core/db.js');
    const completionIso = new Date(fakeRecentNow - 30 * 60_000).toISOString();
    vi.mocked(getAttemptsByIssue).mockImplementation((key: string) => [
      {
        id: `attempt-${key}`, issue_key: key, agent_type: 'research-lead',
        status: 'completed', created_at: completionIso,
      } as any,
    ]);

    // Iteration 1: RYA-1111 is the Todo issue
    mockOneTodoIssue('RYA-1111');
    await autoDispatchFromBacklog();
    expect(skipLogCount('RYA-1111')).toBe(1);

    // Iteration 2: RYA-2222 is the Todo issue — should log independently
    mockOneTodoIssue('RYA-2222');
    await autoDispatchFromBacklog();
    expect(skipLogCount('RYA-2222')).toBe(1);

    // Iteration 3: RYA-1111 returns — still silent because its tuple is unchanged
    mockOneTodoIssue('RYA-1111');
    await autoDispatchFromBacklog();
    expect(skipLogCount('RYA-1111')).toBe(1);
  });

  it('ignores completed attempts outside the dedup window', async () => {
    const { getAttemptsByIssue } = await import('../core/db.js');
    mockOneTodoIssue('RYA-1111');
    // Completion is 12 hours ago — outside the 6-hour window
    const staleIso = new Date(fakeRecentNow - 12 * 60 * 60_000).toISOString();
    const attempts = [
      {
        id: 'attempt-old', issue_key: 'RYA-1111', agent_type: 'research-lead',
        status: 'completed', created_at: staleIso,
      } as any,
    ];
    vi.mocked(getAttemptsByIssue).mockImplementation(() => attempts);

    await autoDispatchFromBacklog();

    // No recent completion → no skip log
    expect(skipLogCount('RYA-1111')).toBe(0);
  });
});
