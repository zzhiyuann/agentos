import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock for Linear's SDK constructor — lets tests assert that
// ensureDelegate called updateIssue with the expected delegateId.
// Must be constructible (regular function, not arrow) since `new LinearClient()`
// is used at runtime in dispatch.ts.
const mockRoleClientUpdateIssue = vi.fn(async () => {});
vi.mock('@linear/sdk', () => ({
  LinearClient: vi.fn(function (this: any) { return { updateIssue: mockRoleClientUpdateIssue }; }),
}));

// Mocks must be declared before the module under test is imported.
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ linearTeamKey: 'RYA', linearTeamId: 'team-uuid' }),
}));

const mockAgentClientUpdateIssue = vi.fn(async () => {});
vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(),
  addComment: vi.fn(async () => {}),
  emitActivity: vi.fn(async () => {}),
  dismissAgentSession: vi.fn(async () => {}),
  getAgentClient: vi.fn(() => ({ updateIssue: mockAgentClientUpdateIssue })),
}));

vi.mock('../core/db.js', () => ({
  getActiveAttempt: vi.fn(() => null),
  updateAttemptStatus: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  getAgentLinearToken: vi.fn(() => 'mock-token'),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc', linearUserId: 'user-uuid' })),
  listAgents: vi.fn(() => ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead']),
}));

vi.mock('../core/router.js', () => ({
  canSpawnAgent: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
}));

vi.mock('../commands/agent.js', () => ({
  agentStartCommand: vi.fn(async () => 'started'),
}));

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  killSession: vi.fn(),
}));

vi.mock('./helpers.js', () => ({
  postToGroupChat: vi.fn(async () => {}),
  isPermanentIssueError: vi.fn(() => false),
}));

vi.mock('./circuit-breaker.js', () => ({
  checkCircuitBreaker: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../core/linear-relations.js', () => ({
  isDuplicateOfDone: vi.fn(async () => null),
}));

// RYA-1298: default = no effort rule matches (tests override per-case). Mocked so
// the developer's real ~/.aos/effort-rules.json can't leak into assertions.
vi.mock('../core/effort-rules.js', () => ({
  resolveEffortRule: vi.fn(() => ({ model: null, reason: 'mock' })),
}));

import { handleDispatch, isToDecidePrefix, ensureDelegate, __resetEnsureDelegateCacheForTests } from './dispatch.js';
import { resolveEffortRule } from '../core/effort-rules.js';
import { getIssue } from '../core/linear.js';
import { agentStartCommand } from '../commands/agent.js';
import { enqueue } from '../core/queue.js';
import { canSpawnAgent } from '../core/router.js';
import { getAgentLinearToken, loadAgentConfig } from '../core/persona.js';
import { isDuplicateOfDone } from '../core/linear-relations.js';
import { getActiveAttempt, updateAttemptStatus } from '../core/db.js';
import { sessionExists, killSession } from '../core/tmux.js';
import { dispatchDedup, autoRoutedSpawns, spawnClaims, claimSpawnSlot } from './state.js';

describe('isToDecidePrefix', () => {
  it('matches standard "[to decide] ..." titles', () => {
    expect(isToDecidePrefix('[to decide] Should we pivot to B2B?')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isToDecidePrefix('[TO DECIDE] Pricing tier structure')).toBe(true);
    expect(isToDecidePrefix('[To Decide] Launch timing')).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(isToDecidePrefix('  [to decide] Budget approval')).toBe(true);
  });

  it('does NOT match the marker mid-title (only prefix)', () => {
    expect(isToDecidePrefix('Fix: "[to decide]" prefix handling')).toBe(false);
    expect(isToDecidePrefix('Issue about what to decide for Q2')).toBe(false);
  });

  it('does not match unrelated titles', () => {
    expect(isToDecidePrefix('Implement feature X')).toBe(false);
    expect(isToDecidePrefix('Fix: broken dispatch guard')).toBe(false);
    expect(isToDecidePrefix('')).toBe(false);
  });
});

