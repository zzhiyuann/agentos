import { readFileSync, existsSync } from 'fs';
import chalk from 'chalk';

/**
 * `aos replay test <trace.jsonl> --assert <mode>`
 *
 * Pure trace-comparison tool. Reads a captured replay JSONL and asserts properties
 * against a baseline trace (or intrinsic checks if no baseline). Exits 1 on any
 * divergence — designed for CI regression gating on prompt / CLAUDE.md changes.
 *
 * Modes:
 *   tool-sequence  — ordered list of tool_call.tool_name matches baseline
 *   file-state     — final file_diff sha256/path map matches baseline
 *   exit-code      — meta.status matches baseline (or expected via --expected-status)
 */

type AssertMode = 'tool-sequence' | 'file-state' | 'exit-code';

const VALID_MODES: AssertMode[] = ['tool-sequence', 'file-state', 'exit-code'];

interface TestOptions {
  baseline?: string;
  assert?: string[];
  expectedStatus?: string;
  json?: boolean;
}

interface ReplayRecord {
  v?: string;
  kind?: string;
  [key: string]: unknown;
}

interface AssertResult {
  mode: AssertMode;
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

interface TestReport {
  trace: string;
  baseline: string | null;
  results: AssertResult[];
  passed: boolean;
}

export async function replayTestCommand(
  tracePath: string,
  options: TestOptions = {},
): Promise<void> {
  if (!existsSync(tracePath)) {
    console.error(chalk.red(`Trace file not found: ${tracePath}`));
    process.exitCode = 1;
    return;
  }

  const trace = readJsonl(tracePath);
  if (trace.length === 0) {
    console.error(chalk.red(`Trace is empty: ${tracePath}`));
    process.exitCode = 1;
    return;
  }

  const baseline = options.baseline ? readJsonl(options.baseline) : null;
  if (options.baseline && !existsSync(options.baseline)) {
    console.error(chalk.red(`Baseline file not found: ${options.baseline}`));
    process.exitCode = 1;
    return;
  }

  const modes = parseModes(options.assert);
  if (modes.length === 0) {
    console.error(chalk.red(`No assert modes specified. Use --assert tool-sequence|file-state|exit-code`));
    process.exitCode = 1;
    return;
  }

  const results: AssertResult[] = [];
  for (const mode of modes) {
    if (mode === 'tool-sequence') {
      results.push(assertToolSequence(trace, baseline));
    } else if (mode === 'file-state') {
      results.push(assertFileState(trace, baseline));
    } else if (mode === 'exit-code') {
      results.push(assertExitCode(trace, baseline, options.expectedStatus));
    }
  }

  const report: TestReport = {
    trace: tracePath,
    baseline: options.baseline ?? null,
    results,
    passed: results.every((r) => r.passed),
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}

function parseModes(raw: string[] | undefined): AssertMode[] {
  if (!raw || raw.length === 0) return [];
  const flat = raw.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  const out: AssertMode[] = [];
  for (const m of flat) {
    if ((VALID_MODES as string[]).includes(m)) {
      out.push(m as AssertMode);
    } else {
      console.error(chalk.yellow(`Unknown assert mode: ${m} — ignored`));
    }
  }
  return out;
}

function readJsonl(path: string): ReplayRecord[] {
  const content = readFileSync(path, 'utf-8');
  const out: ReplayRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ReplayRecord); } catch {
      // Skip malformed lines but record presence
    }
  }
  return out;
}

// ----- Assertions -----

export function assertToolSequence(
  trace: ReplayRecord[],
  baseline: ReplayRecord[] | null,
): AssertResult {
  const got = extractToolSequence(trace);
  if (!baseline) {
    return {
      mode: 'tool-sequence',
      passed: true,
      reason: 'No baseline — tool sequence recorded',
      details: { length: got.length, sequence: got },
    };
  }
  const want = extractToolSequence(baseline);

  if (got.length !== want.length) {
    return {
      mode: 'tool-sequence',
      passed: false,
      reason: `Length mismatch: got ${got.length} tool calls, baseline has ${want.length}`,
      details: { got, want, firstDivergence: firstDivergence(got, want) },
    };
  }

  const div = firstDivergence(got, want);
  if (div >= 0) {
    return {
      mode: 'tool-sequence',
      passed: false,
      reason: `Tool diverged at position ${div}: got "${got[div]}", baseline "${want[div]}"`,
      details: { got, want, firstDivergence: div },
    };
  }

  return {
    mode: 'tool-sequence',
    passed: true,
    reason: `All ${got.length} tool calls match baseline`,
    details: { length: got.length },
  };
}

