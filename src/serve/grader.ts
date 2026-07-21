/**
 * A2.3: Headless completion grader.
 *
 * When an attempt completes and its issue would transition to done/in-review,
 * a headless `claude -p` call grades the work product (issue spec + HANDOFF.md
 * + git diff) against a rubric. The worker's transcript/reasoning is NEVER
 * included — the grader judges deliverables, not effort.
 *
 * Knobs (read at call time):
 *   AOS_GRADER_ENABLED     off|shadow|enforce (default off)
 *                          shadow: grade + record only; enforce: bounce on fail
 *   AOS_GRADER_MODEL       model for the headless call (default claude-sonnet-4-6)
 *   AOS_GRADER_MAX_BOUNCES re-dispatch budget per issue per 24h (default 1)
 *   AOS_GRADER_MIN_SCORE   pass threshold 0-10 (default 6)
 *
 * Fail-open by design: timeouts, spawn failures and unparseable responses are
 * recorded as verdict 'error' and treated as a pass.
 */

import { execFile, execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../core/logger.js';
import { getCachedEnrichment, insertGrade, Attempt } from '../core/db.js';
import { postDiscordSystem } from '../core/discord.js';
import { persistentDedupCheck, persistentDedupRecord } from './state.js';

const log = createLogger('grader');

export type GraderMode = 'off' | 'shadow' | 'enforce';

/** AOS_GRADER_ENABLED=off|shadow|enforce, default off. */
export function graderMode(): GraderMode {
  const raw = (process.env.AOS_GRADER_ENABLED || 'off').toLowerCase();
  if (raw === 'shadow' || raw === 'enforce') return raw;
  return 'off';
}

/** AOS_GRADER_MODEL, default claude-sonnet-4-6 (rubric verdict + JSON score is well within Sonnet; headless calls bill at API list rates after the June 15 cutover). */
export function graderModel(): string {
  return process.env.AOS_GRADER_MODEL || 'claude-sonnet-4-6';
}

/** AOS_GRADER_MAX_BOUNCES, default 1. */
export function graderMaxBounces(): number {
  const n = parseInt(process.env.AOS_GRADER_MAX_BOUNCES || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** AOS_GRADER_MIN_SCORE, default 6. */
export function graderMinScore(): number {
  const n = parseFloat(process.env.AOS_GRADER_MIN_SCORE || '');
  return Number.isFinite(n) ? n : 6;
}

export const GRADER_TIMEOUT_MS = 120_000;
export const GRADER_DIFF_CAP_CHARS = 30_000;

export interface GradeVerdict {
  verdict: 'pass' | 'fail' | 'error';
  score: number | null;
  critique: string;
}

/**
 * Injectable headless-Claude runner. Returns the model's TEXT response.
 * Tests provide a mock; production uses defaultClaudeRunner below.
 */
export type ClaudeRunner = (prompt: string, model: string, timeoutMs: number) => Promise<string>;

/** Spawn `claude -p <prompt> --output-format json` and return the `result` text. */
export const defaultClaudeRunner: ClaudeRunner = (prompt, model, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--model', model],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          // The CLI returns a JSON envelope; `result` carries the model's text.
          const envelope = JSON.parse(stdout) as { result?: unknown };
          if (typeof envelope.result === 'string') return resolve(envelope.result);
        } catch {
          // Not an envelope — fall through and let the verdict parser try raw output
        }
        resolve(stdout);
      },
    );
  });

/**
 * Parse the grader's response into a verdict. Defensive: strips markdown
 * fences, extracts the first JSON object, validates the verdict enum and
 * clamps score to 0-10. Returns null when nothing usable is found.
 */