describe('handleDispatch — [to decide] guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('rejects dispatch when issue title starts with [to decide]', async () => {
    vi.mocked(getIssue).mockResolvedValue({
      id: 'issue-uuid',
      identifier: 'RYA-615',
      title: '[to decide] Should we pivot to B2B?',
      description: '',
      priority: 2,
      labels: [],
      state: 'Backlog',
      url: 'https://linear.app/ryanhub/issue/RYA-615',
    } as Awaited<ReturnType<typeof getIssue>>);

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-615' });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('error');
    expect(result.detail).toContain('[to decide]');
    expect(result.detail).toContain('RYA-615');
    expect(result.detail).toContain('lead-engineer');
    // Agent must NOT be spawned
    expect(vi.mocked(agentStartCommand)).not.toHaveBeenCalled();
  });

  it('allows dispatch for normal issue titles', async () => {
    vi.mocked(getIssue).mockResolvedValue({
      id: 'issue-uuid',
      identifier: 'RYA-100',
      title: 'Fix: broken dispatch guard',
      description: '',
      priority: 2,
      labels: [],
      state: 'Todo',
      url: 'https://linear.app/ryanhub/issue/RYA-100',
    } as Awaited<ReturnType<typeof getIssue>>);

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-100' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith('lead-engineer', 'RYA-100', undefined);
  });

  it('passes through when issue fetch fails (defensive default)', async () => {
    vi.mocked(getIssue).mockRejectedValueOnce(new Error('Network timeout'));
    // Second call (post-spawn comment path) succeeds
    vi.mocked(getIssue).mockResolvedValueOnce({
      id: 'issue-uuid',
      identifier: 'RYA-200',
      title: 'Implement feature',
      description: '',
      priority: 2,
      labels: [],
      state: 'Todo',
      url: 'https://linear.app/ryanhub/issue/RYA-200',
    } as Awaited<ReturnType<typeof getIssue>>);

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-200' });

    expect(result.ok).toBe(true);
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalled();
  });
});

describe('handleDispatch — failure backoff (A1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
  });

  it('delays dispatch via queue when recent failures suggest backoff', async () => {
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    const { enqueue } = await import('../core/queue.js');
    vi.mocked(checkCircuitBreaker).mockReturnValueOnce({
      allowed: true, consecutiveFailures: 1, backoffMs: 60_000,
    } as any);
    vi.mocked(getIssue).mockResolvedValue({
      id: 'issue-uuid', identifier: 'RYA-300', title: 'Fix the thing', description: '',
      priority: 2, labels: [], state: 'Todo', url: 'https://linear.app/ryanhub/issue/RYA-300',
    } as Awaited<ReturnType<typeof getIssue>>);

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-300' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('queued');
    expect(vi.mocked(enqueue)).toHaveBeenCalledWith(expect.objectContaining({
      issue_key: 'RYA-300',
      delay_until: expect.any(String),
    }));
    expect(vi.mocked(agentStartCommand)).not.toHaveBeenCalled();
  });

  it('half-open probes bypass the backoff delay', async () => {
    const { checkCircuitBreaker } = await import('./circuit-breaker.js');
    vi.mocked(checkCircuitBreaker).mockReturnValueOnce({
      allowed: true, consecutiveFailures: 3, backoffMs: 0, halfOpen: true,
    } as any);
    vi.mocked(getIssue).mockResolvedValue({
      id: 'issue-uuid', identifier: 'RYA-301', title: 'Fix the thing', description: '',
      priority: 2, labels: [], state: 'Todo', url: 'https://linear.app/ryanhub/issue/RYA-301',
    } as Awaited<ReturnType<typeof getIssue>>);

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-301' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalled();
  });
});

