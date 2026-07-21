import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs';
import { join } from 'path';

const TEST_STATE_DIR = '/tmp/aos-dream-test';

// vi.mock is hoisted — factories use hardcoded paths / fns.
vi.mock('./persona.js', () => ({
  getAgentsDir: () => '/tmp/aos-dream-test/agents',
  listAgents: () => ['dream-role-a', 'dream-role-b'],
}));

const mockGrades = vi.fn((_role: string, _since: string): unknown[] => []);
const mockAttempts = vi.fn((_role: string, _since: string): unknown[] => []);
vi.mock('./db.js', () => ({
  getGradesForRoleSince: (role: string, since: string) => mockGrades(role, since),
  getCompletedAttemptsForRoleSince: (role: string, since: string) => mockAttempts(role, since),
}));

import {
  runDream, buildDreamPrompt, dreamModel, DREAM_PROMPT_CAP_CHARS,
  type ClaudeRunner,
} from './dream.js';

const AGENTS_DIR = join(TEST_STATE_DIR, 'agents');

function memoryDir(role: string): string {
  return join(AGENTS_DIR, role, 'memory');
}

function writeMemory(role: string, file: string, content: string, mtime?: Date): void {
  mkdirSync(memoryDir(role), { recursive: true });
  const p = join(memoryDir(role), file);
  writeFileSync(p, content, 'utf-8');
  if (mtime) utimesSync(p, mtime, mtime);
}

function grade(issueKey: string, verdict: string, score: number | null = 7, critique = ''): unknown {
  return { attempt_id: 'a1', issue_key: issueKey, verdict, score, critique, model: 'm', graded_at: new Date().toISOString() };
}