export function assertFileState(
  trace: ReplayRecord[],
  baseline: ReplayRecord[] | null,
): AssertResult {
  const got = extractFileState(trace);
  if (!baseline) {
    return {
      mode: 'file-state',
      passed: true,
      reason: 'No baseline — file state recorded',
      details: { count: Object.keys(got).length, files: got },
    };
  }
  const want = extractFileState(baseline);

  const allPaths = new Set([...Object.keys(got), ...Object.keys(want)]);
  const diffs: Array<{ path: string; got: string | null; want: string | null }> = [];
  for (const p of allPaths) {
    const a = got[p] ?? null;
    const b = want[p] ?? null;
    if (a !== b) diffs.push({ path: p, got: a, want: b });
  }

  if (diffs.length > 0) {
    return {
      mode: 'file-state',
      passed: false,
      reason: `File state diverged on ${diffs.length} path(s): ${diffs.map((d) => d.path).join(', ')}`,
      details: { diffs, gotCount: Object.keys(got).length, wantCount: Object.keys(want).length },
    };
  }

  return {
    mode: 'file-state',
    passed: true,
    reason: `All ${Object.keys(got).length} files match baseline`,
    details: { count: Object.keys(got).length },
  };
}

export function assertExitCode(
  trace: ReplayRecord[],
  baseline: ReplayRecord[] | null,
  expectedStatus?: string,
): AssertResult {
  const got = extractStatus(trace);
  // Priority: explicit --expected-status > baseline status > default 'completed'
  const expected = expectedStatus ?? extractStatus(baseline ?? []) ?? 'completed';

  if (got !== expected) {
    return {
      mode: 'exit-code',
      passed: false,
      reason: `Exit status mismatch: got "${got ?? '<missing>'}", expected "${expected}"`,
      details: { got, expected },
    };
  }
  return {
    mode: 'exit-code',
    passed: true,
    reason: `Exit status "${got}" matches expected`,
    details: { got, expected },
  };
}

// ----- Extractors (exported for tests) -----

export function extractToolSequence(trace: ReplayRecord[]): string[] {
  const calls = trace
    .filter((r) => r.kind === 'tool_call' && typeof r.tool_name === 'string')
    .map((r) => ({ name: r.tool_name as string, seq: typeof r.seq === 'number' ? r.seq : 0 }));
  calls.sort((a, b) => a.seq - b.seq);
  return calls.map((c) => c.name);
}

export function extractFileState(trace: ReplayRecord[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of trace) {
    if (r.kind !== 'file_diff') continue;
    if (typeof r.path !== 'string') continue;
    if (r.operation === 'removed') {
      out[r.path] = '<removed>';
      continue;
    }
    if (typeof r.sha256 === 'string') {
      out[r.path] = r.sha256;
    }
  }
  return out;
}

export function extractStatus(trace: ReplayRecord[]): string | null {
  const meta = trace.find((r) => r.kind === 'meta');
  if (!meta) return null;
  return typeof meta.status === 'string' ? meta.status : null;
}

function firstDivergence(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  if (a.length !== b.length) return len;
  return -1;
}

// ----- Output -----

function printHumanReport(report: TestReport): void {
  console.log('');
  console.log(chalk.bold(`Replay regression test`));
  console.log(`  ${chalk.dim('trace:')}    ${report.trace}`);
  console.log(`  ${chalk.dim('baseline:')} ${report.baseline ?? chalk.dim('(none — intrinsic checks only)')}`);
  console.log('');
  for (const r of report.results) {
    const symbol = r.passed ? chalk.green('✓') : chalk.red('✗');
    const label = chalk.bold(r.mode.padEnd(15));
    console.log(`  ${symbol} ${label} ${r.reason ?? ''}`);
    if (!r.passed && r.details && typeof r.details.firstDivergence === 'number') {
      const got = (r.details.got as string[] | undefined) ?? [];
      const want = (r.details.want as string[] | undefined) ?? [];
      const idx = r.details.firstDivergence as number;
      const window = 2;
      const start = Math.max(0, idx - window);
      const end = Math.min(Math.max(got.length, want.length), idx + window + 1);
      for (let i = start; i < end; i++) {
        const gotMark = i === idx ? chalk.red(`got[${i}]= ${got[i] ?? '<end>'}`) : chalk.dim(`got[${i}]= ${got[i] ?? '<end>'}`);
        const wantMark = i === idx ? chalk.red(`want[${i}]=${want[i] ?? '<end>'}`) : chalk.dim(`want[${i}]=${want[i] ?? '<end>'}`);
        console.log(`      ${gotMark}  |  ${wantMark}`);
      }
    }
    if (!r.passed && r.details && Array.isArray(r.details.diffs)) {
      const diffs = r.details.diffs as Array<{ path: string; got: string | null; want: string | null }>;
      for (const d of diffs.slice(0, 10)) {
        const gotShort = d.got ? d.got.slice(0, 12) : '<missing>';
        const wantShort = d.want ? d.want.slice(0, 12) : '<missing>';
        console.log(`      ${chalk.dim(d.path)}: got=${chalk.red(gotShort)} want=${chalk.green(wantShort)}`);
      }
      if (diffs.length > 10) {
        console.log(`      ${chalk.dim(`… ${diffs.length - 10} more`)}`);
      }
    }
  }
  console.log('');
  if (report.passed) {
    console.log(chalk.green(`✓ All ${report.results.length} assertion(s) passed`));
  } else {
    const failed = report.results.filter((r) => !r.passed).length;
    console.log(chalk.red(`✗ ${failed}/${report.results.length} assertion(s) failed`));
  }
}
