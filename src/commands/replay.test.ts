import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hashCanonicalJson, parseClaudeJsonl } from './replay.js';
import type { Attempt } from '../core/db.js';

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'attempt-1',
    issue_id: 'issue-1',
    issue_key: 'RYA-1',
    agent_session_id: null,
    agent_type: 'lead-engineer',
    runner_session_id: null,
    tmux_session: null,
    attempt_number: 1,
    status: 'completed',
    host: 'test',
    workspace_path: '/tmp/ws',
    budget_usd: null,
    cost_usd: 0,
    created_at: '2026-05-03T00:00:00Z',
    updated_at: '2026-05-03T00:01:00Z',
    completed_at: '2026-05-03T01:00:00Z',
    error_log: null,
    ...overrides,
  };
}

describe('hashCanonicalJson', () => {
  it('is stable across key order', () => {
    const a = hashCanonicalJson({ b: 2, a: 1 });
    const b = hashCanonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('is stable across nested object key order', () => {
    const a = hashCanonicalJson({ x: { b: 2, a: 1 } });
    const b = hashCanonicalJson({ x: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it('distinguishes null from missing string', () => {
    const a = hashCanonicalJson({ x: null });
    const b = hashCanonicalJson({ x: '' });
    expect(a).not.toBe(b);
  });

  it('starts with sha256: prefix', () => {
    expect(hashCanonicalJson({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hashes undefined / null to empty hash', () => {
    const e = hashCanonicalJson(undefined);
    expect(e).toBe(hashCanonicalJson(null));
    expect(e).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('includes array order', () => {
    expect(hashCanonicalJson([1, 2, 3])).not.toBe(hashCanonicalJson([3, 2, 1]));
  });
});

describe('parseClaudeJsonl', () => {
  let tmpDir: string;
  let counter: number;
  const next = () => counter++;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'replay-jsonl-'));
    counter = 0;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJsonl(records: unknown[]): string {
    const path = join(tmpDir, 'session.jsonl');
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return path;
  }

  it('emits llm_io + rendered_context for each assistant turn', () => {
    const path = writeJsonl([
      {
        type: 'assistant',
        timestamp: '2026-05-03T00:00:30Z',
        uuid: 'a1',
        sessionId: 'sess-1',
        cwd: '/tmp/ws',
        gitBranch: 'main',
        version: '2.1.116',
        message: {
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          usage: { input_tokens: 6, output_tokens: 12 },
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ]);
    const records = parseClaudeJsonl(path, makeAttempt(), next, {});
    const kinds = records.map((r) => r.kind);
    expect(kinds).toEqual(['llm_io', 'rendered_context', 'text']);

    const ctx = records[1] as Record<string, unknown>;
    expect(ctx.turn_uuid).toBe('a1');
    expect(ctx.model_id).toBe('claude-opus-4-7');
    expect(ctx.rendered).toBe(false);
    expect(ctx.rendered_system_prompt).toBeNull();
    const genAi = ctx.gen_ai as Record<string, unknown>;
    expect(genAi['gen_ai.request.model']).toBe('claude-opus-4-7');
    expect(genAi['gen_ai.conversation.id']).toBe('sess-1');
    expect(genAi['gen_ai.usage.input_tokens']).toBe(6);
    expect(genAi['gen_ai.usage.output_tokens']).toBe(12);
  });

  it('pairs tool_call with tool_result and emits supplement', () => {
    const path = writeJsonl([
      {
        type: 'assistant',
        timestamp: '2026-05-03T00:00:30Z',
        uuid: 'a1',
        sessionId: 'sess-1',
        message: {
          model: 'claude-opus-4-7',
          content: [
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls', timeout: 5000 } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-05-03T00:00:31Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'output text' },
          ],
        },
      },
    ]);
    const records = parseClaudeJsonl(path, makeAttempt(), next, {});
    const supp = records.find((r) => r.kind === 'tool_result_supplement') as Record<string, unknown>;
    expect(supp).toBeDefined();
    expect(supp.tool_use_id).toBe('tu1');
    expect(supp.tool_name).toBe('Bash');
    expect(supp.duration_ms).toBe(1000);
    expect(supp.input_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(supp.result_bytes_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Same input hash regardless of input key order
    expect(supp.input_hash).toBe(hashCanonicalJson({ timeout: 5000, command: 'ls' }));
    expect(supp.is_orphan).toBeUndefined();
  });

  it('emits orphan supplement for unmatched tool_call', () => {
    const path = writeJsonl([
      {
        type: 'assistant',
        timestamp: '2026-05-03T00:00:30Z',
        uuid: 'a1',
        sessionId: 'sess-1',
        message: {
          model: 'claude-opus-4-7',
          content: [{ type: 'tool_use', id: 'tu_orphan', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      // No tool_result — session ended mid-turn.
    ]);
    const records = parseClaudeJsonl(path, makeAttempt(), next, {});
    const orphan = records.find((r) => r.kind === 'tool_result_supplement') as Record<string, unknown>;
    expect(orphan).toBeDefined();
    expect(orphan.tool_use_id).toBe('tu_orphan');
    expect(orphan.is_orphan).toBe(true);
    expect(orphan.result_bytes_sha256).toBeNull();
    expect(orphan.duration_ms).toBeNull();
  });

  it('respects noThinking option', () => {
    const path = writeJsonl([
      {
        type: 'assistant',
        timestamp: '2026-05-03T00:00:30Z',
        uuid: 'a1',
        sessionId: 'sess-1',
        message: {
          model: 'claude-opus-4-7',
          content: [
            { type: 'thinking', thinking: 'secret CoT' },
            { type: 'text', text: 'visible' },
          ],
        },
      },
    ]);
    const withThinking = parseClaudeJsonl(path, makeAttempt(), next, {});
    expect(withThinking.find((r) => r.kind === 'thinking')).toBeDefined();
    counter = 0;
    const withoutThinking = parseClaudeJsonl(path, makeAttempt(), next, { noThinking: true });
    expect(withoutThinking.find((r) => r.kind === 'thinking')).toBeUndefined();
    expect(withoutThinking.find((r) => r.kind === 'text')).toBeDefined();
  });

  it('filters records outside the attempt window', () => {
    const path = writeJsonl([
      {
        type: 'assistant',
        timestamp: '2025-01-01T00:00:00Z',  // way before attempt window
        uuid: 'old',
        sessionId: 'sess-1',
        message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'old' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-05-03T00:00:30Z',
        uuid: 'now',
        sessionId: 'sess-1',
        message: { model: 'claude-opus-4-7', content: [{ type: 'text', text: 'now' }] },
      },
    ]);
    const records = parseClaudeJsonl(path, makeAttempt(), next, {});
    const llmIos = records.filter((r) => r.kind === 'llm_io');
    expect(llmIos).toHaveLength(1);
    expect((llmIos[0] as Record<string, unknown>).uuid).toBe('now');
  });

  it('returns [] gracefully when file missing', () => {
    const records = parseClaudeJsonl('/nonexistent/path.jsonl', makeAttempt(), next, {});
    expect(records).toEqual([]);
  });
});
