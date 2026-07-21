/**
 * A3.5: Dreaming — nightly per-role reflection.
 *
 * For each role with activity in the window, gather (a) that day's grades,
 * (b) completed attempts + issue keys, (c) memory files written today, build
 * a compact prompt (≤20K chars) and ask a headless Claude for a ≤500-token
 * reflection: patterns, mistakes to avoid, what worked. The result is written
 * to ~/.aos/agents/{role}/memory/reflections-YYYY-MM-DD.md with
 * `type: feedback` frontmatter (auto-promoted to system memory on next sync).
 *
 * Knobs (read at call time):
 *   AOS_DREAM_MODEL       model for the headless call (default claude-sonnet-4-6)
 *
 * Propose-only philosophy applies to the related distill prune extension —
 * dreaming itself only ADDS a reflection memory; it never deletes or applies
 * anything automatically.
 */

import { execFile } from 'child_process';
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getAgentsDir, listAgents } from './persona.js';
import { getGradesForRoleSince, getCompletedAttemptsForRoleSince, type Grade, type Attempt } from './db.js';
import { postDiscordSystem } from './discord.js';

export const DREAM_TIMEOUT_MS = 120_000;
export const DREAM_PROMPT_CAP_CHARS = 20_000;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

/** AOS_DREAM_MODEL, default claude-sonnet-4-6 (≤500-token reflection is well within Sonnet; headless calls bill at API list rates after the June 15 cutover). */
export function dreamModel(): string {
  return process.env.AOS_DREAM_MODEL || 'claude-sonnet-4-6';
}

/**
 * Injectable headless-Claude runner (same shape as the grader's runner).
 * Tests provide a mock; production uses defaultDreamRunner below.
 */
export type ClaudeRunner = (prompt: string, model: string, timeoutMs: number) => Promise<string>;

/** Spawn `claude -p <prompt> --output-format json` and return the `result` text. */
export const defaultDreamRunner: ClaudeRunner = (prompt, model, timeoutMs) =>
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
          // Not an envelope — fall through and use raw output
        }
        resolve(stdout);
      },
    );
  });

export interface DreamOptions {
  /** Roles to reflect on (default: all agents). */
  roles?: string[];
  /** Activity window in ms (default: 24h). */
  sinceMs?: number;
  /** Injectable headless runner (tests). */
  runner?: ClaudeRunner;
  /** Clock override (tests). */
  now?: Date;
  /** Injectable failure alert sink (tests). Default posts to Discord. */
  alert?: (message: string) => Promise<boolean>;
}

export interface DreamRoleResult {
  role: string;
  status: 'written' | 'skipped' | 'error';
  path?: string;
  reason?: string;
}

interface RoleActivity {
  grades: Grade[];
  attempts: Attempt[];
  memoryFiles: string[];
}

function gatherActivity(role: string, sinceIso: string, sinceMs: number, now: Date): RoleActivity {
  let grades: Grade[] = [];
  let attempts: Attempt[] = [];
  try {
    grades = getGradesForRoleSince(role, sinceIso);
    attempts = getCompletedAttemptsForRoleSince(role, sinceIso);
  } catch {
    // DB unavailable — fall through with file-only activity
  }

  // Memory files written within the window (mtime), excluding prior
  // reflections so dreams don't feed on themselves.
  const memoryFiles: string[] = [];
  const memoryDir = join(getAgentsDir(), role, 'memory');
  if (existsSync(memoryDir)) {
    const cutoff = now.getTime() - sinceMs;
    for (const file of readdirSync(memoryDir)) {
      if (!file.endsWith('.md') || file.startsWith('reflections-')) continue;
      try {
        if (statSync(join(memoryDir, file)).mtimeMs >= cutoff) memoryFiles.push(file);
      } catch {
        // file vanished mid-scan — skip it
      }
    }
  }

  return { grades, attempts, memoryFiles };
}

