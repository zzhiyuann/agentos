import { describe, it, expect, vi } from 'vitest';

// Mock external dependencies so importing monitor.js (for parseHandoffActions)
// stays hermetic — same setup as monitor.test.ts.
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
  resolveStatePath: vi.fn(),
  getIssueStateDir: vi.fn(() => '/tmp/aos-test/work'),
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
  listAgents: vi.fn(() => ['cto', 'coo', 'lead-engineer']),
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

import { validateHandoffActions, formatRejectedActions, MAX_DISPATCHES, MAX_CONTEXT_LEN } from './handoff-validate.js';
import { parseHandoffActions } from './monitor.js';
import type { HandoffActions, DispatchAction } from './monitor.js';

const ROLES = ['cto', 'coo', 'lead-engineer'];

function actions(overrides: Partial<HandoffActions> = {}): HandoffActions {
  return {
    statusIntent: null,
    dispatches: [],
    delegate: null,
    parentStatus: null,
    reviewDispatch: null,
    reviewLevel: null,
    ...overrides,
  };
}

function dispatch(overrides: Partial<DispatchAction> = {}): DispatchAction {
  return { role: 'coo', issue: 'RYA-42', context: 'do the thing', ...overrides };
}

describe('validateHandoffActions', () => {
  it('passes a clean set of actions through unchanged', () => {
    const input = actions({
      statusIntent: { status: 'in-review' },
      delegate: 'cto',
      dispatches: [dispatch()],
    });
    const result = validateHandoffActions(input, ROLES);
    expect(result.rejected).toEqual([]);
    expect(result.valid.statusIntent).toEqual({ status: 'in-review' });
    expect(result.valid.delegate).toBe('cto');
    expect(result.valid.dispatches).toHaveLength(1);
  });

  // Table-driven per-dispatch rejection cases
  const rejectionCases: Array<{ name: string; d: DispatchAction; reasonMatch: RegExp }> = [
    { name: 'unknown role', d: dispatch({ role: 'evil-agent' }), reasonMatch: /unknown role/ },
    { name: 'empty role', d: dispatch({ role: '' }), reasonMatch: /unknown role/ },
    { name: 'garbled issue key', d: dispatch({ issue: 'DROP TABLE issues;--' }), reasonMatch: /invalid issue key format/ },
    { name: 'lowercase issue key', d: dispatch({ issue: 'rya-42' }), reasonMatch: /invalid issue key format/ },
    { name: 'cross-team issue key', d: dispatch({ issue: 'EVIL-99' }), reasonMatch: /outside team RYA/ },
    { name: 'no target at all', d: { role: 'coo' }, reasonMatch: /neither issue nor new_issue/ },
    {
      name: 'empty new-issue title',
      d: { role: 'coo', new_issue: { title: '   ', description: 'x' } },
      reasonMatch: /title must be 1-200 chars/,
    },
    {
      name: 'oversized new-issue title',
      d: { role: 'coo', new_issue: { title: 'x'.repeat(201), description: 'x' } },
      reasonMatch: /title must be 1-200 chars/,
    },
    {
      name: 'oversized context',
      d: dispatch({ context: 'y'.repeat(MAX_CONTEXT_LEN + 1) }),
      reasonMatch: /context exceeds 2000 chars/,
    },
  ];

  for (const tc of rejectionCases) {
    it(`rejects dispatch: ${tc.name}`, () => {
      const result = validateHandoffActions(actions({ dispatches: [tc.d] }), ROLES);
      expect(result.valid.dispatches).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toMatch(tc.reasonMatch);
    });
  }

  it('drops rejected dispatches individually — valid ones proceed', () => {
    const input = actions({
      dispatches: [
        dispatch({ issue: 'RYA-1' }),
        dispatch({ role: 'nobody', issue: 'RYA-2' }),
        dispatch({ issue: 'RYA-3' }),
      ],
    });
    const result = validateHandoffActions(input, ROLES);
    expect(result.valid.dispatches.map(d => d.issue)).toEqual(['RYA-1', 'RYA-3']);
    expect(result.rejected).toHaveLength(1);
  });

  it('rejects dispatches beyond the limit of 5', () => {
    const many = Array.from({ length: 7 }, (_, i) => dispatch({ issue: `RYA-${i + 1}` }));
    const result = validateHandoffActions(actions({ dispatches: many }), ROLES);
    expect(result.valid.dispatches).toHaveLength(MAX_DISPATCHES);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].reason).toMatch(/dispatch limit exceeded/);
  });

  it('accepts a valid new_issue dispatch', () => {
    const d: DispatchAction = {
      role: 'lead-engineer',
      new_issue: { title: 'Implement the validator', description: 'details', priority: 2 },
      context: 'follow-up work',
    };
    const result = validateHandoffActions(actions({ dispatches: [d] }), ROLES);
    expect(result.rejected).toEqual([]);
    expect(result.valid.dispatches).toHaveLength(1);
  });

  it('nulls out an unknown delegate role', () => {
    const result = validateHandoffActions(actions({ delegate: 'super-admin' }), ROLES);
    expect(result.valid.delegate).toBeNull();
    expect(result.rejected[0].reason).toMatch(/unknown role "super-admin"/);
  });

  it('nulls out a non-whitelisted status intent (defensive)', () => {
    const input = actions({ statusIntent: { status: 'deleted' as never } });
    const result = validateHandoffActions(input, ROLES);
    expect(result.valid.statusIntent).toBeNull();
    expect(result.rejected[0].reason).toMatch(/whitelist/);
  });

  it('preserves parentStatus and review fields untouched', () => {
    const input = actions({ parentStatus: 'in-review', reviewDispatch: 'cto', reviewLevel: 'ceo' });
    const result = validateHandoffActions(input, ROLES);
    expect(result.valid.parentStatus).toBe('in-review');
    expect(result.valid.reviewDispatch).toBe('cto');
    expect(result.valid.reviewLevel).toBe('ceo');
  });
});

