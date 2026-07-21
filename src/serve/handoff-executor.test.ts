import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../core/config.js', () => ({ getConfig: () => ({ linearTeamId: 'team-1', stateDir: '/tmp/test' }) }));
vi.mock('../core/linear.js', () => ({ getIssue: vi.fn(), updateIssueState: vi.fn() }));
vi.mock('../core/db.js', () => ({ getActiveAttempts: vi.fn(() => []), logEvent: vi.fn() }));
vi.mock('../core/persona.js', () => ({ agentExists: vi.fn(() => true), loadAgentConfig: vi.fn(() => ({ linearUserId: 'user-1' })) }));
vi.mock('../core/queue.js', () => ({ getQueueItems: vi.fn(() => []) }));
vi.mock('../types.js', () => ({ WORKFLOW_STATES: { DONE: 'Done', IN_REVIEW: 'In Review', IN_PROGRESS: 'In Progress', TODO: 'Todo' } }));
vi.mock('./dispatch.js', () => ({ handleDispatch: vi.fn(async () => ({ action: 'dispatched' })) }));
vi.mock('./proactive.js', () => ({ TRANSIENT_LINEAR_ERROR_RE: /rate.?limit|network|ETIMEDOUT/i }));

import {
  parseStatusIntent, hasStickyInProgressIntent, parseDispatchesFromFrontMatter,
  parseHandoffActions, hasActiveHandoff,
} from './handoff-executor.js';
import * as db from '../core/db.js';
import * as queue from '../core/queue.js';

// ─── parseStatusIntent ────────────────────────────────────────────────────────

describe('parseStatusIntent', () => {
  it('parses done intent with reason', () => {
    const result = parseStatusIntent('---\nstatus_intent: done\nreason: "Tests pass"\n---\n# H');
    expect(result).toEqual({ status: 'done', reason: 'Tests pass' });
  });

  it('returns null without front matter', () => {
    expect(parseStatusIntent('# HANDOFF')).toBeNull();
  });

  it('returns null for invalid status', () => {
    expect(parseStatusIntent('---\nstatus_intent: invalid\n---')).toBeNull();
  });

  it('parses in-progress', () => {
    const r = parseStatusIntent('---\nstatus_intent: in-progress\n---');
    expect(r?.status).toBe('in-progress');
  });

  it('parses no-change', () => {
    const r = parseStatusIntent('---\nstatus_intent: no-change\n---');
    expect(r?.status).toBe('no-change');
  });
});

// ─── hasStickyInProgressIntent ───────────────────────────────────────────────

describe('hasStickyInProgressIntent', () => {
  it('returns true for in-progress', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: in-progress\n---')).toBe(true);
  });

  it('returns true for no-change', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: no-change\n---')).toBe(true);
  });

  it('returns false for done', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: done\n---')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(hasStickyInProgressIntent(null)).toBe(false);
    expect(hasStickyInProgressIntent(undefined)).toBe(false);
  });

  it('returns false for in-review', () => {
    expect(hasStickyInProgressIntent('---\nstatus_intent: in-review\n---')).toBe(false);
  });
});

// ─── parseDispatchesFromFrontMatter ──────────────────────────────────────────

describe('parseDispatchesFromFrontMatter', () => {
  it('returns empty array when no dispatches key', () => {
    expect(parseDispatchesFromFrontMatter('status_intent: done')).toEqual([]);
  });

  it('parses single dispatch with issue', () => {
    const fm = 'dispatches:\n  - role: coo\n    issue: RYA-1\n    context: "do it"';
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'coo', issue: 'RYA-1', context: 'do it' });
  });

  it('parses dispatch with new_issue', () => {
    const fm = 'dispatches:\n  - role: coo\n    new_issue:\n      title: "T"\n      description: "D"\n      priority: 2';
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result[0].new_issue?.title).toBe('T');
    expect(result[0].new_issue?.priority).toBe(2);
  });

  it('parses multiple dispatches', () => {
    const fm = 'dispatches:\n  - role: cto\n    issue: RYA-1\n  - role: coo\n    issue: RYA-2';
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('cto');
    expect(result[1].role).toBe('coo');
  });

  it('stops at next top-level key', () => {
    const fm = 'dispatches:\n  - role: cto\n    issue: RYA-1\ndelegate: coo';
    const result = parseDispatchesFromFrontMatter(fm);
    expect(result).toHaveLength(1);
  });
});

