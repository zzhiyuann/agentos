/**
 * Tests for Claude Code auth pre-flight check (RYA-591).
 *
 * Covers: happy path, expired token with working refresh, expired token with
 * failing refresh, malformed keychain, missing credential, locked keychain,
 * consecutive-failure tracking and N=2 escalation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  checkClaudeAuth,
  loadFailureState,
  recordAuthFailure,
  recordAuthSuccess,
  CLAUDE_AUTH_FAILURE_THRESHOLD,
  type ClaudeAuthDeps,
} from './claude-auth.js';
import { alertClaudeAuthFailure, type AlertSinks } from './claude-auth-alert.js';

// Silence config.ts env var requirements during module load
vi.mock('./config.js', async () => {
  const os = await import('os');
  return {
    STATE_DIR: join(os.tmpdir(), 'claude-auth-test-state'),
    getConfig: () => ({ stateDir: join(os.tmpdir(), 'claude-auth-test-state') }),
    getIssueStateDir: (key: string) => join(os.tmpdir(), 'claude-auth-test-state', 'work', key),
    resolveWorkspace: (key: string) => join(os.tmpdir(), 'claude-auth-test-state', 'ws', key),
    resolveStatePath: (_k: string, ws: string, f: string) => join(ws, f),
  };
});

function makeDeps(overrides: Partial<ClaudeAuthDeps> = {}): ClaudeAuthDeps {
  const stateDir = mkdtempSync(join(tmpdir(), 'claude-auth-test-'));
  return {
    readKeychain: () => null,
    writeKeychain: () => true,
    fetch: vi.fn() as unknown as typeof fetch,
    now: () => 1_700_000_000_000,
    stateDir,
    ...overrides,
  };
}

function validCredential(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-test',
      refreshToken: 'sk-ant-ort-test',
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  });
}

describe('checkClaudeAuth — keychain states', () => {
  it('healthy: access token valid for more than 5 minutes', async () => {
    const deps = makeDeps({
      readKeychain: () => validCredential(1_700_000_000_000 + 60 * 60 * 1000), // +1h
    });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(true);
    expect(r.source).toBe('keychain-valid');
  });

  it('unhealthy: keychain returns null (locked or credential missing)', async () => {
    const deps = makeDeps({ readKeychain: () => null });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('keychain-locked');
    expect(r.reason).toMatch(/not found in keychain/);
  });

  it('unhealthy: credential is malformed JSON', async () => {
    const deps = makeDeps({ readKeychain: () => 'not-json' });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('keychain-malformed');
  });

  it('unhealthy: credential parses but claudeAiOauth is missing', async () => {
    const deps = makeDeps({ readKeychain: () => JSON.stringify({ other: true }) });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('keychain-malformed');
  });

  it('unhealthy: accessToken present but expiresAt missing', async () => {
    const deps = makeDeps({
      readKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }),
    });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('keychain-missing');
  });

  it('unhealthy: token expired and no refreshToken', async () => {
    const now = 1_700_000_000_000;
    const cred = JSON.stringify({
      claudeAiOauth: { accessToken: 'x', expiresAt: now - 1000 },
    });
    const deps = makeDeps({ readKeychain: () => cred, now: () => now });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('keychain-missing');
    expect(r.reason).toMatch(/no refresh token/);
  });
});

describe('checkClaudeAuth — refresh flow', () => {
  it('expired token + working refresh → healthy, keychain updated', async () => {
    const now = 1_700_000_000_000;
    let keychainState = validCredential(now - 1000);
    const writeKeychain = vi.fn((_s: string, payload: string) => {
      keychainState = payload;
      return true;
    });
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: 'sk-ant-oat-new',
        refresh_token: 'sk-ant-ort-new',
        expires_in: 28800,
      }),
    })) as unknown as typeof fetch;

    const deps = makeDeps({
      readKeychain: () => keychainState,
      writeKeychain,
      fetch: fakeFetch,
      now: () => now,
    });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(true);
    expect(r.source).toBe('keychain-refreshed');
    expect(writeKeychain).toHaveBeenCalledOnce();
    const updated = JSON.parse(keychainState);
    expect(updated.claudeAiOauth.accessToken).toBe('sk-ant-oat-new');
    expect(updated.claudeAiOauth.refreshToken).toBe('sk-ant-ort-new');
  });

  it('expired token + failing refresh (HTTP 400) → unhealthy', async () => {
    const now = 1_700_000_000_000;
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"refresh_token expired"}}',
    })) as unknown as typeof fetch;
    const deps = makeDeps({
      readKeychain: () => validCredential(now - 1000),
      fetch: fakeFetch,
      now: () => now,
    });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('refresh-failed');
    expect(r.reason).toMatch(/refresh failed/);
  });

  it('refresh network error → unhealthy with thrown-error detail', async () => {
    const now = 1_700_000_000_000;
    const fakeFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const deps = makeDeps({
      readKeychain: () => validCredential(now - 1000),
      fetch: fakeFetch,
      now: () => now,
    });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('refresh-failed');
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });

  it('refresh succeeds but keychain write fails → unhealthy', async () => {
    const now = 1_700_000_000_000;
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 28800 }),
    })) as unknown as typeof fetch;
    const deps = makeDeps({
      readKeychain: () => validCredential(now - 1000),
      writeKeychain: () => false, // keychain locked
      fetch: fakeFetch,
      now: () => now,
    });
    const r = await checkClaudeAuth(deps);
    expect(r.healthy).toBe(false);
    expect(r.source).toBe('refresh-failed');
    expect(r.reason).toMatch(/could not be written back/);
  });
});

describe('failure state tracking', () => {
  let deps: ClaudeAuthDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('consecutive failures accumulate', () => {
    const s1 = recordAuthFailure('reason 1', deps);
    expect(s1.consecutiveFailures).toBe(1);
    const s2 = recordAuthFailure('reason 2', deps);
    expect(s2.consecutiveFailures).toBe(2);
    const s3 = recordAuthFailure('reason 3', deps);
    expect(s3.consecutiveFailures).toBe(3);
    expect(loadFailureState(deps).lastReason).toBe('reason 3');
  });

  it('success resets consecutive count', () => {
    recordAuthFailure('x', deps);
    recordAuthFailure('y', deps);
    expect(loadFailureState(deps).consecutiveFailures).toBe(2);
    recordAuthSuccess(deps);
    const after = loadFailureState(deps);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastFailureAt).toBeNull();
    expect(after.lastHealthyAt).toBeGreaterThan(0);
  });

  it('threshold is 2 — the exact N=2 escalation point from the issue', () => {
    expect(CLAUDE_AUTH_FAILURE_THRESHOLD).toBe(2);
  });
});

describe('alertClaudeAuthFailure — P0 alert + BLOCKED.md', () => {
  let sinks: AlertSinks;
  let telegramCalls: string[];
  let discordCalls: string[];
  let blockedCalls: Array<{ path: string; content: string }>;

  beforeEach(() => {
    telegramCalls = [];
    discordCalls = [];
    blockedCalls = [];
    sinks = {
      telegram: async (m) => { telegramCalls.push(m); return true; },
      discord: async (m) => { discordCalls.push(m); return true; },
      writeBlocked: (p, c) => { blockedCalls.push({ path: p, content: c }); },
    };
  });

  it('first failure: alerts both channels, writes BLOCKED.md, NOT escalated', async () => {
    const r = await alertClaudeAuthFailure({
      issueKey: 'RYA-999',
      role: 'coo',
      reason: 'token expired',
      consecutiveFailures: 1,
      blockedMdPath: '/tmp/test-blocked/RYA-999/BLOCKED.md',
    }, sinks);

    expect(r.telegramOk).toBe(true);
    expect(r.discordOk).toBe(true);
    expect(r.blockedWritten).toBe(true);
    expect(r.escalated).toBe(false);
    expect(telegramCalls[0]).toMatch(/P0: Claude Code auth failed/);
    expect(telegramCalls[0]).toMatch(/RYA-999/);
    expect(telegramCalls[0]).toMatch(/token expired/);
    expect(blockedCalls[0].content).toMatch(/token expired/);
    expect(blockedCalls[0].content).toMatch(/refresh Claude Code auth/i);
  });

  it('N=2 failures: alert is escalated with louder prefix', async () => {
    const r = await alertClaudeAuthFailure({
      issueKey: 'RYA-999',
      role: 'coo',
      reason: 'token expired',
      consecutiveFailures: CLAUDE_AUTH_FAILURE_THRESHOLD,
    }, sinks);

    expect(r.escalated).toBe(true);
    expect(telegramCalls[0]).toMatch(/P0 CLAUDE CODE AUTH OUTAGE/);
    expect(telegramCalls[0]).toMatch(/2 consecutive failures/);
    // Mentions the prior incident so humans connect the dots
    expect(telegramCalls[0]).toMatch(/7-day outage/);
  });

  it('simulated auth failure triggers BLOCKED.md, telegram, discord — the acceptance criterion', async () => {
    // This is the "simulated auth failure test triggers alert" acceptance row.
    // Wire an unhealthy checkClaudeAuth result into the alert path and verify
    // all three effects fire.
    const fakeFetch = vi.fn(async () => ({
      ok: false, status: 401, text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    const deps = makeDeps({
      readKeychain: () => validCredential(1_700_000_000_000 - 1000), // expired
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });

    const result = await checkClaudeAuth(deps);
    expect(result.healthy).toBe(false);

    const state = recordAuthFailure(result.reason, deps);
    const alertResult = await alertClaudeAuthFailure({
      issueKey: 'RYA-591-SIM',
      role: 'coo',
      reason: result.reason,
      consecutiveFailures: state.consecutiveFailures,
      blockedMdPath: '/tmp/test-blocked/RYA-591-SIM/BLOCKED.md',
    }, sinks);

    expect(alertResult.telegramOk).toBe(true);
    expect(alertResult.discordOk).toBe(true);
    expect(alertResult.blockedWritten).toBe(true);
    expect(telegramCalls[0]).toMatch(/RYA-591-SIM/);
    expect(discordCalls[0]).toMatch(/RYA-591-SIM/);
    expect(blockedCalls[0].path).toMatch(/RYA-591-SIM\/BLOCKED\.md$/);
  });

  it('alert sink failure does not throw — caller should not lose control flow', async () => {
    const flakySinks: AlertSinks = {
      telegram: async () => { throw new Error('telegram down'); },
      discord: async () => { throw new Error('discord down'); },
      writeBlocked: () => { throw new Error('fs error'); },
    };
    const r = await alertClaudeAuthFailure({
      issueKey: 'RYA-1', role: 'coo', reason: 'x', consecutiveFailures: 1,
      blockedMdPath: '/tmp/nope/BLOCKED.md',
    }, flakySinks);
    expect(r.telegramOk).toBe(false);
    expect(r.discordOk).toBe(false);
    expect(r.blockedWritten).toBe(false);
  });
});
