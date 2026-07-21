/**
 * Regression tests for the OAuth mint single-flight + TTL cache (RYA-599).
 *
 * Background: Linear's client_credentials grant invalidates prior tokens for the
 * same clientId. If two code paths call /oauth/token with the same clientId,
 * they ping-pong invalidate each other. The mint layer must coalesce concurrent
 * calls and reuse a freshly-minted token across callers for a short window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getConfig: () => ({
    stateDir: '/tmp/aos-oauth-test',
    linearTeamId: 'team',
    linearTeamKey: 'TEAM',
    imacHost: 'host',
    imacUser: 'user',
    workspaceBase: '~',
    dbPath: '/tmp/aos-oauth-test/state.db',
    pollIntervalMs: 30000,
    tunnelUrl: '',
  }),
  STATE_DIR: '/tmp/aos-oauth-test',
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  mintTokenForClient,
  _resetOAuthCache,
  MINT_CACHE_TTL_MS,
} from './oauth.js';

function tokenResponse(token: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token }),
    text: async () => JSON.stringify({ access_token: token }),
  };
}

function errorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  };
}

describe('mintTokenForClient — single-flight + TTL cache (RYA-599)', () => {
  beforeEach(() => {
    _resetOAuthCache();
    mockFetch.mockReset();
  });

  afterEach(() => {
    _resetOAuthCache();
  });

  it('coalesces concurrent calls for the same clientId into ONE HTTP mint', async () => {
    // Simulate Linear issuing a different token on each call — mirrors the
    // ping-pong invalidation pattern. If single-flight works, only one of
    // these tokens ever gets emitted.
    let mintCount = 0;
    mockFetch.mockImplementation(async () => {
      mintCount += 1;
      return tokenResponse(`minted-token-#${mintCount}`);
    });

    const [a, b, c] = await Promise.all([
      mintTokenForClient('clientA', 'secret'),
      mintTokenForClient('clientA', 'secret'),
      mintTokenForClient('clientA', 'secret'),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mintCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('minted-token-#1');
  });

  it('caches the minted token for the TTL — second call within TTL does NOT hit the endpoint', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('cached-token'));

    const first = await mintTokenForClient('clientA', 'secret');
    const second = await mintTokenForClient('clientA', 'secret');

    expect(first).toBe('cached-token');
    expect(second).toBe('cached-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT coalesce across different clientIds', async () => {
    mockFetch.mockImplementation(async (_url: string, opts: { body: URLSearchParams | string }) => {
      const body = opts.body instanceof URLSearchParams ? opts.body : new URLSearchParams(opts.body as string);
      return tokenResponse(`token-for-${body.get('client_id')}`);
    });

    const [tokA, tokB] = await Promise.all([
      mintTokenForClient('clientA', 'secretA'),
      mintTokenForClient('clientB', 'secretB'),
    ]);

    expect(tokA).toBe('token-for-clientA');
    expect(tokB).toBe('token-for-clientB');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache failed mints — a failure clears the in-flight slot and the next call retries', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500, 'server error'))
      .mockResolvedValueOnce(tokenResponse('recovery-token'));

    await expect(mintTokenForClient('clientA', 'secret')).rejects.toThrow(/Token request failed/);
    const recovered = await mintTokenForClient('clientA', 'secret');

    expect(recovered).toBe('recovery-token');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('re-mints after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(tokenResponse('token-first'))
        .mockResolvedValueOnce(tokenResponse('token-second'));

      const first = await mintTokenForClient('clientA', 'secret');
      expect(first).toBe('token-first');

      // Advance past the cache window
      vi.setSystemTime(Date.now() + MINT_CACHE_TTL_MS + 1000);

      const second = await mintTokenForClient('clientA', 'secret');
      expect(second).toBe('token-second');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('simulates the RYA-599 shared-client scenario — system and agent with same clientId see ONE token', async () => {
    // Before the fix: system.refresh mints tokenX → agent.refresh mints tokenY
    //                tokenX is now dead because tokenY was issued for the same clientId.
    // After the fix: a single mint is shared — both files receive the same valid token.
    let mintCount = 0;
    mockFetch.mockImplementation(async () => {
      mintCount += 1;
      return tokenResponse(`valid-token-v${mintCount}`);
    });

    // Concurrent refresh (as would happen if two async paths kick off)
    const [systemToken, agentToken] = await Promise.all([
      mintTokenForClient('c4f159a11d', 'shared-secret'),
      mintTokenForClient('c4f159a11d', 'shared-secret'),
    ]);

    // Sequential refresh within TTL (as token-health now does)
    const secondSystem = await mintTokenForClient('c4f159a11d', 'shared-secret');

    expect(systemToken).toBe(agentToken);
    expect(systemToken).toBe(secondSystem);
    expect(mintCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
