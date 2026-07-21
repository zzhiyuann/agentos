/**
 * Auto-deploy watcher: rebuilds TypeScript and restarts serve when src/ changes.
 *
 * Uses Node.js fs.watch (recursive, macOS FSEvents) to detect file changes,
 * debounces rapid edits, runs `tsc`, and signals the serve-loop wrapper
 * to restart by exiting with code 100.
 *
 * SAFETY: Permission-sensitive files (claude-code.ts, router.ts) are blocked
 * from auto-deploy. These require single-agent manual testing + COO approval
 * before fleet rollout. See RYA-203.
 */
import { watch, statSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { postDiscordSystem } from '../core/discord.js';

const DEBOUNCE_MS = 3_000;
const RESTART_EXIT_CODE = 100;

/**
 * Quiet period required on dist/ before a stale-dist restart (RYA-1195).
 * Long enough to coalesce a full tsc emit wave; short enough that a
 * deploy-gap window closes in seconds, not minutes.
 */
const DIST_QUIET_MS = 10_000;

/** Wall-clock time this process started (modules were loaded shortly after). */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

/**
 * Permission-sensitive files that must NOT be auto-deployed.
 * Changes to these files affect how agents are spawned and what permissions they have.
 * Auto-deploying permission changes fleet-wide caused 3 production reverts (RYA-86/88).
 * Protocol: single-agent manual test → COO approval → manual deploy.
 */
const PERMISSION_SENSITIVE_PATTERNS = [
  'adapters/claude-code.ts',  // Agent spawn command, --permission-mode flag
  'core/router.ts',           // Default agent registry, permission-mode in command
];

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let building = false;
let blockedFiles: string[] = [];
let lastBlockedAlertKey: string | null = null;

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.cyan(`[${ts}] [auto-deploy] ${msg}`));
}

function getProjectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // At runtime: dist/serve/auto-deploy.js → project root (../../)
  return resolve(thisFile, '..', '..', '..');
}

function isPermissionSensitive(filename: string): boolean {
  return PERMISSION_SENSITIVE_PATTERNS.some(pattern => filename.endsWith(pattern));
}

/** Short hash of HEAD in the watched repo, or 'unknown' outside a git checkout. */
export function getHeadCommit(projectRoot: string): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: 'pipe',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Discord message for a blocked auto-deploy. Exported for tests. */
export function formatBlockedDeployAlert(files: string[], commit: string): string {
  return [
    `⛔ **Manual deploy pending** — auto-deploy skipped commit \`${commit}\` because permission-sensitive files changed:`,
    ...files.map(f => `• \`${f}\``),
    '',
    'Serve is still running the OLD code — this fix is built but NOT live.',
    'Required (RYA-203): single-agent manual test → COO approval → `npx tsc` + manual serve restart.',
  ].join('\n');
}

/**
 * Alert that a manual deploy is pending (Discord + console.warn).
 * Dedupes per (commit, file-set) so repeated debounce ticks for the same
 * pending change alert once; a new commit or new blocked file re-alerts.
 * The dedup key is only recorded when the Discord post succeeds, so a
 * failed/unconfigured webhook retries on the next change event.
 * Returns true if a Discord alert was posted.
 */
export async function alertBlockedDeploy(
  projectRoot: string,
  files: string[],
  opts: {
    poster?: (msg: string) => Promise<boolean>;
    commit?: string;
  } = {}
): Promise<boolean> {
  const commit = opts.commit ?? getHeadCommit(projectRoot);
  const uniqueFiles = [...new Set(files)].sort();
  const key = `${commit}:${uniqueFiles.join(',')}`;

  console.warn(
    `[auto-deploy] ⛔ Manual serve restart required to deploy commit ${commit} — ` +
    `permission-sensitive files skipped: ${uniqueFiles.join(', ')}`
  );

  if (key === lastBlockedAlertKey) return false;

  const poster = opts.poster ?? postDiscordSystem;
  const sent = await poster(formatBlockedDeployAlert(uniqueFiles, commit));
  if (sent) {
    lastBlockedAlertKey = key;
  } else {
    log(chalk.yellow('Discord alert for blocked deploy was NOT delivered (webhook missing or failed) — will retry on next change.'));
  }
  return sent;
}

