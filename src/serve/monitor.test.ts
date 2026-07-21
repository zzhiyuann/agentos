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
  listAgentSessions: vi.fn(() => []),
  recoverPhantomInput: vi.fn(() => true),
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
}));

import { isNonCodeDeliverable, shouldSkipReview, hasActiveHandoff, parseStatusIntent, hasStickyInProgressIntent, parseHandoffActions, parseDispatchesFromFrontMatter, isTransientApiErrorOutput, isBadModelOutput, TRANSIENT_RETRY_DELAY_MS, TRANSIENT_RETRY_MAX_DURATION_MS, RATE_LIMIT_RETRY_DELAY_MS, RATE_LIMIT_RETRY_MAX_DURATION_MS, detectReviewerFromDescription, classifyReviewLevel, sweepPhantomInput } from './monitor.js';
import * as tmux from '../core/tmux.js';
import { PHANTOM_INPUT_IDLE_MS } from './phantom-input.js';
import type { Attempt } from '../core/db.js';

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


// ─── parseStatusIntent ────────────────────────────────────────────────

describe('parseStatusIntent', () => {
  it('parses valid YAML front matter with status and reason', () => {
    const handoff = `---\nstatus_intent: done\nreason: "Tests pass"\n---\n# HANDOFF\n## Summary\nFixed the bug.`;
    const result = parseStatusIntent(handoff);
    expect(result).toEqual({ status: 'done', reason: 'Tests pass' });
  });

  it('returns null when no front matter present', () => {
    const handoff = `# HANDOFF\n## Summary\nDid stuff.`;
    expect(parseStatusIntent(handoff)).toBeNull();
  });

  it('returns null for invalid status value', () => {
    const handoff = `---\nstatus_intent: yolo\n---\n# HANDOFF`;
    expect(parseStatusIntent(handoff)).toBeNull();
  });

  it('returns undefined reason when not provided', () => {
    const handoff = `---\nstatus_intent: in-review\n---\n# HANDOFF`;
    const result = parseStatusIntent(handoff);
    expect(result).toEqual({ status: 'in-review', reason: undefined });
  });

  it('handles no-change intent', () => {
    const handoff = `---\nstatus_intent: no-change\nreason: "Just answered a question"\n---\n# HANDOFF`;
    const result = parseStatusIntent(handoff);
    expect(result).toEqual({ status: 'no-change', reason: 'Just answered a question' });
  });

  it('handles in-progress intent', () => {
    const handoff = `---\nstatus_intent: in-progress\nreason: "Dispatched to COO"\n---\n# HANDOFF`;
    const result = parseStatusIntent(handoff);
    expect(result).toEqual({ status: 'in-progress', reason: 'Dispatched to COO' });
  });

  it('returns null when front matter has no status_intent field', () => {
    const handoff = `---\ntitle: something\n---\n# HANDOFF`;
    expect(parseStatusIntent(handoff)).toBeNull();
  });
});

// ─── parseDispatchesFromFrontMatter ──────────────────────────────────

describe('parseDispatchesFromFrontMatter', () => {
  it('returns empty array when no dispatches key', () => {
    expect(parseDispatchesFromFrontMatter('status_intent: done')).toEqual([]);
  });

  it('parses single dispatch with existing issue', () => {
    const fm = `status_intent: in-progress\ndispatches:\n  - role: lead-engineer\n    issue: RYA-42\n    context: "Implement auth"`;
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'lead-engineer', issue: 'RYA-42', context: 'Implement auth' });
  });

  it('parses dispatch with new_issue', () => {
    const fm = `dispatches:\n  - role: coo\n    new_issue:\n      title: "Deploy changes"\n      description: "Deploy and verify"\n      priority: 2\n      parent: RYA-42\n    context: "After implementation"`;
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('coo');
    expect(result[0].new_issue).toEqual({ title: 'Deploy changes', description: 'Deploy and verify', priority: 2, parent: 'RYA-42' });
    expect(result[0].context).toBe('After implementation');
  });

  it('parses multiple dispatches', () => {
    const fm = `dispatches:\n  - role: lead-engineer\n    issue: RYA-42\n    context: "First"\n  - role: coo\n    issue: RYA-43\n    context: "Second"`;
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('lead-engineer');
    expect(result[1].role).toBe('coo');
  });

  it('stops parsing at next top-level key', () => {
    const fm = `dispatches:\n  - role: cto\n    issue: RYA-1\ndelegate: coo`;
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('cto');
  });
});

