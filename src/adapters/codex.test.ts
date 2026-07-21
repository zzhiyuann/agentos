import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCodexOverride, syncCodexHome } from './codex.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-codex-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildCodexOverride', () => {
  it('wraps the AgentOS session prompt', () => {
    const override = buildCodexOverride('## Persona\nYou are the lead engineer.');
    expect(override).toContain('AgentOS Session Override');
    expect(override).toContain('You are the lead engineer.');
  });
});

describe('syncCodexHome', () => {
  it('copies config/auth and links shared Codex assets', () => {
    const source = join(makeTempDir(), '.codex');
    const target = join(makeTempDir(), '.codex');

    mkdirSync(source, { recursive: true });
    mkdirSync(join(source, 'skills'), { recursive: true });
    mkdirSync(join(source, 'plugins'), { recursive: true });
    writeFileSync(join(source, 'config.toml'), 'model = "gpt-5.4"\n', 'utf-8');
    writeFileSync(join(source, 'auth.json'), '{"access_token":"test"}\n', 'utf-8');
    writeFileSync(join(source, 'AGENTS.md'), '@RTK.md\n', 'utf-8');
    writeFileSync(join(source, 'RTK.md'), '# RTK\n', 'utf-8');
    writeFileSync(join(source, 'instructions.md'), 'Shared instructions\n', 'utf-8');
    writeFileSync(join(source, 'skills', 'demo.txt'), 'skill\n', 'utf-8');

    syncCodexHome(source, target, '## Session\nUse Codex as the fallback runner.');

    expect(readFileSync(join(target, 'config.toml'), 'utf-8')).toContain('gpt-5.4');
    expect(readFileSync(join(target, 'auth.json'), 'utf-8')).toContain('access_token');
    expect(readFileSync(join(target, 'AGENTS.override.md'), 'utf-8')).toContain('Use Codex as the fallback runner.');
    expect(lstatSync(join(target, 'skills')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(target, 'plugins')).isSymbolicLink()).toBe(true);
  });
});
