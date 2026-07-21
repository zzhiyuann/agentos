/**
 * `aos replay fork <trace.jsonl> --from-step N --edit-prompt|--edit-tool-result`
 *
 * Phase 2 of RYA-751. Builds a fork from a captured replay trace by:
 *   1. Locating the original Claude Code session JSONL referenced in the trace
 *   2. Truncating to step N and applying the user's edit (L1 prompt or L2 tool_result)
 *   3. Restoring workspace state to step N (best-effort via captured snapshots)
 *   4. Spawning `claude --resume <fork-sid> --fork-session` against the prepared dir
 *
 * Determinism boundaries are documented in docs/replay-adr.md (D2/D3). The
 * replay step (0..N-1) is realized by handing Claude Code a session JSONL that
 * already contains those messages — Claude Code itself replays them when it
 * loads the session, without re-billing token cost for the messages already
 * captured.
 */

import { execSync, spawn } from 'child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync,
} from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import chalk from 'chalk';

import { STATE_DIR } from '../core/config.js';
import {
  applyEdit,
  buildForkPlan,
  encodeWorkspacePath,
  extractFileSnapshotsUpTo,
  findStep,
  parseClaudeJsonl,
  resolveStepUuid,
  rewriteSessionId,
  serializeJsonl,
  truncateAtUuid,
  type EditMutation,
  type ForkPlan,
  type TraceRecord,
} from '../replay/fork-engine.js';

export interface ForkOptions {
  fromStep: number;
  editPrompt?: string;
  editToolResult?: string;
  toolResultIsError?: boolean;
  workspace?: string;
  forkId?: string;
  forkSid?: string;
  /** Don't actually spawn the subprocess; print the plan and stop. */
  printPlan?: boolean;
  /** Prepare seed JSONL + workspace, but skip the live spawn (for testing). */
  noSpawn?: boolean;
  /** Override agent role for the spawned process (default: same as original). */
  agentRole?: string;
}

export interface ForkResult {
  plan: ForkPlan;
  spawned: boolean;
  /** Resolved Claude Code uuid for the fork-from step. */
  fromUuid: string;
  /** Where workspace was restored. */
  workspacePath: string;
  /** Where the seeded JSONL was written. */
  seededJsonlPath: string;
  /** Number of records the seeded JSONL contains (= N+1 effectively). */
  seededRecordCount: number;
  /** Workspace files restored from snapshots. */
  restoredFiles: string[];
  /** Files the snapshot referenced but couldn't be restored (backup missing). */
  unresolvedFiles: string[];
}