// ─── detectReviewerFromDescription ──────────────────────────────────

describe('detectReviewerFromDescription', () => {
  it('detects "Reviewer: CTO" pattern', () => {
    expect(detectReviewerFromDescription('Build this project.\nReviewer: CTO\nDeadline: Friday')).toBe('cto');
  });

  it('detects "Cross-review: CPO" pattern', () => {
    expect(detectReviewerFromDescription('Some desc.\nCross-review: CPO')).toBe('cpo');
  });

  it('detects "Review by: lead-engineer" pattern', () => {
    expect(detectReviewerFromDescription('Review by: lead-engineer')).toBe('lead-engineer');
  });

  it('is case-insensitive', () => {
    expect(detectReviewerFromDescription('REVIEWER: cto')).toBe('cto');
    expect(detectReviewerFromDescription('reviewer: CTO')).toBe('cto');
  });

  it('returns null when no reviewer pattern found', () => {
    expect(detectReviewerFromDescription('Just a normal description without reviewer info')).toBeNull();
  });

  it('returns null for undefined/empty description', () => {
    expect(detectReviewerFromDescription(undefined)).toBeNull();
    expect(detectReviewerFromDescription('')).toBeNull();
  });

  it('handles hyphenated cross-review', () => {
    expect(detectReviewerFromDescription('Cross-review: cpo')).toBe('cpo');
  });
});

// ─── parseHandoffActions (review_dispatch) ──────────────────────────

describe('parseHandoffActions review_dispatch', () => {
  it('parses review_dispatch from front matter', () => {
    const handoff = '---\nstatus_intent: in-review\nreview_dispatch: cto\n---\n# HANDOFF';
    const result = parseHandoffActions(handoff);
    expect(result.reviewDispatch).toBe('cto');
  });

  it('returns null reviewDispatch when not present', () => {
    const handoff = '---\nstatus_intent: done\n---\n# HANDOFF';
    const result = parseHandoffActions(handoff);
    expect(result.reviewDispatch).toBeNull();
  });
});

// ─── parseHandoffActions ─────────────────────────────────────────────

describe('parseHandoffActions', () => {
  it('returns empty actions when no front matter', () => {
    const result = parseHandoffActions('# HANDOFF\n## Summary');
    expect(result.dispatches).toEqual([]);
    expect(result.delegate).toBeNull();
    expect(result.parentStatus).toBeNull();
    expect(result.statusIntent).toBeNull();
  });

  it('parses status_intent only (backward compat)', () => {
    const handoff = '---\nstatus_intent: done\nreason: "All good"\n---\n# HANDOFF';
    const result = parseHandoffActions(handoff);
    expect(result.statusIntent).toEqual({ status: 'done', reason: 'All good' });
    expect(result.dispatches).toEqual([]);
    expect(result.delegate).toBeNull();
  });

  it('parses delegate field', () => {
    const handoff = '---\nstatus_intent: in-progress\ndelegate: lead-engineer\n---\n# HANDOFF';
    const result = parseHandoffActions(handoff);
    expect(result.delegate).toBe('lead-engineer');
  });

  it('parses parent_status field', () => {
    const handoff = '---\nstatus_intent: done\nparent_status: in-review\n---\n# HANDOFF';
    const result = parseHandoffActions(handoff);
    expect(result.parentStatus).toBe('in-review');
  });

  it('treats parent_status: null as no action', () => {
    const handoff = '---\nparent_status: null\n---\n# HANDOFF';
    const result = parseHandoffActions(handoff);
    expect(result.parentStatus).toBeNull();
  });

  it('parses all fields together', () => {
    const handoff = `---
status_intent: in-review
reason: "Architecture designed"
dispatches:
  - role: lead-engineer
    issue: RYA-42
    context: "Implement"
delegate: lead-engineer
parent_status: in-review
---
# HANDOFF`;
    const result = parseHandoffActions(handoff);
    expect(result.statusIntent?.status).toBe('in-review');
    expect(result.dispatches).toHaveLength(1);
    expect(result.dispatches[0].role).toBe('lead-engineer');
    expect(result.delegate).toBe('lead-engineer');
    expect(result.parentStatus).toBe('in-review');
  });
});

// ─── hasStickyInProgressIntent (RYA-1116) ───────────────────────────

