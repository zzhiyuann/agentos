/**
 * Linear client management: API clients, auth, GraphQL helper, workflow states.
 * Split from linear.ts — see RYA-117 Finding 6, RYA-142.
 */

import { LinearClient } from '@linear/sdk';
import { getLinearApiKey } from './keychain.js';
import { getOAuthToken, refreshToken } from './oauth.js';
import { getConfig } from './config.js';

let _readClient: LinearClient | null = null;
let _agentClient: LinearClient | null = null;
let _stateCache: Map<string, string> | null = null;

/** Client for read operations (personal API key) */
export function getReadClient(): LinearClient {
  if (!_readClient) {
    _readClient = new LinearClient({ apiKey: getLinearApiKey() });
  }
  return _readClient;
}

/** Client for agent-identity writes (OAuth token) — falls back to read client */
export function getAgentClient(): LinearClient {
  if (!_agentClient) {
    const oauthToken = getOAuthToken();
    if (oauthToken) {
      _agentClient = new LinearClient({ accessToken: oauthToken });
    } else {
      console.warn('[linear] No OAuth token — agent client falling back to personal API key');
      _agentClient = getReadClient();
    }
  }
  return _agentClient;
}

/** Re-create agent client with fresh token (call after 401 errors) */
export async function refreshAgentClient(): Promise<LinearClient> {
  const newToken = await refreshToken();
  if (newToken) {
    _agentClient = new LinearClient({ accessToken: newToken });
    console.log('[linear] OAuth token refreshed successfully');
  } else {
    console.error('[linear] OAuth token refresh FAILED — falling back to personal API key');
    _agentClient = getReadClient();
  }
  return _agentClient;
}

/** Check if we have OAuth-level agent access */
export function hasAgentAccess(): boolean {
  const token = getOAuthToken();
  return token !== null && token !== 'undefined';
}

export function normalizeBearerToken(token?: string | null): string | null {
  if (!token || token === 'undefined') return null;
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

/** Get a raw OAuth Bearer token for agent-session GraphQL calls */
export function getRequiredAgentToken(overrideToken?: string): string | null {
  return normalizeBearerToken(overrideToken ?? getOAuthToken());
}

// --- Raw GraphQL helper ---

export async function graphql(token: string, query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
      },
      body: JSON.stringify({ query, variables }),
    });

    // Rate limited — back off and retry
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      console.warn(`[linear] Rate limited, retrying in ${retryAfter}s (attempt ${attempt + 1}/${maxRetries + 1})`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new Error(`Linear API rate limited after ${maxRetries + 1} attempts`);
    }

    // Auth error — try refreshing token once
    if (res.status === 401 && attempt === 0) {
      console.warn('[linear] 401 Unauthorized — attempting token refresh');
      try {
        await refreshAgentClient();
      } catch { /* refresh failed, will throw below */ }
    }

    const json = await res.json() as { data?: Record<string, unknown>; errors?: { message: string; extensions?: { code?: string } }[] };
    if (json.errors?.length) {
      const err = json.errors[0];
      // Rate limit can also come as a GraphQL error
      if (err.extensions?.code === 'RATELIMITED' && attempt < maxRetries) {
        console.warn(`[linear] GraphQL rate limited, retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw new Error(err.message);
    }
    return json.data!;
  }
  throw new Error('Linear API: max retries exceeded');
}

// --- Workflow States ---

export async function getWorkflowStateId(stateName: string): Promise<string> {
  if (!_stateCache) {
    const config = getConfig();
    const client = getReadClient();
    const team = await client.team(config.linearTeamId);
    const states = await team.states();
    _stateCache = new Map();
    for (const state of states.nodes) {
      _stateCache.set(state.name, state.id);
    }
  }
  const id = _stateCache.get(stateName);
  if (!id) throw new Error(`Workflow state "${stateName}" not found`);
  return id;
}
