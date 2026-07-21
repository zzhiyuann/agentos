import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execSync }));

// getConfig().stateDir is hardcoded to ~/.aos — redirect it to a per-test
// temp dir so the file fallback and .keychain-pass are controllable.
const configState = vi.hoisted(() => ({ stateDir: '' }));
vi.mock('./config.js', () => ({
  getConfig: () => ({ stateDir: configState.stateDir }),
}));

import {
  getLinearApiKey,
  readKeychainPassword,
  __resetKeychainStateForTests,
} from './keychain.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'aos-keychain-test-'));
  configState.stateDir = stateDir;
  process.env.AOS_USER = 'testuser';
  execSync.mockReset();
  __resetKeychainStateForTests();
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.AOS_USER;
});

const isFind = (cmd: string) => cmd.includes('find-generic-password');
const isUnlock = (cmd: string) => cmd.includes('unlock-keychain');

describe('readKeychainPassword', () => {
  it('returns the password when the keychain read succeeds', () => {
    execSync.mockReturnValueOnce('secret-value\n');
    expect(readKeychainPassword('svc-a')).toBe('secret-value');
    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync.mock.calls[0][0]).toContain('-a "testuser"');
    expect(execSync.mock.calls[0][0]).toContain('-s "svc-a"');
  });

  it('unlocks the keychain and retries when the first read fails', () => {
    writeFileSync(join(stateDir, '.keychain-pass'), 'kcpass');
    execSync.mockImplementation((cmd: string) => {
      if (isUnlock(cmd)) return '';
      if (isFind(cmd)) {
        // first find fails, second (post-unlock) succeeds
        if (execSync.mock.calls.filter(c => isFind(c[0])).length <= 1) {
          throw new Error('keychain locked');
        }
        return 'recovered-secret\n';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    expect(readKeychainPassword('svc-a')).toBe('recovered-secret');
    expect(execSync.mock.calls.some(c => isUnlock(c[0]))).toBe(true);
  });

  it('does not attempt unlock when .keychain-pass is missing', () => {
    execSync.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    expect(readKeychainPassword('svc-a')).toBeNull();
    expect(execSync.mock.calls.some(c => isUnlock(c[0]))).toBe(false);
  });

  it('marks only the failing service unavailable, not others', () => {
    execSync.mockImplementation((cmd: string) => {
      if (isFind(cmd) && cmd.includes('svc-missing')) throw new Error('not found');
      if (isFind(cmd)) return 'other-secret\n';
      return '';
    });

    expect(readKeychainPassword('svc-missing')).toBeNull();
    // other service still readable in the same process
    expect(readKeychainPassword('svc-present')).toBe('other-secret');
    // failing service is now circuit-broken: no further security calls for it
    const callsBefore = execSync.mock.calls.length;
    expect(readKeychainPassword('svc-missing')).toBeNull();
    expect(execSync.mock.calls.length).toBe(callsBefore);
  });

  it('only attempts unlock once per process', () => {
    writeFileSync(join(stateDir, '.keychain-pass'), 'kcpass');
    execSync.mockImplementation((cmd: string) => {
      if (isUnlock(cmd)) return '';
      throw new Error('still locked');
    });

    expect(readKeychainPassword('svc-a')).toBeNull();
    expect(readKeychainPassword('svc-b')).toBeNull();
    expect(execSync.mock.calls.filter(c => isUnlock(c[0])).length).toBe(1);
  });
});

describe('getLinearApiKey', () => {
  it('falls back to the file store when the keychain is unavailable', () => {
    execSync.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    writeFileSync(join(stateDir, '.linear-api-key'), 'file-key\n');
    expect(getLinearApiKey()).toBe('file-key');
  });

  it('throws when neither keychain nor file has the key', () => {
    execSync.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    expect(() => getLinearApiKey()).toThrow(/Linear API key not found/);
  });
});
