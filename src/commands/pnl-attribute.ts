/**
 * `aos pnl attribute` — RYA-895.
 *
 * Walks Claude Code JSONL transcripts in a time window, classifies each
 * assistant message via the heuristic classifier, and persists per-session
 * attribution rows to ~/.aos/state.db (table: attempt_attributions).
 *
 * Idempotent: re-running on the same window UPSERTs the same session_ids.
 */

import chalk from 'chalk';
import { backfillWindow, summarize } from '../analytics/cost-attribution.js';

interface AttributeCmdOptions {
  since?: string;       // e.g. "4w", "7d"
  dryRun?: boolean;
  limit?: number;
  json?: boolean;
}

function parseSinceWindowMs(since: string | undefined): number {
  if (!since) return 4 * 7 * 24 * 60 * 60 * 1000; // default: 4 weeks
  const m = since.match(/^(\d+)([dhwm])$/);
  if (!m) {
    throw new Error(`Invalid --since "${since}". Use e.g. 4w, 7d, 24h.`);
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  return unit === 'd' ? n * 24 * 60 * 60 * 1000
    : unit === 'h' ? n * 60 * 60 * 1000
    : unit === 'w' ? n * 7 * 24 * 60 * 60 * 1000
    : unit === 'm' ? n * 60 * 1000
    : 0;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export async function pnlAttributeCommand(opts: AttributeCmdOptions = {}): Promise<void> {
  const windowMs = parseSinceWindowMs(opts.since);
  const untilMs = Date.now();
  const sinceMs = untilMs - windowMs;

  if (!opts.json) {
    const sinceIso = new Date(sinceMs).toISOString().slice(0, 10);
    const untilIso = new Date(untilMs).toISOString().slice(0, 10);
    console.log(chalk.bold(`Attributing tokens for window ${sinceIso} → ${untilIso}...`));
  }

  const result = backfillWindow({
    sinceMs,
    untilMs,
    dryRun: !!opts.dryRun,
    limit: opts.limit,
  });

  const summary = summarize(result);

  if (opts.json) {
    console.log(JSON.stringify({
      window: { sinceMs, untilMs },
      summary,
      rowsWritten: result.rowsWritten,
      unattributedSessions: result.unattributedSessions,
      skippedOutOfWindow: result.skippedOutOfWindow,
    }, null, 2));
    return;
  }

  console.log();
  console.log(`Sessions classified:    ${summary.sessions}`);
  console.log(`Roles covered:          ${summary.rolesCovered}`);
  console.log(`Issues covered:         ${summary.issuesCovered}`);
  console.log(`Attempts matched:       ${summary.matchedAttempts}/${summary.sessions}`);
  console.log(`Unattributed sessions:  ${result.unattributedSessions} (no role mapping in attempts table)`);
  console.log(`Out-of-window skipped:  ${result.skippedOutOfWindow}`);
  console.log();
  console.log(chalk.bold('Token totals:'));
  console.log(`  Task: ${fmtTokens(summary.totalTaskTokens).padStart(8)}  ${fmtUsd(summary.totalTaskCostUsd)}`);
  console.log(`  Meta: ${fmtTokens(summary.totalMetaTokens).padStart(8)}  ${fmtUsd(summary.totalMetaCostUsd)}`);
  console.log(`  ${chalk.bold('Meta-tax')}: ${chalk.yellow(summary.metaTaxPct.toFixed(1) + '%')}`);
  console.log();
  console.log(chalk.bold('Classification quality:'));
  console.log(`  Mean confidence:    ${(summary.meanConfidence * 100).toFixed(1)}%`);
  console.log(`  Low-confidence:     ${summary.lowConfidenceSessions} sessions (< 60%)`);
  console.log();
  if (opts.dryRun) {
    console.log(chalk.dim(`--dry-run: ${result.attributions.length} rows computed but not written.`));
  } else {
    console.log(chalk.green(`✓ Wrote ${result.rowsWritten} rows to attempt_attributions.`));
  }
}
