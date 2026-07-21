/**
 * Tests for fork-engine pure functions (RYA-870 / RYA-751 Phase 2).
 *
 * Covers: trace navigation, edit validation, Claude Code JSONL truncate +
 * apply-edit + sessionId rewrite, fork-plan construction, file-snapshot
 * extraction, workspace path encoding.
 *
 * Filesystem-touching code (prepareForkWorkspace, restoreFromSnapshots,
 * spawnLiveContinuation) lives in replay-fork.ts and is exercised in the
 * orchestrator-level tests / manual smoke runs, not here.
 */

import { describe, it, expect } from 'vitest';

import {
  applyEdit,
  buildForkPlan,
  encodeWorkspacePath,
  extractFileSnapshotsUpTo,
  findMeta,
  findStep,
  parseClaudeJsonl,
  resolveStepUuid,
  rewriteSessionId,
  serializeJsonl,
  truncateAtUuid,
  validateEdit,
  type ClaudeJsonlRecord,
  type EditMutation,
  type TraceRecord,
} from './fork-engine.js';

// ---------- Fixtures ----------

const META: TraceRecord = {
  v: 'replay/v1',
  kind: 'meta',
  attempt_id: 'attempt-1',
  issue_key: 'RYA-XXX',
  agent_type: 'lead-engineer',
  agent_session_id: 'sid-original',
  workspace_path: '/test/agent-workspaces/RYA-XXX',
  extractor: {
    claude_jsonl_files: ['~/.claude/projects/-test-agent-workspaces-RYA-XXX/sid-original.jsonl'],
    sources_present: ['claude_jsonl'],
    sources_missing: [],
    degraded: false,
  },
};

const TRACE: TraceRecord[] = [
  META,
  { kind: 'lifecycle', seq: 0, source: 'monitor' },
  { kind: 'text', seq: 1, role: 'user', uuid: 'u1', content: 'first user prompt' },
  { kind: 'tool_call', seq: 2, role: 'assistant', uuid: 'a1', tool_name: 'Bash', tool_use_id: 'toolu_1' },
  { kind: 'tool_result', seq: 3, tool_use_id: 'toolu_1', content: 'original stdout' },
  { kind: 'attachment', seq: 4, subkind: 'file-history-snapshot', ts: '2026-05-06T10:00:00Z',
    original: { snapshot: { trackedFileBackups: { '/test/agent-workspaces/RYA-XXX/foo.ts': { backupPath: '/tmp/backup-foo.ts' } } } } },
  { kind: 'text', seq: 5, role: 'user', uuid: 'u2', content: 'second user prompt' },
];

const CLAUDE_JSONL: ClaudeJsonlRecord[] = [
  { type: 'user', uuid: 'u1', sessionId: 'sid-original',
    message: { role: 'user', content: 'first user prompt' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 'sid-original',
    message: { role: 'assistant', content: [{ type: 'tool_use', tool_use_id: 'toolu_1', name: 'Bash', input: {} }] } },
  { type: 'user', uuid: 'u_tr1', parentUuid: 'a1', sessionId: 'sid-original',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'original stdout', is_error: false }] },
    toolUseResult: { stdout: 'original stdout', stderr: '', interrupted: false, isImage: false } },
  { type: 'user', uuid: 'u2', parentUuid: 'u_tr1', sessionId: 'sid-original',
    message: { role: 'user', content: 'second user prompt' } },
];

// ---------- Trace navigation ----------

describe('findMeta', () => {
  it('returns the meta record', () => {
    expect(findMeta(TRACE)).toBe(META);
  });
  it('returns null when missing', () => {
    expect(findMeta([{ kind: 'text', seq: 0 }])).toBeNull();
  });
});

describe('findStep', () => {
  it('finds a record by seq', () => {
    const step = findStep(TRACE, 2);
    expect(step.kind).toBe('tool_call');
    expect(step.tool_name).toBe('Bash');
  });
  it('prefers user-text record on seq collision', () => {
    const trace: TraceRecord[] = [
      { kind: 'tool_call', seq: 9, role: 'assistant' },
      { kind: 'text', seq: 9, role: 'user', uuid: 'u9', content: 'pick me' },
    ];
    expect(findStep(trace, 9).uuid).toBe('u9');
  });
  it('prefers tool_result over other matches when no user-text present', () => {
    const trace: TraceRecord[] = [
      { kind: 'attachment', seq: 7 },
      { kind: 'tool_result', seq: 7, tool_use_id: 'toolu_x' },
    ];
    expect(findStep(trace, 7).kind).toBe('tool_result');
  });
  it('throws with seq range hint when not found', () => {
    expect(() => findStep(TRACE, 999)).toThrow(/seq values range 0..5/);
  });
});

