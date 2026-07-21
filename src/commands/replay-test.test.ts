import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertToolSequence,
  assertFileState,
  assertExitCode,
  extractToolSequence,
  extractFileState,
  extractStatus,
  replayTestCommand,
} from './replay-test.js';

interface ReplayRecord {
  v?: string;
  kind?: string;
  [key: string]: unknown;
}

function metaRecord(status: string): ReplayRecord {
  return { v: 'replay/v1', kind: 'meta', attempt_id: 'a', issue_key: 'X-1', status };
}

function toolCall(seq: number, name: string): ReplayRecord {
  return { v: 'replay/v1', kind: 'tool_call', seq, source: 'claude-jsonl', tool_name: name, tool_use_id: `t${seq}` };
}

function fileDiff(path: string, sha: string, op = 'final'): ReplayRecord {
  return { v: 'replay/v1', kind: 'file_diff', seq: 100, source: 'workspace', path, sha256: sha, operation: op };
}

describe('extractToolSequence', () => {
  it('returns tool names in seq order', () => {
    const trace = [toolCall(2, 'Bash'), toolCall(1, 'Read'), toolCall(3, 'Write')];
    expect(extractToolSequence(trace)).toEqual(['Read', 'Bash', 'Write']);
  });

  it('ignores non-tool_call records', () => {
    const trace = [
      metaRecord('completed'),
      { kind: 'text', seq: 1, content: 'hi' },
      toolCall(2, 'Bash'),
    ];
    expect(extractToolSequence(trace)).toEqual(['Bash']);
  });

  it('returns [] on empty trace', () => {
    expect(extractToolSequence([])).toEqual([]);
  });
});

describe('extractFileState', () => {
  it('builds path -> sha256 map', () => {
    const trace = [fileDiff('HANDOFF.md', 'abc123'), fileDiff('PROGRESS.md', 'def456')];
    expect(extractFileState(trace)).toEqual({ 'HANDOFF.md': 'abc123', 'PROGRESS.md': 'def456' });
  });

  it('marks removed files', () => {
    const trace = [fileDiff('OLD.md', 'xxx', 'removed')];
    expect(extractFileState(trace)).toEqual({ 'OLD.md': '<removed>' });
  });

  it('skips records without sha256', () => {
    const trace: ReplayRecord[] = [{ kind: 'file_diff', path: 'X.md', operation: 'final' }];
    expect(extractFileState(trace)).toEqual({});
  });
});

describe('extractStatus', () => {
  it('reads meta.status', () => {
    expect(extractStatus([metaRecord('completed')])).toBe('completed');
  });
  it('returns null when meta missing', () => {
    expect(extractStatus([toolCall(1, 'X')])).toBeNull();
  });
});

describe('assertToolSequence', () => {
  it('passes when sequences match', () => {
    const t = [toolCall(1, 'Bash'), toolCall(2, 'Read')];
    const r = assertToolSequence(t, t);
    expect(r.passed).toBe(true);
    expect(r.mode).toBe('tool-sequence');
  });

  it('fails on length mismatch', () => {
    const t = [toolCall(1, 'Bash')];
    const b = [toolCall(1, 'Bash'), toolCall(2, 'Read')];
    const r = assertToolSequence(t, b);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/Length mismatch/);
  });

  it('reports first divergence index', () => {
    const t = [toolCall(1, 'Bash'), toolCall(2, 'Edit'), toolCall(3, 'Write')];
    const b = [toolCall(1, 'Bash'), toolCall(2, 'Read'), toolCall(3, 'Write')];
    const r = assertToolSequence(t, b);
    expect(r.passed).toBe(false);
    expect(r.details?.firstDivergence).toBe(1);
  });

  it('passes intrinsic-only when no baseline', () => {
    const t = [toolCall(1, 'Bash')];
    const r = assertToolSequence(t, null);
    expect(r.passed).toBe(true);
    expect((r.details?.sequence as string[])).toEqual(['Bash']);
  });
});

