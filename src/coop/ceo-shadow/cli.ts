/**
 * CLI for the CEO Shadow corpus pipeline.
 *
 *   pnpm tsx src/coop/ceo-shadow/cli.ts fetch [--since=ISO] [--page-size=25] [--refresh]
 *   pnpm tsx src/coop/ceo-shadow/cli.ts extract [--out=PATH] [--since=ISO]
 *   pnpm tsx src/coop/ceo-shadow/cli.ts audit [--corpus=PATH]
 *   pnpm tsx src/coop/ceo-shadow/cli.ts all   [--since=ISO]
 *
 * Output (default):
 *   ~/.aos/ceo-shadow/raw/issues-page-NNN.json
 *   ~/.aos/ceo-shadow/corpus.jsonl
 *   ~/.aos/ceo-shadow/AUDIT.md
 *
 * RYA-845.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import { fetchAllIssues, iterCachedIssues } from './fetch.js';
import { extractEventsFromIssues } from './extract.js';
import { computeAudit, renderAuditMarkdown } from './audit.js';
import type { DecisionEvent } from './types.js';

const OUT_BASE = join(homedir(), '.aos', 'ceo-shadow');
const RAW_DIR = join(OUT_BASE, 'raw');
const CORPUS_PATH = join(OUT_BASE, 'corpus.jsonl');
const AUDIT_PATH = join(OUT_BASE, 'AUDIT.md');

function getApiKey(): string {
  const path = join(homedir(), '.aos', '.linear-api-key');
  if (!existsSync(path)) {
    throw new Error(`Linear API key not found at ${path}`);
  }
  return readFileSync(path, 'utf-8').trim();
}

function getTeamId(): string {
  const id = process.env.AOS_LINEAR_TEAM_ID;
  if (id) return id;
  // Fallback: read from project .env
  try {
    const repoRoot = process.cwd();
    const envPath = join(repoRoot, '.env');
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      const m = content.match(/AOS_LINEAR_TEAM_ID=(.+)/);
      if (m) return m[1].trim();
    }
  } catch { /* ignore */ }
  throw new Error('AOS_LINEAR_TEAM_ID not set');
}

function defaultSince(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString();
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      out[k] = v ?? true;
    }
  }
  return out;
}

async function cmdFetch(args: Record<string, string | boolean>): Promise<void> {
  const since = (args.since as string) ?? defaultSince();
  const pageSize = args['page-size'] ? parseInt(args['page-size'] as string, 10) : 25;
  const refresh = !!args.refresh;
  console.log(`[ceo-shadow] fetching issues since ${since} (pageSize=${pageSize}, refresh=${refresh})`);
  mkdirSync(RAW_DIR, { recursive: true });
  const result = await fetchAllIssues({
    apiKey: getApiKey(),
    teamId: getTeamId(),
    since,
    cacheDir: RAW_DIR,
    pageSize,
    refresh,
    log: (m) => console.log(m),
  });
  console.log(`[ceo-shadow] fetched ${result.issues} issues across ${result.pages} pages`);
}

function cmdExtract(args: Record<string, string | boolean>): void {
  const since = (args.since as string) ?? defaultSince();
  const outPath = (args.out as string) ?? CORPUS_PATH;
  mkdirSync(dirname(outPath), { recursive: true });
  const events = extractEventsFromIssues(iterCachedIssues(RAW_DIR), { sinceTs: since });
  const lines = events.map((e) => JSON.stringify(e));
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`[ceo-shadow] wrote ${events.length} events to ${outPath}`);
}

function cmdAudit(args: Record<string, string | boolean>): void {
  const corpusPath = (args.corpus as string) ?? CORPUS_PATH;
  if (!existsSync(corpusPath)) {
    throw new Error(`corpus not found: ${corpusPath} — run 'extract' first`);
  }
  const text = readFileSync(corpusPath, 'utf-8');
  const events: DecisionEvent[] = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const audit = computeAudit(events);
  const md = renderAuditMarkdown(audit);
  writeFileSync(AUDIT_PATH, md + '\n');
  console.log(md);
  console.log(`\n[ceo-shadow] audit written to ${AUDIT_PATH}`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'fetch':
      await cmdFetch(args);
      break;
    case 'extract':
      cmdExtract(args);
      break;
    case 'audit':
      cmdAudit(args);
      break;
    case 'all':
      await cmdFetch(args);
      cmdExtract(args);
      cmdAudit(args);
      break;
    default:
      console.error('Usage: cli.ts <fetch|extract|audit|all> [--since=ISO] [--page-size=N] [--refresh] [--out=PATH] [--corpus=PATH]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