// ---------- Edit validation ----------

describe('validateEdit', () => {
  it('accepts prompt edit on user-text step', () => {
    const step = findStep(TRACE, 1);
    expect(() => validateEdit(step, { kind: 'prompt', text: 'new' })).not.toThrow();
  });
  it('accepts prompt edit on lifecycle step (initial dispatch)', () => {
    expect(() => validateEdit({ kind: 'lifecycle', seq: 0 }, { kind: 'prompt', text: 'x' })).not.toThrow();
  });
  it('rejects prompt edit on tool_call step', () => {
    const step = findStep(TRACE, 2);
    expect(() => validateEdit(step, { kind: 'prompt', text: 'x' }))
      .toThrow(/--edit-prompt requires step 2 to be a user text record/);
  });
  it('accepts tool_result edit on tool_result step', () => {
    const step = findStep(TRACE, 3);
    expect(() => validateEdit(step, { kind: 'tool_result', text: 'x' })).not.toThrow();
  });
  it('rejects tool_result edit on text step', () => {
    const step = findStep(TRACE, 1);
    expect(() => validateEdit(step, { kind: 'tool_result', text: 'x' }))
      .toThrow(/--edit-tool-result requires step 1 to be a tool_result record/);
  });
});

// ---------- resolveStepUuid ----------

describe('resolveStepUuid', () => {
  it('returns step.uuid when present', () => {
    expect(resolveStepUuid(findStep(TRACE, 1), CLAUDE_JSONL)).toBe('u1');
  });
  it('falls back to JSONL scan for tool_result by tool_use_id', () => {
    expect(resolveStepUuid(findStep(TRACE, 3), CLAUDE_JSONL)).toBe('u_tr1');
  });
  it('throws with helpful message on degraded trace', () => {
    expect(() => resolveStepUuid({ kind: 'tool_call', seq: 99 }, CLAUDE_JSONL))
      .toThrow(/cannot resolve Claude Code uuid for step 99/);
  });
});

// ---------- Claude Code JSONL ops ----------

describe('parseClaudeJsonl', () => {
  it('parses well-formed lines', () => {
    const txt = '{"type":"user","uuid":"a"}\n{"type":"assistant","uuid":"b"}\n';
    expect(parseClaudeJsonl(txt)).toHaveLength(2);
  });
  it('skips malformed and blank lines', () => {
    const txt = '{"type":"user"}\nnot-json\n\n{"type":"assistant"}';
    const out = parseClaudeJsonl(txt);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('user');
    expect(out[1].type).toBe('assistant');
  });
});

describe('truncateAtUuid', () => {
  it('keeps records up to and including target uuid', () => {
    const out = truncateAtUuid(CLAUDE_JSONL, 'u_tr1');
    expect(out).toHaveLength(3);
    expect(out[out.length - 1].uuid).toBe('u_tr1');
  });
  it('throws when uuid not found', () => {
    expect(() => truncateAtUuid(CLAUDE_JSONL, 'nonexistent'))
      .toThrow(/uuid nonexistent not found/);
  });
});

describe('applyEdit — prompt', () => {
  it('rewrites user message content', () => {
    const truncated = truncateAtUuid(CLAUDE_JSONL, 'u1');
    const out = applyEdit(truncated, { kind: 'prompt', text: 'NEW PROMPT' }, {});
    expect(out[out.length - 1].message?.content).toBe('NEW PROMPT');
    // Original input is not mutated
    expect(CLAUDE_JSONL[0].message?.content).toBe('first user prompt');
  });
  it('throws when last record is not type=user', () => {
    const truncated = truncateAtUuid(CLAUDE_JSONL, 'a1');
    expect(() => applyEdit(truncated, { kind: 'prompt', text: 'x' }, {}))
      .toThrow(/last truncated record must be type=user \(got type=assistant\)/);
  });
  it('throws on empty record stream', () => {
    expect(() => applyEdit([], { kind: 'prompt', text: 'x' }, {}))
      .toThrow(/cannot apply edit to empty record stream/);
  });
});

