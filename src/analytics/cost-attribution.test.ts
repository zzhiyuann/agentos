import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock config so DB writes go to in-memory SQLite per worker (matches db.test.ts pattern).
vi.mock('../core/config.js', () => ({
  getConfig: () => ({
    linearTeamId: 'test',
    linearTeamKey: 'TEST',
    imacHost: 'localhost',
    imacUser: 'test',
    workspaceBase: '/tmp/aos-test',
    dbPath: ':memory:',
    pollIntervalMs: 30000,
    stateDir: '/tmp/aos-test',
    tunnelUrl: '',
  }),
  STATE_DIR: '/tmp/aos-test',
}));

import {
  classifyTranscript,
  backfillWindow,
  summarize,
} from './cost-attribution.js';
import { DEFAULT_RULES, type ClassifierConfig } from './pnl-classifier.js';
import { getAttribution, getAttributionsForIssue } from '../core/db.js';

const cfg: ClassifierConfig = { defaultBucket: 'task', rules: DEFAULT_RULES };

/**
 * Build a JSONL transcript line representing one assistant message with given
 * tool calls and a usage record. Timestamp determines window membership.
 */
function assistantLine(opts: {
  timestamp: string;
  toolUses?: Array<{ name: string; input: Record<string, unknown> }>;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
}): string {
  const content: Array<unknown> = [];
  for (const tu of opts.toolUses ?? []) {
    content.push({ type: 'tool_use', name: tu.name, input: tu.input });
  }
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    message: {
      model: opts.model ?? 'claude-sonnet-4-6',
      content,
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
      },
    },
  });
}

