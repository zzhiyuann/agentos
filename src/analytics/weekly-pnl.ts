/**
 * Weekly Agent P&L digest — formats aggregated token/cost data into a
 * Discord-postable markdown summary and (optionally) posts it.
 *
 * The digest answers the parent issue's "viral hook" question: what % of
 * our agent token spend last week went to meta-tax (HANDOFF.md, memory
 * updates, progress comments, status prose) vs. real task work?
 *
 * Output sections:
 *   1. Headline — total tokens, total USD, meta-tax % (one-liner)
 *   2. Task vs meta breakdown table (% + absolute)
 *   3. Per-agent breakdown (tokens, meta %)
 *   4. Top 3 most expensive issues
 *   5. Week-over-week delta on meta-tax %
 *
 * Persists last week's snapshot to ~/.aos/pnl-history.json so the next run
 * can compute the WoW delta.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from '../core/config.js';
import { postToDiscord } from '../core/discord.js';
import { upsertAttribution, findAttemptForSession } from '../core/db.js';
import {
  aggregateWindow,
  type AggregateBuckets,
  type DigestData,
  type AggregatorOptions,
  type SessionBuckets,
} from './pnl-aggregator.js';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_PATH = join(STATE_DIR, 'pnl-history.json');

export interface DigestSnapshot {
  generatedAt: string;
  windowStartIso: string;
  windowEndIso: string;
  totalTokens: number;
  taskTokens: number;
  metaTokens: number;
  totalCostUsd: number;
  metaTaxPct: number;
  perRole: Record<string, AggregateBuckets>;
}

interface History {
  lastSnapshot?: DigestSnapshot;
}

function loadHistory(): History {
  if (!existsSync(HISTORY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8')) as History;
  } catch {
    return {};
  }
}

function saveHistory(h: History): void {
  writeFileSync(HISTORY_PATH, JSON.stringify(h, null, 2));
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function totalTokens(b: AggregateBuckets): number {
  return b.taskTokens + b.metaTokens;
}

function metaTaxPct(b: AggregateBuckets): number {
  const total = totalTokens(b);
  if (total === 0) return 0;
  return (b.metaTokens / total) * 100;
}

/** Render a horizontal ASCII bar (markdown code-block) for a meta-tax %. */
function bar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtDateRange(sinceMs: number, untilMs: number): string {
  const s = new Date(sinceMs).toISOString().slice(0, 10);
  const e = new Date(untilMs).toISOString().slice(0, 10);
  return `${s} → ${e}`;
}

export interface FormatOptions {
  /** Previous snapshot for week-over-week delta. */
  previous?: DigestSnapshot;
  /** Title prefix override. */
  title?: string;
}

/** Format the digest into a Discord-friendly markdown string. */
export function formatDigest(data: DigestData, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  const title = opts.title ?? '📊 **Weekly Agent P&L**';
  const totalTok = totalTokens(data.totals);
  const metaPct = metaTaxPct(data.totals);
  const totalCost = data.totals.taskCostUsd + data.totals.metaCostUsd;

  lines.push(`${title} — ${fmtDateRange(data.sinceMs, data.untilMs)}`);
  lines.push('');

  if (totalTok === 0) {
    lines.push('_No agent activity captured this week._');
    return lines.join('\n');
  }

  // 1. Headline
  lines.push(
    `**Meta-tax this week: ${fmtPct(metaPct)}** — ${fmtTokens(data.totals.metaTokens)} of ${fmtTokens(totalTok)} tokens (${fmtUsd(totalCost)} total spend).`
  );

  // WoW delta
  if (opts.previous) {
    const delta = metaPct - opts.previous.metaTaxPct;
    const arrow = delta > 0.5 ? '🔺' : delta < -0.5 ? '🔻' : '➖';
    lines.push(`Week-over-week: ${arrow} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp (was ${fmtPct(opts.previous.metaTaxPct)}).`);
  } else {
    lines.push('_No prior snapshot — first run, no week-over-week delta yet._');
  }
  lines.push('');

  // 2. Task vs meta table
  lines.push('```');
  lines.push('Bucket  Tokens     Cost      Share');
  lines.push('─────── ────────── ───────── ──────');
  const taskShare = (data.totals.taskTokens / totalTok) * 100;
  lines.push(`Task    ${fmtTokens(data.totals.taskTokens).padEnd(10)} ${fmtUsd(data.totals.taskCostUsd).padEnd(9)} ${fmtPct(taskShare).padStart(6)}`);
  lines.push(`Meta    ${fmtTokens(data.totals.metaTokens).padEnd(10)} ${fmtUsd(data.totals.metaCostUsd).padEnd(9)} ${fmtPct(metaPct).padStart(6)}`);
  lines.push('```');
  lines.push('');

  // 3. Per-agent breakdown
  if (data.perRole.size > 0) {
    lines.push('**Per agent:**');
    lines.push('```');
    lines.push('Agent              Tokens     Cost      Meta-tax');
    lines.push('────────────────── ────────── ───────── ──────── ────');
    const sorted = Array.from(data.perRole.entries())
      .sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]));
    for (const [role, agg] of sorted) {
      const pct = metaTaxPct(agg);
      const cost = agg.taskCostUsd + agg.metaCostUsd;
      lines.push(
        `${role.padEnd(18)} ${fmtTokens(totalTokens(agg)).padEnd(10)} ${fmtUsd(cost).padEnd(9)} ${fmtPct(pct).padStart(7)}  ${bar(pct, 8)}`
      );
    }
    lines.push('```');
    lines.push('');
  }

  // 4. Top 3 most expensive issues
  if (data.perIssue.size > 0) {
    const top = Array.from(data.perIssue.entries())
      .map(([issue, agg]) => ({ issue, agg, total: totalTokens(agg), cost: agg.taskCostUsd + agg.metaCostUsd }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 3);
    lines.push('**Top 3 most expensive issues:**');
    for (const { issue, agg, total, cost } of top) {
      const pct = metaTaxPct(agg);
      lines.push(`• \`${issue}\` (${agg.role}) — ${fmtTokens(total)} tokens, ${fmtUsd(cost)}, ${fmtPct(pct)} meta`);
    }
    lines.push('');
  }

  // 5. Footer
  lines.push(`_${data.sessionCount} sessions${data.unattributedSessions ? `, ${data.unattributedSessions} unattributed (skipped)` : ''}_`);
  return lines.join('\n');
}

