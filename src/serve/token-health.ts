/**
 * Token Health: proactive validation and refresh of agent OAuth tokens.
 * Runs on a 1-hour interval within the serve monitor loop.
 * Prevents silent agent outages from expired tokens (see RYA-316).
 *
 * RYA-599 fix: de-duplicate refresh by clientId — Linear's client_credentials grant
 * invalidates prior tokens for the same clientId, so two refreshes for the same
 * identity ping-pong. We now group roles by clientId, mint once per clientId, and
 * fan the resulting token out to every token file that represents that identity.
 */

import chalk from 'chalk';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  listAgents,
  loadAgentConfig,
  getAgentLinearToken,
  getAgentsDir,
  sharesIdentityWithSystem,
} from '../core/persona.js';
import {
  getOAuthToken,
  getOAuthConfig,
  mintTokenForClient,
  saveOAuthToken,
} from '../core/oauth.js';

const TOKEN_CHECK_INTERVAL_MS = 60 * 60_000; // 1 hour
let lastTokenCheckTime = 0;

interface TokenStatus {
  role: string;
  valid: boolean;
  name?: string;
  refreshed?: boolean;
  error?: string;
}

/**
 * Validate a token by calling Linear's viewer query.
 * Returns the actor name on success, null on failure.
 */
async function validateToken(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      },
      body: JSON.stringify({ query: '{ viewer { id name } }' }),
    });
    if (res.status === 401) return null;
    if (!res.ok) return null;
    const json = await res.json() as { data?: { viewer?: { name: string } }; errors?: unknown[] };
    if (json.errors?.length) return null;
    return json.data?.viewer?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the same token to every file that represents the given clientId's identity.
 * This includes the per-agent .oauth-token files AND the system token file if the
 * system's oauth.json clientId matches.
 */
function persistTokenForClientId(clientId: string, token: string, roles: string[]): void {
  // Per-agent files
  for (const role of roles) {
    const tokenPath = join(getAgentsDir(), role, '.oauth-token');
    writeFileSync(tokenPath, token, { mode: 0o600 });
  }
  // System file, if this clientId is the system clientId
  const systemCfg = getOAuthConfig();
  if (systemCfg && systemCfg.clientId === clientId) {
    saveOAuthToken(token);
  }
}

/**
 * Validate and refresh all agent tokens + the global system token.
 * Called from the monitor loop on a 1-hour interval.
 *
 * Algorithm (RYA-599):
 *   1. Group every identity (system + each agent) by clientId.
 *   2. Validate one representative token per clientId.
 *   3. If invalid, mint ONCE for that clientId, fan the new token out to every file.
 *   4. Roles that share clientId with the system are NOT refreshed independently.
 */