function attempt(issueKey: string): unknown {
  return {
    id: 'a1', issue_id: 'i1', issue_key: issueKey, agent_session_id: null,
    agent_type: 'dream-role-a', runner_session_id: null, tmux_session: null,
    attempt_number: 1, status: 'completed', host: 'h', workspace_path: null,
    budget_usd: null, cost_usd: 0, created_at: '', updated_at: '',
    completed_at: new Date().toISOString(), error_log: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT reset implementations — restore the defaults so
  // mockImplementation calls don't leak across tests.
  mockGrades.mockImplementation(() => []);
  mockAttempts.mockImplementation(() => []);
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  mkdirSync(AGENTS_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

describe('dreamModel', () => {
  it('defaults to claude-sonnet-4-6 and honours AOS_DREAM_MODEL', () => {
    delete process.env.AOS_DREAM_MODEL;
    expect(dreamModel()).toBe('claude-sonnet-4-6');
    process.env.AOS_DREAM_MODEL = 'claude-haiku-4-5';
    try {
      expect(dreamModel()).toBe('claude-haiku-4-5');
    } finally {
      delete process.env.AOS_DREAM_MODEL;
    }
  });
});

describe('buildDreamPrompt', () => {
  it('includes grades, attempts and memory files', () => {
    const prompt = buildDreamPrompt('dream-role-a', {
      grades: [grade('RYA-1', 'fail', 4, 'Handoff lacked verification')] as never[],
      attempts: [attempt('RYA-1')] as never[],
      memoryFiles: ['rya-1-findings.md'],
    }, '2026-06-10');
    expect(prompt).toContain('dream-role-a');
    expect(prompt).toContain('RYA-1');
    expect(prompt).toContain('fail');
    expect(prompt).toContain('Handoff lacked verification');
    expect(prompt).toContain('rya-1-findings.md');
    expect(prompt).toContain('500 tokens');
  });

  it('caps the prompt at DREAM_PROMPT_CAP_CHARS', () => {
    // Per-entry slices (20 grades × ≤400-char critiques) keep normal prompts
    // small; force overflow with pathological issue keys to exercise the cap.
    const grades = Array.from({ length: 20 }, (_, i) =>
      grade(`RYA-${i}-${'X'.repeat(2000)}`, 'pass', 8, 'x'.repeat(400))) as never[];
    const prompt = buildDreamPrompt('dream-role-a', { grades, attempts: [], memoryFiles: [] }, '2026-06-10');
    expect(prompt.length).toBeLessThanOrEqual(DREAM_PROMPT_CAP_CHARS + 100);
    expect(prompt).toContain('…(activity truncated)');
  });
});

describe('runDream', () => {
  it('skips roles with no activity and never calls the runner for them', async () => {
    const runner = vi.fn(async () => 'reflection text') as ClaudeRunner;
    const results = await runDream({ runner });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'skipped')).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it('writes a reflection file with frontmatter for active roles', async () => {
    mockGrades.mockImplementation((role) => role === 'dream-role-a' ? [grade('RYA-42', 'pass', 9)] : []);
    mockAttempts.mockImplementation((role) => role === 'dream-role-a' ? [attempt('RYA-42')] : []);

    const runner = vi.fn(async () => 'You shipped RYA-42 cleanly. Keep verifying before handoff.') as ClaudeRunner;
    const now = new Date('2026-06-10T04:00:00Z');
    const results = await runDream({ runner, now });

    const a = results.find(r => r.role === 'dream-role-a')!;
    const b = results.find(r => r.role === 'dream-role-b')!;
    expect(a.status).toBe('written');
    expect(b.status).toBe('skipped');
    expect(runner).toHaveBeenCalledTimes(1);

    const outPath = join(memoryDir('dream-role-a'), 'reflections-2026-06-10.md');
    expect(a.path).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    const content = readFileSync(outPath, 'utf-8');
    expect(content.startsWith('---\nname: reflections-2026-06-10\ndescription: nightly reflection\ntype: feedback\n---\n')).toBe(true);
    expect(content).toContain('Keep verifying before handoff.');
  });

  it('detects activity from memory files written in the window', async () => {
    const now = new Date();
    writeMemory('dream-role-b', 'rya-7-notes.md', 'fresh notes'); // mtime = now
    const runner = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('rya-7-notes.md');
      return 'Reflection about notes.';
    }) as ClaudeRunner;

    const results = await runDream({ runner, now });
    expect(results.find(r => r.role === 'dream-role-b')!.status).toBe('written');
  });

  it('ignores stale memory files and prior reflections', async () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    writeMemory('dream-role-a', 'old-notes.md', 'stale', old);
    writeMemory('dream-role-a', 'reflections-2026-06-09.md', 'yesterday dream'); // fresh but excluded

    const runner = vi.fn(async () => 'should not run') as ClaudeRunner;
    const results = await runDream({ runner });
    expect(results.find(r => r.role === 'dream-role-a')!.status).toBe('skipped');
    expect(runner).not.toHaveBeenCalled();
  });

  it('passes the AOS_DREAM_MODEL to the runner', async () => {
    process.env.AOS_DREAM_MODEL = 'claude-haiku-4-5';
    try {
      mockGrades.mockImplementation(() => [grade('RYA-1', 'pass')]);
      const runner = vi.fn(async (_p: string, model: string) => {
        expect(model).toBe('claude-haiku-4-5');
        return 'r';
      }) as ClaudeRunner;
      await runDream({ runner, roles: ['dream-role-a'] });
      expect(runner).toHaveBeenCalled();
    } finally {
      delete process.env.AOS_DREAM_MODEL;
    }
  });

  it('records per-role errors without blocking other roles, and fires one summary alert', async () => {
    mockGrades.mockImplementation(() => [grade('RYA-1', 'pass')]);
    const runner = vi.fn(async (prompt: string) => {
      if (prompt.includes('"dream-role-a"')) throw new Error('model exploded');
      return 'fine';
    }) as ClaudeRunner;
    const alert = vi.fn(async (_message: string) => true);

    const results = await runDream({ runner, alert });
    expect(results.find(r => r.role === 'dream-role-a')!.status).toBe('error');
    expect(results.find(r => r.role === 'dream-role-a')!.reason).toContain('model exploded');
    expect(results.find(r => r.role === 'dream-role-b')!.status).toBe('written');

    // depletion observability: failed headless calls must be loud
    expect(alert).toHaveBeenCalledTimes(1);
    const message = alert.mock.calls[0][0];
    expect(message).toContain('dream-role-a');
    expect(message).toContain('model exploded');
    expect(message).toContain('1/2');
  });

  it('treats an empty model response as an error (no empty memory files)', async () => {
    mockGrades.mockImplementation(() => [grade('RYA-1', 'pass')]);
    const runner = vi.fn(async () => '   ') as ClaudeRunner;
    const alert = vi.fn(async (_message: string) => true);
    const results = await runDream({ runner, roles: ['dream-role-a'], alert });
    expect(results[0].status).toBe('error');
    expect(existsSync(join(memoryDir('dream-role-a'), `reflections-${new Date().toISOString().slice(0, 10)}.md`))).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('does not alert when all roles succeed or skip', async () => {
    mockGrades.mockImplementation((role) => role === 'dream-role-a' ? [grade('RYA-1', 'pass')] : []);
    const runner = vi.fn(async () => 'a fine reflection') as ClaudeRunner;
    const alert = vi.fn(async (_message: string) => true);
    const results = await runDream({ runner, alert });
    expect(results.find(r => r.role === 'dream-role-a')!.status).toBe('written');
    expect(alert).not.toHaveBeenCalled();
  });

  it('a failing alert sink does not make runDream throw', async () => {
    mockGrades.mockImplementation(() => [grade('RYA-1', 'pass')]);
    const runner = vi.fn(async () => { throw new Error('exit 1: credit balance exhausted'); }) as ClaudeRunner;
    const alert = vi.fn(async (_message: string) => { throw new Error('discord down'); });
    const results = await runDream({ runner, roles: ['dream-role-a'], alert });
    expect(results[0].status).toBe('error');
  });
});