// ─── parseHandoffActions ─────────────────────────────────────────────────────

describe('parseHandoffActions', () => {
  it('returns empty actions without front matter', () => {
    const r = parseHandoffActions('# HANDOFF');
    expect(r.dispatches).toEqual([]);
    expect(r.delegate).toBeNull();
    expect(r.parentStatus).toBeNull();
    expect(r.reviewDispatch).toBeNull();
    expect(r.reviewLevel).toBeNull();
    expect(r.statusIntent).toBeNull();
  });

  it('parses delegate field', () => {
    const r = parseHandoffActions('---\ndelegate: lead-engineer\n---');
    expect(r.delegate).toBe('lead-engineer');
  });

  it('parses parent_status field', () => {
    const r = parseHandoffActions('---\nparent_status: in-review\n---');
    expect(r.parentStatus).toBe('in-review');
  });

  it('ignores parent_status: null', () => {
    const r = parseHandoffActions('---\nparent_status: null\n---');
    expect(r.parentStatus).toBeNull();
  });

  it('parses review_dispatch', () => {
    const r = parseHandoffActions('---\nreview_dispatch: cto\n---');
    expect(r.reviewDispatch).toBe('cto');
  });

  it('parses review_level: ceo', () => {
    const r = parseHandoffActions('---\nreview_level: ceo\n---');
    expect(r.reviewLevel).toBe('ceo');
  });

  it('parses review_level: cto', () => {
    const r = parseHandoffActions('---\nreview_level: cto\n---');
    expect(r.reviewLevel).toBe('cto');
  });

  it('parses all fields together', () => {
    const handoff = `---
status_intent: in-review
dispatches:
  - role: coo
    issue: RYA-99
    context: "Deploy"
delegate: lead-engineer
parent_status: done
review_dispatch: cto
review_level: ceo
---
# HANDOFF`;
    const r = parseHandoffActions(handoff);
    expect(r.statusIntent?.status).toBe('in-review');
    expect(r.dispatches).toHaveLength(1);
    expect(r.dispatches[0].issue).toBe('RYA-99');
    expect(r.delegate).toBe('lead-engineer');
    expect(r.parentStatus).toBe('done');
    expect(r.reviewDispatch).toBe('cto');
    expect(r.reviewLevel).toBe('ceo');
  });
});

// ─── hasActiveHandoff ─────────────────────────────────────────────────────────

describe('hasActiveHandoff', () => {
  beforeEach(() => {
    vi.mocked(db.getActiveAttempts).mockReturnValue([]);
    vi.mocked(queue.getQueueItems).mockReturnValue([]);
  });

  it('returns false when no other attempts', () => {
    expect(hasActiveHandoff('RYA-1', 'attempt-1')).toBe(false);
  });

  it('returns true when another attempt is active for same issue', () => {
    vi.mocked(db.getActiveAttempts).mockReturnValue([
      { id: 'attempt-2', issue_key: 'RYA-1', status: 'running' } as any,
    ]);
    expect(hasActiveHandoff('RYA-1', 'attempt-1')).toBe(true);
  });

  it('ignores the current attempt', () => {
    vi.mocked(db.getActiveAttempts).mockReturnValue([
      { id: 'attempt-1', issue_key: 'RYA-1', status: 'running' } as any,
    ]);
    expect(hasActiveHandoff('RYA-1', 'attempt-1')).toBe(false);
  });

  it('returns true when work is queued for the issue', () => {
    vi.mocked(queue.getQueueItems).mockReturnValue([
      { issue_key: 'RYA-1' } as any,
    ]);
    expect(hasActiveHandoff('RYA-1', 'attempt-1')).toBe(true);
  });
});