describe('assertFileState', () => {
  it('passes when shas match', () => {
    const t = [fileDiff('A.md', 'aaa')];
    const r = assertFileState(t, t);
    expect(r.passed).toBe(true);
  });

  it('fails on diverged sha', () => {
    const t = [fileDiff('A.md', 'aaa')];
    const b = [fileDiff('A.md', 'bbb')];
    const r = assertFileState(t, b);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/diverged on 1 path/);
  });

  it('fails when baseline has extra path', () => {
    const t = [fileDiff('A.md', 'aaa')];
    const b = [fileDiff('A.md', 'aaa'), fileDiff('B.md', 'bbb')];
    const r = assertFileState(t, b);
    expect(r.passed).toBe(false);
    const diffs = r.details?.diffs as Array<{ path: string }>;
    expect(diffs.map((d) => d.path)).toContain('B.md');
  });
});

describe('assertExitCode', () => {
  it('passes when status matches baseline', () => {
    const t = [metaRecord('completed')];
    const r = assertExitCode(t, t);
    expect(r.passed).toBe(true);
  });

  it('passes against default "completed" with no baseline', () => {
    const t = [metaRecord('completed')];
    const r = assertExitCode(t, null);
    expect(r.passed).toBe(true);
  });

  it('fails on status mismatch with baseline', () => {
    const t = [metaRecord('failed')];
    const b = [metaRecord('completed')];
    const r = assertExitCode(t, b);
    expect(r.passed).toBe(false);
  });

  it('honors --expected-status override', () => {
    const t = [metaRecord('failed')];
    const r = assertExitCode(t, null, 'failed');
    expect(r.passed).toBe(true);
  });

  it('fails when meta missing', () => {
    const t = [toolCall(1, 'Bash')];
    const r = assertExitCode(t, null);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/<missing>/);
  });
});

describe('replayTestCommand (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  function writeJsonl(name: string, records: ReplayRecord[]): string {
    const path = join(tmpDir, name);
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return path;
  }

  it('exits 0 on matching tool sequence', async () => {
    const records = [metaRecord('completed'), toolCall(1, 'Bash'), toolCall(2, 'Read')];
    const trace = writeJsonl('trace.jsonl', records);
    const baseline = writeJsonl('baseline.jsonl', records);

    await replayTestCommand(trace, { baseline, assert: ['tool-sequence'], json: true });
    expect(process.exitCode).not.toBe(1);
  });

  it('exits 1 on diverged tool sequence', async () => {
    const trace = writeJsonl('trace.jsonl', [metaRecord('completed'), toolCall(1, 'Bash')]);
    const baseline = writeJsonl('baseline.jsonl', [metaRecord('completed'), toolCall(1, 'Read')]);

    await replayTestCommand(trace, { baseline, assert: ['tool-sequence'], json: true });
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when trace file missing', async () => {
    await replayTestCommand(join(tmpDir, 'nope.jsonl'), { assert: ['exit-code'] });
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 with no assert modes', async () => {
    const trace = writeJsonl('trace.jsonl', [metaRecord('completed')]);
    await replayTestCommand(trace, {});
    expect(process.exitCode).toBe(1);
  });

  it('runs all three modes when comma-separated', async () => {
    const records = [metaRecord('completed'), toolCall(1, 'Bash'), fileDiff('HANDOFF.md', 'aaa')];
    const trace = writeJsonl('trace.jsonl', records);
    const baseline = writeJsonl('baseline.jsonl', records);

    await replayTestCommand(trace, {
      baseline,
      assert: ['tool-sequence,file-state,exit-code'],
      json: true,
    });
    expect(process.exitCode).not.toBe(1);
  });

  it('intrinsic check passes without baseline when status is completed', async () => {
    const trace = writeJsonl('trace.jsonl', [metaRecord('completed')]);
    await replayTestCommand(trace, { assert: ['exit-code'], json: true });
    expect(process.exitCode).not.toBe(1);
  });
});
