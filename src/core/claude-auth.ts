/**
 * Claude Code auth health check.
 *
 * Detects expired/invalid Claude Code credentials BEFORE we spawn an agent.
 * Backstory: RYA-591 — on 2026-04-15 tokens expired, refresh script wasn't
 * cron'd, no monitoring caught it, and every dispatched session silently
 * failed with "Please run /login" for 7 days. This module is the pre-flight
 * gate that prevents a repeat.
 *
 * Probe strategy (cheap first):
 *   1. Read Claude Code credential from macOS keychain
 *   2. Parse the OAuth payload, compare `expiresAt` to now
 *   3. If access token expired, attempt in-process refresh with the stored
 *      refresh token (same flow as ~/.claude/refresh-all-tokens.sh)
 *   4. If still unhealthy, caller posts P0 alert + blocks spawn
 *
 * Cost: one `security` call + optional one refresh POST. No Claude API call
 * in the happy path.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { STATE_DIR } from './config.js';

export interface ClaudeAuthResult {
  /** True if auth is good to use right now. */
  healthy: boolean;
  /** Human-readable reason. For P0 alerts when unhealthy. */
  reason: string;
  /** Unix ms when the current access token expires, if known. */
  expiresAt?: number;
  /** How we determined the result, for logs. */
  source: 'keychain-valid' | 'keychain-refreshed' | 'keychain-missing' | 'keychain-locked' | 'keychain-malformed' | 'refresh-failed' | 'probe-skipped';
}

interface AuthFailureState {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastReason: string | null;
  lastHealthyAt: number | null;
}

const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/** Keychain service name used by Claude Code. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** How long before expiry we treat the token as already stale (ms). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Injection point for tests to replace `security` / `fetch` calls. */
export interface ClaudeAuthDeps {
  readKeychain: (service: string) => string | null;
  writeKeychain: (service: string, payload: string) => boolean;
  fetch: typeof fetch;
  now: () => number;
  stateDir?: string;
}