describe('classifyTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cost-attr-'));
  });

  it('aggregates task vs meta tokens by message classification', () => {
    const path = join(tmpDir, 'sess-1.jsonl');
    const lines = [
      // Task: edit src/ file
      assistantLine({
        timestamp: '2026-04-01T10:00:00Z',
        toolUses: [{ name: 'Edit', input: { file_path: '/Users/x/projects/agentos/src/foo.ts' } }],
        inputTokens: 1000,
        outputTokens: 500,
      }),
      // Meta: edit HANDOFF.md
      assistantLine({
        timestamp: '2026-04-01T10:01:00Z',
        toolUses: [{ name: 'Edit', input: { file_path: '/Users/x/.aos/work/RYA-1/HANDOFF.md' } }],
        inputTokens: 200,
        outputTokens: 100,
      }),
      // Meta: linear-tool comment
      assistantLine({
        timestamp: '2026-04-01T10:02:00Z',
        toolUses: [{ name: 'Bash', input: { command: 'linear-tool comment RYA-1 "hi"' } }],
        inputTokens: 50,
        outputTokens: 25,
      }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = classifyTranscript(
      path,
      'RYA-1',
      'lead-engineer',
      cfg,
      Date.parse('2026-04-01T00:00:00Z'),
      Date.parse('2026-04-02T00:00:00Z'),
    );

    expect(result).not.toBeNull();
    expect(result!.taskMessages).toBe(1);
    expect(result!.metaMessages).toBe(2);
    expect(result!.taskTokens).toBe(1500);  // 1000 + 500
    expect(result!.metaTokens).toBe(375);   // 200+100 + 50+25
    // All 3 messages hit non-default rules → confidence = 1.0
    expect(result!.classificationConfidence).toBe(1);
    expect(result!.firstSeenIso).toBe('2026-04-01T10:00:00.000Z');
    expect(result!.lastSeenIso).toBe('2026-04-01T10:02:00.000Z');
    expect(result!.sessionId).toBe('sess-1');
  });

  it('lowers confidence when messages fall through to default bucket', () => {
    const path = join(tmpDir, 'sess-2.jsonl');
    const lines = [
      // Will hit a rule (Edit on src/)
      assistantLine({
        timestamp: '2026-04-01T10:00:00Z',
        toolUses: [{ name: 'Edit', input: { file_path: '/Users/x/src/a.ts' } }],
      }),
      // Empty content → no-tool-calls → default bucket
      assistantLine({ timestamp: '2026-04-01T10:01:00Z', toolUses: [] }),
      // Empty content
      assistantLine({ timestamp: '2026-04-01T10:02:00Z', toolUses: [] }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = classifyTranscript(
      path, 'RYA-2', 'cto', cfg,
      Date.parse('2026-04-01T00:00:00Z'),
      Date.parse('2026-04-02T00:00:00Z'),
    );

    expect(result).not.toBeNull();
    // 1 of 3 messages hit a real rule → confidence = 1/3
    expect(result!.classificationConfidence).toBeCloseTo(1 / 3, 5);
  });

  it('returns null when no messages fall in window', () => {
    const path = join(tmpDir, 'sess-3.jsonl');
    writeFileSync(path, assistantLine({ timestamp: '2026-01-01T00:00:00Z' }) + '\n');

    const result = classifyTranscript(
      path, 'RYA-3', 'cpo', cfg,
      Date.parse('2026-04-01T00:00:00Z'),
      Date.parse('2026-04-02T00:00:00Z'),
    );

    expect(result).toBeNull();
  });

  it('skips malformed lines without crashing', () => {
    const path = join(tmpDir, 'sess-4.jsonl');
    const lines = [
      'not-json-at-all',
      assistantLine({ timestamp: '2026-04-01T10:00:00Z' }),
      '{"type":"user"}',  // wrong type, not assistant
    ];
    writeFileSync(path, lines.join('\n') + '\n');

    const result = classifyTranscript(
      path, 'RYA-4', 'coo', cfg,
      Date.parse('2026-04-01T00:00:00Z'),
      Date.parse('2026-04-02T00:00:00Z'),
    );

    expect(result).not.toBeNull();
    expect(result!.taskMessages + result!.metaMessages).toBe(1);
  });
});

describe('backfillWindow', () => {
  let tmpProjects: string;

  beforeEach(() => {
    tmpProjects = mkdtempSync(join(tmpdir(), 'cost-attr-projects-'));
  });

  it('walks projects dir, classifies, and writes rows to SQLite', () => {
    const dirName = '-Users-user-agent-workspaces-RYA-100';
    const fullDir = join(tmpProjects, dirName);
    mkdirSync(fullDir, { recursive: true });
    writeFileSync(
      join(fullDir, 'session-aaa.jsonl'),
      assistantLine({
        timestamp: '2026-04-01T10:00:00Z',
        toolUses: [{ name: 'Edit', input: { file_path: '/Users/x/projects/agentos/src/foo.ts' } }],
      }) + '\n',
    );

    const issueRoles = new Map<string, string>([['RYA-100', 'lead-engineer']]);

    const result = backfillWindow({
      sinceMs: Date.parse('2026-04-01T00:00:00Z'),
      untilMs: Date.parse('2026-04-02T00:00:00Z'),
      projectsDir: tmpProjects,
      classifier: cfg,
      issueRoles,
    });

    expect(result.attributions).toHaveLength(1);
    expect(result.rowsWritten).toBe(1);
    expect(result.attributions[0].sessionId).toBe('session-aaa');
    expect(result.attributions[0].role).toBe('lead-engineer');

    // Verify it was actually persisted
    const persisted = getAttribution('session-aaa');
    expect(persisted).toBeDefined();
    expect(persisted!.issue_key).toBe('RYA-100');
    expect(persisted!.role).toBe('lead-engineer');
    expect(persisted!.task_messages).toBe(1);
  });

  it('counts unattributed when issue has no role mapping', () => {
    const dirName = '-Users-user-agent-workspaces-RYA-200';
    const fullDir = join(tmpProjects, dirName);
    mkdirSync(fullDir, { recursive: true });
    writeFileSync(join(fullDir, 'session-bbb.jsonl'),
      assistantLine({ timestamp: '2026-04-01T10:00:00Z' }) + '\n');

    const result = backfillWindow({
      sinceMs: Date.parse('2026-04-01T00:00:00Z'),
      untilMs: Date.parse('2026-04-02T00:00:00Z'),
      projectsDir: tmpProjects,
      classifier: cfg,
      issueRoles: new Map(),  // empty — no mapping
    });

    expect(result.attributions).toHaveLength(0);
    expect(result.unattributedSessions).toBe(1);
  });

  it('UPSERT is idempotent on session_id', () => {
    const dirName = '-Users-user-agent-workspaces-RYA-300';
    const fullDir = join(tmpProjects, dirName);
    mkdirSync(fullDir, { recursive: true });
    const sessionPath = join(fullDir, 'session-ccc.jsonl');
    writeFileSync(sessionPath,
      assistantLine({
        timestamp: '2026-04-01T10:00:00Z',
        toolUses: [{ name: 'Edit', input: { file_path: '/Users/x/src/a.ts' } }],
        inputTokens: 100, outputTokens: 50,
      }) + '\n');

    const issueRoles = new Map<string, string>([['RYA-300', 'cto']]);

    backfillWindow({
      sinceMs: Date.parse('2026-04-01T00:00:00Z'),
      projectsDir: tmpProjects,
      classifier: cfg,
      issueRoles,
    });

    // Re-run with the SAME session — should not duplicate, just refresh.
    backfillWindow({
      sinceMs: Date.parse('2026-04-01T00:00:00Z'),
      projectsDir: tmpProjects,
      classifier: cfg,
      issueRoles,
    });

    const rows = getAttributionsForIssue('RYA-300');
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe('session-ccc');
  });

  it('dryRun does not write to DB', () => {
    const dirName = '-Users-user-agent-workspaces-RYA-400';
    const fullDir = join(tmpProjects, dirName);
    mkdirSync(fullDir, { recursive: true });
    writeFileSync(join(fullDir, 'session-ddd.jsonl'),
      assistantLine({ timestamp: '2026-04-01T10:00:00Z' }) + '\n');

    const result = backfillWindow({
      sinceMs: Date.parse('2026-04-01T00:00:00Z'),
      projectsDir: tmpProjects,
      classifier: cfg,
      issueRoles: new Map([['RYA-400', 'cpo']]),
      dryRun: true,
    });

    expect(result.attributions).toHaveLength(1);
    expect(result.rowsWritten).toBe(0);
    expect(getAttribution('session-ddd')).toBeUndefined();
  });

  it('skips non-agent-workspace dirs', () => {
    mkdirSync(join(tmpProjects, 'random-non-aos-dir'));
    writeFileSync(join(tmpProjects, 'random-non-aos-dir', 'foo.jsonl'),
      assistantLine({ timestamp: '2026-04-01T10:00:00Z' }) + '\n');

    const result = backfillWindow({
      sinceMs: Date.parse('2026-04-01T00:00:00Z'),
      projectsDir: tmpProjects,
      classifier: cfg,
      issueRoles: new Map(),
    });

    expect(result.attributions).toHaveLength(0);
    expect(result.unattributedSessions).toBe(0);
  });
});

describe('summarize', () => {
  it('aggregates totals + meta-tax % across attributions', () => {
    const result = summarize({
      sinceMs: 0, untilMs: 0, rowsWritten: 0, unattributedSessions: 0, skippedOutOfWindow: 0,
      attributions: [
        {
          sessionId: 'a', issueKey: 'RYA-1', role: 'cto', attemptId: null,
          taskTokens: 1000, metaTokens: 500,
          taskCostUsd: 0.5, metaCostUsd: 0.2,
          taskMessages: 5, metaMessages: 2,
          classificationConfidence: 0.9,
          firstSeenIso: null, lastSeenIso: null, transcriptPath: '',
        },
        {
          sessionId: 'b', issueKey: 'RYA-2', role: 'cto', attemptId: 'attempt-x',
          taskTokens: 500, metaTokens: 1500,
          taskCostUsd: 0.1, metaCostUsd: 0.4,
          taskMessages: 1, metaMessages: 4,
          classificationConfidence: 0.4,  // low confidence
          firstSeenIso: null, lastSeenIso: null, transcriptPath: '',
        },
      ],
    });

    expect(result.sessions).toBe(2);
    expect(result.rolesCovered).toBe(1);
    expect(result.issuesCovered).toBe(2);
    expect(result.totalTaskTokens).toBe(1500);
    expect(result.totalMetaTokens).toBe(2000);
    // 2000 / 3500 ≈ 57.14%
    expect(result.metaTaxPct).toBeCloseTo(57.14, 1);
    expect(result.meanConfidence).toBeCloseTo(0.65, 5);
    expect(result.lowConfidenceSessions).toBe(1);  // session b
    expect(result.matchedAttempts).toBe(1);  // session b only
  });

  it('handles empty result', () => {
    const result = summarize({
      sinceMs: 0, untilMs: 0, rowsWritten: 0, unattributedSessions: 0, skippedOutOfWindow: 0,
      attributions: [],
    });
    expect(result.sessions).toBe(0);
    expect(result.metaTaxPct).toBe(0);
    expect(result.meanConfidence).toBe(0);
  });
});

// Cleanup any leftover tmp dirs (best-effort)
import { afterAll } from 'vitest';
afterAll(() => {
  try {
    rmSync('/tmp/aos-test', { recursive: true, force: true });
  } catch {
    // ignore
  }
});