describe('handleDispatch — duplicate-of-Done guard (RYA-1071)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
    vi.mocked(isDuplicateOfDone).mockResolvedValue(null);
  });

  const normalIssue = {
    id: 'issue-uuid',
    identifier: 'RYA-1067',
    title: 'Implement thing',
    description: '',
    priority: 2,
    labels: [],
    state: 'Todo',
    url: 'https://linear.app/ryanhub/issue/RYA-1067',
  } as Awaited<ReturnType<typeof getIssue>>;

  it('rejects dispatch when issue is duplicate of a Done issue', async () => {
    vi.mocked(getIssue).mockResolvedValue(normalIssue);
    vi.mocked(isDuplicateOfDone).mockResolvedValueOnce({
      canonicalKey: 'RYA-1065',
      canonicalState: 'Done',
    });

    const result = await handleDispatch({ role: 'coo', issueKey: 'RYA-1067' });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('error');
    expect(result.detail).toContain('duplicate of RYA-1065');
    expect(result.detail).toContain('Done');
    expect(vi.mocked(agentStartCommand)).not.toHaveBeenCalled();
  });

  it('rejects dispatch when canonical is Canceled', async () => {
    vi.mocked(getIssue).mockResolvedValue(normalIssue);
    vi.mocked(isDuplicateOfDone).mockResolvedValueOnce({
      canonicalKey: 'RYA-900',
      canonicalState: 'Canceled',
    });

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-1067' });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Canceled');
    expect(vi.mocked(agentStartCommand)).not.toHaveBeenCalled();
  });

  it('allows dispatch when issue has no duplicate-of relation', async () => {
    vi.mocked(getIssue).mockResolvedValue(normalIssue);
    vi.mocked(isDuplicateOfDone).mockResolvedValueOnce(null);

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-1067' });

    expect(result.ok).toBe(true);
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalled();
  });

  it('skips the check when prefetch failed (fail-open via missing prefetchedIssue)', async () => {
    // First fetch fails — no prefetchedIssue, so we don't run isDuplicateOfDone
    vi.mocked(getIssue).mockRejectedValueOnce(new Error('Network'));
    // Second fetch succeeds for the post-spawn comment path
    vi.mocked(getIssue).mockResolvedValueOnce(normalIssue);

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-1067' });

    expect(result.ok).toBe(true);
    expect(vi.mocked(isDuplicateOfDone)).not.toHaveBeenCalled();
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalled();
  });
});

describe('handleDispatch — delegate assignment (RYA-657)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
    __resetEnsureDelegateCacheForTests();
    mockRoleClientUpdateIssue.mockReset();
    mockRoleClientUpdateIssue.mockResolvedValue(undefined);
    mockAgentClientUpdateIssue.mockReset();
    mockAgentClientUpdateIssue.mockResolvedValue(undefined);
    vi.mocked(canSpawnAgent).mockReturnValue({ allowed: true });
    vi.mocked(getAgentLinearToken).mockReturnValue('mock-token');
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-uuid' } as any);
  });

  const normalIssue = {
    id: 'issue-uuid',
    identifier: 'RYA-500',
    title: 'Implement thing',
    description: '',
    priority: 2,
    labels: [],
    state: 'Todo',
    url: 'https://linear.app/ryanhub/issue/RYA-500',
  } as Awaited<ReturnType<typeof getIssue>>;

  it('sets delegate before enqueue when capacity is exhausted (queued path)', async () => {
    vi.mocked(getIssue).mockResolvedValue(normalIssue);
    vi.mocked(canSpawnAgent).mockReturnValue({ allowed: false, reason: 'at capacity' });

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-500' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('queued');
    // Delegate must be set BEFORE enqueue so the next heartbeat sees the issue as assigned.
    // delegateId-only is the canonical app-user assignment (RYA-1053): Linear rejects
    // calls that pass both delegateId and assigneeId for app users.
    expect(mockRoleClientUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockRoleClientUpdateIssue).toHaveBeenCalledWith('issue-uuid', {
      delegateId: 'user-uuid',
    });
    expect(vi.mocked(enqueue)).toHaveBeenCalled();
    expect(vi.mocked(agentStartCommand)).not.toHaveBeenCalled();
  });

  it('sets delegate exactly once on the started path (not duplicated post-spawn)', async () => {
    vi.mocked(getIssue).mockResolvedValue(normalIssue);

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-500' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
    // Pre-dispatch set should fire; post-spawn block should NOT re-set (prefetchedIssue was not null)
    expect(mockRoleClientUpdateIssue).toHaveBeenCalledTimes(1);
  });

  it('retries delegate assignment post-spawn when the prefetch fetch failed', async () => {
    // First fetch (pre-dispatch): fails
    vi.mocked(getIssue).mockRejectedValueOnce(new Error('Network timeout'));
    // Second fetch (post-spawn comment path): succeeds
    vi.mocked(getIssue).mockResolvedValueOnce(normalIssue);

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-500' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
    // No pre-dispatch delegate call (prefetchedIssue was null), but post-spawn must recover
    expect(mockRoleClientUpdateIssue).toHaveBeenCalledTimes(1);
    expect(mockRoleClientUpdateIssue).toHaveBeenCalledWith('issue-uuid', {
      delegateId: 'user-uuid',
    });
  });

  it('continues dispatch even when delegate-set throws (best-effort)', async () => {
    vi.mocked(getIssue).mockResolvedValue(normalIssue);
    mockRoleClientUpdateIssue.mockRejectedValueOnce(new Error('Linear 500'));

    const result = await handleDispatch({ role: 'cto', issueKey: 'RYA-500' });

    // Must not block the dispatch — the agent can still work the issue
    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalled();
  });

  it('does NOT set delegate when the dispatch is rejected by [to decide] guard', async () => {
    vi.mocked(getIssue).mockResolvedValue({
      ...normalIssue,
      identifier: 'RYA-615',
      title: '[to decide] Pivot to B2B?',
      state: 'Backlog',
    });

    const result = await handleDispatch({ role: 'coo', issueKey: 'RYA-615' });

    expect(result.ok).toBe(false);
    expect(mockRoleClientUpdateIssue).not.toHaveBeenCalled();
    expect(mockAgentClientUpdateIssue).not.toHaveBeenCalled();
  });
});

