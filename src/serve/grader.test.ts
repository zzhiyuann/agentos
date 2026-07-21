import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  graderMode, graderModel, graderMaxBounces, graderMinScore,
  parseGraderResponse, collectGitDiff, loadRubric, buildGraderPrompt,
  gradeAttempt, gradeFails, shouldGradeIssue, takeGraderBounce,
  GRADER_TIMEOUT_MS, ClaudeRunner,
} from './grader.js';
import { getGrade, cacheEnrichment } from '../core/db.js';

const ENV_KEYS = ['AOS_GRADER_ENABLED', 'AOS_GRADER_MODEL', 'AOS_GRADER_MAX_BOUNCES', 'AOS_GRADER_MIN_SCORE'];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

function makeAttempt() {
  return {
    id: randomUUID(),
    issue_key: `TEST-GR-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    agent_type: 'lead-engineer',
    workspace_path: '/tmp/nonexistent-grader-ws',
  };
}

// ─── knob defaults ───────────────────────────────────────────────────

describe('grader knobs', () => {
  it('graderMode defaults to off and parses shadow/enforce', () => {
    expect(graderMode()).toBe('off');
    process.env.AOS_GRADER_ENABLED = 'shadow';
    expect(graderMode()).toBe('shadow');
    process.env.AOS_GRADER_ENABLED = 'ENFORCE';
    expect(graderMode()).toBe('enforce');
    process.env.AOS_GRADER_ENABLED = 'yes';
    expect(graderMode()).toBe('off');
  });

  it('graderModel defaults to claude-sonnet-4-6 and honours AOS_GRADER_MODEL', () => {
    expect(graderModel()).toBe('claude-sonnet-4-6');
    process.env.AOS_GRADER_MODEL = 'claude-fable-5';
    expect(graderModel()).toBe('claude-fable-5');
  });

  it('graderMaxBounces defaults to 1', () => {
    expect(graderMaxBounces()).toBe(1);
    process.env.AOS_GRADER_MAX_BOUNCES = '3';
    expect(graderMaxBounces()).toBe(3);
    process.env.AOS_GRADER_MAX_BOUNCES = 'junk';
    expect(graderMaxBounces()).toBe(1);
  });

  it('graderMinScore defaults to 6', () => {
    expect(graderMinScore()).toBe(6);
    process.env.AOS_GRADER_MIN_SCORE = '7.5';
    expect(graderMinScore()).toBe(7.5);
  });
});

// ─── parseGraderResponse ─────────────────────────────────────────────

describe('parseGraderResponse', () => {
  it('parses clean JSON', () => {
    const result = parseGraderResponse('{"verdict": "pass", "score": 8, "critique": "solid"}');
    expect(result).toEqual({ verdict: 'pass', score: 8, critique: 'solid' });
  });

  it('parses fenced JSON', () => {
    const text = 'Here is my grade:\n```json\n{"verdict": "fail", "score": 3, "critique": "no tests"}\n```\n';
    const result = parseGraderResponse(text);
    expect(result).toEqual({ verdict: 'fail', score: 3, critique: 'no tests' });
  });

  it('parses JSON embedded in prose', () => {
    const text = 'After review: {"verdict": "pass", "score": 9.5, "critique": "great"} — done.';
    const result = parseGraderResponse(text);
    expect(result?.verdict).toBe('pass');
    expect(result?.score).toBe(9.5);
  });

  it('clamps score to 0-10', () => {
    expect(parseGraderResponse('{"verdict":"pass","score":15,"critique":""}')?.score).toBe(10);
    expect(parseGraderResponse('{"verdict":"fail","score":-2,"critique":""}')?.score).toBe(0);
  });

  it('tolerates missing/invalid score and critique', () => {
    const result = parseGraderResponse('{"verdict":"pass"}');
    expect(result).toEqual({ verdict: 'pass', score: null, critique: '' });
  });

  it('returns null for garbage', () => {
    expect(parseGraderResponse('I think the work is fine overall.')).toBeNull();
    expect(parseGraderResponse('')).toBeNull();
    expect(parseGraderResponse('{"verdict": "maybe", "score": 5}')).toBeNull();
    expect(parseGraderResponse('{not json}')).toBeNull();
  });
});

// ─── collectGitDiff ──────────────────────────────────────────────────

describe('collectGitDiff', () => {
  it('returns empty string for missing workspace', () => {
    expect(collectGitDiff('/tmp/definitely-not-a-real-dir-12345')).toBe('');
    expect(collectGitDiff(null)).toBe('');
    expect(collectGitDiff(undefined)).toBe('');
  });

  it('returns empty string for a non-git directory', () => {
    expect(collectGitDiff('/tmp')).toBe('');
  });
});

// ─── loadRubric ──────────────────────────────────────────────────────

describe('loadRubric', () => {
  it('uses cached enrichment acceptance criteria when available', () => {
    const issueKey = `TEST-RUBRIC-${Date.now()}`;
    cacheEnrichment(issueKey, {
      deliverable: 'a thing',
      acceptanceCriteria: ['criterion one', 'criterion two'],
      dependencies: [],
      definitionOfDone: 'both criteria met',
    });
    const rubric = loadRubric(issueKey);
    expect(rubric).toContain('criterion one');
    expect(rubric).toContain('criterion two');
    expect(rubric).toContain('Definition of done: both criteria met');
  });

  it('falls back to the generic rubric when no enrichment exists', () => {
    const rubric = loadRubric(`TEST-NO-ENRICH-${Date.now()}`);
    // Either the template file or the embedded fallback — both mention completeness/verification
    expect(rubric.toLowerCase()).toContain('completeness');
    expect(rubric.toLowerCase()).toContain('verification');
  });
});

// ─── buildGraderPrompt ───────────────────────────────────────────────

describe('buildGraderPrompt', () => {
  it('includes issue, rubric, handoff, diff and the strict JSON instruction', () => {
    const prompt = buildGraderPrompt({
      issueKey: 'RYA-1',
      issueTitle: 'Build the widget',
      issueDescription: 'A widget that does X',
      handoff: '# HANDOFF\nDid the widget.',
      diff: 'src/widget.ts | 10 +++',
      rubric: 'My rubric',
    });
    expect(prompt).toContain('RYA-1');
    expect(prompt).toContain('Build the widget');
    expect(prompt).toContain('My rubric');
    expect(prompt).toContain('Did the widget.');
    expect(prompt).toContain('src/widget.ts');
    expect(prompt).toContain('"verdict": "pass" | "fail"');
  });

  it('notes when no diff is available', () => {
    const prompt = buildGraderPrompt({
      issueKey: 'RYA-2', issueTitle: 't', handoff: 'h', diff: '', rubric: 'r',
    });
    expect(prompt).toContain('no git diff available');
  });
});

// ─── gradeAttempt (mocked runner) ────────────────────────────────────

describe('gradeAttempt', () => {
  it('records a pass verdict from a clean JSON response', async () => {
    const attempt = makeAttempt();
    const runner: ClaudeRunner = vi.fn(async () => '{"verdict":"pass","score":9,"critique":"good"}');
    const result = await gradeAttempt(
      { attempt, handoff: '# HANDOFF', issue: { title: 'Test issue' } },
      runner,
    );
    expect(result).toEqual({ verdict: 'pass', score: 9, critique: 'good' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runner).mock.calls[0][2]).toBe(GRADER_TIMEOUT_MS);

    const row = getGrade(attempt.id);
    expect(row).toBeDefined();
    expect(row!.verdict).toBe('pass');
    expect(row!.score).toBe(9);
    expect(row!.issue_key).toBe(attempt.issue_key);
  });

  it('parses fenced responses', async () => {
    const attempt = makeAttempt();
    const runner: ClaudeRunner = async () => '```json\n{"verdict":"fail","score":2,"critique":"missing tests"}\n```';
    const result = await gradeAttempt({ attempt, handoff: 'h', issue: { title: 't' } }, runner);
    expect(result.verdict).toBe('fail');
    expect(getGrade(attempt.id)!.verdict).toBe('fail');
  });

  it('fail-open: garbage response records verdict error without firing the alert', async () => {
    const attempt = makeAttempt();
    const runner: ClaudeRunner = async () => 'total nonsense, no json here';
    const alert = vi.fn(async (_message: string) => true);
    const result = await gradeAttempt({ attempt, handoff: 'h', issue: { title: 't' } }, runner, alert);
    expect(result.verdict).toBe('error');
    expect(result.score).toBeNull();
    expect(getGrade(attempt.id)!.verdict).toBe('error');
    // unparseable text is a model-output problem, not a spawn failure — no alert
    expect(alert).not.toHaveBeenCalled();
    // treated as pass downstream
    expect(gradeFails(result)).toBe(false);
  });

  it('fail-open: runner throwing (timeout/spawn failure) records verdict error and fires a Discord alert', async () => {
    const attempt = makeAttempt();
    const runner: ClaudeRunner = async () => { throw new Error('ETIMEDOUT'); };
    const alert = vi.fn(async (_message: string) => true);
    const result = await gradeAttempt({ attempt, handoff: 'h', issue: { title: 't' } }, runner, alert);
    expect(result.verdict).toBe('error');
    expect(result.critique).toContain('ETIMEDOUT');
    expect(getGrade(attempt.id)!.verdict).toBe('error');
    expect(gradeFails(result)).toBe(false);
    // depletion observability: spawn failures must be loud
    expect(alert).toHaveBeenCalledTimes(1);
    const message = alert.mock.calls[0][0] as string;
    expect(message).toContain(attempt.issue_key);
    expect(message).toContain('ETIMEDOUT');
    expect(message).toContain('claude-sonnet-4-6');
  });

  it('a failing alert sink does not break the fail-open grading path', async () => {
    const attempt = makeAttempt();
    const runner: ClaudeRunner = async () => { throw new Error('exit 1: credit balance exhausted'); };
    const alert = vi.fn(async (_message: string) => { throw new Error('discord down'); });
    const result = await gradeAttempt({ attempt, handoff: 'h', issue: { title: 't' } }, runner, alert);
    expect(result.verdict).toBe('error');
    expect(gradeFails(result)).toBe(false);
  });

  it('does not include any transcript in the prompt (only issue/handoff/diff/rubric)', async () => {
    const attempt = makeAttempt();
    let capturedPrompt = '';
    const runner: ClaudeRunner = async (prompt) => {
      capturedPrompt = prompt;
      return '{"verdict":"pass","score":7,"critique":""}';
    };
    await gradeAttempt({ attempt, handoff: 'THE-HANDOFF-CONTENT', issue: { title: 'T', description: 'D' } }, runner);
    expect(capturedPrompt).toContain('THE-HANDOFF-CONTENT');
    expect(capturedPrompt).not.toMatch(/transcript|reasoning|thinking/i);
  });
});

// ─── gradeFails ──────────────────────────────────────────────────────

describe('gradeFails', () => {
  it('fail verdict always fails', () => {
    expect(gradeFails({ verdict: 'fail', score: 9, critique: '' })).toBe(true);
  });

  it('pass verdict below min score fails', () => {
    expect(gradeFails({ verdict: 'pass', score: 4, critique: '' })).toBe(true);
  });

  it('pass verdict at/above min score passes', () => {
    expect(gradeFails({ verdict: 'pass', score: 6, critique: '' })).toBe(false);
    expect(gradeFails({ verdict: 'pass', score: 10, critique: '' })).toBe(false);
  });

  it('pass with null score passes (no numeric signal)', () => {
    expect(gradeFails({ verdict: 'pass', score: null, critique: '' })).toBe(false);
  });

  it('error verdict is fail-open', () => {
    expect(gradeFails({ verdict: 'error', score: null, critique: '' })).toBe(false);
  });

  it('respects AOS_GRADER_MIN_SCORE', () => {
    process.env.AOS_GRADER_MIN_SCORE = '9';
    expect(gradeFails({ verdict: 'pass', score: 8, critique: '' })).toBe(true);
  });
});

// ─── shouldGradeIssue ────────────────────────────────────────────────

describe('shouldGradeIssue', () => {
  const base = { effectiveStatus: 'in-review', trivial: false, labels: [] as string[], isFollowUp: false };

  it('grades non-trivial in-review/done issues', () => {
    expect(shouldGradeIssue(base)).toBe(true);
    expect(shouldGradeIssue({ ...base, effectiveStatus: 'done' })).toBe(true);
  });

  it('skips trivial issues', () => {
    expect(shouldGradeIssue({ ...base, trivial: true })).toBe(false);
  });

  it('skips grader:skip label (case-insensitive)', () => {
    expect(shouldGradeIssue({ ...base, labels: ['grader:skip'] })).toBe(false);
    expect(shouldGradeIssue({ ...base, labels: ['Grader:Skip'] })).toBe(false);
  });

  it('skips non-terminal statuses', () => {
    expect(shouldGradeIssue({ ...base, effectiveStatus: 'in-progress' })).toBe(false);
    expect(shouldGradeIssue({ ...base, effectiveStatus: 'todo' })).toBe(false);
    expect(shouldGradeIssue({ ...base, effectiveStatus: 'no-change' })).toBe(false);
  });

  it('skips follow-ups', () => {
    expect(shouldGradeIssue({ ...base, isFollowUp: true })).toBe(false);
  });
});

// ─── takeGraderBounce ────────────────────────────────────────────────

describe('takeGraderBounce', () => {
  function fakeStore() {
    const seen = new Set<string>();
    return {
      seen,
      check: (key: string) => seen.has(key),
      record: (key: string) => { seen.add(key); },
    };
  }

  it('grants exactly maxBounces bounces (default key shape grade:{issueKey})', () => {
    const store = fakeStore();
    expect(takeGraderBounce('RYA-9', 1, store.check, store.record)).toBe(true);
    expect(store.seen.has('grade:RYA-9')).toBe(true);
    expect(takeGraderBounce('RYA-9', 1, store.check, store.record)).toBe(false);
  });

  it('supports a budget > 1 with indexed keys', () => {
    const store = fakeStore();
    expect(takeGraderBounce('RYA-9', 2, store.check, store.record)).toBe(true);
    expect(takeGraderBounce('RYA-9', 2, store.check, store.record)).toBe(true);
    expect(takeGraderBounce('RYA-9', 2, store.check, store.record)).toBe(false);
    expect(store.seen.has('grade:RYA-9')).toBe(true);
    expect(store.seen.has('grade:RYA-9:2')).toBe(true);
  });

  it('budget 0 never bounces', () => {
    const store = fakeStore();
    expect(takeGraderBounce('RYA-9', 0, store.check, store.record)).toBe(false);
  });
});
