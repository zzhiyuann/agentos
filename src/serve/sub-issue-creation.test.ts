import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (vi.mock is hoisted) ──────────────────────────────────────────

vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'team-uuid', linearTeamKey: 'RYA' }),
}));

vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(),
  hasAgentAccess: vi.fn(() => true),
  emitActivity: vi.fn(),
  addComment: vi.fn(),
  updateIssueState: vi.fn(),
  createIssueDocument: vi.fn(),
  dismissAgentSession: vi.fn(),
  generateHandoffSummary: vi.fn(() => 'summary'),
  getRecentCommentBodies: vi.fn(async () => []),
}));

const mockClient = {
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
};

vi.mock('../core/linear-client.js', () => ({
  getAgentClient: () => mockClient,
  getWorkflowStateId: vi.fn(async () => 'state-todo-uuid'),
}));

vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
  getActiveAttempt: vi.fn(),
  getAttemptsByIssue: vi.fn(() => []),
  getRecentAttemptsByAgent: vi.fn(() => []),
  updateAttemptStatus: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  readFileOnRemote: vi.fn(() => null),
  capturePane: vi.fn(() => ''),
  killSession: vi.fn(),
  sendKeys: vi.fn(),
}));

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => false),
  getAgentLinearToken: vi.fn(() => 'test-token'),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc' })),
}));

vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
  setCooldown: vi.fn(),
  cancelQueuedByRole: vi.fn(),
  getQueueItems: vi.fn(() => []),
}));

vi.mock('./state.js', () => ({
  reportedHandoffs: new Set(),
  trustPromptHandled: new Map(),
  followUpMeta: new Map(),
  FOLLOW_UP_TTL_MS: 600_000,
  gcStateMaps: vi.fn(),
}));

vi.mock('./discord-bot.js', () => ({
  sendDiscordReply: vi.fn(async () => true),
}));

vi.mock('./helpers.js', () => ({
  postToGroupChat: vi.fn(),
  handoffContentHash: vi.fn(() => 'hash'),
  isHandoffAlreadyPosted: vi.fn(async () => false),
  countConsecutiveRateLimitFailures: vi.fn(() => 0),
  getRateLimitBackoffMs: vi.fn(() => 0),
  RATE_LIMIT_ESCALATION_MARKER: '🚨 RATE LIMIT',
  isPermanentIssueError: vi.fn(() => false),
}));

import { createSubIssueFromAction } from './monitor.js';
import { getIssue } from '../core/linear.js';
import type { Attempt } from '../core/db.js';
import type { DispatchAction } from './monitor.js';

const baseAttempt: Attempt = {
  id: 'attempt-1',
  issue_id: 'current-issue-uuid',
  issue_key: 'RYA-50',
  agent_type: 'cto',
  attempt_number: 1,
  status: 'running',
  created_at: Date.now(),
  updated_at: Date.now(),
} as unknown as Attempt;

const baseAction: DispatchAction = {
  role: 'lead-engineer',
  context: 'context here',
  new_issue: {
    title: 'Sub-issue title',
    description: 'desc',
    priority: 2,
    parent: 'RYA-42',
  },
};

// ─── createSubIssueFromAction parent-resolution fail-CLOSED (RYA-1034) ─────
//
// Contract: when getIssue() throws a transient Linear error (rate-limit,
// network), parent resolution must return null so the dispatcher SKIPS
// creation this cycle and retries next tick. Without this guard, the
// function falls through with parentId=undefined, producing an orphaned
// top-level sub-issue that the system can pick up as fresh work — duplicate
// dispatches downstream. Non-transient errors still fall through to the
// orphan path because the orphan is recoverable manually.

describe('createSubIssueFromAction parent resolution (RYA-1034 fail-CLOSED)', () => {
  beforeEach(() => {
    vi.mocked(getIssue).mockReset();
    mockClient.createIssue.mockReset();
    mockClient.updateIssue.mockReset();
  });

  it('returns null without calling createIssue on rate-limit error', async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await createSubIssueFromAction(baseAction, baseAttempt);

    expect(result).toBeNull();
    expect(mockClient.createIssue).not.toHaveBeenCalled();
  });

  it('returns null on HTTP 429', async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error('GraphQL request failed: 429'));

    const result = await createSubIssueFromAction(baseAction, baseAttempt);

    expect(result).toBeNull();
    expect(mockClient.createIssue).not.toHaveBeenCalled();
  });

  it('returns null on network error (ECONNRESET)', async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error('fetch failed: ECONNRESET'));

    const result = await createSubIssueFromAction(baseAction, baseAttempt);

    expect(result).toBeNull();
    expect(mockClient.createIssue).not.toHaveBeenCalled();
  });

  it('returns null on ETIMEDOUT', async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error('ETIMEDOUT connecting to api.linear.app'));

    const result = await createSubIssueFromAction(baseAction, baseAttempt);

    expect(result).toBeNull();
    expect(mockClient.createIssue).not.toHaveBeenCalled();
  });

  it('falls through and creates an orphan on non-transient errors (permission/schema)', async () => {
    vi.mocked(getIssue).mockRejectedValue(new Error('AuthenticationFailed: bad token'));
    mockClient.createIssue.mockResolvedValue({
      success: true,
      issue: Promise.resolve({ id: 'orphan-uuid', identifier: 'RYA-999' }),
    });

    const result = await createSubIssueFromAction(baseAction, baseAttempt);

    expect(result).toEqual({ key: 'RYA-999', id: 'orphan-uuid' });
    expect(mockClient.createIssue).toHaveBeenCalledTimes(1);
    expect(mockClient.createIssue.mock.calls[0][0].parentId).toBeUndefined();
  });

  it('uses resolved parent when getIssue succeeds', async () => {
    vi.mocked(getIssue).mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-42',
      title: 'parent',
      description: undefined,
      priority: 2,
      labels: [],
      state: 'In Progress',
      url: 'https://linear.app/x',
    });
    mockClient.createIssue.mockResolvedValue({
      success: true,
      issue: Promise.resolve({ id: 'child-uuid', identifier: 'RYA-1000' }),
    });

    const result = await createSubIssueFromAction(baseAction, baseAttempt);

    expect(result).toEqual({ key: 'RYA-1000', id: 'child-uuid' });
    expect(mockClient.createIssue).toHaveBeenCalledTimes(1);
    expect(mockClient.createIssue.mock.calls[0][0].parentId).toBe('parent-uuid');
  });

  it('uses current attempt issue as parent when no parent specified', async () => {
    const action: DispatchAction = {
      ...baseAction,
      new_issue: { ...baseAction.new_issue!, parent: undefined },
    };
    mockClient.createIssue.mockResolvedValue({
      success: true,
      issue: Promise.resolve({ id: 'child-uuid', identifier: 'RYA-1001' }),
    });

    const result = await createSubIssueFromAction(action, baseAttempt);

    expect(result).toEqual({ key: 'RYA-1001', id: 'child-uuid' });
    expect(vi.mocked(getIssue)).not.toHaveBeenCalled();
    expect(mockClient.createIssue.mock.calls[0][0].parentId).toBe('current-issue-uuid');
  });
});