describe('hasStickyInProgressIntent', () => {
  it('returns true for status_intent: in-progress', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: in-progress\n---\n# HANDOFF')).toBe(true);
  });

  it('returns true for status_intent: no-change', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: no-change\n---\n# HANDOFF')).toBe(true);
  });

  it('returns false for status_intent: in-review', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: in-review\n---\n# HANDOFF')).toBe(false);
  });

  it('returns false for status_intent: done', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: done\n---\n# HANDOFF')).toBe(false);
  });

  it('returns false for status_intent: todo', () => {
    // todo is a state change request, not "stay In Progress" — the main flow handles it
    expect(hasStickyInProgressIntent('---\nstatus_intent: todo\n---\n# HANDOFF')).toBe(false);
  });

  it('returns false when no front matter', () => {
    expect(hasStickyInProgressIntent('# HANDOFF\n## Summary')).toBe(false);
  });

  it('returns false when no status_intent field', () => {
    expect(hasStickyInProgressIntent('---\nreason: something\n---\n# HANDOFF')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(hasStickyInProgressIntent(null)).toBe(false);
    expect(hasStickyInProgressIntent(undefined)).toBe(false);
    expect(hasStickyInProgressIntent('')).toBe(false);
  });

  it('honors quoted values', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: "in-progress"\n---\n# HANDOFF')).toBe(true);
    expect(hasStickyInProgressIntent("---\nstatus_intent: 'in-progress'\n---\n# HANDOFF")).toBe(true);
  });

  it('ignores invalid values', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: in-progres\n---\n# HANDOFF')).toBe(false);
    expect(hasStickyInProgressIntent('---\nstatus_intent: bogus\n---\n# HANDOFF')).toBe(false);
  });

  it('matches real research-lead → CTO handoff pattern from RYA-1107', () => {
    const handoff = `---
status_intent: in-progress
reason: "Spec authored and dispatched to lead-engineer; implementation work continues on this same issue."
---
# HANDOFF — RYA-1107

## Summary
Authored a copy-paste-ready production design spec...
`;
    expect(hasStickyInProgressIntent(handoff)).toBe(true);
  });
});

// ─── classifyReviewLevel (RYA-543) ──────────────────────────────────

describe('classifyReviewLevel', () => {
  const handoff = (extra = '') => `---\nstatus_intent: in-review\n${extra}---\n# HANDOFF\n## Summary\nDid stuff.`;

  it('defaults to CTO review for standard internal work', () => {
    expect(classifyReviewLevel('Implement new API handler', handoff(), 'lead-engineer')).toBe('cto');
  });

  it('escalates to CEO for security-related titles', () => {
    expect(classifyReviewLevel('Update auth middleware', handoff(), 'lead-engineer')).toBe('ceo');
    expect(classifyReviewLevel('Fix authentication flow', handoff(), 'lead-engineer')).toBe('ceo');
    expect(classifyReviewLevel('Security audit of user endpoints', handoff(), 'coo')).toBe('ceo');
  });

  it('escalates to CEO for architecture changes', () => {
    expect(classifyReviewLevel('Architecture redesign for queue system', handoff(), 'lead-engineer')).toBe('ceo');
  });

  it('escalates to CEO for production deployments', () => {
    expect(classifyReviewLevel('Deploy prod hotfix for billing', handoff(), 'coo')).toBe('ceo');
  });

  it('escalates to CEO for external/public-facing changes', () => {
    expect(classifyReviewLevel('Update public-facing API docs', handoff(), 'lead-engineer')).toBe('ceo');
    expect(classifyReviewLevel('Customer-facing dashboard redesign', handoff(), 'lead-engineer')).toBe('ceo');
  });

  it('escalates to CEO for strategy/budget', () => {
    expect(classifyReviewLevel('Strategic planning for Q2', handoff(), 'coo')).toBe('ceo');
    expect(classifyReviewLevel('Budget allocation for new infra', handoff(), 'coo')).toBe('ceo');
  });

  it('escalates to CEO for OSS releases', () => {
    expect(classifyReviewLevel('OSS release of health-dash v1.0', handoff(), 'lead-engineer')).toBe('ceo');
  });

  it('escalates to CEO when builder is CTO or CPO', () => {
    expect(classifyReviewLevel('Refactor internal module', handoff(), 'cto')).toBe('ceo');
    expect(classifyReviewLevel('Update product specs', handoff(), 'cpo')).toBe('ceo');
  });

  it('allows CTO review for COO internal work', () => {
    expect(classifyReviewLevel('Update monitoring dashboard', handoff(), 'coo')).toBe('cto');
  });

  it('allows CTO review for lead-engineer standard work', () => {
    expect(classifyReviewLevel('Add pagination to list endpoint', handoff(), 'lead-engineer')).toBe('cto');
  });

  it('respects review_level: ceo override in front matter', () => {
    expect(classifyReviewLevel('Simple internal change', handoff('review_level: ceo\n'), 'lead-engineer')).toBe('ceo');
  });

  it('respects review_level: cto override in front matter', () => {
    expect(classifyReviewLevel('Security-sounding but actually safe', handoff('review_level: cto\n'), 'lead-engineer')).toBe('cto');
  });

  it('escalates to CEO when HANDOFF reason contains security signals', () => {
    const h = `---\nstatus_intent: in-review\nreason: "Breaking change to auth system"\n---\n# HANDOFF`;
    expect(classifyReviewLevel('Update middleware', h, 'lead-engineer')).toBe('ceo');
  });

  it('parses review_level in parseHandoffActions', () => {
    const h = '---\nstatus_intent: in-review\nreview_level: ceo\n---\n# HANDOFF';
    const result = parseHandoffActions(h);
    expect(result.reviewLevel).toBe('ceo');
  });

  it('returns null reviewLevel when not present', () => {
    const h = '---\nstatus_intent: in-review\n---\n# HANDOFF';
    const result = parseHandoffActions(h);
    expect(result.reviewLevel).toBeNull();
  });
});

