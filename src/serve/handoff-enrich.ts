/**
 * Auto-enrichment of HANDOFF.md from session log + git diff (RYA-902).
 *
 * Meta-tax reduction: agents previously hand-wrote "Files Changed" and
 * "Verification" sections in every HANDOFF.md, costing 100–500 output tokens
 * per session multiplied by every active issue. Both sections are mechanically
 * derivable from the workspace's git diff and the agent's session transcript,
 * so we generate them here and inject them into the HANDOFF.md before it's
 * posted as a Linear document.
 *
 * Agents now write only what is *not* mechanical: status_intent + a 1–3
 * sentence Summary explaining intent and decisions. The rest is auto-filled.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const SECTION_ORDER = ['Summary', 'Files Changed', 'Verification', 'Memory Updated', 'Remaining Issues'];

/**
 * Run `git diff --stat --name-status` against the workspace and format the
 * output as a markdown list. Returns null when:
 *   - the workspace doesn't exist
 *   - the workspace isn't a git repo
 *   - the diff is empty (clean working tree, nothing to enrich with)
 *
 * Both staged and unstaged changes are included (HEAD..working-tree).
 */
export function deriveFilesChanged(workspacePath: string): string | null {
  if (!workspacePath || !existsSync(workspacePath)) return null;
  if (!existsSync(join(workspacePath, '.git'))) return null;

  let nameStatus = '';
  try {
    nameStatus = execFileSync('git', ['diff', 'HEAD', '--name-status'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5_000,
      // Capture stderr — the default inherits it, dumping git usage text
      // into serve's stderr log when the workspace has no commits.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
  if (!nameStatus) return null;

  const lines = nameStatus.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  // Cap to keep the section bounded — full diff lives in git history anyway.
  const MAX = 40;
  const shown = lines.slice(0, MAX).map((line) => {
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const tag = status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'M' ? 'modified' : status;
    return `- \`${path}\` — ${tag}`;
  });
  const overflow = lines.length > MAX ? `\n- … and ${lines.length - MAX} more` : '';
  return shown.join('\n') + overflow;
}

interface ToolCallSummary {
  name: string;
  command?: string;
  filePath?: string;
}

function collectToolCalls(jsonlPath: string, sinceMs: number): ToolCallSummary[] {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, 'utf-8');
  } catch {
    return [];
  }
  const out: ToolCallSummary[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as { type?: string; timestamp?: string; message?: { content?: unknown[] } };
    if (obj.type !== 'assistant') continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
    if (ts && ts < sinceMs) continue;
    for (const c of obj.message?.content ?? []) {
      const tu = c as { type?: string; name?: string; input?: Record<string, unknown> };
      if (tu.type !== 'tool_use' || !tu.name) continue;
      out.push({
        name: tu.name,
        command: typeof tu.input?.command === 'string' ? tu.input.command : undefined,
        filePath: typeof tu.input?.file_path === 'string' ? tu.input.file_path : undefined,
      });
    }
  }
  return out;
}

/**
 * Locate the most recent .jsonl transcript for the given workspace path. Claude
 * Code writes per-workspace transcript directories under ~/.claude/projects/
 * with the workspace path slug-encoded (slashes → dashes, leading dash).
 */
export function findTranscriptForWorkspace(workspacePath: string): string | null {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  const slug = workspacePath.replace(/\//g, '-');
  for (const dirName of readdirSync(projectsDir)) {
    if (dirName !== slug && !dirName.endsWith(slug)) continue;
    const dir = join(projectsDir, dirName);
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    let newest: { path: string; mtime: number } | null = null;
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        const m = statSync(p).mtimeMs;
        if (!newest || m > newest.mtime) newest = { path: p, mtime: m };
      } catch (err) {
        console.log(chalk.dim(`[transcript] stat ${p} failed: ${(err as Error).message}`));
      }
    }
    if (newest) return newest.path;
  }
  return null;
}

const VERIFY_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  { re: /^npx\s+vitest\b/, tag: 'vitest' },
  { re: /^npm\s+(test|run\s+test)\b/, tag: 'npm-test' },
  { re: /\btsc\b/, tag: 'tsc' },
  { re: /^npx\s+eslint\b/, tag: 'eslint' },
  { re: /^cargo\s+(test|build)\b/, tag: 'cargo' },
  { re: /^pytest\b/, tag: 'pytest' },
  { re: /^go\s+(test|build)\b/, tag: 'go-test' },
  { re: /\bgit\s+commit\b/, tag: 'git-commit' },
  { re: /\bgit\s+push\b/, tag: 'git-push' },
];

/**
 * Scan a session's bash tool calls for build/test/verification commands and
 * dedupe them into a short list. Returns null if nothing verification-shaped
 * ran during the session.
 */