export const defaultDeps: ClaudeAuthDeps = {
  readKeychain: (service) => {
    try {
      return execSync(
        `security find-generic-password -s ${JSON.stringify(service)} -w`,
        { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
    } catch {
      return null;
    }
  },
  writeKeychain: (service, payload) => {
    try {
      // Delete + re-add (keychain entries can't be updated in place via CLI)
      try {
        execSync(
          `security delete-generic-password -s ${JSON.stringify(service)}`,
          { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch (err: unknown) {
        // Delete may fail if entry does not exist — expected; log at debug for diagnostics
        console.debug(`[claude-auth] keychain delete skipped (entry may not exist): ${(err as Error).message}`);
      }
      // Write payload via stdin-equivalent: escape for shell
      const escaped = payload.replace(/'/g, `'\\''`);
      execSync(
        `security add-generic-password -s ${JSON.stringify(service)} -a "$USER" -w '${escaped}'`,
        { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return true;
    } catch {
      return false;
    }
  },
  fetch: (input, init) => fetch(input as any, init as any),
  now: () => Date.now(),
};

function stateFilePath(deps: ClaudeAuthDeps): string {
  return join(deps.stateDir || STATE_DIR, 'claude-auth-state.json');
}

export function loadFailureState(deps: ClaudeAuthDeps = defaultDeps): AuthFailureState {
  const path = stateFilePath(deps);
  if (!existsSync(path)) {
    return { consecutiveFailures: 0, lastFailureAt: null, lastReason: null, lastHealthyAt: null };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AuthFailureState;
  } catch {
    return { consecutiveFailures: 0, lastFailureAt: null, lastReason: null, lastHealthyAt: null };
  }
}

function saveFailureState(state: AuthFailureState, deps: ClaudeAuthDeps = defaultDeps): void {
  const path = stateFilePath(deps);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

export function recordAuthSuccess(deps: ClaudeAuthDeps = defaultDeps): void {
  saveFailureState(
    { consecutiveFailures: 0, lastFailureAt: null, lastReason: null, lastHealthyAt: deps.now() },
    deps
  );
}

export function recordAuthFailure(reason: string, deps: ClaudeAuthDeps = defaultDeps): AuthFailureState {
  const prev = loadFailureState(deps);
  const next: AuthFailureState = {
    consecutiveFailures: prev.consecutiveFailures + 1,
    lastFailureAt: deps.now(),
    lastReason: reason,
    lastHealthyAt: prev.lastHealthyAt,
  };
  saveFailureState(next, deps);
  return next;
}

interface OAuthCredential {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

function parseCredential(raw: string): OAuthCredential | null {
  try {
    return JSON.parse(raw) as OAuthCredential;
  } catch {
    return null;
  }
}

async function refreshAccessToken(
  credential: OAuthCredential,
  deps: ClaudeAuthDeps
): Promise<{ ok: true; credential: OAuthCredential } | { ok: false; error: string }> {
  const refreshToken = credential.claudeAiOauth?.refreshToken;
  if (!refreshToken) return { ok: false, error: 'no refreshToken in credential' };

  try {
    const resp = await deps.fetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, error: `refresh HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: { message?: string } };
    if (!data.access_token || !data.refresh_token) {
      return { ok: false, error: data.error?.message || 'refresh returned no tokens' };
    }
    const expiresAt = deps.now() + ((data.expires_in || 28800) - 300) * 1000;
    const updated: OAuthCredential = {
      ...credential,
      claudeAiOauth: {
        ...(credential.claudeAiOauth || {}),
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
      },
    };
    return { ok: true, credential: updated };
  } catch (err) {
    return { ok: false, error: `refresh threw: ${(err as Error).message}` };
  }
}

/**
 * Check Claude Code auth. If the access token is expired but a refresh token
 * is present, automatically attempt a refresh and update the keychain.
 *
 * Returns a result describing the final state — `healthy: false` means the
 * caller should block spawn and alert.
 */
export async function checkClaudeAuth(deps: ClaudeAuthDeps = defaultDeps): Promise<ClaudeAuthResult> {
  const raw = deps.readKeychain(KEYCHAIN_SERVICE);
  if (raw === null) {
    return {
      healthy: false,
      reason: `Claude Code credential not found in keychain (service: "${KEYCHAIN_SERVICE}"). Keychain may be locked, or user never logged in. Fix: unlock keychain, then run \`claude /login\`.`,
      source: 'keychain-locked',
    };
  }

  const credential = parseCredential(raw);
  if (!credential || !credential.claudeAiOauth) {
    return {
      healthy: false,
      reason: `Claude Code credential is malformed (unparseable JSON or missing claudeAiOauth). Fix: re-run \`claude /login\`.`,
      source: 'keychain-malformed',
    };
  }

  const { accessToken, expiresAt, refreshToken } = credential.claudeAiOauth;
  if (!accessToken || !expiresAt) {
    return {
      healthy: false,
      reason: `Claude Code credential missing accessToken or expiresAt. Fix: re-run \`claude /login\`.`,
      source: 'keychain-missing',
    };
  }

  const now = deps.now();
  if (expiresAt > now + EXPIRY_BUFFER_MS) {
    // Happy path — access token still valid with buffer
    return { healthy: true, reason: 'access token valid', expiresAt, source: 'keychain-valid' };
  }

  // Expired or about-to-expire — try refresh
  if (!refreshToken) {
    return {
      healthy: false,
      reason: `Claude Code access token expired at ${new Date(expiresAt).toISOString()} and no refresh token is present. Fix: run \`claude /login\`.`,
      expiresAt,
      source: 'keychain-missing',
    };
  }

  const result = await refreshAccessToken(credential, deps);
  if (!result.ok) {
    return {
      healthy: false,
      reason: `Claude Code access token expired and refresh failed: ${result.error}. Fix: run \`claude /login\` on the iMac server.`,
      expiresAt,
      source: 'refresh-failed',
    };
  }

  const written = deps.writeKeychain(KEYCHAIN_SERVICE, JSON.stringify(result.credential));
  if (!written) {
    return {
      healthy: false,
      reason: `Claude Code token refresh succeeded but could not be written back to keychain. Keychain may be locked. Fix: \`security unlock-keychain ~/Library/Keychains/login.keychain-db\`.`,
      expiresAt,
      source: 'refresh-failed',
    };
  }

  return {
    healthy: true,
    reason: 'access token refreshed',
    expiresAt: result.credential.claudeAiOauth?.expiresAt,
    source: 'keychain-refreshed',
  };
}

export const CLAUDE_AUTH_FAILURE_THRESHOLD = 2;