export async function validateAndRefreshAllTokens(): Promise<void> {
  if (Date.now() - lastTokenCheckTime < TOKEN_CHECK_INTERVAL_MS) return;
  lastTokenCheckTime = Date.now();

  const ts = new Date().toLocaleTimeString();
  console.log(chalk.dim(`[${ts}] Token health check starting...`));

  const results: TokenStatus[] = [];

  // --- Phase 1: Group by clientId ---
  interface IdentityGroup {
    clientId: string;
    clientSecret: string;
    isSystem: boolean;
    roles: string[];     // agents sharing this identity
    labels: string[];    // display labels (e.g. 'system', 'ceo-office')
  }
  const groups = new Map<string, IdentityGroup>();

  const systemCfg = getOAuthConfig();
  if (systemCfg) {
    groups.set(systemCfg.clientId, {
      clientId: systemCfg.clientId,
      clientSecret: systemCfg.clientSecret,
      isSystem: true,
      roles: [],
      labels: ['system'],
    });
  }

  const orphanAgents: string[] = []; // agents with no clientId credentials in config.json

  for (const role of listAgents()) {
    const cfg = loadAgentConfig(role);
    if (!cfg.linearClientId || !cfg.linearClientSecret) {
      orphanAgents.push(role);
      continue;
    }
    const existing = groups.get(cfg.linearClientId);
    if (existing) {
      existing.roles.push(role);
      existing.labels.push(role);
    } else {
      groups.set(cfg.linearClientId, {
        clientId: cfg.linearClientId,
        clientSecret: cfg.linearClientSecret,
        isSystem: false,
        roles: [role],
        labels: [role],
      });
    }
  }

  // --- Phase 2: For each group, validate one representative and refresh if needed ---
  for (const group of groups.values()) {
    const groupLabel = group.labels.join('+');
    // Pick a representative token: prefer system token if this is the system group,
    // otherwise the first agent's token file. getAgentLinearToken already handles
    // the shared-identity collision (returns system token when clientId matches).
    let representativeToken: string | null = null;
    if (group.isSystem) {
      representativeToken = getOAuthToken();
    } else {
      representativeToken = getAgentLinearToken(group.roles[0]);
    }

    if (!representativeToken) {
      console.log(chalk.yellow(`  [token-health] ${groupLabel}: no token file — minting...`));
      try {
        const newToken = await mintTokenForClient(group.clientId, group.clientSecret);
        const verifyName = await validateToken(newToken);
        if (verifyName) {
          persistTokenForClientId(group.clientId, newToken, group.roles);
          for (const label of group.labels) {
            results.push({ role: label, valid: true, name: verifyName, refreshed: true });
          }
          console.log(chalk.green(`  [token-health] ${groupLabel}: minted (${verifyName})`));
        } else {
          for (const label of group.labels) {
            results.push({ role: label, valid: false, error: 'mint verify failed' });
          }
          console.log(chalk.red(`  [token-health] ${groupLabel}: minted but verify failed`));
        }
      } catch (err) {
        for (const label of group.labels) {
          results.push({ role: label, valid: false, error: (err as Error).message });
        }
        console.log(chalk.red(`  [token-health] ${groupLabel}: mint error: ${(err as Error).message}`));
      }
      continue;
    }

    const name = await validateToken(representativeToken);
    if (name) {
      for (const label of group.labels) {
        results.push({ role: label, valid: true, name });
      }
      continue;
    }

    // Invalid — refresh ONCE for this clientId and fan out
    console.log(chalk.yellow(`  [token-health] ${groupLabel}: token invalid — refreshing clientId ${group.clientId.slice(0, 10)}...`));
    try {
      const newToken = await mintTokenForClient(group.clientId, group.clientSecret);
      const verifyName = await validateToken(newToken);
      if (verifyName) {
        persistTokenForClientId(group.clientId, newToken, group.roles);
        for (const label of group.labels) {
          results.push({ role: label, valid: true, name: verifyName, refreshed: true });
        }
        console.log(chalk.green(`  [token-health] ${groupLabel}: refreshed successfully (${verifyName})`));
      } else {
        for (const label of group.labels) {
          results.push({ role: label, valid: false, error: 'refresh verify failed' });
        }
        console.log(chalk.red(`  [token-health] ${groupLabel}: refreshed but still invalid — KEEPING OLD TOKEN`));
      }
    } catch (err) {
      for (const label of group.labels) {
        results.push({ role: label, valid: false, error: (err as Error).message });
      }
      console.log(chalk.red(`  [token-health] ${groupLabel}: refresh error: ${(err as Error).message}`));
    }
  }

  // --- Phase 3: Report orphan agents (no credentials in config.json) ---
  for (const role of orphanAgents) {
    const token = getAgentLinearToken(role);
    if (!token) {
      results.push({ role, valid: false, error: 'no token file' });
      console.log(chalk.yellow(`  [token-health] ${role}: no token file`));
      continue;
    }
    const name = await validateToken(token);
    if (name) {
      results.push({ role, valid: true, name });
    } else {
      results.push({ role, valid: false, error: 'no OAuth credentials — cannot refresh' });
      console.log(chalk.yellow(`  [token-health] ${role}: no OAuth credentials in config.json — cannot refresh`));
    }
  }

  // --- Summary ---
  const valid = results.filter(r => r.valid).length;
  const invalid = results.filter(r => !r.valid).length;
  const refreshed = results.filter(r => r.refreshed).length;

  if (invalid === 0) {
    console.log(chalk.dim(`[${ts}] Token health: all ${valid} tokens valid${refreshed > 0 ? ` (${refreshed} refreshed)` : ''}`));
  } else {
    console.log(chalk.red(`[${ts}] Token health: ${invalid} INVALID, ${valid} valid${refreshed > 0 ? `, ${refreshed} refreshed` : ''}`));
    for (const r of results.filter(r => !r.valid)) {
      console.log(chalk.red(`  FAILED: ${r.role} — ${r.error || 'unknown'}`));
    }
  }
}

/**
 * Force an immediate token check (bypasses the interval timer).
 * Useful for startup and after known auth failures.
 */
export async function forceTokenCheck(): Promise<void> {
  lastTokenCheckTime = 0;
  await validateAndRefreshAllTokens();
}

// Re-export for tests that still reference sharesIdentityWithSystem from persona.
export { sharesIdentityWithSystem };