/** Build a serializable snapshot from a DigestData for history persistence. */
export function snapshotFromData(data: DigestData): DigestSnapshot {
  const totalTok = totalTokens(data.totals);
  const totalCost = data.totals.taskCostUsd + data.totals.metaCostUsd;
  const perRole: Record<string, AggregateBuckets> = {};
  for (const [role, agg] of data.perRole) perRole[role] = agg;
  return {
    generatedAt: new Date().toISOString(),
    windowStartIso: new Date(data.sinceMs).toISOString(),
    windowEndIso: new Date(data.untilMs).toISOString(),
    totalTokens: totalTok,
    taskTokens: data.totals.taskTokens,
    metaTokens: data.totals.metaTokens,
    totalCostUsd: totalCost,
    metaTaxPct: totalTok ? (data.totals.metaTokens / totalTok) * 100 : 0,
    perRole,
  };
}

export interface RunOptions {
  /** ms epoch for window start. Defaults to 7 days ago. */
  sinceMs?: number;
  /** ms epoch for window end. Defaults to now. */
  untilMs?: number;
  /** When true, format only — do not post or persist history. */
  dryRun?: boolean;
  /** Skip persisting the snapshot to history (useful for ad-hoc runs). */
  noPersist?: boolean;
  /** Override aggregator options (for tests). */
  aggregatorOpts?: Partial<AggregatorOptions>;
}

export interface RunResult {
  formatted: string;
  data: DigestData;
  posted: boolean;
  postError?: string;
  /** Number of sessions persisted to attempt_attributions table. */
  persistedSessions: number;
}

/** Persist per-session classification rows to attempt_attributions. */
export function persistSessions(sessions: SessionBuckets[]): number {
  let count = 0;
  for (const s of sessions) {
    const firstSeenIso = s.firstSeenMs ? new Date(s.firstSeenMs).toISOString() : null;
    const lastSeenIso = s.lastSeenMs ? new Date(s.lastSeenMs).toISOString() : null;
    const attemptId = findAttemptForSession(s.issueKey, s.role, firstSeenIso, lastSeenIso);
    try {
      upsertAttribution({
        session_id: s.sessionId,
        attempt_id: attemptId,
        issue_key: s.issueKey,
        role: s.role,
        task_tokens: s.taskTokens,
        meta_tokens: s.metaTokens,
        task_cost_usd: s.taskCostUsd,
        meta_cost_usd: s.metaCostUsd,
        // The aggregator currently tracks total messageCount; the richer
        // task/meta breakdown lives in cost-attribution.ts (used by `aos pnl
        // backfill`). Best-effort here: bias all messages to "task" for the
        // weekly digest's persisted rows. The dedicated backfill overwrites
        // these with accurate per-bucket counts when run.
        task_messages: s.messageCount,
        meta_messages: 0,
        classification_confidence: 1.0,
        first_seen_at: firstSeenIso,
        last_seen_at: lastSeenIso,
        transcript_path: null,
      });
      count += 1;
    } catch {
      // best-effort persistence — never block the digest on a write failure
    }
  }
  return count;
}

/** Generate, format, and (unless dryRun) post the weekly digest. */
export async function runWeeklyPnL(opts: RunOptions = {}): Promise<RunResult> {
  const untilMs = opts.untilMs ?? Date.now();
  const sinceMs = opts.sinceMs ?? (untilMs - ONE_WEEK_MS);
  const data = aggregateWindow({ sinceMs, untilMs, ...(opts.aggregatorOpts ?? {}) });
  const history = loadHistory();
  const formatted = formatDigest(data, { previous: history.lastSnapshot });

  // Persist per-session classifications regardless of dry-run — this populates
  // the attribution table for the validation task (RYA-899) and writeup baseline
  // (RYA-900). It's idempotent (UPSERT keyed on session_id) so re-running is safe.
  const persistedSessions = opts.noPersist ? 0 : persistSessions(data.sessions);

  let posted = false;
  let postError: string | undefined;
  if (!opts.dryRun) {
    try {
      posted = await postToDiscord('system', formatted);
      if (!posted) postError = 'webhook not configured or post failed';
    } catch (err) {
      postError = (err as Error).message;
    }
    if (!opts.noPersist) {
      saveHistory({ lastSnapshot: snapshotFromData(data) });
    }
  }

  return { formatted, data, posted, postError, persistedSessions };
}

/** Visible for testing — read the history file. */
export function _readHistory(): History {
  return loadHistory();
}

/** Visible for testing — overwrite history file (or pass null to delete). */
export function _writeHistory(h: History | null): void {
  if (h === null) {
    try {
      if (existsSync(HISTORY_PATH)) unlinkSync(HISTORY_PATH);
    } catch {
      /* best effort */
    }
    return;
  }
  saveHistory(h);
}
