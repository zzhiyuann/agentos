import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// RYA-1184 regression tests: the dispatch concurrency cap.
//
// Incident 2026-06-10 — 7 agent sessions spawned in ~10 min exhausted the
// shared Claude session limit; every session froze on an interactive billing
// dialog for 7h. Root cause: canSpawnAgent counted sessions where
// agent_type === model type ('cc'), but attempts store the ROLE
// ('lead-engineer'), so the count was always 0 and the cap never tripped.

const tmpStateDir = mkdtempSync(join(tmpdir(), 'aos-router-test-'));

vi.mock('./config.js', () => ({
  getConfig: () => ({ stateDir: tmpStateDir, imacHost: '10.0.0.1' }),
}));

const mockGetActiveSessions = vi.fn((): any[] => []);
vi.mock('./db.js', () => ({
  getActiveSessions: (...args: unknown[]) => mockGetActiveSessions(...args as []),
}));

const ROLES = ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead'];
vi.mock('./persona.js', () => ({
  agentExists: vi.fn((role: string) => ROLES.includes(role)),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc' })),
}));

import { canSpawnAgent, getDispatchCap } from './router.js';

/** Build a running attempt row the way agentStartCommand writes it: agent_type = ROLE. */
function runningAttempt(role: string, issueKey: string, status = 'running') {
  return {
    id: `attempt-${role}-${issueKey}`,
    issue_key: issueKey,
    agent_type: role,
    tmux_session: `aos-${role}-${issueKey}`,
    status,
  };
}

describe('canSpawnAgent (RYA-1184 dispatch cap)', () => {
  beforeEach(() => {
    mockGetActiveSessions.mockReturnValue([]);
    delete process.env.AOS_DISPATCH_CONCURRENCY;
    // Registry file with the pre-incident live value (cc.maxConcurrent: 20) —
    // the ceiling must clamp it, not trust it.
    writeFileSync(join(tmpStateDir, 'agents.json'), JSON.stringify({
      cc: { label: 'agent:cc', command: 'claude', host: 'x', capabilities: ['code'], maxConcurrent: 20 },
      codex: { label: 'agent:codex', command: 'codex', host: 'x', capabilities: ['code'], maxConcurrent: 4 },
      gemini: { label: 'agent:gemini', command: 'gemini', host: 'x', capabilities: ['code'], maxConcurrent: 2 },
    }, null, 2));
  });

  afterEach(() => {
    delete process.env.AOS_DISPATCH_CONCURRENCY;
  });

  it('allows spawn when nothing is running', () => {
    expect(canSpawnAgent('cc')).toEqual({ allowed: true });
  });

  it('counts ROLE-typed sessions against the model-type cap (the incident bug)', () => {
    // Pre-fix: these three rows counted as ZERO 'cc' sessions because
    // agent_type holds the role, so the gate never tripped.
    mockGetActiveSessions.mockReturnValue([
      runningAttempt('lead-engineer', 'RYA-1'),
      runningAttempt('cto', 'RYA-2'),
      runningAttempt('coo', 'RYA-3'),
    ]);
    const result = canSpawnAgent('cc');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('3/3');
  });

  it('incident regression: a 7-session wave is blocked at the cap, not at 7', () => {
    const wave = [1, 2, 3, 4, 5, 6, 7].map(n => runningAttempt(ROLES[n % ROLES.length], `RYA-${n}`));
    // Simulate the dispatch loop: how many of the 7 would have been allowed?
    let allowedSpawns = 0;
    for (let i = 0; i < wave.length; i++) {
      mockGetActiveSessions.mockReturnValue(wave.slice(0, i));
      if (canSpawnAgent('cc').allowed) allowedSpawns++;
    }
    expect(allowedSpawns).toBe(3);
  });

  it('clamps the registry maxConcurrent (live agents.json says 20)', () => {
    expect(getDispatchCap('cc')).toBe(3);
  });

  it('registry values BELOW the ceiling still win', () => {
    expect(getDispatchCap('gemini')).toBe(2);
  });

  it('AOS_DISPATCH_CONCURRENCY raises the ceiling', () => {
    process.env.AOS_DISPATCH_CONCURRENCY = '6';
    expect(getDispatchCap('cc')).toBe(6);
    mockGetActiveSessions.mockReturnValue([
      runningAttempt('lead-engineer', 'RYA-1'),
      runningAttempt('cto', 'RYA-2'),
      runningAttempt('coo', 'RYA-3'),
      runningAttempt('cpo', 'RYA-4'),
    ]);
    expect(canSpawnAgent('cc').allowed).toBe(true);
  });

  it('ignores invalid AOS_DISPATCH_CONCURRENCY values', () => {
    process.env.AOS_DISPATCH_CONCURRENCY = 'lots';
    expect(getDispatchCap('cc')).toBe(3);
    process.env.AOS_DISPATCH_CONCURRENCY = '0';
    expect(getDispatchCap('cc')).toBe(3);
  });

  it('dedupes attempt rows sharing one tmux session', () => {
    const a = runningAttempt('lead-engineer', 'RYA-1');
    const b = { ...runningAttempt('lead-engineer', 'RYA-1'), id: 'attempt-2' };
    mockGetActiveSessions.mockReturnValue([a, b, runningAttempt('cto', 'RYA-2')]);
    expect(canSpawnAgent('cc').allowed).toBe(true); // 2 unique sessions < 3
  });

  it('excludes hibernated/idle sessions — SIGSTOPped agents do not hold a slot', () => {
    mockGetActiveSessions.mockReturnValue([
      runningAttempt('lead-engineer', 'RYA-1', 'hibernated'),
      runningAttempt('cto', 'RYA-2', 'idle'),
      runningAttempt('coo', 'RYA-3'),
    ]);
    expect(canSpawnAgent('cc').allowed).toBe(true); // only 1 running
  });

  it('counts legacy rows that stored the model type directly', () => {
    mockGetActiveSessions.mockReturnValue([
      runningAttempt('cc', 'RYA-1'),
      runningAttempt('lead-engineer', 'RYA-2'),
      runningAttempt('cto', 'RYA-3'),
    ]);
    expect(canSpawnAgent('cc').allowed).toBe(false);
  });

  it('does not count cc sessions against the codex cap', () => {
    mockGetActiveSessions.mockReturnValue([
      runningAttempt('lead-engineer', 'RYA-1'),
      runningAttempt('cto', 'RYA-2'),
      runningAttempt('coo', 'RYA-3'),
    ]);
    expect(canSpawnAgent('codex').allowed).toBe(true);
  });

  it('throws for unknown agent type', () => {
    expect(() => canSpawnAgent('nonexistent')).toThrow('Unknown agent type');
  });
});

// Cleanup the tmp state dir after the suite (force:true suppresses ENOENT).
process.on('exit', () => rmSync(tmpStateDir, { recursive: true, force: true }));
