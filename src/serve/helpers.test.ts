import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies BEFORE importing helpers (vi.mock is hoisted).
vi.mock('../core/linear.js', () => ({
  getRecentCommentBodies: vi.fn(),
}));
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
}));
vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  loadAgentConfig: vi.fn(() => ({})),
  listAgents: vi.fn(() => []),
}));
vi.mock('../core/queue.js', () => ({
  getQueueItems: vi.fn(() => []),
}));

import { wrapFollowUpMessage, isHandoffAlreadyPosted } from './helpers.js';
import { getRecentCommentBodies } from '../core/linear.js';

describe('wrapFollowUpMessage', () => {
  it('wraps message with linear-tool comment when no commentId', () => {
    const result = wrapFollowUpMessage('RYA-42', 'What is the status?');
    expect(result).toContain('[FOLLOW-UP]');
    expect(result).toContain('> What is the status?');
    expect(result).toContain('linear-tool comment RYA-42');
    expect(result).not.toContain('linear-tool reply');
    expect(result).toContain('Do NOT write HANDOFF.md');
  });

  it('wraps message with linear-tool reply when commentId present', () => {
    const result = wrapFollowUpMessage('RYA-42', 'Can you explain?', 'comment-123');
    expect(result).toContain('[FOLLOW-UP]');
    expect(result).toContain('> Can you explain?');
    expect(result).toContain('linear-tool reply RYA-42 comment-123');
    expect(result).not.toContain('linear-tool comment RYA-42');
    expect(result).toContain('Do NOT write HANDOFF.md');
  });

  it('preserves multiline messages', () => {
    const msg = 'Line 1\nLine 2\nLine 3';
    const result = wrapFollowUpMessage('RYA-99', msg);
    expect(result).toContain('> Line 1\nLine 2\nLine 3');
  });
});

// ─── isHandoffAlreadyPosted (RYA-1034) ──────────────────────────────────
//
// Contract: under transient Linear errors (rate-limit, network), the guard
// must fail-CLOSED and return true so the monitor SKIPS re-posting the
// HANDOFF comment. Non-transient errors (permission/schema) keep the
// historical fail-open behavior so a permanent bug doesn't wedge completions.

describe('isHandoffAlreadyPosted (RYA-1034 fail-CLOSED)', () => {
  beforeEach(() => {
    vi.mocked(getRecentCommentBodies).mockReset();
  });

  it('returns true when fingerprint already in recent comments', async () => {
    vi.mocked(getRecentCommentBodies).mockResolvedValue([
      'some other comment',
      'HANDOFF — RYA-42\nstuff matching the fingerprint here',
    ]);
    const handoff = 'HANDOFF — RYA-42\nstuff matching the fingerprint here';
    expect(await isHandoffAlreadyPosted('issue-uuid', handoff)).toBe(true);
  });

  it('returns false when fingerprint not in recent comments', async () => {
    vi.mocked(getRecentCommentBodies).mockResolvedValue([
      'unrelated comment',
      'another unrelated comment',
    ]);
    const handoff = 'HANDOFF — RYA-99\nbrand new content';
    expect(await isHandoffAlreadyPosted('issue-uuid', handoff)).toBe(false);
  });

  it('fails CLOSED (returns true) on Linear rate-limit error', async () => {
    vi.mocked(getRecentCommentBodies).mockRejectedValue(
      new Error('Rate limit exceeded — please retry'),
    );
    expect(await isHandoffAlreadyPosted('issue-uuid', 'any handoff')).toBe(true);
  });

  it('fails CLOSED on HTTP 429', async () => {
    vi.mocked(getRecentCommentBodies).mockRejectedValue(
      new Error('GraphQL request failed: 429 Too Many Requests'),
    );
    expect(await isHandoffAlreadyPosted('issue-uuid', 'any handoff')).toBe(true);
  });

  it('fails CLOSED on network error (ECONNRESET)', async () => {
    vi.mocked(getRecentCommentBodies).mockRejectedValue(
      new Error('fetch failed: ECONNRESET'),
    );
    expect(await isHandoffAlreadyPosted('issue-uuid', 'any handoff')).toBe(true);
  });

  it('fails CLOSED on ETIMEDOUT', async () => {
    vi.mocked(getRecentCommentBodies).mockRejectedValue(
      new Error('ETIMEDOUT connecting to api.linear.app'),
    );
    expect(await isHandoffAlreadyPosted('issue-uuid', 'any handoff')).toBe(true);
  });

  it('fails OPEN (returns false) on non-transient errors so completions are not wedged', async () => {
    vi.mocked(getRecentCommentBodies).mockRejectedValue(
      new Error('GraphQL syntax error: unknown field "foo"'),
    );
    expect(await isHandoffAlreadyPosted('issue-uuid', 'any handoff')).toBe(false);
  });

  it('fails OPEN on permission errors so completions are not wedged', async () => {
    vi.mocked(getRecentCommentBodies).mockRejectedValue(
      new Error('AuthenticationFailed: invalid token'),
    );
    expect(await isHandoffAlreadyPosted('issue-uuid', 'any handoff')).toBe(false);
  });
});