/** Test-only: reset the blocked-deploy alert dedup state. */
export function _resetBlockedDeployAlertState(): void {
  lastBlockedAlertKey = null;
}

/**
 * Check if any .ts file in a directory tree is newer than a given threshold.
 */
function hasNewerFiles(dir: string, threshold: number): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (hasNewerFiles(fullPath, threshold)) return true;
      } else if (entry.name.endsWith('.ts')) {
        const stat = statSync(fullPath);
        if (stat.mtimeMs > threshold) return true;
      }
    }
  } catch (err) {
    console.log(chalk.dim(`[auto-deploy] hasNewerFiles scan failed: ${(err as Error).message}`));
  }
  return false;
}

/**
 * Check if any src/ file is newer than dist/cli.js (the build entry point).
 */
function needsRebuild(projectRoot: string): boolean {
  try {
    const distEntry = join(projectRoot, 'dist', 'cli.js');
    const distStat = statSync(distEntry);
    return hasNewerFiles(join(projectRoot, 'src'), distStat.mtimeMs);
  } catch {
    // dist/cli.js doesn't exist — definitely needs rebuild
    return true;
  }
}

function runBuild(projectRoot: string): boolean {
  log('Rebuilding TypeScript...');
  try {
    // RYA-1195: serialize with the post-commit hook via the shared build
    // mutex. Timeout covers lock wait (up to 240s) plus the build itself.
    execSync('bash scripts/build-locked.sh', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 300_000,
      stdio: 'pipe',
    });
    log('Build succeeded.');
    return true;
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const output = (error.stderr || error.stdout || 'unknown error').trim();
    // Show first 10 lines of error to keep logs readable
    const lines = output.split('\n').slice(0, 10).join('\n');
    log(`Build FAILED:\n${lines}`);
    return false;
  }
}

function handleChange(projectRoot: string, changedFile?: string): void {
  if (building) return;

  // Track permission-sensitive files across debounce window
  if (changedFile && isPermissionSensitive(changedFile)) {
    blockedFiles.push(changedFile);
  }

  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    if (!needsRebuild(projectRoot)) {
      blockedFiles = [];
      return;
    }

    // Block auto-deploy when permission-sensitive files changed (RYA-203)
    if (blockedFiles.length > 0) {
      log(chalk.red('⛔ AUTO-DEPLOY BLOCKED — permission-sensitive files changed:'));
      for (const f of blockedFiles) {
        log(chalk.red(`   • ${f}`));
      }
      log(chalk.yellow('These files control agent spawn permissions. Fleet-wide auto-deploy'));
      log(chalk.yellow('of permission changes caused 3 production incidents (RYA-86/88).'));
      log(chalk.yellow(''));
      log(chalk.yellow('Required protocol:'));
      log(chalk.yellow('  1. Test on ONE agent manually (see runbook)'));
      log(chalk.yellow('  2. Get COO approval'));
      log(chalk.yellow('  3. Deploy manually: npx tsc && kill serve → serve-loop restarts'));
      log(chalk.yellow(''));
      log(chalk.yellow('See: ~/.aos/shared-memory/permission-model-protocol.md'));
      // RYA-1189: the gate is intentional, the silence was not — alert that a
      // manual deploy is pending so the fix doesn't sit un-deployed unnoticed.
      void alertBlockedDeploy(projectRoot, blockedFiles).catch(err => {
        log(chalk.yellow(`Blocked-deploy alert failed: ${(err as Error).message}`));
      });
      blockedFiles = [];
      return;
    }

    building = true;
    const success = runBuild(projectRoot);
    building = false;

    if (success) {
      log('Restarting serve (exit 100)...');
      process.exit(RESTART_EXIT_CODE);
    }
    // On failure: stay running, agent can fix and commit again.
    // tsc emits JS even when typechecking fails (no noEmitOnError), so our
    // own failed build just rewrote dist/. Advance the staleness threshold
    // so the dist watcher doesn't restart us into a non-typechecking build.
    distStaleThresholdMs = Date.now();
  }, DEBOUNCE_MS);
}