describe('ensureDelegate — direct helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetEnsureDelegateCacheForTests();
    mockRoleClientUpdateIssue.mockReset();
    mockRoleClientUpdateIssue.mockResolvedValue(undefined);
    mockAgentClientUpdateIssue.mockReset();
    mockAgentClientUpdateIssue.mockResolvedValue(undefined);
  });

  it('uses the role-specific token when available', async () => {
    vi.mocked(getAgentLinearToken).mockReturnValue('role-token');
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-abc' } as any);

    await ensureDelegate('issue-xyz', 'lead-engineer');

    expect(mockRoleClientUpdateIssue).toHaveBeenCalledWith('issue-xyz', {
      delegateId: 'user-abc',
    });
    expect(mockAgentClientUpdateIssue).not.toHaveBeenCalled();
  });

  it('falls back to the shared agent client when the role has no token', async () => {
    vi.mocked(getAgentLinearToken).mockReturnValue(null);
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-abc' } as any);

    await ensureDelegate('issue-xyz', 'lead-engineer');

    expect(mockAgentClientUpdateIssue).toHaveBeenCalledWith('issue-xyz', {
      delegateId: 'user-abc',
    });
    expect(mockRoleClientUpdateIssue).not.toHaveBeenCalled();
  });

  it('is a no-op when the role has no linearUserId', async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc' } as any);

    await ensureDelegate('issue-xyz', 'cpo');

    expect(mockRoleClientUpdateIssue).not.toHaveBeenCalled();
    expect(mockAgentClientUpdateIssue).not.toHaveBeenCalled();
  });

  it('debounces: skips duplicate delegate write for same issue within 30s', async () => {
    vi.mocked(getAgentLinearToken).mockReturnValue(null);
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-abc' } as any);

    await ensureDelegate('issue-debounce', 'lead-engineer');
    await ensureDelegate('issue-debounce', 'lead-engineer'); // same issue, within 30s

    // Only one updateIssue call despite two ensureDelegate calls
    expect(mockAgentClientUpdateIssue).toHaveBeenCalledTimes(1);
  });

  it('debounce does not affect different issues', async () => {
    vi.mocked(getAgentLinearToken).mockReturnValue(null);
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-abc' } as any);

    await ensureDelegate('issue-alpha', 'lead-engineer');
    await ensureDelegate('issue-beta', 'lead-engineer'); // different issue

    expect(mockAgentClientUpdateIssue).toHaveBeenCalledTimes(2);
  });
});

