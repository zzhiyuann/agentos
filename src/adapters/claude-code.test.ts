import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Capture the command passed to createTmuxSession so we can assert env exports.
const tmuxCommands: string[] = [];

vi.mock('../core/tmux.js', () => ({
  createTmuxSession: vi.fn((_name: string, _cwd: string, cmd: string) => {
    tmuxCommands.push(cmd);
  }),
  sessionExists: vi.fn(() => false),
  killSession: vi.fn(),
  capturePane: vi.fn(() => ''),
  writeFileOnRemote: vi.fn(),
  sendKeys: vi.fn(),
}));

vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test-state' }),
  getIssueStateDir: (key: string) => `/tmp/aos-test-state/${key}`,
}));

vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
}));

let workspace: string;
const originalEnv = process.env.AOS_CAPTURE_MODE;

beforeEach(() => {
  tmuxCommands.length = 0;
  workspace = mkdtempSync(join(tmpdir(), 'aos-cc-test-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env.AOS_CAPTURE_MODE;
  } else {
    process.env.AOS_CAPTURE_MODE = originalEnv;
  }
});

async function spawnAdapter(captureMode?: boolean, model?: string): Promise<string> {
  const { ClaudeCodeAdapter } = await import('./claude-code.js');
  const adapter = new ClaudeCodeAdapter();
  await adapter.spawn({
    issueKey: 'RYA-TEST',
    title: 'test',
    systemPrompt: 'persona',
    initialPrompt: 'do work',
    workspacePath: workspace,
    attemptNumber: 1,
    agentRole: 'cto',
    ...(captureMode !== undefined ? { captureMode } : {}),
    ...(model !== undefined ? { model } : {}),
  });
  expect(tmuxCommands.length).toBeGreaterThan(0);
  return tmuxCommands[tmuxCommands.length - 1];
}

describe('ClaudeCodeAdapter model override (A4.4 / RYA-1258)', () => {
  it('always passes --model even when opts.model is unset (uses fallback)', async () => {
    delete process.env.AOS_FALLBACK_CLAUDE_MODEL;
    const cmd = await spawnAdapter();
    expect(cmd).toContain('--model claude-sonnet-4-6');
  });

  it('passes --model <id> when opts.model is set', async () => {
    const cmd = await spawnAdapter(undefined, 'claude-opus-4-8');
    expect(cmd).toContain('claude --dangerously-skip-permissions --model claude-opus-4-8 --append-system-prompt-file');
  });

  it('AOS_FALLBACK_CLAUDE_MODEL env var overrides the hardcoded default', async () => {
    process.env.AOS_FALLBACK_CLAUDE_MODEL = 'claude-haiku-4-5';
    try {
      const cmd = await spawnAdapter();
      expect(cmd).toContain('--model claude-haiku-4-5');
    } finally {
      delete process.env.AOS_FALLBACK_CLAUDE_MODEL;
    }
  });

  it('opts.model takes precedence over AOS_FALLBACK_CLAUDE_MODEL', async () => {
    process.env.AOS_FALLBACK_CLAUDE_MODEL = 'claude-haiku-4-5';
    try {
      const cmd = await spawnAdapter(undefined, 'claude-opus-4-8');
      expect(cmd).toContain('--model claude-opus-4-8');
      expect(cmd).not.toContain('claude-haiku-4-5');
    } finally {
      delete process.env.AOS_FALLBACK_CLAUDE_MODEL;
    }
  });
});

describe('ClaudeCodeAdapter capture mode', () => {
  it('omits ANTHROPIC_LOG by default', async () => {
    delete process.env.AOS_CAPTURE_MODE;
    const cmd = await spawnAdapter();
    expect(cmd).not.toContain('ANTHROPIC_LOG');
  });

  it('injects ANTHROPIC_LOG=info when opts.captureMode=true', async () => {
    delete process.env.AOS_CAPTURE_MODE;
    const cmd = await spawnAdapter(true);
    expect(cmd).toContain('export ANTHROPIC_LOG=info');
  });

  it('injects ANTHROPIC_LOG=info when AOS_CAPTURE_MODE=1', async () => {
    process.env.AOS_CAPTURE_MODE = '1';
    const cmd = await spawnAdapter();
    expect(cmd).toContain('export ANTHROPIC_LOG=info');
  });

  it('opts.captureMode=false overrides AOS_CAPTURE_MODE=1', async () => {
    process.env.AOS_CAPTURE_MODE = '1';
    const cmd = await spawnAdapter(false);
    expect(cmd).not.toContain('ANTHROPIC_LOG');
  });
});
