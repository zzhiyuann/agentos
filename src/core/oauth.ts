import { execSync } from 'child_process';
import { getConfig } from './config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const KEYCHAIN_SERVICE = 'aos-linear-oauth';

function getKeychainAccount(): string {
  return process.env.AOS_USER || 'aos';
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
  // Try Keychain first
  try {
    const token = execSync(
      `security find-generic-password -a "${getKeychainAccount()}" -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`,
      { encoding: 'utf-8' }
    ).trim();
    if (token && token !== 'undefined') return token;
  } catch { /* fall through */ }

  // Fallback: file-based (for SSH/headless environments)
  try {
    const path = tokenFilePath();
    if (existsSync(path)) {
      const token = readFileSync(path, 'utf-8').trim();
      if (token && token !== 'undefined') return token;
    }
  } catch { /* ignore */ }

  return null;
}

export function saveOAuthToken(token: string): void {
  // Try Keychain
  try {
    execSync(
      `security add-generic-password -a "${getKeychainAccount()}" -s "${KEYCHAIN_SERVICE}" -w "${token}" -U 2>/dev/null`,
      { encoding: 'utf-8' }
    );
  } catch { /* Keychain not available */ }

  // Always save to file as backup
  const path = tokenFilePath();
  mkdirSync(getConfig().stateDir, { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
}

export function hasOAuthSetup(): boolean {
  return getOAuthConfig() !== null && getOAuthToken() !== null;
}

/**
 * Obtain OAuth token via client_credentials grant.
 * Works when the app is already installed in the workspace.
 */
export async function runOAuthFlow(clientId: string, clientSecret: string): Promise<string> {
  // Save config for future token refreshes
  saveOAuthConfig({ clientId, clientSecret });

  // Use client_credentials grant (app must be installed in workspace first)
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

  saveOAuthToken(accessToken);
  return accessToken;
}

/**
 * Refresh the OAuth token using stored credentials.
 */
export async function refreshToken(): Promise<string | null> {
  const config = getOAuthConfig();
  if (!config) return null;

  try {
    return await runOAuthFlow(config.clientId, config.clientSecret);
  } catch {
    return null;
  }
}