describe('handleDispatch — effort-scaled dispatch (A4.4)', () => {
  const choreIssue = {
    id: 'issue-uuid',
    identifier: 'RYA-700',
    title: 'Chore: tidy docs',
    description: '',
    priority: 4,
    labels: ['chore'],
    state: 'Todo',
    url: 'https://linear.app/ryanhub/issue/RYA-700',
  } as Awaited<ReturnType<typeof getIssue>>;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
    vi.mocked(resolveEffortRule).mockReturnValue({ model: null, reason: 'mock' });
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-uuid' } as never);
    vi.mocked(canSpawnAgent).mockReturnValue({ allowed: true } as never);
    vi.mocked(isDuplicateOfDone).mockResolvedValue(null as never);
  });

  it('passes the matched model to agentStartCommand as claudeModel', async () => {
    vi.mocked(getIssue).mockResolvedValue(choreIssue);
    vi.mocked(resolveEffortRule).mockReturnValue({ model: 'claude-sonnet-4-6', reason: 'explicit-rule:test' });

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-700' });

    expect(result.ok).toBe(true);
    expect(vi.mocked(resolveEffortRule)).toHaveBeenCalledWith({
      labels: ['chore'], priority: 4,
    });
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith(
      'lead-engineer', 'RYA-700', { claudeModel: 'claude-sonnet-4-6' },
    );
  });

  it('passes undefined opts when no rule matches (model inherits default)', async () => {
    vi.mocked(getIssue).mockResolvedValue(choreIssue);
    vi.mocked(resolveEffortRule).mockReturnValue({ model: null, reason: 'mock' });

    await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-700' });

    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith('lead-engineer', 'RYA-700', undefined);
  });

  it('combines claudeModel with skipCompletionCheck', async () => {
    vi.mocked(getIssue).mockResolvedValue(choreIssue);
    vi.mocked(resolveEffortRule).mockReturnValue({ model: 'claude-sonnet-4-6', reason: 'explicit-rule:test' });

    await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-700', skipCompletionCheck: true });

    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith(
      'lead-engineer', 'RYA-700', { skipCompletionCheck: true, claudeModel: 'claude-sonnet-4-6' },
    );
  });

  it('skips effort resolution when the issue prefetch failed (no labels/priority)', async () => {
    vi.mocked(getIssue).mockRejectedValueOnce(new Error('Network timeout'));
    vi.mocked(getIssue).mockResolvedValueOnce(choreIssue);

    await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-700' });

    expect(vi.mocked(resolveEffortRule)).not.toHaveBeenCalled();
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith('lead-engineer', 'RYA-700', undefined);
  });

  it('dispatches with default model when resolveEffortRule throws (best-effort)', async () => {
    vi.mocked(getIssue).mockResolvedValue(choreIssue);
    vi.mocked(resolveEffortRule).mockImplementation(() => { throw new Error('bad config'); });

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-700' });

    expect(result.ok).toBe(true);
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith('lead-engineer', 'RYA-700', undefined);
  });
});