let distStaleThresholdMs = PROCESS_START_MS;
let distDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Recursively find .js files under dir with mtime newer than thresholdMs.
 * A hit under dist/ means code on disk is newer than the code this process
 * loaded at startup — i.e. the running serve is stale (RYA-1195).
 */
export function findFilesNewerThan(dir: string, thresholdMs: number): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        found.push(...findFilesNewerThan(fullPath, thresholdMs));
      } else if (entry.name.endsWith('.js') && statSync(fullPath).mtimeMs > thresholdMs) {
        found.push(fullPath);
      }
    } catch {
      // file vanished mid-scan (builder still writing) — ignore
    }
  }
  return found;
}

function scheduleStaleDistRestart(distDir: string): void {
  if (distDebounceTimer) clearTimeout(distDebounceTimer);
  distDebounceTimer = setTimeout(() => {
    if (building) {
      // Our own build is running; it exits 100 on success by itself.
      scheduleStaleDistRestart(distDir);
      return;
    }
    const stale = findFilesNewerThan(distDir, distStaleThresholdMs);
    if (stale.length === 0) return;
    log(chalk.yellow(
      `dist/ was rewritten after this process loaded its modules ` +
      `(${stale.length} file(s), e.g. ${stale[0]}).`
    ));
    log(chalk.yellow('In-memory code is stale (deploy-gap, RYA-1195). Restarting serve (exit 100)...'));
    process.exit(RESTART_EXIT_CODE);
  }, DIST_QUIET_MS);
}

/**
 * Guard against deploy-gap variant #4 (RYA-1058/RYA-1141/RYA-1195): an
 * external builder (post-commit hook) can finish writing dist/ AFTER
 * serve-loop spawned this node, leaving stale code in memory while disk
 * looks fresh. Watch dist/ for post-startup writes; once writes quiesce
 * for DIST_QUIET_MS, exit 100 so serve-loop reloads the fresh dist.
 * Also scans once at startup to cover writes that landed between process
 * spawn and watcher registration.
 */
export function startDistStalenessWatcher(): void {
  const projectRoot = getProjectRoot();
  const distDir = join(projectRoot, 'dist');

  try {
    const watcher = watch(distDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.js')) return;
      if (building) return;
      scheduleStaleDistRestart(distDir);
    });

    watcher.on('error', (err) => {
      log(`dist watcher error: ${err.message}`);
    });

    if (findFilesNewerThan(distDir, distStaleThresholdMs).length > 0) {
      log(chalk.yellow('dist/ already newer than process start — scheduling stale-dist restart check.'));
      scheduleStaleDistRestart(distDir);
    }

    log('Watching dist/ for post-startup rewrites (deploy-gap guard, RYA-1195).');
  } catch (err) {
    log(`Failed to start dist staleness watcher: ${(err as Error).message}`);
  }
}

/**
 * Start watching src/ for changes. Call this from serve.ts.
 * Uses recursive fs.watch (FSEvents on macOS).
 */
export function startAutoDeployWatcher(): void {
  const projectRoot = getProjectRoot();
  const srcDir = join(projectRoot, 'src');

  try {
    const watcher = watch(srcDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.ts')) return;
      log(`Detected change: ${filename}`);
      handleChange(projectRoot, filename);
    });

    watcher.on('error', (err) => {
      log(`Watcher error: ${err.message}`);
    });

    log(`Watching ${srcDir} for changes.`);
    log(`Permission-sensitive files (blocked from auto-deploy): ${PERMISSION_SENSITIVE_PATTERNS.join(', ')}`);
  } catch (err) {
    log(`Failed to start watcher: ${(err as Error).message}`);
  }

  startDistStalenessWatcher();
}

/** Exit code used to signal the serve-loop wrapper to restart. */
export const AUTO_DEPLOY_EXIT_CODE = RESTART_EXIT_CODE;
