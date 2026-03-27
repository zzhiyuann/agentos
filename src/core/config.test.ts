import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig, resolveWorkspace, getIssueStateDir, resolveStatePath } from './config.js';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TEST_ENV = {
  AOS_LINEAR_TEAM_ID: 'test-team-uuid-1234',
  AOS_LINEAR_TEAM_KEY: 'TST',
  AOS_HOST: '192.168.1.100',
  AOS_USER: 'testuser',
};

describe('getConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set test env vars
    for (const [key, val] of Object.entries(TEST_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }
  });

  afterEach(() => {
    // Restore original env vars
    for (const [key] of Object.entries(TEST_ENV)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('returns config from environment variables', () => {
    const config = getConfig();
    expect(config.linearTeamId).toBe('test-team-uuid-1234');
    expect(config.linearTeamKey).toBe('TST');
    expect(config.imacHost).toBe('192.168.1.100');
    expect(config.imacUser).toBe('testuser');
    expect(config.workspaceBase).toBe('~/agent-workspaces');
    expect(config.dbPath).toContain('.aos/state.db');
    expect(config.stateDir).toContain('.aos');
    expect(typeof config.pollIntervalMs).toBe('number');
  });

  it('throws when required env vars are missing', () => {
    delete process.env.AOS_LINEAR_TEAM_ID;
    expect(() => getConfig()).toThrow('Missing required environment variable: AOS_LINEAR_TEAM_ID');
  });

  it('reads tunnel URL from file', () => {
    const config = getConfig();
    expect(typeof config.tunnelUrl).toBe('string');
  });
});

describe('resolveWorkspace', () => {
  const testMapPath = join(homedir(), '.aos', 'workspace-map.json');
  let originalContent: string | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Set required env vars for getConfig()
    for (const [key, val] of Object.entries(TEST_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }
    // Save original workspace-map content
    try {
      const { readFileSync } = require('fs');
      originalContent = readFileSync(testMapPath, 'utf-8');
    } catch {
      originalContent = null;
    }
  });

  afterEach(() => {
    // Restore original content
    if (originalContent !== null) {
      writeFileSync(testMapPath, originalContent);
    }
    // Restore env vars
    for (const [key] of Object.entries(TEST_ENV)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('uses workspace-map.json when project matches', () => {
    writeFileSync(testMapPath, JSON.stringify({
      'project:TestProject': '~/projects/test-project',
      'default': '~/agent-workspaces',
    }));

    const result = resolveWorkspace('TST-99', 'TestProject');
    expect(result).toBe(join(homedir(), 'projects/test-project'));
  });

  it('falls back to default + issueKey when no project match', () => {
    writeFileSync(testMapPath, JSON.stringify({
      'project:Other': '~/projects/other',
      'default': '~/agent-workspaces',
    }));

    const result = resolveWorkspace('TST-99', 'NoMatch');
    expect(result).toContain('agent-workspaces/TST-99');
  });

  it('falls back to config workspaceBase when no map file', () => {
    const { renameSync } = require('fs');
    const backup = testMapPath + '.bak';
    try {
      if (existsSync(testMapPath)) renameSync(testMapPath, backup);
      const result = resolveWorkspace('TST-99');
      expect(result).toContain('agent-workspaces/TST-99');
    } finally {
      if (existsSync(backup)) renameSync(backup, testMapPath);
    }
  });

  it('resolves ~ to homedir in mapped paths', () => {
    writeFileSync(testMapPath, JSON.stringify({
      'project:MyProj': '~/my-project',
    }));

    const result = resolveWorkspace('TST-1', 'MyProj');
    expect(result).not.toContain('~');
    expect(result).toContain(homedir());
  });
});

describe('getIssueStateDir', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, val] of Object.entries(TEST_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }
  });

  afterEach(() => {
    for (const [key] of Object.entries(TEST_ENV)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('returns path under ~/.aos/work/{issueKey}', () => {
    const dir = getIssueStateDir('RYA-999');
    expect(dir).toBe(join(homedir(), '.aos', 'work', 'RYA-999'));
  });

  it('creates the directory', () => {
    const dir = getIssueStateDir('RYA-999');
    expect(existsSync(dir)).toBe(true);
    // cleanup
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns same path for same issue key', () => {
    const a = getIssueStateDir('RYA-100');
    const b = getIssueStateDir('RYA-100');
    expect(a).toBe(b);
    rmSync(a, { recursive: true, force: true });
  });
});

describe('resolveStatePath', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const testWorkspace = join(homedir(), '.aos', '_test_workspace_resolve');

  beforeEach(() => {
    for (const [key, val] of Object.entries(TEST_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }
    mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    for (const [key] of Object.entries(TEST_ENV)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(testWorkspace, { recursive: true, force: true });
    rmSync(getIssueStateDir('RYA-RESOLVE-1'), { recursive: true, force: true });
  });

  it('prefers state dir when file exists there', () => {
    const stateDir = getIssueStateDir('RYA-RESOLVE-1');
    writeFileSync(join(stateDir, 'HANDOFF.md'), 'state dir version');
    writeFileSync(join(testWorkspace, 'HANDOFF.md'), 'workspace version');

    const path = resolveStatePath('RYA-RESOLVE-1', testWorkspace, 'HANDOFF.md');
    expect(path).toBe(join(stateDir, 'HANDOFF.md'));
  });

  it('falls back to workspace when state dir file missing', () => {
    const path = resolveStatePath('RYA-RESOLVE-1', testWorkspace, 'HANDOFF.md');
    expect(path).toBe(join(testWorkspace, 'HANDOFF.md'));
  });

  it('works for BLOCKED.md', () => {
    const stateDir = getIssueStateDir('RYA-RESOLVE-1');
    writeFileSync(join(stateDir, 'BLOCKED.md'), 'blocked content');

    const path = resolveStatePath('RYA-RESOLVE-1', testWorkspace, 'BLOCKED.md');
    expect(path).toBe(join(stateDir, 'BLOCKED.md'));
  });
});