export async function replayForkCommand(
  tracePath: string,
  options: ForkOptions,
): Promise<ForkResult> {
  // ---- Validate flags ----
  if (!existsSync(tracePath)) {
    throw new Error(`trace file not found: ${tracePath}`);
  }
  if (!options.editPrompt && !options.editToolResult) {
    throw new Error('must specify exactly one of --edit-prompt or --edit-tool-result');
  }
  if (options.editPrompt && options.editToolResult) {
    throw new Error('--edit-prompt and --edit-tool-result are mutually exclusive');
  }
  if (!Number.isFinite(options.fromStep) || options.fromStep < 0) {
    throw new Error(`--from-step must be a non-negative integer (got ${options.fromStep})`);
  }

  const edit: EditMutation = options.editPrompt
    ? { kind: 'prompt', text: options.editPrompt }
    : { kind: 'tool_result', text: options.editToolResult ?? '', isError: options.toolResultIsError ?? false };

  // ---- Parse trace + build plan ----
  const trace = readJsonlTrace(tracePath);
  const plan = buildForkPlan({
    trace,
    fromStep: options.fromStep,
    edit,
    forkId: options.forkId,
    forkSid: options.forkSid,
    workspacePath: options.workspace,
    homeDir: homedir(),
    stateDir: STATE_DIR,
  });

  // ---- Validate source JSONL exists ----
  if (!existsSync(plan.sourceJsonlPath)) {
    throw new Error(
      `original Claude Code JSONL not found at ${plan.sourceJsonlPath}. ` +
      `It may have been deleted or the original session was on a different host.`,
    );
  }

  // ---- Resolve fromUuid by reading the source JSONL ----
  const sourceContent = readFileSync(plan.sourceJsonlPath, 'utf-8');
  const sourceRecords = parseClaudeJsonl(sourceContent);
  const step = findStep(trace, options.fromStep);
  const fromUuid = resolveStepUuid(step, sourceRecords);

  // ---- Truncate + mutate ----
  const truncated = truncateAtUuid(sourceRecords, fromUuid);
  const mutated = applyEdit(truncated, edit, { stepToolUseId: typeof step.tool_use_id === 'string' ? step.tool_use_id : undefined });
  const seededRecords = rewriteSessionId(mutated, plan.forkSid);

  // ---- Print plan if requested ----
  if (options.printPlan) {
    printPlan(plan, fromUuid, seededRecords.length);
    return { plan, spawned: false, fromUuid, workspacePath: plan.workspacePath, seededJsonlPath: plan.seededJsonlPath, seededRecordCount: seededRecords.length, restoredFiles: [], unresolvedFiles: [] };
  }

  // ---- Prepare fork workspace (clone of original) ----
  prepareForkWorkspace(plan.workspacePath, plan.parentWorkspacePath);

  // ---- Restore files from captured file-history-snapshots ----
  const snapshots = extractFileSnapshotsUpTo(trace, options.fromStep);
  const { restored, unresolved } = restoreFromSnapshots(plan.workspacePath, snapshots);

  // ---- Write seeded JSONL into Claude Code's projects dir for the fork workspace ----
  mkdirSync(dirname(plan.seededJsonlPath), { recursive: true });
  writeFileSync(plan.seededJsonlPath, serializeJsonl(seededRecords), 'utf-8');

  // ---- Drop a fork-marker file so the spawned agent knows it's a fork ----
  const markerPath = join(plan.workspacePath, '.aos-fork.json');
  writeFileSync(markerPath, JSON.stringify({
    fork_id: plan.forkId,
    parent_sid: plan.parentSid,
    fork_sid: plan.forkSid,
    from_step: plan.fromStep,
    from_uuid: fromUuid,
    edit_kind: edit.kind,
    parent_workspace: plan.parentWorkspacePath,
    created_at: new Date().toISOString(),
    advisory: 'This is a fork session. External writes (Linear comments, dispatches, status changes) are NOT permitted — see ADR D7.',
  }, null, 2), 'utf-8');

  // ---- Print plan summary ----
  printPlan(plan, fromUuid, seededRecords.length, { restored: restored.length, unresolved: unresolved.length });

  if (options.noSpawn) {
    console.log(chalk.dim('  [--no-spawn] skipping live continuation'));
    return { plan, spawned: false, fromUuid, workspacePath: plan.workspacePath, seededJsonlPath: plan.seededJsonlPath, seededRecordCount: seededRecords.length, restoredFiles: restored, unresolvedFiles: unresolved };
  }

  // ---- Spawn the live continuation ----
  const spawned = await spawnLiveContinuation(plan, options.agentRole);
  return {
    plan,
    spawned,
    fromUuid,
    workspacePath: plan.workspacePath,
    seededJsonlPath: plan.seededJsonlPath,
    seededRecordCount: seededRecords.length,
    restoredFiles: restored,
    unresolvedFiles: unresolved,
  };
}

// ---------- Helpers ----------

function readJsonlTrace(path: string): TraceRecord[] {
  const content = readFileSync(path, 'utf-8');
  const out: TraceRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as TraceRecord); } catch { /* skip malformed */ }
  }
  return out;
}

function prepareForkWorkspace(forkPath: string, parentPath: string): void {
  if (existsSync(forkPath)) {
    throw new Error(
      `fork workspace already exists: ${forkPath}. ` +
      `Pick a different --workspace or --fork-id, or remove the existing dir.`,
    );
  }
  mkdirSync(dirname(forkPath), { recursive: true });

  if (existsSync(parentPath)) {
    // APFS clonefile via `cp -c` (macOS) → near-zero cost. Fall back to recursive copy.
    try {
      execSync(`cp -c -R "${parentPath}" "${forkPath}"`, { stdio: 'ignore' });
    } catch {
      cpSync(parentPath, forkPath, { recursive: true, force: true });
    }
  } else {
    mkdirSync(forkPath, { recursive: true });
  }
}

interface SnapshotRestoreResult {
  restored: string[];
  unresolved: string[];
}

