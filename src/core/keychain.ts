import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getConfig } from './config.js';

const SERVICE_NAME = 'aos-linear-api-key';

// RYA-1087: once a service is known unavailable in this process, skip it
// forever. Prevents `security` subprocess spam on every Linear API call
// (was 120+ log lines per 5000-line serve pane window before this fix).
// RYA-1194: per-service, so a missing oauth entry can't disable the
// Linear-key entry (or vice versa) for the rest of the process.
const unavailableServices = new Set<string>();

// RYA-1194: only attempt unlock once per process — if the unlock itself
// fails (no .keychain-pass, wrong password), retrying per read is pure spam.
let unlockAttempted = false;

function getAccountName(): string {
  // RYA-1194: entries are stored under the login user's name. The old
  // default ('aos') never matched any stored entry, so every context
  // without AOS_USER set silently fell back to the file store.
  return process.env.AOS_USER || process.env.USER || 'aos';
}

function apiKeyFilePath(): string {
  return join(getConfig().stateDir, '.linear-api-key');
}

function keychainPassPath(): string {
  return join(getConfig().stateDir, '.keychain-pass');
}

/**
 * RYA-1194: the login keychain locks on boot/sleep, and serve now runs under
 * launchd (RYA-1187) with no GUI session to unlock it. Same remedy the tmux
 * spawn paths already use (claude-code.ts / codex.ts / chat-session.ts).
 */
// On a LOCKED keychain in a GUI session, `security find-generic-password`
// blocks on an unlock dialog instead of erroring (verified during RYA-1194).
// A hard timeout turns that hang into a failure we can recover from via
// tryUnlockKeychain(). stdin is ignored so `security` can't wait on input.
const SECURITY_TIMEOUT_MS = 5_000;

function tryUnlockKeychain(): boolean {
  const passPath = keychainPassPath();
  if (!existsSync(passPath)) return false;
  try {
    execSync(
      `security unlock-keychain -p "$(cat "${passPath}")" "${join(homedir(), 'Library/Keychains/login.keychain-db')}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: SECURITY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return true;
  } catch {
    return false;
  }
}

function readPasswordOnce(service: string, account: string): string | null {
  const out = execSync(
    `security find-generic-password -a "${account}" -s "${service}" -w 2>/dev/null`,
    { encoding: 'utf-8', timeout: SECURITY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  return out || null;
}

/**
 * Read a generic password from the login keychain, unlocking it once if the
 * first read fails (launchd/headless contexts). Returns null if the keychain
 * is unavailable — callers fall back to their file store.
 *
 * Shared by the Linear API key (this module) and the OAuth token (oauth.ts).
 */
export function readKeychainPassword(service: string): string | null {
  if (unavailableServices.has(service)) return null;

  try {
    const value = readPasswordOnce(service, getAccountName());
    if (value) return value;
  } catch {
    // fall through to unlock-and-retry
  }

  if (!unlockAttempted) {
    unlockAttempted = true;
    if (tryUnlockKeychain()) {
      try {
        const value = readPasswordOnce(service, getAccountName());
        if (value) {
          console.warn(`[keychain] Keychain was locked; unlocked it and recovered service="${service}".`);
          return value;
        }
      } catch {
        // unlock succeeded but the entry is missing/unreadable — give up below
      }
    }
  }

  unavailableServices.add(service);
  console.warn(
    `[keychain] Keychain unavailable for service="${service}" account="${getAccountName()}" (using file fallback for the rest of this process).`
  );
  return null;
}

export function getLinearApiKey(): string {
  const key = readKeychainPassword(SERVICE_NAME);
  if (key) return key;

  // Fallback: file-based (for SSH/headless environments)
  try {
    const path = apiKeyFilePath();
    if (existsSync(path)) {
      const key = readFileSync(path, 'utf-8').trim();
      if (key) return key;
    }
  } catch (err: unknown) {
    console.debug(`[keychain] file-based key read failed:`, (err as Error).message);
  }

  throw new Error(
    'Linear API key not found in Keychain or file. Run: aos setup --api-key <key>'
  );
}

export function storeLinearApiKey(key: string): void {
  // Try Keychain
  let keychainStored = false;
  try {
    execSync(
      `security add-generic-password -a "${getAccountName()}" -s "${SERVICE_NAME}" -w "${key}" -U 2>/dev/null`,
      { encoding: 'utf-8', timeout: SECURITY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    keychainStored = true;
  } catch (err: unknown) {
    console.warn(`[keychain] Keychain store failed (using file fallback):`, (err as Error).message);
  }

  // Successful store invalidates the "unavailable" cache — next read can try keychain again
  if (keychainStored) unavailableServices.delete(SERVICE_NAME);

  // Always save to file as backup
  const dir = getConfig().stateDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(apiKeyFilePath(), key, { mode: 0o600 });
}

/** Test-only: reset module-level circuit breakers between cases. */
export function __resetKeychainStateForTests(): void {
  unavailableServices.clear();
  unlockAttempted = false;
}