describe('applyEdit — tool_result', () => {
  it('rewrites the matching tool_result content block + sidecar toolUseResult', () => {
    const truncated = truncateAtUuid(CLAUDE_JSONL, 'u_tr1');
    const out = applyEdit(truncated, { kind: 'tool_result', text: 'EDITED OUTPUT' },
      { stepToolUseId: 'toolu_1' });
    const last = out[out.length - 1];
    const block = (last.message?.content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>)[0];
    expect(block.content).toBe('EDITED OUTPUT');
    expect(block.is_error).toBe(false);
    expect(last.toolUseResult?.stdout).toBe('EDITED OUTPUT');
    expect(last.toolUseResult?.stderr).toBe('');
  });
  it('respects isError flag', () => {
    const truncated = truncateAtUuid(CLAUDE_JSONL, 'u_tr1');
    const out = applyEdit(truncated, { kind: 'tool_result', text: 'oops', isError: true },
      { stepToolUseId: 'toolu_1' });
    const block = (out[out.length - 1].message?.content as Array<{ is_error?: boolean }>)[0];
    expect(block.is_error).toBe(true);
  });
  it('throws when stepToolUseId missing', () => {
    const truncated = truncateAtUuid(CLAUDE_JSONL, 'u_tr1');
    expect(() => applyEdit(truncated, { kind: 'tool_result', text: 'x' }, {}))
      .toThrow(/missing tool_use_id from step record/);
  });
  it('throws when no matching tool_result block', () => {
    const truncated = truncateAtUuid(CLAUDE_JSONL, 'u_tr1');
    expect(() => applyEdit(truncated, { kind: 'tool_result', text: 'x' },
      { stepToolUseId: 'toolu_DOES_NOT_EXIST' }))
      .toThrow(/no tool_result block matched tool_use_id=toolu_DOES_NOT_EXIST/);
  });
});

describe('rewriteSessionId', () => {
  it('replaces sessionId on every record carrying one', () => {
    const out = rewriteSessionId(CLAUDE_JSONL, 'sid-fork');
    expect(out.every((r) => r.sessionId === 'sid-fork')).toBe(true);
  });
  it('does not add sessionId where absent', () => {
    const records: ClaudeJsonlRecord[] = [{ type: 'user', uuid: 'a' }];
    expect(rewriteSessionId(records, 'sid-x')[0].sessionId).toBeUndefined();
  });
});

describe('serializeJsonl', () => {
  it('round-trips through parse', () => {
    const txt = serializeJsonl(CLAUDE_JSONL);
    expect(parseClaudeJsonl(txt)).toEqual(CLAUDE_JSONL);
  });
});

// ---------- Fork plan ----------