// ─── isTransientApiErrorOutput ───────────────────────────────────────

describe('isTransientApiErrorOutput', () => {
  it('detects API Error: 500', () => {
    const output = 'API Error: 500\n{"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
    expect(isTransientApiErrorOutput(output)).toBe(true);
  });

  it('detects API Error: 503', () => {
    const output = 'API Error: 503\n{"type":"error","error":{"type":"api_error","message":"Service unavailable"}}';
    expect(isTransientApiErrorOutput(output)).toBe(true);
  });

  it('detects API Error: 500 with surrounding context', () => {
    const output = '❯ \nAPI Error: 500\n  {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
    expect(isTransientApiErrorOutput(output)).toBe(true);
  });

  it('detects overloaded_error', () => {
    const output = 'overloaded_error: The API is temporarily overloaded';
    expect(isTransientApiErrorOutput(output)).toBe(true);
  });

  it('detects "Internal server error" in output', () => {
    const output = '{"type":"api_error","message":"Internal server error"}';
    expect(isTransientApiErrorOutput(output)).toBe(true);
  });

  it('detects "service unavailable" in output', () => {
    const output = 'Error: service unavailable, please try again';
    expect(isTransientApiErrorOutput(output)).toBe(true);
  });

  it('does NOT detect rate limit errors as transient', () => {
    const output = 'API Error: 429\n{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}';
    expect(isTransientApiErrorOutput(output)).toBe(false);
  });

  it('does NOT detect auth errors as transient', () => {
    const output = 'API Error: 401\n{"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}';
    expect(isTransientApiErrorOutput(output)).toBe(false);
  });

  it('does NOT detect normal output as transient error', () => {
    const output = '❯ \nFlowing...';
    expect(isTransientApiErrorOutput(output)).toBe(false);
  });

  it('does NOT false-positive on issue content mentioning 500 errors', () => {
    // The text "500 error" without "API Error:" prefix should not match
    const output = 'Reading issue: "Handle 500 errors from the API"\n❯ ';
    expect(isTransientApiErrorOutput(output)).toBe(false);
  });
});

// ─── Transient retry constants ──────────────────────────────────────

