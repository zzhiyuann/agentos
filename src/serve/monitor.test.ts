import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock external dependencies before importing monitor
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
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
  agentExists: vi.fn(() => true),
  getAgentLinearToken: vi.fn(() => 'test-token'),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc' })),
}));

vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
  setCooldown: vi.fn(),
  cancelQueuedByRole: vi.fn(),
}));

vi.mock('./state.js', () => ({
  reportedHandoffs: new Set(),
  trustPromptHandled: new Map(),
  followUpMeta: new Map(),
  FOLLOW_UP_TTL_MS: 600_000,
  progressNudgedAttempts: new Map(),
}));

vi.mock('./helpers.js', () => ({
  postToGroupChat: vi.fn(),
  handoffContentHash: vi.fn(() => 'hash'),
  isHandoffAlreadyPosted: vi.fn(async () => false),
  countConsecutiveRateLimitFailures: vi.fn(() => 0),
  getRateLimitBackoffMs: vi.fn(() => 0),
  RATE_LIMIT_ESCALATION_MARKER: '🚨 RATE LIMIT',
}));

import { isNonCodeDeliverable, shouldSkipReview, hasActiveHandoff, validateHandoff } from './monitor.js';
import { getIssue } from '../core/linear.js';
import { getRecentAttemptsByAgent } from '../core/db.js';
import { execSync } from 'child_process';
import type { Attempt } from '../core/db.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'some-file.md'),
}));

// ─── isNonCodeDeliverable ────────────────────────────────────────────

describe('isNonCodeDeliverable', () => {
  it('detects bracket tags in title', () => {
    expect(isNonCodeDeliverable('[Strategy] One-Person Company Ideas', [])).toBe(true);
    expect(isNonCodeDeliverable('[Research] LLM Cost Analysis', [])).toBe(true);
    expect(isNonCodeDeliverable('[Analysis] Q1 Revenue Breakdown', [])).toBe(true);
    expect(isNonCodeDeliverable('[Report] Security Scan Results', [])).toBe(true);
    expect(isNonCodeDeliverable('[Exploration] New Markets', [])).toBe(true);
    expect(isNonCodeDeliverable('[Investigation] User Churn', [])).toBe(true);
  });

  it('is case-insensitive for bracket tags', () => {
    expect(isNonCodeDeliverable('[STRATEGY] Plan', [])).toBe(true);
    expect(isNonCodeDeliverable('[strategy] plan', [])).toBe(true);
  });

  it('detects non-code labels', () => {
    expect(isNonCodeDeliverable('Some title', ['strategy'])).toBe(true);
    expect(isNonCodeDeliverable('Some title', ['Research'])).toBe(true);
    expect(isNonCodeDeliverable('Some title', ['bug', 'analysis'])).toBe(true);
  });

  it('detects compound title keywords', () => {
    expect(isNonCodeDeliverable('Create strategic plan for Q2', [])).toBe(true);
    expect(isNonCodeDeliverable('Market analysis of competitors', [])).toBe(true);
    expect(isNonCodeDeliverable('Business plan for new product line', [])).toBe(true);
    expect(isNonCodeDeliverable('Landscape scan of AI tools', [])).toBe(true);
    expect(isNonCodeDeliverable('Competitive analysis report', [])).toBe(true);
  });

  it('does not false-positive on code tasks', () => {
    expect(isNonCodeDeliverable('Fix authentication bug in login flow', [])).toBe(false);
    expect(isNonCodeDeliverable('Refactor database connection pooling', [])).toBe(false);
    expect(isNonCodeDeliverable('Add unit tests for queue module', [])).toBe(false);
    expect(isNonCodeDeliverable('Implement webhook handler', [])).toBe(false);
  });

  it('does not false-positive on code tasks with similar words', () => {
    // "review" as a code review, not a research review
    expect(isNonCodeDeliverable('Code review: PR #42', ['bug'])).toBe(false);
    // "test" is not a non-code deliverable
    expect(isNonCodeDeliverable('Test the deploy pipeline', ['test'])).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(isNonCodeDeliverable('', [])).toBe(false);
  });

  it('detects strategy keyword without brackets', () => {
    expect(isNonCodeDeliverable('Define product strategy for 2026', [])).toBe(true);
  });
});

