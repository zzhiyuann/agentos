import { describe, it, expect, beforeEach, vi } from 'vitest';

// RYA-1184: GLOBAL_MAX_SESSIONS is the last-line-of-defense account-wide cap.
// Every spawn path funnels through agentStartCommand → canStartNewSession(),
// so this default is what actually prevents a dispatch wave from exhausting
// the shared Claude session limit (incident 2026-06-10: 7 sessions → 7h freeze
// on an interactive billing dialog).

vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn((): any[] => []),
  getIdleAttempts: vi.fn((): any[] => []),
  getHibernatedAttempts: vi.fn((): any[] => []),
  updateAttemptStatus: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../core/tmux.js', () => ({
  suspendSession: vi.fn(),
  resumeSessionProcess: vi.fn(),
  sessionExists: vi.fn(() => true),
  killSession: vi.fn(),
}));
vi.mock('../core/persona.js', () => ({
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc' })),
  listAgents: vi.fn(() => ['cto', 'lead-engineer']),
}));
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp' }),
  getIssueStateDir: (key: string) => `/tmp/${key}`,
}));

import { getActiveAttempts } from '../core/db.js';

function runningAttempt(role: string, issueKey: string) {
  return {
    id: `attempt-${role}-${issueKey}`,
    issue_key: issueKey,
    agent_type: role,
    tmux_session: `aos-${role}-${issueKey}`,
    status: 'running',
    created_at: '2026-06-10T00:00:00',
    updated_at: '2026-06-10T00:00:00',
  };
}

describe('GLOBAL_MAX_SESSIONS (RYA-1184)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(getActiveAttempts).mockReturnValue([]);
  });

  it('defaults to 3 when AOS_MAX_SESSIONS is unset', async () => {
    vi.stubEnv('AOS_MAX_SESSIONS', '');
    delete process.env.AOS_MAX_SESSIONS;
    const { GLOBAL_MAX_SESSIONS } = await import('./concurrency.js');
    expect(GLOBAL_MAX_SESSIONS).toBe(3);
    vi.unstubAllEnvs();
  });

  it('respects AOS_MAX_SESSIONS override', async () => {
    vi.stubEnv('AOS_MAX_SESSIONS', '5');
    const { GLOBAL_MAX_SESSIONS } = await import('./concurrency.js');
    expect(GLOBAL_MAX_SESSIONS).toBe(5);
    vi.unstubAllEnvs();
  });

  it('falls back to 3 on a malformed AOS_MAX_SESSIONS (fail closed, not NaN)', async () => {
    vi.stubEnv('AOS_MAX_SESSIONS', 'unlimited');
    const { GLOBAL_MAX_SESSIONS } = await import('./concurrency.js');
    expect(GLOBAL_MAX_SESSIONS).toBe(3);
    vi.unstubAllEnvs();
  });

  it('falls back to 3 on a non-positive AOS_MAX_SESSIONS', async () => {
    vi.stubEnv('AOS_MAX_SESSIONS', '0');
    const { GLOBAL_MAX_SESSIONS } = await import('./concurrency.js');
    expect(GLOBAL_MAX_SESSIONS).toBe(3);
    vi.unstubAllEnvs();
  });

  it('canStartNewSession blocks at the cap — a 7-session wave cannot all start', async () => {
    vi.stubEnv('AOS_MAX_SESSIONS', '');
    delete process.env.AOS_MAX_SESSIONS;
    const { canStartNewSession } = await import('./concurrency.js');

    const roles = ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead', 'cto', 'cpo'];
    let allowed = 0;
    for (let i = 0; i < 7; i++) {
      vi.mocked(getActiveAttempts).mockReturnValue(
        roles.slice(0, i).map((r, n) => runningAttempt(r, `RYA-${n}`)) as any
      );
      if (canStartNewSession().allowed) allowed++;
    }
    expect(allowed).toBe(3);
    vi.unstubAllEnvs();
  });

  it('canStartNewSession allows below the cap', async () => {
    vi.stubEnv('AOS_MAX_SESSIONS', '');
    delete process.env.AOS_MAX_SESSIONS;
    const { canStartNewSession } = await import('./concurrency.js');
    vi.mocked(getActiveAttempts).mockReturnValue([
      runningAttempt('cto', 'RYA-1'),
      runningAttempt('coo', 'RYA-2'),
    ] as any);
    expect(canStartNewSession().allowed).toBe(true);
  });
});
