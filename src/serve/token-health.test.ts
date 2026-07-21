import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../core/persona.js', () => ({
  listAgents: vi.fn(() => ['ceo-office', 'cto', 'lead-engineer']),
  loadAgentConfig: vi.fn((role: string) => ({
    baseModel: 'cc',
    linearClientId: `client-id-${role}`,
    linearClientSecret: `client-secret-${role}`,
  })),
  getAgentLinearToken: vi.fn((role: string) => `token-${role}`),
  getAgentsDir: vi.fn(() => '/tmp/aos-test/agents'),
  sharesIdentityWithSystem: vi.fn(() => false),
}));

vi.mock('../core/oauth.js', () => ({
  getOAuthToken: vi.fn(() => 'global-token'),
  getOAuthConfig: vi.fn(() => ({ clientId: 'client-id-system', clientSecret: 'system-secret' })),
  mintTokenForClient: vi.fn(async (clientId: string) => `new-token-for-${clientId}`),
  saveOAuthToken: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual as object, writeFileSync: vi.fn() };
});

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { validateAndRefreshAllTokens, forceTokenCheck } from './token-health.js';
import { listAgents, getAgentLinearToken, loadAgentConfig } from '../core/persona.js';
import { getOAuthToken, getOAuthConfig, mintTokenForClient, saveOAuthToken } from '../core/oauth.js';
import { writeFileSync } from 'fs';

function mockValidTokenResponse(name: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { viewer: { id: '1', name } } }),
  };
}

function mock401Response() {
  return { ok: false, status: 401, json: async () => ({}) };
}

