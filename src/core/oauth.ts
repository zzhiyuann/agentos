import { execSync } from 'child_process';
import { getConfig } from './config.js';
import { readKeychainPassword } from './keychain.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const KEYCHAIN_SERVICE = 'aos-linear-oauth';

function getKeychainAccount(): string {
  // RYA-1194: match keychain.ts — stored entries use the login user's name
  return process.env.AOS_USER || process.env.USER || 'aos';
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
}

function getOAuthConfigPath(): string {
  return join(getConfig().stateDir, 'oauth.json');
}

export function getOAuthConfig(): OAuthConfig | null {
  const path = getOAuthConfigPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveOAuthConfig(config: OAuthConfig): void {
  const stateDir = getConfig().stateDir;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(getOAuthConfigPath(), JSON.stringify(config, null, 2));
}

function tokenFilePath(): string {
  return join(getConfig().stateDir, '.oauth-token');
}

export function getOAuthToken(): string | null {
  // Try Keychain first (shared unlock-aware reader, RYA-1194)
  const token = readKeychainPassword(KEYCHAIN_SERVICE);
  if (token && token !== 'undefined') return token;

  // Fallback: file-based (for SSH/headless environments)
  try {
    const path = tokenFilePath();
    if (existsSync(path)) {
      const token = readFileSync(path, 'utf-8').trim();
      if (token && token !== 'undefined') return token;
    }
  } catch (err: unknown) {
    console.debug(`[oauth] file-based token read failed:`, (err as Error).message);
  }

  return null;
}

export function saveOAuthToken(token: string): void {
  // Try Keychain
  try {
    execSync(
      `security add-generic-password -a "${getKeychainAccount()}" -s "${KEYCHAIN_SERVICE}" -w "${token}" -U 2>/dev/null`,
      // Timeout: a locked keychain can block `security` on a GUI dialog (RYA-1194)
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err: unknown) {
    console.warn(`[oauth] Keychain store failed (using file fallback):`, (err as Error).message);
  }

  // Always save to file as backup
  const path = tokenFilePath();
  mkdirSync(getConfig().stateDir, { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
}

export function hasOAuthSetup(): boolean {
  return getOAuthConfig() !== null && getOAuthToken() !== null;
}

// --- Single-flight + TTL cache keyed by clientId (RYA-599) ---
// Linear's client_credentials grant invalidates prior tokens for the same clientId.
// When multiple code paths mint for the same clientId, they ping-pong invalidate each other.
// Coalesce concurrent mints and reuse a freshly-minted token across callers for a short window.

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const inFlightMints = new Map<string, Promise<string>>();

// Tokens are reused across callers for this long before a re-mint can occur.
// Long enough to coalesce token-health's sequential system+agent refresh;
// short enough that a real token rotation (issued by some other process) recovers quickly.
export const MINT_CACHE_TTL_MS = 60_000;

/**
 * Mint a fresh OAuth token via client_credentials, with single-flight coalescing
 * and a short TTL cache keyed by clientId.
 *
 * Guarantees:
 *  - Concurrent callers with the same clientId share a single HTTP request.
 *  - A successful mint is reused by subsequent callers for MINT_CACHE_TTL_MS.
 *  - Failed mints are NOT cached.
 *
 * This is the ONLY place in the codebase that should call Linear's /oauth/token endpoint.
 */
export async function mintTokenForClient(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const existing = inFlightMints.get(clientId);
  if (existing) return existing;

  const promise = (async () => {
    const tokenResponse = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'read,write,app:assignable,app:mentionable',
      }),
    });

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      throw new Error(`Token request failed: ${err}`);
    }

    const tokens = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = tokens.access_token as string;
    if (!accessToken) {
      throw new Error(`No access_token in response: ${JSON.stringify(tokens)}`);
    }

    tokenCache.set(clientId, {
      token: accessToken,
      expiresAt: Date.now() + MINT_CACHE_TTL_MS,
    });
    return accessToken;
  })();

  inFlightMints.set(clientId, promise);
  try {
    return await promise;
  } finally {
    inFlightMints.delete(clientId);
  }
}

/** Test-only: clear the clientId token cache + in-flight map. */
export function _resetOAuthCache(): void {
  tokenCache.clear();
  inFlightMints.clear();
}

/**
 * Obtain OAuth token via client_credentials grant.
 * Works when the app is already installed in the workspace.
 * Uses the shared mint cache — safe to call concurrently from multiple paths.
 */
export async function runOAuthFlow(clientId: string, clientSecret: string): Promise<string> {
  // Save config for future token refreshes
  saveOAuthConfig({ clientId, clientSecret });

  const accessToken = await mintTokenForClient(clientId, clientSecret);
  saveOAuthToken(accessToken);
  return accessToken;
}

/**
 * Refresh the OAuth token using stored credentials.
 * Logs the underlying error so failures are diagnosable (RYA-592).
 */
export async function refreshToken(): Promise<string | null> {
  const config = getOAuthConfig();
  if (!config) {
    console.warn('[oauth] refreshToken: no oauth.json — cannot refresh (system needs re-auth)');
    return null;
  }

  try {
    return await runOAuthFlow(config.clientId, config.clientSecret);
  } catch (err: unknown) {
    console.warn(`[oauth] refreshToken failed: ${(err as Error).message}`);
    return null;
  }
}