// ─── shouldSkipReview ────────────────────────────────────────────────

describe('shouldSkipReview', () => {
  it('auto-closes trivial issues with success signals', () => {
    expect(shouldSkipReview('Fix typo in README', 'Fixed and verified.')).toBe(true);
    expect(shouldSkipReview('Hotfix: broken deploy', 'All tests pass now.')).toBe(true);
    expect(shouldSkipReview('Bump version to 1.2.3', 'Done, version bumped.')).toBe(true);
  });

  it('does not auto-close non-trivial issues', () => {
    expect(shouldSkipReview('Implement new auth system', 'All tests pass.')).toBe(false);
    expect(shouldSkipReview('[Strategy] Market Analysis', 'Complete.')).toBe(false);
  });

  it('does not auto-close trivial issues without success signals', () => {
    expect(shouldSkipReview('Fix login bug', 'Still investigating root cause.')).toBe(false);
  });
});

// ─── hasActiveHandoff ────────────────────────────────────────────────

describe('hasActiveHandoff', () => {
  it('returns false when no other attempts exist', () => {
    expect(hasActiveHandoff('RYA-42', 'attempt-1')).toBe(false);
  });
});

// ─── validateHandoff ────────────────────────────────────────────────

describe('validateHandoff', () => {
  const baseAttempt: Attempt = {
    id: 'attempt-1',
    issue_id: 'issue-id-1',
    issue_key: 'RYA-42',
    agent_session_id: null,
    agent_type: 'cpo',
    runner_session_id: null,
    attempt_number: 1,
    status: 'running',
    host: 'localhost',
    tmux_session: 'aos-cpo',
    workspace_path: '/tmp/workspace',
    budget_usd: null,
    cost_usd: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    error_log: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: memory files exist
    vi.mocked(execSync).mockReturnValue('some-file.md');
  });

  describe('code tasks (default)', () => {
    beforeEach(() => {
      vi.mocked(getIssue).mockResolvedValue({
        id: 'issue-id-1',
        identifier: 'RYA-42',
        title: 'Fix authentication bug',
        description: undefined,
        priority: 2,
        labels: ['bug'],
        state: 'In Progress',
        url: 'https://linear.app/test/RYA-42',
      });
    });

    it('passes when handoff has verification evidence', async () => {
      const result = await validateHandoff(baseAttempt, 'All tests pass. Verified end-to-end.');
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes when handoff has file change evidence', async () => {
      const result = await validateHandoff(baseAttempt, '3 files changed. Committed to main.');
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('warns when handoff lacks verification AND file changes', async () => {
      const result = await validateHandoff(baseAttempt, 'Did some work on the issue.');
      expect(result.passed).toBe(false);
      expect(result.warnings).toContain('HANDOFF.md has no evidence of verification or file changes');
    });

    it('warns when no memory files written', async () => {
      vi.mocked(execSync).mockReturnValue('');
      const result = await validateHandoff(baseAttempt, 'All tests pass.');
      expect(result.warnings).toContain('No memory files written this session');
    });
  });

  describe('non-code deliverables (strategy/research)', () => {
    beforeEach(() => {
      vi.mocked(getIssue).mockResolvedValue({
        id: 'issue-id-1',
        identifier: 'RYA-60',
        title: '[Strategy] One-Person Company Ideas for Zhiyuan',
        description: undefined,
        priority: 2,
        labels: ['strategy'],
        state: 'In Progress',
        url: 'https://linear.app/test/RYA-60',
      });
    });

    it('passes when handoff mentions deliverable document', async () => {
      const result = await validateHandoff(baseAttempt,
        'Produced 556-line strategy document with recommendations and analysis.');
      expect(result.passed).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes with workspace reference', async () => {
      const result = await validateHandoff(baseAttempt,
        'Output written to workspace at /tmp/agent-workspaces/cpo/RYA-60-strategy.md');
      expect(result.passed).toBe(true);
    });

    it('passes with research/findings keywords', async () => {
      const result = await validateHandoff(baseAttempt,
        'Research complete. Key findings documented with sourced data.');
      expect(result.passed).toBe(true);
    });

    it('does NOT warn about missing file changes (non-code tasks dont modify source)', async () => {
      const result = await validateHandoff(baseAttempt,
        'Strategy document drafted with 10 scored business ideas.');
      expect(result.passed).toBe(true);
      // Should NOT contain the code-task verification warning
      expect(result.warnings).not.toContain('HANDOFF.md has no evidence of verification or file changes');
    });

    it('warns if handoff has no deliverable evidence at all', async () => {
      const result = await validateHandoff(baseAttempt, 'Did some thinking about the topic.');
      expect(result.passed).toBe(false);
      expect(result.warnings).toContain('HANDOFF.md has no evidence of a deliverable document or analysis');
    });

    it('skips audit follow-up check for strategy deliverables', async () => {
      vi.mocked(getRecentAttemptsByAgent).mockReturnValue([]);
      const result = await validateHandoff(baseAttempt,
        'Strategy document complete with recommendations.');
      // Should NOT warn about missing follow-up issues
      expect(result.warnings).not.toContain('Audit/research task completed without creating any follow-up issues');
    });
  });

  describe('audit/research tasks (code-adjacent, not non-code deliverables)', () => {
    beforeEach(() => {
      vi.mocked(getIssue).mockResolvedValue({
        id: 'issue-id-1',
        identifier: 'RYA-50',
        title: 'Collaboration quality audit v2',
        description: undefined,
        priority: 1,
        labels: ['audit'],
        state: 'In Progress',
        url: 'https://linear.app/test/RYA-50',
      });
    });

    it('warns when audit task creates no follow-up issues', async () => {
      vi.mocked(getRecentAttemptsByAgent).mockReturnValue([]);
      const result = await validateHandoff(baseAttempt,
        'Audit verified all modules. Tests pass.');
      expect(result.warnings).toContain('Audit/research task completed without creating any follow-up issues');
    });

    it('does not warn when audit task created follow-up issues', async () => {
      vi.mocked(getRecentAttemptsByAgent).mockReturnValue([
        { id: 'attempt-2', issue_key: 'RYA-51' } as Attempt,
      ]);
      const result = await validateHandoff(baseAttempt,
        'Audit verified all modules. Tests pass. Created RYA-51 for the one issue found.');
      expect(result.warnings).not.toContain('Audit/research task completed without creating any follow-up issues');
    });
  });

  describe('edge cases', () => {
    it('falls back to code-task checks when getIssue fails', async () => {
      vi.mocked(getIssue).mockRejectedValue(new Error('API error'));
      const result = await validateHandoff(baseAttempt, 'Did some work.');
      // Should use code-task checks (empty title/labels = not non-code)
      expect(result.warnings).toContain('HANDOFF.md has no evidence of verification or file changes');
    });

    it('handles memory check failure gracefully', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('dir not found'); });
      vi.mocked(getIssue).mockResolvedValue({
        id: 'issue-id-1',
        identifier: 'RYA-42',
        title: 'Fix bug',
        description: undefined,
        priority: 2,
        labels: [],
        state: 'In Progress',
        url: 'https://linear.app/test/RYA-42',
      });
      const result = await validateHandoff(baseAttempt, 'All tests pass.');
      // Memory check should not crash, and verification check should still pass
      expect(result.warnings).not.toContain('HANDOFF.md has no evidence of verification or file changes');
    });

    it('detects non-code task by label even without title pattern', async () => {
      vi.mocked(getIssue).mockResolvedValue({
        id: 'issue-id-1',
        identifier: 'RYA-70',
        title: 'Evaluate new markets in Southeast Asia',
        description: undefined,
        priority: 3,
        labels: ['research'],
        state: 'In Progress',
        url: 'https://linear.app/test/RYA-70',
      });
      const result = await validateHandoff(baseAttempt,
        'Research report produced with market analysis and recommendations.');
      expect(result.passed).toBe(true);
    });
  });
});
