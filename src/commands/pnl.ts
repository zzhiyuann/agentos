/**
 * `aos pnl digest` — generate the weekly Agent P&L digest.
 *
 * Default: post the digest to Discord via the configured system webhook
 * and persist a snapshot for next-week's WoW delta. Use --dry-run to
 * preview the output without posting or persisting.
 */

import chalk from 'chalk';
import { runWeeklyPnL } from '../analytics/weekly-pnl.js';

interface DigestCmdOptions {
  since?: string;          // e.g. "7d", "14d"
  dryRun?: boolean;
  noPersist?: boolean;
}

function parseSinceWindowMs(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const m = since.match(/^(\d+)([dhwm])$/);
  if (!m) {
    throw new Error(`Invalid --since "${since}". Use e.g. 7d, 24h, 2w.`);
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === 'd' ? n * 24 * 60 * 60 * 1000
    : unit === 'h' ? n * 60 * 60 * 1000
    : unit === 'w' ? n * 7 * 24 * 60 * 60 * 1000
    : unit === 'm' ? n * 60 * 1000
    : 0;
  return ms;
}

export async function pnlDigestCommand(opts: DigestCmdOptions = {}): Promise<void> {
  const windowMs = parseSinceWindowMs(opts.since);
  const untilMs = Date.now();
  const sinceMs = windowMs ? untilMs - windowMs : untilMs - 7 * 24 * 60 * 60 * 1000;

  const result = await runWeeklyPnL({
    sinceMs,
    untilMs,
    dryRun: !!opts.dryRun,
    noPersist: !!opts.noPersist,
  });

  console.log(result.formatted);
  console.log();

  if (opts.dryRun) {
    console.log(chalk.dim(`--dry-run: not posted. ${result.persistedSessions} session(s) classified.`));
    return;
  }

  if (result.posted) {
    console.log(chalk.green(`✓ Posted digest to Discord (${result.data.sessionCount} sessions analyzed, ${result.persistedSessions} persisted).`));
  } else {
    console.log(chalk.yellow(`✗ Digest not posted: ${result.postError ?? 'unknown reason'}`));
    if (result.postError && result.postError.includes('webhook not configured')) {
      console.log(chalk.dim('  Configure webhook with: aos setup discord'));
    }
    process.exitCode = 1;
  }
}
