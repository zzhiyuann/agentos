import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  issueKeyFromProjectDir,
  aggregateWindow,
} from './pnl-aggregator.js';
import { DEFAULT_RULES, type ClassifierConfig } from './pnl-classifier.js';

const cfg: ClassifierConfig = { defaultBucket: 'task', rules: DEFAULT_RULES };

describe('issueKeyFromProjectDir', () => {
  it('extracts issue key from agent-workspaces dir name', () => {
    expect(issueKeyFromProjectDir('-Users-user-agent-workspaces-RYA-620')).toBe('RYA-620');
  });

  it('returns null for non-workspace dirs', () => {
    expect(issueKeyFromProjectDir('-Users-user-Documents-something')).toBeNull();
    expect(issueKeyFromProjectDir('random-dir')).toBeNull();
  });
});

describe('aggregateWindow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `pnl-test-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  function writeJsonl(dir: string, file: string, lines: object[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('attributes meta and task tokens correctly', () => {
    const sessionDir = join(tmpDir, '-Users-user-agent-workspaces-RYA-100');
    const ts = new Date().toISOString();
    writeJsonl(sessionDir, 'sess1.jsonl', [
      { type: 'system', sessionId: 'sess1' },
      // task message: edits src/
      {
        type: 'assistant',
        timestamp: ts,
        message: {
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/x/src/foo.ts' } },
          ],
          usage: { input_tokens: 100, output_tokens: 200 },
        },
      },
      // meta message: writes HANDOFF.md
      {
        type: 'assistant',
        timestamp: ts,
        message: {
          model: 'claude-sonnet-4-6',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/x/.aos/work/RYA-100/HANDOFF.md' } },
          ],
          usage: { input_tokens: 50, output_tokens: 50 },
        },
      },
    ]);

    const data = aggregateWindow({
      sinceMs: Date.now() - 3600_000,
      projectsDir: tmpDir,
      classifier: cfg,
      issueRoles: new Map([['RYA-100', 'lead-engineer']]),
    });

    expect(data.sessionCount).toBe(1);
    expect(data.totals.taskTokens).toBe(300);
    expect(data.totals.metaTokens).toBe(100);
    expect(data.perRole.get('lead-engineer')?.metaTokens).toBe(100);
    expect(data.perIssue.get('RYA-100')?.role).toBe('lead-engineer');
  });

  it('skips sessions whose role cannot be resolved', () => {
    const sessionDir = join(tmpDir, '-Users-user-agent-workspaces-RYA-999');
    const ts = new Date().toISOString();
    writeJsonl(sessionDir, 'sess.jsonl', [
      {
        type: 'assistant',
        timestamp: ts,
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/x.ts' } }],
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      },
    ]);

    const data = aggregateWindow({
      sinceMs: Date.now() - 3600_000,
      projectsDir: tmpDir,
      classifier: cfg,
      issueRoles: new Map(),
    });

    expect(data.sessionCount).toBe(0);
    expect(data.unattributedSessions).toBe(1);
  });

  it('respects time window — drops messages outside range', () => {
    const sessionDir = join(tmpDir, '-Users-user-agent-workspaces-RYA-200');
    const oldTs = new Date(Date.now() - 14 * 24 * 3600_000).toISOString(); // 14 days ago
    const recentTs = new Date().toISOString();
    writeJsonl(sessionDir, 'sess.jsonl', [
      {
        type: 'assistant',
        timestamp: oldTs,
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/x.ts' } }],
          usage: { input_tokens: 1000, output_tokens: 1000 },
        },
      },
      {
        type: 'assistant',
        timestamp: recentTs,
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/src/x.ts' } }],
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      },
    ]);

    const data = aggregateWindow({
      sinceMs: Date.now() - 7 * 24 * 3600_000,
      projectsDir: tmpDir,
      classifier: cfg,
      issueRoles: new Map([['RYA-200', 'cto']]),
    });

    // Only recent message counts
    expect(data.totals.taskTokens).toBe(10);
  });

  it('handles missing usage gracefully', () => {
    const sessionDir = join(tmpDir, '-Users-user-agent-workspaces-RYA-300');
    const ts = new Date().toISOString();
    writeJsonl(sessionDir, 'sess.jsonl', [
      { type: 'assistant', timestamp: ts, message: { content: [], model: 'claude-sonnet-4-6' } },
      { type: 'user', timestamp: ts, message: { content: 'hi' } },
    ]);

    const data = aggregateWindow({
      sinceMs: Date.now() - 3600_000,
      projectsDir: tmpDir,
      classifier: cfg,
      issueRoles: new Map([['RYA-300', 'cpo']]),
    });

    // No usage means no contribution; no session entry created
    expect(data.totals.taskTokens).toBe(0);
    expect(data.totals.metaTokens).toBe(0);
  });

  it('returns empty result when projects dir does not exist', () => {
    const data = aggregateWindow({
      sinceMs: Date.now() - 3600_000,
      projectsDir: join(tmpDir, 'does-not-exist'),
      classifier: cfg,
      issueRoles: new Map(),
    });
    expect(data.sessionCount).toBe(0);
    expect(data.totals.taskTokens).toBe(0);
  });

  // Cleanup at end of suite via tmpDir scope
  it('cleanup', () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
