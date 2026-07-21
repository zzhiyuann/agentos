import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../core/linear.js', () => ({ addComment: vi.fn(async () => {}) }));
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{"failingTests":[],"updatedAt":"2026-01-01"}'),
  writeFileSync: vi.fn(),
}));

import { loadEvalBaseline, saveEvalBaseline, extractFailingTests } from './eval-runner.js';
import * as fs from 'fs';

// ─── loadEvalBaseline ──────────────────────────────────────────────────────

describe('loadEvalBaseline', () => {
  it('returns empty set when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadEvalBaseline().size).toBe(0);
  });

  it('returns empty set on parse error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not-json' as any);
    expect(loadEvalBaseline().size).toBe(0);
  });

  it('loads failing tests from baseline file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ failingTests: ['test A', 'test B'], updatedAt: '2026-01-01' }) as any,
    );
    const baseline = loadEvalBaseline();
    expect(baseline.size).toBe(2);
    expect(baseline.has('test A')).toBe(true);
    expect(baseline.has('test B')).toBe(true);
  });
});

// ─── saveEvalBaseline ────────────────────────────────────────────────────────

describe('saveEvalBaseline', () => {
  it('writes baseline JSON to disk', () => {
    saveEvalBaseline(['test X']);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('eval-baseline.json'),
      expect.stringContaining('test X'),
      'utf-8',
    );
  });

  it('writes empty array for clean baseline', () => {
    saveEvalBaseline([]);
    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string;
    expect(JSON.parse(written).failingTests).toEqual([]);
  });
});

// ─── extractFailingTests ─────────────────────────────────────────────────────

describe('extractFailingTests', () => {
  it('returns empty array for invalid JSON', () => {
    expect(extractFailingTests('not-json')).toEqual([]);
  });

  it('returns empty array when no test results', () => {
    expect(extractFailingTests('{"testResults":[]}')).toEqual([]);
  });

  it('extracts failing test names', () => {
    const json = JSON.stringify({
      testResults: [{
        assertionResults: [
          { status: 'failed', title: 'should work', ancestorTitles: ['Suite A'] },
          { status: 'passed', title: 'passes fine', ancestorTitles: ['Suite A'] },
          { status: 'failed', title: 'also fails', ancestorTitles: [] },
        ],
      }],
    });
    const result = extractFailingTests(json);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('Suite A > should work');
    expect(result[1]).toBe('also fails');
  });

  it('handles nested ancestor titles', () => {
    const json = JSON.stringify({
      testResults: [{
        assertionResults: [{
          status: 'failed',
          title: 'fails',
          ancestorTitles: ['Outer', 'Inner'],
        }],
      }],
    });
    expect(extractFailingTests(json)[0]).toBe('Outer > Inner > fails');
  });

  it('handles missing ancestorTitles field gracefully', () => {
    const json = JSON.stringify({
      testResults: [{
        assertionResults: [{
          status: 'failed',
          title: 'bare test',
        }],
      }],
    });
    expect(extractFailingTests(json)[0]).toBe('bare test');
  });
});