describe('buildForkPlan', () => {
  it('produces a plan from a healthy trace', () => {
    const HOME = '/test/home';
    const STATE = '/test/home/.aos';
    const plan = buildForkPlan({
      trace: TRACE,
      fromStep: 1,
      edit: { kind: 'prompt', text: 'x' } as EditMutation,
      homeDir: HOME,
      stateDir: STATE,
    });
    expect(plan.parentSid).toBe('sid-original');
    expect(plan.parentWorkspacePath).toBe('/test/agent-workspaces/RYA-XXX');
    expect(plan.sourceJsonlPath).toBe(
      `${HOME}/.claude/projects/-test-agent-workspaces-RYA-XXX/sid-original.jsonl`,
    );
    expect(plan.workspacePath.startsWith(`${STATE}/forks/`)).toBe(true);
    expect(plan.seededJsonlPath.includes('.claude/projects/')).toBe(true);
    expect(plan.fromUuid).toBe('u1');
  });

  it('honors workspace, fork-id, fork-sid overrides', () => {
    const HOME = '/test/home';
    const plan = buildForkPlan({
      trace: TRACE,
      fromStep: 1,
      edit: { kind: 'prompt', text: 'x' } as EditMutation,
      forkId: 'fork-pinned',
      forkSid: 'sid-fork-pinned',
      workspacePath: '/tmp/custom-fork-ws',
      homeDir: HOME,
      stateDir: '/test/home/.aos',
    });
    expect(plan.forkId).toBe('fork-pinned');
    expect(plan.forkSid).toBe('sid-fork-pinned');
    expect(plan.workspacePath).toBe('/tmp/custom-fork-ws');
    // seededJsonlPath always lives under ~/.claude/projects encoding the workspace
    expect(plan.seededJsonlPath).toBe(
      `${HOME}/.claude/projects/-tmp-custom-fork-ws/sid-fork-pinned.jsonl`,
    );
  });

  it('rejects trace with no meta', () => {
    expect(() => buildForkPlan({
      trace: [{ kind: 'text', seq: 0 }],
      fromStep: 0,
      edit: { kind: 'prompt', text: 'x' } as EditMutation,
      homeDir: '/h',
      stateDir: '/h/.aos',
    })).toThrow(/trace missing meta record/);
  });

  it('rejects trace whose meta lacks workspace_path', () => {
    const trace: TraceRecord[] = [
      { kind: 'meta', agent_session_id: 'sid', extractor: { claude_jsonl_files: ['x'] } },
      { kind: 'text', seq: 0, role: 'user', uuid: 'u' },
    ];
    expect(() => buildForkPlan({
      trace, fromStep: 0,
      edit: { kind: 'prompt', text: 'x' } as EditMutation,
      homeDir: '/h', stateDir: '/h/.aos',
    })).toThrow(/meta missing workspace_path/);
  });

  it('rejects degraded capture with no Claude JSONL', () => {
    const trace: TraceRecord[] = [
      { kind: 'meta', agent_session_id: 'sid', workspace_path: '/ws',
        extractor: { claude_jsonl_files: [], sources_present: [], sources_missing: ['claude_jsonl'], degraded: true } },
      { kind: 'text', seq: 0, role: 'user', uuid: 'u' },
    ];
    expect(() => buildForkPlan({
      trace, fromStep: 0,
      edit: { kind: 'prompt', text: 'x' } as EditMutation,
      homeDir: '/h', stateDir: '/h/.aos',
    })).toThrow(/degraded capture/);
  });

  it('runs validateEdit (rejects mismatched edit/step)', () => {
    expect(() => buildForkPlan({
      trace: TRACE,
      fromStep: 2,           // tool_call step
      edit: { kind: 'prompt', text: 'x' } as EditMutation,
      homeDir: '/h', stateDir: '/h/.aos',
    })).toThrow(/--edit-prompt requires step 2/);
  });
});

// ---------- File snapshots ----------

describe('extractFileSnapshotsUpTo', () => {
  it('returns the latest snapshot per file before the cutoff', () => {
    const trace: TraceRecord[] = [
      { kind: 'attachment', seq: 1, subkind: 'file-history-snapshot', ts: 't1',
        original: { snapshot: { trackedFileBackups: { '/p/foo.ts': { backupPath: '/b/foo.ts' } } } } },
      { kind: 'attachment', seq: 2, subkind: 'file-history-snapshot', ts: 't2',
        original: { snapshot: { trackedFileBackups: { '/p/foo.ts': { backupPath: '/b/foo-v2.ts' } } } } },
      { kind: 'text', seq: 3, role: 'user' },
    ];
    const out = extractFileSnapshotsUpTo(trace, 3);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('/p/foo.ts');
    expect(out[0].backupPath).toBe('/b/foo-v2.ts');
  });
  it('excludes snapshots at or after cutoff', () => {
    const trace: TraceRecord[] = [
      { kind: 'attachment', seq: 5, subkind: 'file-history-snapshot', ts: 't',
        original: { snapshot: { trackedFileBackups: { '/p/x': { backupPath: '/b/x' } } } } },
    ];
    expect(extractFileSnapshotsUpTo(trace, 5)).toHaveLength(0);
  });
  it('skips records that aren\'t file-history-snapshots', () => {
    const trace: TraceRecord[] = [
      { kind: 'attachment', seq: 1, subkind: 'something-else' },
      { kind: 'text', seq: 2 },
    ];
    expect(extractFileSnapshotsUpTo(trace, 5)).toHaveLength(0);
  });
});

// ---------- Path encoding ----------

describe('encodeWorkspacePath', () => {
  it('replaces all slashes with dashes', () => {
    expect(encodeWorkspacePath('/test/agent-workspaces/RYA-751'))
      .toBe('-test-agent-workspaces-RYA-751');
  });
});
