/**
 * Auto-deploy watcher: rebuilds TypeScript and restarts serve when src/ changes.
 *
 * Uses Node.js fs.watch (recursive, macOS FSEvents) to detect file changes,
 * debounces rapid edits, runs `tsc`, and signals the serve-loop wrapper
 * to restart by exiting with code 100.
 *
 * SAFETY: Permission-sensitive files (claude-code.ts, router.ts) are blocked
 * from auto-deploy. These require single-agent manual testing + COO approval
 * before fleet rollout.
 */
import { watch, statSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const DEBOUNCE_MS = 3_000;
const RESTART_EXIT_CODE = 100;

/**
 * Permission-sensitive files that must NOT be auto-deployed.
 * Changes to these files affect how agents are spawned and what permissions they have.
 * Auto-deploying permission changes fleet-wide caused production reverts.
 * Protocol: single-agent manual test → COO approval → manual deploy.
 */
const PERMISSION_SENSITIVE_PATTERNS = [
  'adapters/claude-code.ts',  // Agent spawn command, --permission-mode flag
  'core/router.ts',           // Default agent registry, permission-mode in command
];

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let building = false;
let blockedFiles: string[] = [];

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
  } catch { /* ignore */ }
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
    execSync('npx tsc', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 60_000,
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

    // Block auto-deploy when permission-sensitive files changed
    if (blockedFiles.length > 0) {
      log(chalk.red('⛔ AUTO-DEPLOY BLOCKED — permission-sensitive files changed:'));
      for (const f of blockedFiles) {
        log(chalk.red(`   • ${f}`));
      }
      log(chalk.yellow('These files control agent spawn permissions. Fleet-wide auto-deploy'));
      log(chalk.yellow('of permission changes caused production incidents.'));
      log(chalk.yellow(''));
      log(chalk.yellow('Required protocol:'));
      log(chalk.yellow('  1. Test on ONE agent manually (see runbook)'));
      log(chalk.yellow('  2. Get COO approval'));
      log(chalk.yellow('  3. Deploy manually: npx tsc && kill serve → serve-loop restarts'));
      log(chalk.yellow(''));
      log(chalk.yellow('See: ~/.aos/shared-memory/permission-model-protocol.md'));
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
    // On failure: stay running, agent can fix and commit again
  }, DEBOUNCE_MS);
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
}

/** Exit code used to signal the serve-loop wrapper to restart. */
export const AUTO_DEPLOY_EXIT_CODE = RESTART_EXIT_CODE;