describe('transient retry constants', () => {
  it('retry delay is 60 seconds', () => {
    expect(TRANSIENT_RETRY_DELAY_MS).toBe(60_000);
  });

  it('max retry duration is 2 hours', () => {
    expect(TRANSIENT_RETRY_MAX_DURATION_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe('rate limit in-place retry constants (RYA-443)', () => {
  it('rate limit retry delay is 2 minutes', () => {
    expect(RATE_LIMIT_RETRY_DELAY_MS).toBe(120_000);
  });

  it('max rate limit retry duration is 30 minutes', () => {
    expect(RATE_LIMIT_RETRY_MAX_DURATION_MS).toBe(30 * 60_000);
  });
});

// ─── Phantom unsubmitted input sweep (RYA-1251) ──────────────────────

describe('sweepPhantomInput', () => {
  const phantomPane = (text: string) => [
    '────────────────────────────────────────',
    `❯ ${text}`,
    '────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');

  beforeEach(() => {
    vi.mocked(tmux.capturePane).mockReset();
    vi.mocked(tmux.listAgentSessions).mockReset();
    vi.mocked(tmux.recoverPhantomInput).mockReset();
    vi.mocked(tmux.recoverPhantomInput).mockReturnValue(true);
  });

  it('fires literal retype once phantom input sits unchanged past the idle threshold', () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tmux.listAgentSessions).mockReturnValue(['aos-coo-coo']);
      vi.mocked(tmux.capturePane).mockReturnValue(phantomPane('clean up the .bak files too'));

      sweepPhantomInput(); // first sighting — starts the clock
      expect(tmux.recoverPhantomInput).not.toHaveBeenCalled();

      vi.advanceTimersByTime(PHANTOM_INPUT_IDLE_MS + 1_000);
      sweepPhantomInput();
      expect(tmux.recoverPhantomInput).toHaveBeenCalledWith('aos-coo-coo', 'clean up the .bak files too');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the clock while the text keeps changing (someone is typing)', () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tmux.listAgentSessions).mockReturnValue(['aos-cto-RYA-1']);
      vi.mocked(tmux.capturePane).mockReturnValue(phantomPane('first draft'));
      sweepPhantomInput();

      vi.advanceTimersByTime(PHANTOM_INPUT_IDLE_MS + 1_000);
      vi.mocked(tmux.capturePane).mockReturnValue(phantomPane('first draft, now longer'));
      sweepPhantomInput(); // text changed — reset, not recover
      expect(tmux.recoverPhantomInput).not.toHaveBeenCalled();

      vi.advanceTimersByTime(PHANTOM_INPUT_IDLE_MS - 1_000);
      sweepPhantomInput(); // still inside the new window
      expect(tmux.recoverPhantomInput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch a pane while the agent is actively working', () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tmux.listAgentSessions).mockReturnValue(['aos-cpo-RYA-2']);
      const busyPane = `✻ Flowing… (esc to interrupt)\n${phantomPane('queued message')}`;
      vi.mocked(tmux.capturePane).mockReturnValue(busyPane);
      sweepPhantomInput();
      vi.advanceTimersByTime(PHANTOM_INPUT_IDLE_MS * 3);
      sweepPhantomInput();
      expect(tmux.recoverPhantomInput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears tracking when the input box empties on its own', () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tmux.listAgentSessions).mockReturnValue(['aos-coo-RYA-3']);
      vi.mocked(tmux.capturePane).mockReturnValue(phantomPane('about to submit'));
      sweepPhantomInput();

      vi.mocked(tmux.capturePane).mockReturnValue('────\n❯ \n────');
      vi.advanceTimersByTime(PHANTOM_INPUT_IDLE_MS + 1_000);
      sweepPhantomInput();
      expect(tmux.recoverPhantomInput).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── isBadModelOutput (RYA-1258) ────────────────────────────────────────────

describe('isBadModelOutput', () => {
  it('detects exact "There is an issue with the selected model" phrase', () => {
    const output = 'There is an issue with the selected model (claude-fable-5[1m]). It may not exist or you may not have access to it.';
    expect(isBadModelOutput(output)).toBe(true);
  });

  it('detects "may not exist or you may not have access to it" alone', () => {
    const output = 'Error: may not exist or you may not have access to it';
    expect(isBadModelOutput(output)).toBe(true);
  });

  it('is case-insensitive', () => {
    const output = 'THERE IS AN ISSUE WITH THE SELECTED MODEL (claude-opus-4-8). IT MAY NOT EXIST.';
    expect(isBadModelOutput(output)).toBe(true);
  });

  it('does NOT match on normal pane output', () => {
    expect(isBadModelOutput('❯ \nFlowing...')).toBe(false);
  });

  it('does NOT match transient 500 errors', () => {
    expect(isBadModelOutput('API Error: 500\n{"type":"api_error"}')).toBe(false);
  });

  it('does NOT match rate-limit output', () => {
    expect(isBadModelOutput('API Error: 429 Too many requests')).toBe(false);
  });

  it('does NOT false-positive on issue descriptions mentioning model access', () => {
    // Should only match the literal claude error message, not general text
    expect(isBadModelOutput('Checking if the model has access to the database')).toBe(false);
  });
});
