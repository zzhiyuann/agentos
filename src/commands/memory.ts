/**
 * `aos memory distill` — CLI for the memory distill engine.
 *
 * Wires src/core/distill.ts (RYA-857 / RYA-940) into the aos CLI.
 * Subcommands: propose, apply, reject, metrics, list-runs, restore.
 *
 * RYA-967: schedule-driven propose + Discord notification mode for the
 * weekly launchd run. The schedule produces proposals; humans curate via
 * `aos memory distill apply`.
 */

import chalk from 'chalk';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  runPropose, listRuns, loadRun, saveRun, applyProposal, rejectProposal,
  computeMetrics, runBulkApply, restoreArchivedFile, listAvailableRoles,
  loadDistillConfig, DISTILL_DIR, ARCHIVE_DIR, type DistillProposal,
} from '../core/distill.js';
import { postToDiscord } from '../core/discord.js';

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export interface ProposeCmdOptions {
  role?: string;
  allRoles?: boolean;
  notify?: boolean;
  json?: boolean;
}

export async function distillProposeCommand(opts: ProposeCmdOptions = {}): Promise<void> {
  const roles = resolveRoles(opts);
  if (roles.length === 0) {
    console.error(chalk.red('No roles found. Specify --role <name> or --all-roles.'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.bold(`Distill propose: scanning ${roles.length} role(s) — ${roles.join(', ')}`));
  const result = runPropose({ roles });

  console.log(chalk.green(`✓ Run ${result.run_id}`));
  console.log(`  Memories scanned: ${result.meta.total_memories_scanned}`);
  console.log(`  Clusters: ${result.meta.total_clusters}`);
  console.log(`  Proposals: ${result.meta.total_proposals}`);
  console.log(`  Proposals JSON: ${result.proposals_path}`);
  console.log(`  Summary MD:     ${result.summary_path}`);

  if (opts.json) {
    console.log(JSON.stringify({
      run_id: result.run_id,
      proposals_path: result.proposals_path,
      summary_path: result.summary_path,
      total_memories_scanned: result.meta.total_memories_scanned,
      total_clusters: result.meta.total_clusters,
      total_proposals: result.meta.total_proposals,
    }, null, 2));
  }

  if (opts.notify) {
    const ok = await postDistillNotification(result.run_id, result.meta.total_memories_scanned, result.meta.total_proposals, roles, result.summary_path);
    if (ok) console.log(chalk.green('✓ Discord notification posted.'));
    else console.log(chalk.yellow('✗ Discord notification not posted (webhook not configured).'));
  }
}

function resolveRoles(opts: ProposeCmdOptions): string[] {
  if (opts.role) return [opts.role];
  if (opts.allRoles) return listAvailableRoles();
  return [];
}

async function postDistillNotification(
  runId: string,
  totalMemories: number,
  totalProposals: number,
  roles: string[],
  summaryPath: string,
): Promise<boolean> {
  const lines: string[] = [];
  lines.push('🧠 **Memory Distill — weekly run**');
  lines.push(`Run ID: \`${runId}\``);
  lines.push(`Roles scanned: ${roles.join(', ')} (${totalMemories} memories)`);
  lines.push(`Proposals: **${totalProposals}**`);
  lines.push('');
  lines.push(`Review:  \`aos memory distill metrics ${runId}\``);
  lines.push(`Apply:   \`aos memory distill apply ${runId} --kind merge --min-confidence 0.60\``);
  lines.push(`Summary: ${summaryPath}`);
  return postToDiscord('system', lines.join('\n'));
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface ApplyCmdOptions {
  proposalId?: string;
  kind?: string;
  minConfidence?: string;
  dryRun?: boolean;
}

export async function distillApplyCommand(runId: string, opts: ApplyCmdOptions = {}): Promise<void> {
  if (!runId) {
    console.error(chalk.red('Usage: aos memory distill apply <run-id> [...]'));
    process.exitCode = 1;
    return;
  }
  if (!opts.proposalId && !opts.kind && opts.minConfidence === undefined) {
    console.error(chalk.red('No filters supplied — refusing to apply every pending proposal.'));
    console.error(chalk.dim('Pass at least one of: --proposal-id <id> | --kind <k> | --min-confidence <n>'));
    console.error(chalk.dim(`Tip: \`aos memory distill metrics ${runId}\` to inspect proposals first.`));
    process.exitCode = 1;
    return;
  }
  const minConf = opts.minConfidence !== undefined ? parseFloat(opts.minConfidence) : undefined;
  if (opts.minConfidence !== undefined && Number.isNaN(minConf)) {
    console.error(chalk.red(`Invalid --min-confidence: ${opts.minConfidence}`));
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = runBulkApply(runId, {
      proposalId: opts.proposalId,
      kind: opts.kind,
      minConfidence: minConf,
      dryRun: !!opts.dryRun,
    });
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.dim(`--dry-run: ${result.candidates} candidate(s) would be applied`));
    for (const p of result.applied_proposals) console.log(`  • ${p.proposal_id}`);
    return;
  }

  console.log(chalk.green(`✓ Applied ${result.applied}/${result.candidates}`));
  if (result.skipped > 0) console.log(chalk.yellow(`  Skipped: ${result.skipped} (already applied/rejected)`));
  for (const p of result.applied_proposals) {
    console.log(`  • ${p.proposal_id} → ${p.merged_path ?? '(dry-run)'}`);
  }
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

export interface RejectCmdOptions {
  reason?: string;
}

export async function distillRejectCommand(
  runId: string,
  proposalId: string,
  opts: RejectCmdOptions = {},
): Promise<void> {
  if (!runId || !proposalId) {
    console.error(chalk.red('Usage: aos memory distill reject <run-id> <proposal-id> [--reason "..."]'));
    process.exitCode = 1;
    return;
  }
  let data;
  try {
    data = loadRun(runId);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
    return;
  }
  const proposal = data.proposals.find((p: DistillProposal) => p.proposal_id === proposalId);
  if (!proposal) {
    console.error(chalk.red(`No such proposal in ${runId}: ${proposalId}`));
    process.exitCode = 1;
    return;
  }
  const ok = rejectProposal(runId, proposal, opts.reason ?? 'no reason given');
  if (!ok) {
    console.log(chalk.yellow(`Skipped: proposal already applied or rejected`));
    return;
  }
  saveRun(runId, data);
  console.log(chalk.green(`✓ Rejected ${proposalId}: ${proposal.rejection_reason}`));
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

export interface MetricsCmdOptions {
  json?: boolean;
}

export async function distillMetricsCommand(runId: string, opts: MetricsCmdOptions = {}): Promise<void> {
  if (!runId) {
    console.error(chalk.red('Usage: aos memory distill metrics <run-id>'));
    process.exitCode = 1;
    return;
  }
  let data;
  try {
    data = loadRun(runId);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
    return;
  }
  const m = computeMetrics(runId, data);
  if (opts.json) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }
  console.log(chalk.bold(`Distill metrics: ${runId}`));
  console.log(`  Memories before:    ${m.memories_before}`);
  console.log(`  Memories after:     ${m.memories_after_estimated}`);
  console.log(`  Reduction:          ${chalk.cyan(m.reduction_pct + '%')}`);
  console.log(`  Total proposals:    ${m.total_proposals}`);
  console.log(`    Engine-generated: ${m.engine_proposals}`);
  console.log(`    Manual:           ${m.manual_proposals}`);
  console.log(`  Applied:            ${chalk.green(String(m.applied))}`);
  console.log(`  Rejected:           ${chalk.red(String(m.rejected))}`);
  console.log(`  Pending:            ${m.pending}`);
  console.log(`  Engine-only FP rate: ${m.false_positive_rate_engine_only}`);
  console.log(`  Combined FP rate:    ${m.false_positive_rate_combined}`);
}

// ---------------------------------------------------------------------------
// list-runs
// ---------------------------------------------------------------------------

export async function distillListRunsCommand(opts: { json?: boolean } = {}): Promise<void> {
  const runs = listRuns();
  if (opts.json) {
    console.log(JSON.stringify({ runs }, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.log(chalk.dim(`No distill runs found in ${DISTILL_DIR}`));
    return;
  }
  console.log(chalk.bold(`${runs.length} distill run(s):`));
  for (const r of runs) console.log(`  • ${r}`);
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export interface RestoreCmdOptions {
  list?: boolean;
}

export async function distillRestoreCommand(
  runId?: string,
  filename?: string,
  opts: RestoreCmdOptions = {},
): Promise<void> {
  if (opts.list || (!runId && !filename)) {
    listArchivesPretty();
    return;
  }
  if (!runId || !filename) {
    console.error(chalk.red('Usage: aos memory distill restore <run-id> <filename>  (or --list)'));
    process.exitCode = 1;
    return;
  }
  try {
    const r = restoreArchivedFile(runId, filename);
    console.log(chalk.green(`✓ Restored ${r.role}/${filename}`));
    console.log(`  ${r.archived_path} → ${r.restored_path}`);
  } catch (e) {
    console.error(chalk.red((e as Error).message));
    process.exitCode = 1;
  }
}

function listArchivesPretty(): void {
  if (!existsSync(ARCHIVE_DIR)) {
    console.log(chalk.dim(`No archives in ${ARCHIVE_DIR}`));
    return;
  }
  const runs = readdirSync(ARCHIVE_DIR);
  if (runs.length === 0) {
    console.log(chalk.dim(`No archives in ${ARCHIVE_DIR}`));
    return;
  }
  for (const runId of runs) {
    const dir = join(ARCHIVE_DIR, runId);
    const files = readdirSync(dir).filter(f => f.endsWith('.md'));
    console.log(chalk.bold(`${runId} (${files.length} files):`));
    for (const f of files) console.log(`  ${f}`);
  }
}

// ---------------------------------------------------------------------------
// config (reflective: show effective config — handy for ops)
// ---------------------------------------------------------------------------

export async function distillConfigCommand(): Promise<void> {
  const cfg = loadDistillConfig();
  console.log(JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------------------
// dream (A3.5: nightly per-role reflection)
// ---------------------------------------------------------------------------

export interface DreamCmdOptions {
  role?: string;
  sinceHours?: string;
  json?: boolean;
}

export async function dreamCommand(opts: DreamCmdOptions = {}): Promise<void> {
  const { runDream } = await import('../core/dream.js');

  const sinceHours = opts.sinceHours !== undefined ? parseFloat(opts.sinceHours) : 24;
  if (Number.isNaN(sinceHours) || sinceHours <= 0) {
    console.error(chalk.red(`Invalid --since-hours: ${opts.sinceHours}`));
    process.exitCode = 1;
    return;
  }

  const roles = opts.role ? [opts.role] : undefined;
  console.log(chalk.bold(`Dream: reflecting on the last ${sinceHours}h${opts.role ? ` for ${opts.role}` : ' for all roles'}`));

  const results = await runDream({ roles, sinceMs: sinceHours * 60 * 60 * 1000 });

  if (opts.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  for (const r of results) {
    if (r.status === 'written') {
      console.log(chalk.green(`✓ ${r.role}`) + chalk.dim(` → ${r.path}`));
    } else if (r.status === 'skipped') {
      console.log(chalk.dim(`- ${r.role}: skipped (${r.reason})`));
    } else {
      console.log(chalk.yellow(`✗ ${r.role}: ${r.reason}`));
    }
  }
  const written = results.filter(r => r.status === 'written').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log(chalk.dim(`\n${written} reflection(s) written, ${results.length - written - errors} skipped, ${errors} error(s).`));
  if (errors > 0) process.exitCode = 1;
}
