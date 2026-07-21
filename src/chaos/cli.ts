/**
 * CLI for the chaos drill module.
 *
 * Subcommands wired into the top-level `aos chaos` group:
 *   aos chaos list                      — list available failure modes
 *   aos chaos generate <mode>           — generate a scenario JSON, print
 *   aos chaos run --scenario <id>       — run a scenario by id (or --mode)
 *   aos chaos report <run-id>           — re-print a saved run report
 *
 * All operations default to sandbox mode.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { loadTaxonomy, findFailureMode } from './taxonomy.js';
import { generateDrill } from './generator.js';
import { runDrill, formatRunReport } from './runner.js';
import { DrillRun } from './types.js';

const DEFAULT_RUN_DIR = path.join(os.homedir(), '.aos', 'chaos-runs');

function ensureRunDir(): string {
  if (!existsSync(DEFAULT_RUN_DIR)) mkdirSync(DEFAULT_RUN_DIR, { recursive: true });
  return DEFAULT_RUN_DIR;
}

export async function chaosListCommand(opts: { taxonomy?: string } = {}): Promise<void> {
  const modes = loadTaxonomy(opts.taxonomy);
  console.log(`# Chaos drill taxonomy (${modes.length} failure modes)\n`);
  for (const m of modes) {
    console.log(`- ${m.id} [${m.severity}/${m.surface}]`);
    console.log(`    ${m.title}`);
    if (m.incidentRefs && m.incidentRefs.length > 0) {
      console.log(`    refs: ${m.incidentRefs.join(', ')}`);
    }
  }
}

export async function chaosGenerateCommand(opts: {
  mode: string;
  seed?: number;
  target?: string;
  taxonomy?: string;
  out?: string;
}): Promise<void> {
  const modes = loadTaxonomy(opts.taxonomy);
  const mode = findFailureMode(modes, opts.mode);
  const scenario = generateDrill(mode, {
    seed: opts.seed,
    targetIssueKey: opts.target,
  });
  const json = JSON.stringify(scenario, null, 2);
  if (opts.out) {
    writeFileSync(opts.out, json + '\n', 'utf-8');
    console.log(`Wrote scenario to ${opts.out}`);
  } else {
    console.log(json);
  }
}

export async function chaosRunCommand(opts: {
  mode?: string;
  scenario?: string;
  seed?: number;
  target?: string;
  taxonomy?: string;
  iConfirmLive?: boolean;
  saveTo?: string;
}): Promise<void> {
  const sandbox = opts.iConfirmLive !== true;
  let scenarioOverride;

  if (opts.scenario && existsSync(opts.scenario)) {
    scenarioOverride = JSON.parse(readFileSync(opts.scenario, 'utf-8'));
  }

  const modeId = opts.mode ?? scenarioOverride?.failureModeId;
  if (!modeId) {
    console.error('Either --mode <id> or --scenario <path> is required.');
    process.exitCode = 2;
    return;
  }

  let run: DrillRun;
  try {
    run = await runDrill({
      modeId,
      scenarioOverride,
      sandbox,
      confirmLive: opts.iConfirmLive,
      generate: { seed: opts.seed, targetIssueKey: opts.target },
      taxonomyPath: opts.taxonomy,
    });
  } catch (err) {
    console.error(`chaos run aborted: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  console.log(formatRunReport(run));

  const dir = ensureRunDir();
  const savePath = opts.saveTo ?? path.join(dir, `${run.id}.json`);
  writeFileSync(savePath, JSON.stringify(run, null, 2) + '\n', 'utf-8');
  console.log(`\nSaved run to ${savePath}`);
}

export async function chaosReportCommand(opts: { runId: string }): Promise<void> {
  const dir = ensureRunDir();
  const direct = path.join(dir, opts.runId.endsWith('.json') ? opts.runId : `${opts.runId}.json`);
  let resolvedPath = direct;
  if (!existsSync(direct)) {
    // Fuzzy match: any file containing the runId.
    const match = readdirSync(dir).find(f => f.includes(opts.runId));
    if (!match) {
      throw new Error(`No run found for "${opts.runId}" in ${dir}`);
    }
    resolvedPath = path.join(dir, match);
  }
  const run: DrillRun = JSON.parse(readFileSync(resolvedPath, 'utf-8'));
  console.log(formatRunReport(run));
}
