/**
 * Unit tests for the CEO Shadow corpus extractor. RYA-845.
 *
 * Run:  pnpm vitest run src/coop/ceo-shadow/ceo-shadow.test.ts
 */

import { describe, it, expect } from 'vitest';

import { classifyCeoComment } from './classify.js';
import { extractEventsFromIssues } from './extract.js';
import { computeAudit } from './audit.js';
import { CEO_USER_ID, AGENT_USER_IDS } from './users.js';
import type { RawIssue } from './types.js';

describe('classifyCeoComment', () => {
  it('catches English approve patterns', () => {
    expect(classifyCeoComment('Approve, ship it.').category).toBe('approve');
    expect(classifyCeoComment('LGTM').category).toBe('approve');
    expect(classifyCeoComment('go ahead').category).toBe('approve');
    expect(classifyCeoComment('sounds good 👍').category).toBe('approve');
  });

  it('catches Mandarin approve patterns', () => {
    expect(classifyCeoComment('同意，去做').category).toBe('approve');
    expect(classifyCeoComment('可以').category).toBe('approve');
    expect(classifyCeoComment('批准').category).toBe('approve');
  });

  it('catches reject patterns', () => {
    expect(classifyCeoComment('Reject — wrong direction').category).toBe('reject');
    expect(classifyCeoComment('not now').category).toBe('reject');
    expect(classifyCeoComment('kill this').category).toBe('reject');
    expect(classifyCeoComment('拒绝').category).toBe('reject');
    expect(classifyCeoComment('不要这样做').category).toBe('reject');
    expect(classifyCeoComment('❌ no').category).toBe('reject');
  });

  it('detects dispatch with @-mention', () => {
    const r = classifyCeoComment('@cto fix the eval regression please');
    expect(r.category).toBe('dispatch');
    expect(r.dispatch_target).toBe('cto');
  });

  it('treats plain @role as dispatch', () => {
    const r = classifyCeoComment('@researchlead what data should we use?');
    // plain @role → dispatch (CEO addressing an agent)
    expect(r.category).toBe('dispatch');
    expect(r.dispatch_target).toBe('research-lead');
  });

  it('falls back to comment for ambiguous text', () => {
    expect(classifyCeoComment('Hmm interesting.').category).toBe('comment');
    expect(classifyCeoComment('').category).toBe('comment');
  });
});

function fixture(): RawIssue[] {
  const ceo = { id: CEO_USER_ID, name: 'Zhiyuan Wang' };
  const cpo = { id: AGENT_USER_IDS['cpo'], name: 'CPO' };
  const cto = { id: AGENT_USER_IDS['cto'], name: 'CTO' };
  return [
    // Issue created by CEO
    {
      id: 'iss-1',
      identifier: 'RYA-1',
      title: 'Make this thing',
      description: 'Need to build it.',
      priority: 2,
      createdAt: '2026-04-01T10:00:00.000Z',
      updatedAt: '2026-04-02T10:00:00.000Z',
      creator: ceo,
      assignee: { id: AGENT_USER_IDS['cto'], name: 'CTO' },
      state: { name: 'Done' },
      parent: null,
      labels: { nodes: [{ name: 'priority:high' }] },
      history: { nodes: [] },
      comments: { nodes: [] },
    },
    // Proactive proposal where CEO comments approve and changes status
    {
      id: 'iss-2',
      identifier: 'RYA-2',
      title: '[proactive] Reflect — Privacy Mirror',
      description: 'Long proposal body. Decision Asked: vote.',
      priority: 2,
      createdAt: '2026-04-23T03:56:31.000Z',
      updatedAt: '2026-05-03T15:17:31.000Z',
      creator: cpo,
      assignee: null,
      state: { name: 'Canceled' },
      parent: { identifier: 'RYA-640' },
      labels: { nodes: [] },
      history: {
        nodes: [
          {
            id: 'h1',
            createdAt: '2026-05-03T15:17:31.000Z',
            fromState: { name: 'In Review' },
            toState: { name: 'Canceled' },
            fromPriority: null,
            toPriority: null,
            fromAssignee: null,
            toAssignee: null,
            actor: ceo,
          },
        ],
      },
      comments: {
        nodes: [
          {
            id: 'c1',
            body: 'CTO vote: approve with conditions.',
            createdAt: '2026-04-23T05:00:00.000Z',
            user: cto,
          },
          {
            id: 'c2',
            body: 'Reject — timing conflicts with AgentOS launch.',
            createdAt: '2026-05-03T15:00:00.000Z',
            user: ceo,
          },
        ],
      },
    },
    // Stale [to decide] with zero CEO touch
    {
      id: 'iss-3',
      identifier: 'RYA-3',
      title: '[to decide] hub governance',
      description: 'Three hubs overlap.',
      priority: 3,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      creator: cpo,
      assignee: null,
      state: { name: 'Backlog' },
      parent: null,
      labels: { nodes: [] },
      history: { nodes: [] },
      comments: {
        nodes: [{ id: 'c-prop', body: 'Recommend option B.', createdAt: '2026-04-01T01:00:00.000Z', user: cpo }],
      },
    },
  ];
}

describe('extractEventsFromIssues', () => {
  it('emits create + status-change + comment + silent-decline', () => {
    const events = extractEventsFromIssues(fixture(), {
      sinceTs: '2026-03-01T00:00:00.000Z',
      asOf: new Date('2026-05-03T18:00:00.000Z'),
    });
    const cats = events.map((e) => e.category);
    expect(cats).toContain('create');
    expect(cats).toContain('status-change');
    expect(cats).toContain('reject');
    expect(cats).toContain('no-action');

    const cancel = events.find((e) => e.decision_type === 'status:In Review→Canceled');
    expect(cancel).toBeDefined();
    expect(cancel!.is_ceo_decision).toBe(true);
    expect(cancel!.tags).toContain('governance-failure:RYA-640');
    expect(cancel!.tags).toContain('proactive');

    const noop = events.find((e) => e.category === 'no-action');
    expect(noop).toBeDefined();
    expect(noop!.negative_example).toBe(true);
    expect(noop!.tags).toContain('to-decide');
  });

  it('reconstructs prior state via reverse history walk', () => {
    const events = extractEventsFromIssues(fixture(), {
      sinceTs: '2026-03-01T00:00:00.000Z',
      asOf: new Date('2026-05-03T18:00:00.000Z'),
    });
    const cancel = events.find((e) => e.decision_type === 'status:In Review→Canceled')!;
    expect(cancel.context_at_decision.state).toBe('In Review');
  });

  it('audit summary counts categories', () => {
    const events = extractEventsFromIssues(fixture(), {
      sinceTs: '2026-03-01T00:00:00.000Z',
      asOf: new Date('2026-05-03T18:00:00.000Z'),
    });
    const a = computeAudit(events);
    expect(a.total).toBeGreaterThan(0);
    expect(a.byCategory['no-action']).toBe(1);
    expect(a.byCategory['create']).toBe(1);
    expect(a.byCategory['status-change']).toBe(1);
    expect(a.byCategory['reject']).toBe(1);
    expect(a.uniqueIssues).toBe(3);
  });
});
