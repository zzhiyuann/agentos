import { AosConfig } from '../types.js';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';

// NOTE: do NOT make this honor AOS_STATE_DIR — that env var already means
// "per-issue state dir" and is exported into every agent session by
// adapters/claude-code.ts. Test isolation of sqlite writes uses AOS_DB_PATH
// instead (see getConfig().dbPath and vitest.setup.ts — RYA-1198).
export const STATE_DIR = join(homedir(), '.aos');

/** Per-issue state directory — isolates HANDOFF.md, BLOCKED.md, PROGRESS.md from shared workspaces */
const WORK_DIR = join(STATE_DIR, 'work');

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it in your .env file or shell environment. See .env.example for reference.`
    );
  }
  return val;
}

export function getConfig(): AosConfig {
  // Read tunnel URL from file (updated by serve command)
  let tunnelUrl = '';
  const tunnelFile = join(STATE_DIR, 'tunnel-url');
  if (existsSync(tunnelFile)) {
    tunnelUrl = readFileSync(tunnelFile, 'utf-8').trim();
  }

  return {
    linearTeamId: requireEnv('AOS_LINEAR_TEAM_ID'),
    linearTeamKey: requireEnv('AOS_LINEAR_TEAM_KEY'),
    imacHost: requireEnv('AOS_HOST'),
    imacUser: requireEnv('AOS_USER'),
    workspaceBase: process.env.AOS_WORKSPACE_BASE || '~/agent-workspaces',
    // AOS_DB_PATH lets tests isolate sqlite writes without redirecting the
    // whole state dir (vitest.setup.ts sets it to a tmpdir — RYA-1198).
    dbPath: process.env.AOS_DB_PATH || join(STATE_DIR, 'state.db'),
    pollIntervalMs: Number(process.env.AOS_POLL_INTERVAL_MS) || 30_000,
    stateDir: STATE_DIR,
    tunnelUrl,
  };
}

/** Resolve workspace path from issue's project via workspace-map.json */
export function resolveWorkspace(issueKey: string, projectName?: string): string {
  const config = getConfig();
  const mapPath = join(STATE_DIR, 'workspace-map.json');

  if (existsSync(mapPath)) {
    try {
      const map = JSON.parse(readFileSync(mapPath, 'utf-8')) as Record<string, string>;

      if (projectName) {
        const mapped = map[`project:${projectName}`];
        if (mapped) return mapped.replace(/^~/, homedir());
      }

      // Fall back to default from map
      if (map.default) {
        return `${map.default.replace(/^~/, homedir())}/${issueKey}`;
      }
    } catch (err: unknown) {
      console.debug(`[config] workspace-map.json parse failed:`, (err as Error).message);
    }
  }

  return `${config.workspaceBase}/${issueKey}`;
}

/**
 * Get the per-issue state directory for state files (HANDOFF.md, BLOCKED.md, PROGRESS.md).
 * Separates issue state from code workspace to prevent cross-issue contamination
 * when workspace-map.json maps multiple issues to the same directory (RYA-246).
 */
export function getIssueStateDir(issueKey: string): string {
  const dir = join(WORK_DIR, issueKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read a state file (HANDOFF.md, BLOCKED.md, PROGRESS.md) for an issue.
 * Checks the per-issue state dir first, falls back to workspace for backward compat
 * with in-flight sessions that still write to the workspace.
 */
export function resolveStatePath(issueKey: string, workspacePath: string, filename: string): string {
  const stateDir = getIssueStateDir(issueKey);
  const statePath = join(stateDir, filename);
  if (existsSync(statePath)) return statePath;
  // Fallback to workspace path for in-flight sessions
  return join(workspacePath, filename);
}