export function parseGraderResponse(text: string): GradeVerdict | null {
  if (!text) return null;
  let cleaned = text.trim();

  // Strip markdown fences if present
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();

  // Try candidate JSON object spans: greedy first (handles nested objects),
  // then non-greedy (handles trailing junk after the object).
  const candidates: string[] = [];
  const greedy = cleaned.match(/\{[\s\S]*\}/);
  if (greedy) candidates.push(greedy[0]);
  const lazy = cleaned.match(/\{[\s\S]*?\}/);
  if (lazy && lazy[0] !== greedy?.[0]) candidates.push(lazy[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { verdict?: unknown; score?: unknown; critique?: unknown };
      const verdict = String(parsed.verdict ?? '').toLowerCase();
      if (verdict !== 'pass' && verdict !== 'fail') continue;
      let score: number | null = null;
      const n = Number(parsed.score);
      if (Number.isFinite(n)) score = Math.max(0, Math.min(10, n));
      return {
        verdict,
        score,
        critique: typeof parsed.critique === 'string' ? parsed.critique : '',
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Collect `git diff HEAD~1` (stat + patch) from the workspace, capped.
 * Falls back to `git diff` when there is no parent commit; returns '' when
 * the workspace has no usable git repo (diff is then skipped from the prompt).
 */
export function collectGitDiff(workspacePath: string | null | undefined, cap = GRADER_DIFF_CAP_CHARS): string {
  if (!workspacePath || !existsSync(workspacePath)) return '';
  const run = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        // Capture stderr — the default inherits it, dumping git usage text
        // into serve's stderr log when the workspace has no commits.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return null;
    }
  };

  let stat = run(['diff', 'HEAD~1', '--stat']);
  let patch = stat !== null ? run(['diff', 'HEAD~1']) : null;
  if (stat === null) {
    // No parent commit (fresh repo) — fall back to working-tree diff
    stat = run(['diff', '--stat']);
    patch = stat !== null ? run(['diff']) : null;
  }
  if (stat === null) return '';

  const combined = `${(stat || '').trim()}\n\n${(patch || '').trim()}`.trim();
  if (!combined) return '';
  return combined.length > cap ? combined.slice(0, cap) + '\n…[diff truncated]' : combined;
}

const FALLBACK_RUBRIC = `Grade against: completeness (deliverables present), correctness (handoff claims match the diff), verification (work was tested/checked), and handoff quality (specific, follow-ups tracked as issue keys). pass requires score >= 6 with no critical gaps.`;

/**
 * Rubric for an issue: cached structured spec (acceptance criteria) when
 * available, else the generic templates/grading-rubric.md, else an embedded
 * fallback.
 */
export function loadRubric(issueKey: string): string {
  try {
    const spec = getCachedEnrichment(issueKey);
    const criteria = spec?.acceptanceCriteria;
    if (Array.isArray(criteria) && criteria.length > 0) {
      const dod = typeof spec!.definitionOfDone === 'string' && spec!.definitionOfDone
        ? `\nDefinition of done: ${spec!.definitionOfDone}`
        : '';
      return `Acceptance criteria for this issue:\n${criteria.map(c => `- ${String(c)}`).join('\n')}${dod}`;
    }
  } catch (err) {
    log.debug('Enrichment rubric lookup failed', { issueKey, error: (err as Error).message });
  }
  try {
    const templatePath = join(dirname(fileURLToPath(import.meta.url)), '../../templates/grading-rubric.md');
    if (existsSync(templatePath)) return readFileSync(templatePath, 'utf-8');
  } catch (err) {
    log.debug('Rubric template read failed', { error: (err as Error).message });
  }
  return FALLBACK_RUBRIC;
}

export interface GraderPromptInput {
  issueKey: string;
  issueTitle: string;
  issueDescription?: string;
  handoff: string;
  diff: string;
  rubric: string;
}

/** Build the grading prompt. NO worker transcript/reasoning is included. */
export function buildGraderPrompt(input: GraderPromptInput): string {
  const sections = [
    'You are a strict quality grader for an AI engineering organization. Grade the completed work below.',
    '',
    `## Issue ${input.issueKey}: ${input.issueTitle}`,
    input.issueDescription ? `\n${input.issueDescription.substring(0, 4000)}` : '\n(no description)',
    '',
    '## Rubric',
    input.rubric,
    '',
    '## Agent handoff (HANDOFF.md)',
    input.handoff.substring(0, 10_000),
    '',
    input.diff ? `## Code changes (git diff, may be truncated)\n${input.diff}` : '## Code changes\n(no git diff available — grade on the handoff and rubric only)',
    '',
    'Respond with ONLY strict JSON, no markdown fences, no extra text:',
    '{"verdict": "pass" | "fail", "score": <number 0-10>, "critique": "<concrete critique: what is missing or wrong, and what would make this pass>"}',
  ];
  return sections.join('\n');
}

export interface GradeAttemptInput {
  attempt: Pick<Attempt, 'id' | 'issue_key' | 'agent_type' | 'workspace_path'>;
  handoff: string;
  issue: { title: string; description?: string };
  workspacePath?: string | null;
}

/** Alert sink for headless-claude failures — injectable for tests. */
export type AlertSink = (message: string) => Promise<boolean>;

/**
 * Grade a completed attempt and record the result in the grades table.
 * Never throws — failures are recorded as verdict 'error' (fail-open).
 *
 * A failed `claude -p` spawn (timeout, non-zero exit, depleted credit pool)
 * additionally fires a Discord alert: post-June-15 credit billing means
 * depletion hard-fails every headless call, and fail-open would otherwise
 * hide that until grades are audited.
 */
export async function gradeAttempt(
  input: GradeAttemptInput,
  runClaude: ClaudeRunner = defaultClaudeRunner,
  alert: AlertSink = postDiscordSystem,
): Promise<GradeVerdict> {
  const { attempt, handoff, issue } = input;
  const model = graderModel();
  let result: GradeVerdict;

  try {
    const diff = collectGitDiff(input.workspacePath ?? attempt.workspace_path);
    const rubric = loadRubric(attempt.issue_key);
    const prompt = buildGraderPrompt({
      issueKey: attempt.issue_key,
      issueTitle: issue.title,
      issueDescription: issue.description,
      handoff,
      diff,
      rubric,
    });
    const text = await runClaude(prompt, model, GRADER_TIMEOUT_MS);
    const parsed = parseGraderResponse(text);
    result = parsed ?? {
      verdict: 'error',
      score: null,
      critique: `Unparseable grader response: ${String(text).substring(0, 300)}`,
    };
  } catch (err) {
    const message = (err as Error).message;
    result = { verdict: 'error', score: null, critique: `Grader failed: ${message}` };
    log.warn('Grader headless claude call failed', { issueKey: attempt.issue_key, model, error: message });
    try {
      await alert(
        `🚨 Grader headless \`claude -p\` call FAILED for ${attempt.issue_key} (model ${model}): ${message.substring(0, 300)}\n` +
        `Grade recorded as fail-open 'error' — the issue still completes, but grading is blind. ` +
        `If this persists across issues, the Anthropic credit pool is likely depleted (June 15 per-user credit billing). Top up or check \`claude -p\` auth.`,
      );
    } catch {
      // Alerting must never break the fail-open grading path
    }
  }

  try {
    insertGrade({
      attempt_id: attempt.id,
      issue_key: attempt.issue_key,
      verdict: result.verdict,
      score: result.score,
      critique: result.critique,
      model,
    });
  } catch (err) {
    log.debug('Failed to record grade', { issueKey: attempt.issue_key, error: (err as Error).message });
  }

  log.info('Graded attempt', { issueKey: attempt.issue_key, verdict: result.verdict, score: result.score });
  return result;
}

/**
 * True when a grade should block completion (enforce mode).
 * verdict 'error' is fail-open (treated as pass).
 */
export function gradeFails(grade: GradeVerdict, minScore: number = graderMinScore()): boolean {
  if (grade.verdict === 'error') return false;
  if (grade.verdict === 'fail') return true;
  return grade.score !== null && grade.score < minScore;
}

/**
 * Gate: only grade issues that are (a) heading to done/in-review, (b) not
 * trivial (shouldSkipReview === false semantics — caller computes), (c) not
 * labeled grader:skip, and (d) not follow-up conversations.
 */
export function shouldGradeIssue(params: {
  effectiveStatus: string;
  trivial: boolean;
  labels: string[];
  isFollowUp: boolean;
}): boolean {
  if (params.isFollowUp) return false;
  if (params.effectiveStatus !== 'done' && params.effectiveStatus !== 'in-review') return false;
  if (params.trivial) return false;
  if (params.labels.some(l => l.toLowerCase() === 'grader:skip')) return false;
  return true;
}

/**
 * Consume one bounce from the per-issue 24h budget (persistent across serve
 * restarts via dedup_keys). Returns true when a bounce slot was available
 * and is now taken; false when the budget is exhausted.
 */
export function takeGraderBounce(
  issueKey: string,
  maxBounces: number = graderMaxBounces(),
  check: (key: string, windowMs: number) => boolean = persistentDedupCheck,
  record: (key: string) => void = persistentDedupRecord,
): boolean {
  const windowMs = 24 * 60 * 60_000;
  for (let i = 1; i <= maxBounces; i++) {
    const key = i === 1 ? `grade:${issueKey}` : `grade:${issueKey}:${i}`;
    if (!check(key, windowMs)) {
      record(key);
      return true;
    }
  }
  return false;
}