/** Build the compact reflection prompt, hard-capped at DREAM_PROMPT_CAP_CHARS. */
export function buildDreamPrompt(role: string, activity: RoleActivity, dateStr: string): string {
  const lines: string[] = [];
  lines.push(`You are the nightly reflection process for the "${role}" AI agent (date: ${dateStr}).`);
  lines.push('Below is a summary of the agent\'s activity today. Write a reflection of AT MOST 500 tokens covering:');
  lines.push('1. Patterns you notice across the day\'s work');
  lines.push('2. Mistakes to avoid repeating (be specific)');
  lines.push('3. What worked well and should be repeated');
  lines.push('Write in second person ("you"), as advice the agent will read tomorrow. Be concrete; no filler. Output markdown only — no preamble.');
  lines.push('');

  if (activity.attempts.length > 0) {
    lines.push(`## Completed attempts (${activity.attempts.length})`);
    for (const a of activity.attempts.slice(0, 20)) {
      lines.push(`- ${a.issue_key} (attempt ${a.attempt_number}, completed ${a.completed_at})${a.error_log ? ` — note: ${a.error_log.slice(0, 200)}` : ''}`);
    }
    lines.push('');
  }

  if (activity.grades.length > 0) {
    lines.push(`## Grades received (${activity.grades.length})`);
    for (const g of activity.grades.slice(0, 20)) {
      lines.push(`- ${g.issue_key}: ${g.verdict}${g.score != null ? ` (score ${g.score}/10)` : ''}${g.critique ? ` — ${g.critique.slice(0, 400)}` : ''}`);
    }
    lines.push('');
  }

  if (activity.memoryFiles.length > 0) {
    lines.push(`## Memory files written today (${activity.memoryFiles.length})`);
    for (const f of activity.memoryFiles.slice(0, 30)) lines.push(`- ${f}`);
    lines.push('');
  }

  let prompt = lines.join('\n');
  if (prompt.length > DREAM_PROMPT_CAP_CHARS) {
    prompt = prompt.slice(0, DREAM_PROMPT_CAP_CHARS) + '\n…(activity truncated)';
  }
  return prompt;
}

function reflectionFrontmatter(dateStr: string): string {
  return `---\nname: reflections-${dateStr}\ndescription: nightly reflection\ntype: feedback\n---\n\n`;
}

/**
 * Run the nightly dream for the given roles. Roles with no activity in the
 * window are skipped. Returns one result per role. Never throws per-role —
 * an error reflecting one role must not block the others.
 */
export async function runDream(opts: DreamOptions = {}): Promise<DreamRoleResult[]> {
  const roles = opts.roles && opts.roles.length > 0 ? opts.roles : listAgents();
  const sinceMs = opts.sinceMs ?? DEFAULT_SINCE_MS;
  const runner = opts.runner ?? defaultDreamRunner;
  const alert = opts.alert ?? postDiscordSystem;
  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - sinceMs).toISOString();
  const dateStr = now.toISOString().slice(0, 10);

  const results: DreamRoleResult[] = [];

  for (const role of roles) {
    try {
      const activity = gatherActivity(role, sinceIso, sinceMs, now);
      const hasActivity = activity.grades.length > 0 || activity.attempts.length > 0 || activity.memoryFiles.length > 0;
      if (!hasActivity) {
        results.push({ role, status: 'skipped', reason: 'no activity in window' });
        continue;
      }

      const prompt = buildDreamPrompt(role, activity, dateStr);
      const reflection = (await runner(prompt, dreamModel(), DREAM_TIMEOUT_MS)).trim();
      if (!reflection) {
        results.push({ role, status: 'error', reason: 'empty reflection from model' });
        continue;
      }

      const memoryDir = join(getAgentsDir(), role, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      const outPath = join(memoryDir, `reflections-${dateStr}.md`);
      writeFileSync(outPath, reflectionFrontmatter(dateStr) + reflection + '\n', 'utf-8');
      results.push({ role, status: 'written', path: outPath });
    } catch (err: unknown) {
      results.push({ role, status: 'error', reason: (err as Error).message });
    }
  }

  // Depletion observability: a failed headless `claude -p` call must not die
  // silently — post-June-15 credit billing means a depleted pool hard-fails
  // every call, and the nightly dream would otherwise just quietly stop
  // producing reflections. One summary alert per run, never throws.
  const errored = results.filter(r => r.status === 'error');
  if (errored.length > 0) {
    const detail = errored
      .map(r => `${r.role}: ${(r.reason || 'unknown').substring(0, 200)}`)
      .join('; ');
    try {
      await alert(
        `🚨 Nightly dream (reflection) FAILED for ${errored.length}/${results.length} role(s) — ${detail}. ` +
        `Model: ${dreamModel()}. If errors mention spawn/exit failures, the Anthropic credit pool may be depleted (June 15 per-user credit billing).`,
      );
    } catch {
      // Alerting must never fail the dream run itself
    }
  }

  return results;
}
