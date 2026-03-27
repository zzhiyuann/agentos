import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../core/db.js', () => ({
  getAttemptsByIssue: vi.fn(() => []),
}));

vi.mock('../core/linear.js', () => ({
  addComment: vi.fn(),
  updateIssueState: vi.fn(),
  getRecentCommentBodies: vi.fn(async () => []),
}));

vi.mock('../core/queue.js', () => ({
  cancelQueued: vi.fn(),
}));

import {
  checkCircuitBreaker,
  tripCircuitBreaker,
  DEFAULT_MAX_RETRIES,
  CIRCUIT_BREAKER_MARKER,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from './circuit-breaker.js';
import { getAttemptsByIssue } from '../core/db.js';
import { addComment, updateIssueState, getRecentCommentBodies } from '../core/linear.js';
import { cancelQueued } from '../core/queue.js';

const mockGetAttempts = vi.mocked(getAttemptsByIssue);
const mockAddComment = vi.mocked(addComment);
const mockUpdateState = vi.mocked(updateIssueState);
const mockGetComments = vi.mocked(getRecentCommentBodies);
const mockCancelQueued = vi.mocked(cancelQueued);

function makeAttempt(status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked', agentType = 'cto', minutesAgo = 0) {
  return {
    id: `attempt-${Math.random().toString(36).slice(2)}`,
    issue_id: 'issue-uuid',
    issue_key: 'RYA-99',
    agent_session_id: null,
    agent_type: agentType,
    runner_session_id: null,
    tmux_session: null,
    attempt_number: 1,
    status,
    host: 'test',
    workspace_path: null,
    budget_usd: null,
    cost_usd: 0,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: status === 'completed' || status === 'failed' ? new Date().toISOString() : null,
    error_log: null,
  };
}

describe('checkCircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows retry when no previous attempts exist', () => {
    mockGetAttempts.mockReturnValue([]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.backoffMs).toBe(0);
  });

  it('allows retry when previous attempts all succeeded', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('completed'),
      makeAttempt('completed'),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(0);
  });

  it('allows retry with backoff after 1 failure', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed'),
      makeAttempt('completed'),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(1);
    expect(result.backoffMs).toBe(BASE_BACKOFF_MS); // 60s
  });

  it('allows retry with doubled backoff after 2 failures', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed'),
      makeAttempt('failed'),
      makeAttempt('completed'),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(2);
    expect(result.backoffMs).toBe(BASE_BACKOFF_MS * 2); // 120s
  });

  it('blocks retry after 3 consecutive failures (default limit)', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed'),
      makeAttempt('failed'),
      makeAttempt('failed'),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(false);
    expect(result.consecutiveFailures).toBe(3);
    expect(result.reason).toContain('3 consecutive');
  });

  it('resets failure count after a success', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed'),           // most recent
      makeAttempt('completed'),        // success resets chain
      makeAttempt('failed'),           // old failure (before success)
      makeAttempt('failed'),
      makeAttempt('failed'),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(1); // only the one after success
  });

  it('filters by agent role when specified', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed', 'cto'),
      makeAttempt('failed', 'cto'),
      makeAttempt('failed', 'cto'),
      makeAttempt('failed', 'lead-engineer'), // different role
    ]);
    // Check for lead-engineer: only 1 failure
    const result = checkCircuitBreaker('RYA-99', 'lead-engineer');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(1);

    // Check for cto: 3 failures — blocked
    const resultCto = checkCircuitBreaker('RYA-99', 'cto');
    expect(resultCto.allowed).toBe(false);
    expect(resultCto.consecutiveFailures).toBe(3);
  });

  it('respects custom maxRetries parameter', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed'),
      makeAttempt('failed'),
    ]);
    // Default (3): should allow
    expect(checkCircuitBreaker('RYA-99').allowed).toBe(true);
    // Custom max=2: should block
    expect(checkCircuitBreaker('RYA-99', undefined, 2).allowed).toBe(false);
    // Custom max=5: should allow
    expect(checkCircuitBreaker('RYA-99', undefined, 5).allowed).toBe(true);
  });

  it('ignores old failures outside the time window', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('failed', 'cto', 150), // 150 min ago — outside 2hr window
      makeAttempt('failed', 'cto', 130),
      makeAttempt('failed', 'cto', 125),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(true);
    expect(result.consecutiveFailures).toBe(0);
  });

  it('skips running/pending attempts without breaking the chain', () => {
    mockGetAttempts.mockReturnValue([
      makeAttempt('running'),  // skip — doesn't break chain
      makeAttempt('failed'),
      makeAttempt('failed'),
      makeAttempt('failed'),
    ]);
    const result = checkCircuitBreaker('RYA-99');
    expect(result.allowed).toBe(false);
    expect(result.consecutiveFailures).toBe(3);
  });

  it('caps backoff at MAX_BACKOFF_MS', () => {
    // With many failures but custom high limit, backoff should still be capped
    const attempts = [];
    for (let i = 0; i < 20; i++) {
      attempts.push(makeAttempt('failed'));
    }
    mockGetAttempts.mockReturnValue(attempts);
    const result = checkCircuitBreaker('RYA-99', undefined, 25); // allow up to 25
    expect(result.allowed).toBe(true);
    expect(result.backoffMs).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

describe('tripCircuitBreaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetComments.mockResolvedValue([]);
  });

  it('cancels queued items', async () => {
    await tripCircuitBreaker('RYA-99', 'issue-uuid', 'cto', 3);
    expect(mockCancelQueued).toHaveBeenCalledWith('RYA-99');
  });

  it('moves issue to Todo', async () => {
    await tripCircuitBreaker('RYA-99', 'issue-uuid', 'cto', 3);
    expect(mockUpdateState).toHaveBeenCalledWith('issue-uuid', 'Todo');
  });

  it('posts a circuit breaker comment', async () => {
    await tripCircuitBreaker('RYA-99', 'issue-uuid', 'cto', 3);
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const commentBody = mockAddComment.mock.calls[0][1];
    expect(commentBody).toContain(CIRCUIT_BREAKER_MARKER);
    expect(commentBody).toContain('3 consecutive');
    expect(commentBody).toContain('cto');
  });

  it('does not duplicate the comment if already posted', async () => {
    mockGetComments.mockResolvedValue([`Some text... ${CIRCUIT_BREAKER_MARKER} ...more`]);
    await tripCircuitBreaker('RYA-99', 'issue-uuid', 'cto', 3);
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});