describe('handleDispatch — explicit dispatch supersedes auto-route (RYA-1139)', () => {
  const issue1138 = {
    id: 'issue-1138-uuid',
    identifier: 'RYA-1138',
    title: 'Follow-up work item',
    description: '',
    priority: 2,
    labels: [],
    state: 'Todo',
    url: 'https://linear.app/ryanhub/issue/RYA-1138',
  } as Awaited<ReturnType<typeof getIssue>>;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchDedup.clear();
    autoRoutedSpawns.clear();
    spawnClaims.clear();
    vi.mocked(agentStartCommand).mockResolvedValue('started');
    vi.mocked(getActiveAttempt).mockReturnValue(null as never);
    vi.mocked(sessionExists).mockReturnValue(false);
    vi.mocked(canSpawnAgent).mockReturnValue({ allowed: true });
    vi.mocked(loadAgentConfig).mockReturnValue({ baseModel: 'cc', linearUserId: 'user-uuid' } as never);
    vi.mocked(isDuplicateOfDone).mockResolvedValue(null as never);
    vi.mocked(getIssue).mockResolvedValue(issue1138);
  });

  it('regression: create-issue auto-route → dispatch other role within dedup window starts the other role', async () => {
    // Simulate the auto-route path (issues.ts): creator-default spawn for coo
    // claimed the per-issue spawn slot and recorded the auto-route marker.
    expect(claimSpawnSlot('RYA-1138')).toBe(true);
    autoRoutedSpawns.set('RYA-1138', { role: 'coo', at: Date.now() });
    vi.mocked(sessionExists).mockReturnValue(true);
    vi.mocked(getActiveAttempt).mockReturnValue({
      id: 'attempt-coo', issue_key: 'RYA-1138', agent_type: 'coo', status: 'running',
    } as never);

    // 5s later: coo explicitly dispatches lead-engineer (linear-tool → HTTP /dispatch)
    const result = await handleDispatch({
      role: 'lead-engineer', issueKey: 'RYA-1138', from: 'coo', skipCompletionCheck: true,
    });

    // Auto-routed coo session is killed and its attempt closed as superseded
    expect(vi.mocked(killSession)).toHaveBeenCalledWith('aos-coo-RYA-1138');
    expect(vi.mocked(updateAttemptStatus)).toHaveBeenCalledWith(
      'attempt-coo', 'completed', 'Superseded by explicit dispatch to lead-engineer',
    );
    // Spawn claim released so the explicit spawn can claim it, marker consumed
    expect(spawnClaims.has('RYA-1138')).toBe(false);
    expect(autoRoutedSpawns.has('RYA-1138')).toBe(false);
    // The dispatched role actually starts
    expect(vi.mocked(agentStartCommand)).toHaveBeenCalledWith(
      'lead-engineer', 'RYA-1138', { skipCompletionCheck: true },
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe('started');
  });

  it('does NOT supersede when the dispatched role matches the auto-routed role', async () => {
    claimSpawnSlot('RYA-1138');
    autoRoutedSpawns.set('RYA-1138', { role: 'coo', at: Date.now() });

    await handleDispatch({ role: 'coo', issueKey: 'RYA-1138', skipCompletionCheck: true });

    expect(vi.mocked(killSession)).not.toHaveBeenCalled();
    expect(spawnClaims.has('RYA-1138')).toBe(true);
    expect(autoRoutedSpawns.has('RYA-1138')).toBe(true);
  });

  it('does NOT supersede when the auto-route marker is older than the override window', async () => {
    autoRoutedSpawns.set('RYA-1138', { role: 'coo', at: Date.now() - 6 * 60_000 });
    vi.mocked(sessionExists).mockReturnValue(true);

    await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-1138', skipCompletionCheck: true });

    expect(vi.mocked(killSession)).not.toHaveBeenCalled();
  });

  it('reports an accurate skipped outcome when the spawn is deduped (not "started")', async () => {
    vi.mocked(agentStartCommand).mockResolvedValue('deduped');
    vi.mocked(getActiveAttempt).mockReturnValue({
      id: 'attempt-coo', issue_key: 'RYA-1138', agent_type: 'coo', status: 'running',
    } as never);

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-1138' });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('skipped');
    expect(result.detail).toContain('coo already on RYA-1138');
    expect(result.detail).toContain('lead-engineer was NOT started');
  });

  it('reports queued when agentStartCommand queues for capacity', async () => {
    vi.mocked(agentStartCommand).mockResolvedValue('queued');

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-1138' });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('queued');
    expect(result.detail).toContain('queued');
  });

  it('reports error when agentStartCommand fails', async () => {
    vi.mocked(agentStartCommand).mockResolvedValue('error');

    const result = await handleDispatch({ role: 'lead-engineer', issueKey: 'RYA-1138' });

    expect(result.ok).toBe(false);
    expect(result.action).toBe('error');
  });
});
