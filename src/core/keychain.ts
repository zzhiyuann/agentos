import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';

const SERVICE_NAME = 'aos-linear-api-key';

function getAccountName(): string {
  return process.env.AOS_USER || 'aos';
}

function apiKeyFilePath(): string {
  return join(getConfig().stateDir, '.linear-api-key');
}

export function getLinearApiKey(): string {
  // Try Keychain first
  try {
    const key = execSync(
      `security find-generic-password -a "${getAccountName()}" -s "${SERVICE_NAME}" -w 2>/dev/null`,
      { encoding: 'utf-8' }
    ).trim();
    if (key) return key;
  } catch { /* Keychain locked or unavailable — fall through */ }

  // Fallback: file-based (for SSH/headless environments)
  try {
    const path = apiKeyFilePath();
    if (existsSync(path)) {
      const key = readFileSync(path, 'utf-8').trim();
      if (key) return key;
    }
  } catch { /* ignore */ }

  throw new Error(
    'Linear API key not found in Keychain or file. Run: aos setup --api-key <key>'
  );
}

export function storeLinearApiKey(key: string): void {
  // Try Keychain
  try {
    execSync(
      `security add-generic-password -a "${getAccountName()}" -s "${SERVICE_NAME}" -w "${key}" -U 2>/dev/null`,
      { encoding: 'utf-8' }
    );
  } catch { /* Keychain not available */ }

  // Always save to file as backup
  const dir = getConfig().stateDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(apiKeyFilePath(), key, { mode: 0o600 });
}