describe('token-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default behavior of the oauth.js mock between tests
    vi.mocked(getOAuthConfig).mockReturnValue({ clientId: 'client-id-system', clientSecret: 'system-secret' });
    vi.mocked(getOAuthToken).mockReturnValue('global-token');
    vi.mocked(mintTokenForClient).mockImplementation(async (clientId: string) => `new-token-for-${clientId}`);
    vi.mocked(loadAgentConfig).mockImplementation((role: string) => ({
      baseModel: 'cc',
      linearClientId: `client-id-${role}`,
      linearClientSecret: `client-secret-${role}`,
    }));
    vi.mocked(getAgentLinearToken).mockImplementation((role: string) => `token-${role}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips check when interval has not elapsed', async () => {
    // First call — should execute
    mockFetch.mockResolvedValue(mockValidTokenResponse('System'));
    await forceTokenCheck();
    expect(mockFetch).toHaveBeenCalled();

    mockFetch.mockClear();
    // Second call within interval — should skip (no forceTokenCheck)
    await validateAndRefreshAllTokens();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('validates all tokens when they are valid', async () => {
    mockFetch.mockImplementation(async (_url: string, opts: { body: string }) => {
      const body = JSON.parse(opts.body);
      if (body.query?.includes('viewer')) {
        return mockValidTokenResponse('Agent');
      }
      return mock401Response();
    });

    await forceTokenCheck();

    // 1 system + 3 agents = 4 validation calls (all unique clientIds)
    expect(mockFetch).toHaveBeenCalledTimes(4);
    // No refresh needed — mintTokenForClient should NOT be called
    expect(mintTokenForClient).not.toHaveBeenCalled();
  });

  it('refreshes expired agent token via mintTokenForClient', async () => {
    mockFetch.mockImplementation(async (_url: string, opts: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(opts.body);
      if (body.query?.includes('viewer')) {
        const authHeader = opts.headers?.['Authorization'] || '';
        // ceo-office token expired, refreshed token (new-token-for-client-id-ceo-office) succeeds
        if (authHeader.includes('token-ceo-office')) return mock401Response();
        if (authHeader.includes('new-token-for-client-id-ceo-office')) {
          return mockValidTokenResponse('CEO Office (refreshed)');
        }
        return mockValidTokenResponse('Agent');
      }
      return mock401Response();
    });

    await forceTokenCheck();

    // mintTokenForClient called exactly once for ceo-office's clientId
    expect(mintTokenForClient).toHaveBeenCalledWith('client-id-ceo-office', 'client-secret-ceo-office');
    // Written to the agent's token file
    expect(writeFileSync).toHaveBeenCalledWith(
      '/tmp/aos-test/agents/ceo-office/.oauth-token',
      'new-token-for-client-id-ceo-office',
      { mode: 0o600 },
    );
  });

  it('refreshes expired global token via mintTokenForClient', async () => {
    mockFetch.mockImplementation(async (_url: string, opts: { body: string; headers: Record<string, string> }) => {
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
      if (body.query?.includes('viewer')) {
        const authHeader = opts.headers?.['Authorization'] || '';
        if (authHeader.includes('global-token')) return mock401Response();
        if (authHeader.includes('new-token-for-client-id-system')) {
          return mockValidTokenResponse('System (refreshed)');
        }
        return mockValidTokenResponse('Agent');
      }
      return mock401Response();
    });

    await forceTokenCheck();
    expect(mintTokenForClient).toHaveBeenCalledWith('client-id-system', 'system-secret');
    // saveOAuthToken persists to the system token file
    expect(saveOAuthToken).toHaveBeenCalledWith('new-token-for-client-id-system');
  });

  it('handles agent with no OAuth credentials gracefully', async () => {
    vi.mocked(loadAgentConfig).mockImplementation((role: string) => {
      if (role === 'cto') return { baseModel: 'cc' }; // No OAuth credentials
      return {
        baseModel: 'cc',
        linearClientId: `client-id-${role}`,
        linearClientSecret: `client-secret-${role}`,
      };
    });

    mockFetch.mockImplementation(async (_url: string, opts: { body: string; headers: Record<string, string> }) => {
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
      if (body.query?.includes('viewer')) {
        const authHeader = opts.headers?.['Authorization'] || '';
        if (authHeader.includes('token-cto')) return mock401Response();
        return mockValidTokenResponse('Agent');
      }
      return mock401Response();
    });

    // Should not throw even though CTO has no credentials
    await forceTokenCheck();
    // CTO must NOT trigger a mint — no credentials available
    const ctoMintCalls = vi.mocked(mintTokenForClient).mock.calls.filter(
      c => c[0] === 'client-id-cto',
    );
    expect(ctoMintCalls).toHaveLength(0);
    // CTO token file should NOT be written
    const writeCalls = vi.mocked(writeFileSync).mock.calls;
    const ctoWrites = writeCalls.filter(c => String(c[0]).includes('cto'));
    expect(ctoWrites).toHaveLength(0);
  });

  it('handles agent with no token file', async () => {
    vi.mocked(getAgentLinearToken).mockImplementation((role: string) => {
      if (role === 'lead-engineer') return null; // No token file
      return `token-${role}`;
    });

    mockFetch.mockResolvedValue(mockValidTokenResponse('Agent'));

    await forceTokenCheck();
    // lead-engineer has no token but has credentials → mints once.
    // So: 1 system validate + 3 agents (lead-engineer: mint + verify, others: validate)
    // = 1 (system validate) + 1 (cto validate) + 1 (ceo-office validate)
    //   + 1 (lead-engineer verify of minted token) = 4 fetches
    expect(mintTokenForClient).toHaveBeenCalledWith('client-id-lead-engineer', 'client-secret-lead-engineer');
  });

  // --- RYA-599 regression: shared clientId between system and ceo-office ---
  it('RYA-599 regression: system + ceo-office sharing clientId → ONE mint, ONE validation, ONE fan-out', async () => {
    // Both system and ceo-office advertise the same clientId ("shared-client").
    // Pre-fix behavior: each is refreshed independently → two mints → each invalidates the other.
    // Post-fix behavior: grouped by clientId → ONE mint → token written to BOTH files.
    vi.mocked(getOAuthConfig).mockReturnValue({
      clientId: 'shared-client',
      clientSecret: 'shared-secret',
    });
    vi.mocked(loadAgentConfig).mockImplementation((role: string) => {
      if (role === 'ceo-office') {
        return {
          baseModel: 'cc',
          linearClientId: 'shared-client', // SAME as system
          linearClientSecret: 'shared-secret',
        };
      }
      return {
        baseModel: 'cc',
        linearClientId: `client-id-${role}`,
        linearClientSecret: `client-secret-${role}`,
      };
    });
    // ceo-office's getAgentLinearToken also falls back to system token (collision detection).
    vi.mocked(getAgentLinearToken).mockImplementation((role: string) => {
      if (role === 'ceo-office') return 'global-token'; // same as system
      return `token-${role}`;
    });

    // The shared token is invalid; after refresh, the new token validates.
    mockFetch.mockImplementation(async (_url: string, opts: { body: string; headers: Record<string, string> }) => {
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
      if (body.query?.includes('viewer')) {
        const authHeader = opts.headers?.['Authorization'] || '';
        if (authHeader.includes('global-token')) return mock401Response();
        if (authHeader.includes('new-token-for-shared-client')) {
          return mockValidTokenResponse('Shared Identity (refreshed)');
        }
        return mockValidTokenResponse('Agent');
      }
      return mock401Response();
    });

    await forceTokenCheck();

    // CRITICAL: mintTokenForClient called exactly once for the shared clientId.
    const sharedMintCalls = vi.mocked(mintTokenForClient).mock.calls.filter(
      c => c[0] === 'shared-client',
    );
    expect(sharedMintCalls).toHaveLength(1);

    // The fan-out writes the SAME token to ceo-office's file AND the system token file.
    const ceoWrites = vi.mocked(writeFileSync).mock.calls.filter(
      c => String(c[0]).includes('ceo-office'),
    );
    expect(ceoWrites).toHaveLength(1);
    expect(ceoWrites[0][1]).toBe('new-token-for-shared-client');

    // saveOAuthToken called for the system file with the same token.
    expect(saveOAuthToken).toHaveBeenCalledWith('new-token-for-shared-client');

    // No separate mint for a non-existent "client-id-ceo-office" — the old code path.
    const oldStyleCalls = vi.mocked(mintTokenForClient).mock.calls.filter(
      c => c[0] === 'client-id-ceo-office',
    );
    expect(oldStyleCalls).toHaveLength(0);
  });
});
