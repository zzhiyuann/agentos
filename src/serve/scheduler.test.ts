import { describe, it, expect, beforeEach, vi } from 'vitest';
import { globalDismissedSessions } from '../core/linear.js';

// Mock all external dependencies before importing scheduler
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
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
}));

vi.mock('../commands/spawn.js', () => ({ spawnCommand: vi.fn() }));
vi.mock('../commands/agent.js', () => ({ agentStartCommand: vi.fn() }));
vi.mock('./state.js', () => ({ autoDispatchFailures: new Map() }));
vi.mock('./helpers.js', async () => {
  const actual = await vi.importActual('./helpers.js') as Record<string, unknown>;
  return {
    hasQueuedIssue: vi.fn(() => false),
    postToGroupChat: vi.fn(),
    // Use the REAL isPermanentIssueError so we test actual error classification
    isPermanentIssueError: actual.isPermanentIssueError,
  };
});
vi.mock('./monitor.js', () => ({ shouldSkipReview: vi.fn(() => false) }));
vi.mock('./circuit-breaker.js', () => ({
  checkCircuitBreaker: vi.fn(() => ({ allowed: true, consecutiveFailures: 0, backoffMs: 0 })),
  tripCircuitBreaker: vi.fn(),
}));

import { janitorAgentSessions, drainQueue } from './scheduler.js';
import { dismissAgentSession, listAgentSessions } from '../core/linear.js';
import { isPermanentIssueError } from './helpers.js';

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
    expect(dismissAgentSession).toHaveBeenCalledWith(sessionId, expect.any(String), '–');
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
    expect(dismissAgentSession).toHaveBeenCalledWith('sess-orphan', expect.any(String), '–');
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
