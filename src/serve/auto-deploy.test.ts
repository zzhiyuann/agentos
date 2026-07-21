import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  getHeadCommit,
  formatBlockedDeployAlert,
  alertBlockedDeploy,
  findFilesNewerThan,
  _resetBlockedDeployAlertState,
} from './auto-deploy.js';

let dir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-deploy-test-'));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  _resetBlockedDeployAlertState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  warnSpy.mockRestore();
});

describe('getHeadCommit', () => {
  it('returns the short HEAD hash in a git repo', () => {
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
      cwd: dir,
    });
    expect(getHeadCommit(dir)).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('returns "unknown" outside a git checkout', () => {
    expect(getHeadCommit(dir)).toBe('unknown');
  });
});

describe('formatBlockedDeployAlert', () => {
  it('names the commit, the skipped files, and the manual-restart requirement', () => {
    const msg = formatBlockedDeployAlert(['core/router.ts'], 'd157252');
    expect(msg).toContain('d157252');
    expect(msg).toContain('core/router.ts');
    expect(msg).toContain('NOT live');
    expect(msg).toContain('manual serve restart');
    expect(msg).toContain('RYA-203');
  });
});

describe('findFilesNewerThan', () => {
  /** Write a .js file with an mtime offset (seconds) from a fixed epoch. */
  const epoch = 1_700_000_000_000; // fixed ms timestamp
  function writeWithMtime(relPath: string, offsetSecs: number): void {
    const fullPath = join(dir, relPath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, '// test');
    const t = new Date(epoch + offsetSecs * 1000);
    utimesSync(fullPath, t, t);
  }

  it('finds .js files newer than the threshold, including nested dirs', () => {
    writeWithMtime('old.js', -60);
    writeWithMtime('fresh.js', 30);
    writeWithMtime('serve/nested-fresh.js', 45);
    const found = findFilesNewerThan(dir, epoch);
    expect(found).toHaveLength(2);
    expect(found.some(f => f.endsWith('fresh.js'))).toBe(true);
    expect(found.some(f => f.endsWith('nested-fresh.js'))).toBe(true);
  });

  it('returns empty when nothing is newer than the threshold', () => {
    writeWithMtime('a.js', -10);
    writeWithMtime('serve/b.js', -5);
    expect(findFilesNewerThan(dir, epoch)).toHaveLength(0);
  });

  it('ignores non-.js files and dotfiles', () => {
    writeWithMtime('fresh.d.ts', 30);
    writeWithMtime('fresh.js.map', 30);
    writeWithMtime('.hidden.js', 30);
    const found = findFilesNewerThan(dir, epoch);
    expect(found).toHaveLength(0);
  });

  it('returns empty for a missing directory instead of throwing', () => {
    expect(findFilesNewerThan(join(dir, 'does-not-exist'), epoch)).toHaveLength(0);
  });
});

describe('alertBlockedDeploy', () => {
  it('posts a Discord alert and logs a console.warn with the commit', async () => {
    const poster = vi.fn().mockResolvedValue(true);
    const posted = await alertBlockedDeploy(dir, ['core/router.ts'], {
      poster,
      commit: 'abc1234',
    });
    expect(posted).toBe(true);
    expect(poster).toHaveBeenCalledOnce();
    expect(poster.mock.calls[0][0]).toContain('abc1234');
    expect(poster.mock.calls[0][0]).toContain('core/router.ts');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Manual serve restart required to deploy commit abc1234');
  });

  it('dedupes repeat alerts for the same commit + file set, but always console.warns', async () => {
    const poster = vi.fn().mockResolvedValue(true);
    await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'abc1234' });
    const second = await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'abc1234' });
    expect(second).toBe(false);
    expect(poster).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('re-alerts when a new commit lands while a deploy is still pending', async () => {
    const poster = vi.fn().mockResolvedValue(true);
    await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'abc1234' });
    const again = await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'def5678' });
    expect(again).toBe(true);
    expect(poster).toHaveBeenCalledTimes(2);
  });

  it('re-alerts when an additional blocked file appears for the same commit', async () => {
    const poster = vi.fn().mockResolvedValue(true);
    await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'abc1234' });
    const again = await alertBlockedDeploy(
      dir,
      ['core/router.ts', 'adapters/claude-code.ts'],
      { poster, commit: 'abc1234' }
    );
    expect(again).toBe(true);
    expect(poster).toHaveBeenCalledTimes(2);
  });

  it('dedupes duplicate filenames from repeated change events within one batch', async () => {
    const poster = vi.fn().mockResolvedValue(true);
    await alertBlockedDeploy(dir, ['core/router.ts', 'core/router.ts'], {
      poster,
      commit: 'abc1234',
    });
    const occurrences = (poster.mock.calls[0][0] as string).match(/core\/router\.ts/g);
    expect(occurrences).toHaveLength(1);
  });

  it('retries on the next event when the Discord post fails', async () => {
    const poster = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const first = await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'abc1234' });
    expect(first).toBe(false);
    // Same key, but the failed send must not have been recorded as alerted
    const second = await alertBlockedDeploy(dir, ['core/router.ts'], { poster, commit: 'abc1234' });
    expect(second).toBe(true);
    expect(poster).toHaveBeenCalledTimes(2);
  });
});