export function deriveVerification(workspacePath: string, sessionStartMs: number): string | null {
  const transcript = findTranscriptForWorkspace(workspacePath);
  if (!transcript) return null;
  const calls = collectToolCalls(transcript, sessionStartMs);
  const seen = new Map<string, string>(); // tag → most-specific command
  for (const c of calls) {
    if (c.name !== 'Bash' || !c.command) continue;
    const cmd = c.command.replace(/\s+/g, ' ').trim();
    for (const { re, tag } of VERIFY_PATTERNS) {
      if (re.test(cmd)) {
        // Prefer the longest (most specific) command per tag.
        const prev = seen.get(tag);
        if (!prev || cmd.length > prev.length) {
          seen.set(tag, cmd.slice(0, 120));
        }
        break;
      }
    }
  }
  if (seen.size === 0) return null;
  const items: string[] = [];
  for (const cmd of seen.values()) {
    items.push(`- \`${cmd}\``);
  }
  return items.join('\n');
}

interface ParsedHandoff {
  frontMatter: string | null;
  body: string;
  sections: Map<string, string>;
}

/**
 * Parse a HANDOFF.md into front matter + a section map keyed by H2 title.
 * Sections are the markdown content between `## <Title>` lines.
 */
export function parseHandoff(handoff: string): ParsedHandoff {
  let frontMatter: string | null = null;
  let body = handoff;
  const fmMatch = handoff.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    frontMatter = fmMatch[1];
    body = handoff.slice(fmMatch[0].length);
  }
  const sections = new Map<string, string>();
  const headingRe = /^## (.+)$/gm;
  const matches: Array<{ title: string; index: number; len: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body))) {
    matches.push({ title: m[1].trim(), index: m.index, len: m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].len;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    sections.set(matches[i].title, body.slice(start, end).trim());
  }
  return { frontMatter, body, sections };
}

/** Heuristic: a section is empty/template when it's blank, just a placeholder, or just whitespace bullets. */
function sectionIsEmpty(content: string | undefined): boolean {
  if (!content) return true;
  const trimmed = content.trim();
  if (!trimmed) return true;
  // Template placeholders use bracketed prose hints.
  if (/^\[.*\]$/s.test(trimmed) && trimmed.length < 200) return true;
  return false;
}

export interface EnrichOptions {
  workspacePath: string;
  /** epoch ms — earliest tool-call timestamp to include in Verification scan */
  sessionStartMs: number;
  /** When true, also overwrite a non-empty Files Changed/Verification section. */
  forceOverwrite?: boolean;
}

/**
 * Enrich a HANDOFF.md by injecting auto-derived Files Changed and Verification
 * sections when the agent left them empty. Idempotent: re-running on already-
 * enriched HANDOFF.md is a no-op (sections are non-empty after first enrichment).
 *
 * Behavioural rules:
 *   - Front matter is preserved verbatim.
 *   - Existing Summary, Memory Updated, Remaining Issues are preserved.
 *   - Files Changed: filled from `git diff` if section is empty/template.
 *   - Verification: filled from session bash tool calls if section is empty/template.
 *   - When neither auto source produced output, the original handoff is returned unchanged.
 */
export function enrichHandoff(handoff: string, opts: EnrichOptions): string {
  const parsed = parseHandoff(handoff);
  let touched = false;

  const filesEmpty = sectionIsEmpty(parsed.sections.get('Files Changed'));
  const verifyEmpty = sectionIsEmpty(parsed.sections.get('Verification'));

  if (filesEmpty || opts.forceOverwrite) {
    const derived = deriveFilesChanged(opts.workspacePath);
    if (derived) {
      parsed.sections.set('Files Changed', `${derived}\n\n_Auto-derived from \`git diff\` — RYA-902._`);
      touched = true;
    }
  }
  if (verifyEmpty || opts.forceOverwrite) {
    const derived = deriveVerification(opts.workspacePath, opts.sessionStartMs);
    if (derived) {
      parsed.sections.set('Verification', `${derived}\n\n_Auto-derived from session log — RYA-902._`);
      touched = true;
    }
  }

  if (!touched) return handoff;

  return rebuildHandoff(parsed);
}

function rebuildHandoff(parsed: ParsedHandoff): string {
  const out: string[] = [];
  if (parsed.frontMatter !== null) {
    out.push(`---\n${parsed.frontMatter}\n---`);
  }
  // Preserve the H1 title if present (everything in body before the first ## heading).
  const firstSection = parsed.body.match(/^## /m);
  const preamble = firstSection ? parsed.body.slice(0, firstSection.index).trim() : parsed.body.trim();
  if (preamble) out.push(preamble);

  // Emit known sections in canonical order; preserve any unknown sections appended after.
  const knownEmitted = new Set<string>();
  for (const title of SECTION_ORDER) {
    const content = parsed.sections.get(title);
    if (content !== undefined && content.length > 0) {
      out.push(`## ${title}\n\n${content}`);
      knownEmitted.add(title);
    }
  }
  for (const [title, content] of parsed.sections) {
    if (knownEmitted.has(title)) continue;
    if (content.length === 0) continue;
    out.push(`## ${title}\n\n${content}`);
  }
  return out.join('\n\n') + '\n';
}