// ─── End-to-end: garbled / malicious front matter through the real parser ────

describe('validateHandoffActions on parsed front matter', () => {
  it('drops a hallucinated role and cross-team key from real front matter', () => {
    const handoff = `---
status_intent: in-review
dispatches:
  - role: lead-engineer
    issue: RYA-77
    context: "continue the work"
  - role: root
    issue: RYA-78
  - role: coo
    issue: OTHER-1
delegate: lead-engineer
---
# HANDOFF`;
    const parsed = parseHandoffActions(handoff);
    const result = validateHandoffActions(parsed, ROLES);
    expect(result.valid.dispatches).toHaveLength(1);
    expect(result.valid.dispatches[0].issue).toBe('RYA-77');
    expect(result.valid.delegate).toBe('lead-engineer');
    expect(result.rejected).toHaveLength(2);
  });

  it('handles malicious injection-style front matter', () => {
    const handoff = `---
status_intent: done
dispatches:
  - role: coo
    issue: "RYA-1; rm -rf /"
  - role: coo
    issue: javascript:alert(1)
---
# HANDOFF`;
    const parsed = parseHandoffActions(handoff);
    const result = validateHandoffActions(parsed, ROLES);
    expect(result.valid.dispatches).toEqual([]);
    expect(result.rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of result.rejected) {
      expect(r.reason).toMatch(/invalid issue key format/);
    }
  });

  it('handles completely garbled YAML gracefully (nothing to execute)', () => {
    const handoff = `---
:: ::: not yaml at all
dispatches: [ { role: ??? }
---
# HANDOFF`;
    const parsed = parseHandoffActions(handoff);
    const result = validateHandoffActions(parsed, ROLES);
    expect(result.valid.dispatches).toEqual([]);
  });
});

describe('formatRejectedActions', () => {
  it('renders one bullet per rejection', () => {
    const text = formatRejectedActions([
      { action: 'dispatch[0] role=x → RYA-1', reason: 'unknown role "x"' },
      { action: 'delegate: y', reason: 'unknown role "y"' },
    ]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('unknown role "x"');
  });
});