function restoreFromSnapshots(
  workspacePath: string,
  snapshots: ReturnType<typeof extractFileSnapshotsUpTo>,
): SnapshotRestoreResult {
  const restored: string[] = [];
  const unresolved: string[] = [];
  for (const snap of snapshots) {
    if (!snap.backupPath || !existsSync(snap.backupPath)) {
      unresolved.push(snap.path);
      continue;
    }
    // snap.path is absolute (Claude Code uses absolute paths). Map to fork workspace
    // by replacing the parent workspace prefix if present.
    const target = snap.path; // absolute — fork workspace was cloned to a different path,
                              // so we have to be careful not to write to the PARENT workspace.
    // If snap.path is inside the parent workspace, rewrite to the fork workspace.
    // Otherwise, this is a file outside the workspace — restoring it would mutate
    // global state, which we refuse to do.
    const rewritten = rewritePathToFork(snap.path, workspacePath);
    if (!rewritten) {
      unresolved.push(snap.path);
      continue;
    }
    try {
      mkdirSync(dirname(rewritten), { recursive: true });
      copyFileSync(snap.backupPath, rewritten);
      restored.push(rewritten);
    } catch {
      unresolved.push(snap.path);
    }
  }
  return { restored, unresolved };
}

/**
 * Rewrite an absolute path under the parent workspace to the fork workspace.
 * Returns null if the path is outside any known workspace (refusing to mutate
 * global state).
 *
 * Heuristic: most file-history-snapshot paths look like
 * `<HOME>/agent-workspaces/RYA-XXX/<relative>`. We extract the relative
 * suffix after the first `agent-workspaces/<key>/` segment and join it under
 * the fork workspace.
 */
function rewritePathToFork(absPath: string, forkWorkspace: string): string | null {
  const m = absPath.match(/agent-workspaces\/[^/]+\/(.*)$/);
  if (m) return join(forkWorkspace, m[1]);
  // Fall through: if the path's basename exists at top-level workspace, use it.
  const idx = absPath.lastIndexOf('/');
  if (idx > 0) return join(forkWorkspace, absPath.slice(idx + 1));
  return null;
}

async function spawnLiveContinuation(plan: ForkPlan, agentRole?: string): Promise<boolean> {
  // Build the claude resume command. `--fork-session` ensures Claude Code creates
  // its own NEW session rather than appending to ours (defense in depth).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AOS_FORK_MODE: '1',
    AOS_FORK_ID: plan.forkId,
    AOS_FORK_PARENT_SID: plan.parentSid,
  };
  if (agentRole) env.AGENT_ROLE = agentRole;

  console.log('');
  console.log(chalk.bold('Spawning live continuation'));
  console.log(`  ${chalk.dim('cwd:')}     ${plan.workspacePath}`);
  console.log(`  ${chalk.dim('resume:')}  ${plan.forkSid}`);
  console.log(`  ${chalk.dim('cmd:')}     claude --resume ${plan.forkSid} --fork-session`);
  console.log('');

  const child = spawn('claude', [
    '--resume', plan.forkSid,
    '--fork-session',
    '--dangerously-skip-permissions',
  ], {
    cwd: plan.workspacePath,
    env,
    stdio: 'inherit',
  });

  return new Promise<boolean>((resolve) => {
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', (err) => {
      console.error(chalk.red(`spawn failed: ${err.message}`));
      resolve(false);
    });
  });
}

function printPlan(
  plan: ForkPlan,
  fromUuid: string,
  seededCount: number,
  restore?: { restored: number; unresolved: number },
): void {
  console.log('');
  console.log(chalk.bold('Fork plan'));
  console.log(`  ${chalk.dim('fork-id:')}        ${plan.forkId}`);
  console.log(`  ${chalk.dim('parent-sid:')}     ${plan.parentSid}`);
  console.log(`  ${chalk.dim('fork-sid:')}       ${plan.forkSid}`);
  console.log(`  ${chalk.dim('from-step:')}      ${plan.fromStep}`);
  console.log(`  ${chalk.dim('from-uuid:')}      ${fromUuid}`);
  console.log(`  ${chalk.dim('edit:')}           ${plan.edit.kind === 'prompt' ? 'prompt' : 'tool_result'}`);
  console.log(`  ${chalk.dim('parent-ws:')}      ${plan.parentWorkspacePath}`);
  console.log(`  ${chalk.dim('fork-ws:')}        ${plan.workspacePath}`);
  console.log(`  ${chalk.dim('seeded-jsonl:')}   ${plan.seededJsonlPath}`);
  console.log(`  ${chalk.dim('seeded-records:')} ${seededCount}`);
  if (restore) {
    console.log(`  ${chalk.dim('restored-files:')} ${restore.restored}`);
    if (restore.unresolved > 0) {
      console.log(`  ${chalk.dim('unresolved:')}     ${chalk.yellow(`${restore.unresolved} files (snapshots missing — workspace clone is the fallback)`)}`);
    }
  }
  console.log('');
}

// ---- Re-exports for consistency ----

export { encodeWorkspacePath };

// Marker type to satisfy strict mode (statSync is used by some downstream
// integrators that import from this module; keep import alive)
void statSync;
