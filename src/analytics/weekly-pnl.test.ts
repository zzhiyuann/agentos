import { describe, it, expect } from 'vitest';
import {
  formatDigest,
  snapshotFromData,
  type DigestSnapshot,
} from './weekly-pnl.js';
import type { DigestData } from './pnl-aggregator.js';

function bucket(task = 0, meta = 0, taskCost = 0, metaCost = 0) {
  return { taskTokens: task, metaTokens: meta, taskCostUsd: taskCost, metaCostUsd: metaCost, messageCount: 1 };
}

describe('formatDigest', () => {
  it('renders empty week message when no activity', () => {
    const data: DigestData = {
      sinceMs: Date.parse('2026-04-29T00:00:00Z'),
      untilMs: Date.parse('2026-05-06T00:00:00Z'),
      totals: bucket(),
      perRole: new Map(),
      perIssue: new Map(),
      sessions: [],
      sessionCount: 0,
      unattributedSessions: 0,
    };
    const out = formatDigest(data);
    expect(out).toContain('No agent activity');
  });

  it('includes meta-tax headline + range', () => {
    const data: DigestData = {
      sinceMs: Date.parse('2026-04-29T00:00:00Z'),
      untilMs: Date.parse('2026-05-06T00:00:00Z'),
      totals: bucket(7000, 3000, 7, 3),
      perRole: new Map([
        ['lead-engineer', bucket(5000, 2000, 5, 2)],
        ['cto', bucket(2000, 1000, 2, 1)],
      ]),
      perIssue: new Map([
        ['RYA-100', { ...bucket(5000, 2000, 5, 2), role: 'lead-engineer' }],
        ['RYA-200', { ...bucket(2000, 1000, 2, 1), role: 'cto' }],
      ]),
      sessions: [],
      sessionCount: 4,
      unattributedSessions: 1,
    };

    const out = formatDigest(data);
    expect(out).toContain('Meta-tax this week: 30.0%');
    expect(out).toContain('2026-04-29');
    expect(out).toContain('2026-05-06');
    expect(out).toContain('lead-engineer');
    expect(out).toContain('cto');
    expect(out).toContain('RYA-100');
    expect(out).toContain('Top 3 most expensive');
    expect(out).toContain('4 sessions');
    expect(out).toContain('1 unattributed');
    expect(out).toContain('No prior snapshot');
  });

  it('renders week-over-week delta when previous snapshot present', () => {
    const data: DigestData = {
      sinceMs: Date.parse('2026-05-06T00:00:00Z'),
      untilMs: Date.parse('2026-05-13T00:00:00Z'),
      totals: bucket(8000, 2000, 8, 2),
      perRole: new Map([['cpo', bucket(8000, 2000, 8, 2)]]),
      perIssue: new Map(),
      sessions: [],
      sessionCount: 1,
      unattributedSessions: 0,
    };
    const previous: DigestSnapshot = {
      generatedAt: '2026-05-05T00:00:00Z',
      windowStartIso: '2026-04-29T00:00:00Z',
      windowEndIso: '2026-05-05T00:00:00Z',
      totalTokens: 10000,
      taskTokens: 7000,
      metaTokens: 3000,
      totalCostUsd: 10,
      metaTaxPct: 30,
      perRole: {},
    };

    const out = formatDigest(data, { previous });
    // 20% this week vs 30% last week → -10pp
    expect(out).toContain('Week-over-week');
    expect(out).toContain('-10.0pp');
  });

  it('snapshotFromData computes meta-tax %', () => {
    const data: DigestData = {
      sinceMs: 0,
      untilMs: 1000,
      totals: bucket(3000, 1000, 3, 1),
      perRole: new Map(),
      perIssue: new Map(),
      sessions: [],
      sessionCount: 1,
      unattributedSessions: 0,
    };
    const snap = snapshotFromData(data);
    expect(snap.metaTaxPct).toBe(25);
    expect(snap.totalTokens).toBe(4000);
    expect(snap.totalCostUsd).toBe(4);
  });
});
