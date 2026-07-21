import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getActiveAttempts: vi.fn(),
  getAllAttempts: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  getQueueItems: vi.fn(),
}));

const concurrencyMocks = vi.hoisted(() => ({
  getSystemConcurrencyStatus: vi.fn(),
  getRoleRunningCount: vi.fn(),
  getMaxParallel: vi.fn(),
}));

vi.mock('../core/db.js', () => dbMocks);
vi.mock('../core/queue.js', () => queueMocks);
vi.mock('./concurrency.js', () => concurrencyMocks);

import { buildRoleControlSnapshot, formatRoleControlText } from './role-control.js';

describe('role-control snapshot', () => {
  beforeEach(() => {
    dbMocks.getActiveAttempts.mockReset();
    dbMocks.getAllAttempts.mockReset();
    queueMocks.getQueueItems.mockReset();
    concurrencyMocks.getSystemConcurrencyStatus.mockReset();
    concurrencyMocks.getRoleRunningCount.mockReset();
    concurrencyMocks.getMaxParallel.mockReset();

    dbMocks.getActiveAttempts.mockReturnValue([
      { agent_type: 'cto', status: 'running', issue_key: 'RYA-1' },
      { agent_type: 'cpo', status: 'running', issue_key: 'RYA-2' },
    ]);
    dbMocks.getAllAttempts.mockReturnValue([
      { agent_type: 'cto', status: 'running', issue_key: 'RYA-1' },
      { agent_type: 'cpo', status: 'running', issue_key: 'RYA-2' },
      { agent_type: 'cto', status: 'blocked', issue_key: 'RYA-3' },
      { agent_type: 'lead-engineer', status: 'hibernated', issue_key: 'RYA-4' },
      { agent_type: 'lead-engineer', status: 'idle', issue_key: 'RYA-5' },
    ]);
    queueMocks.getQueueItems.mockReturnValue([
      { issue_key: 'RYA-6', agent_role: 'cto' },
      { issue_key: 'RYA-7', agent_role: 'lead-engineer' },
    ]);
    concurrencyMocks.getSystemConcurrencyStatus.mockReturnValue({
      running: 2,
      maxSessions: 20,
      atCapacity: false,
      roleCapacity: {
        cto: { running: 1, max: 2 },
        cpo: { running: 1, max: 1 },
        'lead-engineer': { running: 0, max: 3 },
      },
    });
    concurrencyMocks.getRoleRunningCount.mockImplementation((role: string) => ({
      cto: 1,
      cpo: 1,
      'lead-engineer': 0,
    }[role] ?? 0));
    concurrencyMocks.getMaxParallel.mockImplementation((role: string) => ({
      cto: 2,
      cpo: 1,
      'lead-engineer': 3,
    }[role] ?? 1));
  });

  it('builds role-centric snapshot with blocked and queued issues', () => {
    const snapshot = buildRoleControlSnapshot();
    expect(snapshot.summary.running).toBe(2);
    expect(snapshot.summary.queued).toBe(2);
    expect(snapshot.summary.blocked).toBe(1);

    const cto = snapshot.roles.find(r => r.role === 'cto');
    expect(cto).toMatchObject({
      running: 1,
      max: 2,
      queued: 1,
      blocked: 1,
      status: 'blocked',
    });
    expect(cto?.busyIssueKeys).toEqual(['RYA-1']);
    expect(cto?.queuedIssueKeys).toEqual(['RYA-6']);
    expect(cto?.blockedIssueKeys).toEqual(['RYA-3']);

    const cpo = snapshot.roles.find(r => r.role === 'cpo');
    expect(cpo?.status).toBe('saturated');

    const lead = snapshot.roles.find(r => r.role === 'lead-engineer');
    expect(lead?.hibernated).toBe(1);
    expect(lead?.queuedIssueKeys).toEqual(['RYA-7']);
  });

  it('formats a readable summary', () => {
    const text = formatRoleControlText(buildRoleControlSnapshot());
    expect(text).toContain('Company load: 2/20 running · 2 queued · 1 blocked');
    expect(text).toContain('cto 1/2 · 1 queued · 1 blocked');
    expect(text).toContain('busy: RYA-1');
    expect(text).toContain('blocked: RYA-3');
  });
});
