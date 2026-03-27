/**
 * Swarm Monitor — Integrates swarm lifecycle into the AgentOS serve loop.
 *
 * Responsibilities:
 * 1. Detect active swarms by scanning known workspace paths
 * 2. Track experiment progress and notify on new experiments (Telegram/Discord)
 * 3. Detect stalls (no new experiments for N minutes) and notify
 * 4. Auto-stop swarms when all agents are done (tmux sessions dead)
 * 5. Post experiment progress comments on the parent Linear issue (if configured)
 */

import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SwarmStateManager, type SwarmConfig, type Experiment } from '../core/swarm-state.js';
import { getSwarmStatus, stopSwarm, generateSwarmReport, type SwarmStatus } from '../core/swarm-coordinator.js';
import { sessionExists, listSessionsByPrefix } from '../core/tmux.js';
import { postToGroupChat } from './helpers.js';

// ─── Configuration ────────────────────────────────────────────────────────

const STALL_THRESHOLD_MS = 15 * 60_000;    // 15 min without new experiment = stall
const PROGRESS_COMMENT_INTERVAL_MS = 10 * 60_000; // Post Linear comment every 10 min at most
const ALL_DEAD_GRACE_MS = 60_000;           // Wait 60s after all agents dead before auto-stop

// ─── Tracked State ────────────────────────────────────────────────────────

interface TrackedSwarm {
  workspacePath: string;
  swarmId: string;
  lastExperimentCount: number;
  lastExperimentTime: number;
  lastProgressCommentTime: number;
  lastNotifiedExperimentCount: number;
  stallNotified: boolean;
  allDeadSince: number | null;
  completionNotified: boolean;
  parentIssueId: string | null;
  parentIssueKey: string | null;
}

// Workspace → tracked swarm state
const trackedSwarms = new Map<string, TrackedSwarm>();

// File that persists registered swarm workspace paths
function getRegistryPath(): string {
  const homeDir = process.env.HOME || '/tmp';
  return join(homeDir, '.aos', 'swarm-registry.json');
}

// ─── Registry: track which workspaces have swarms ─────────────────────────

export function registerSwarm(
  workspacePath: string,
  parentIssueKey?: string,
  parentIssueId?: string,
): void {
  const registry = loadRegistry();
  const existing = registry.find(r => r.workspacePath === workspacePath);
  if (existing) {
    if (parentIssueKey) existing.parentIssueKey = parentIssueKey;
    if (parentIssueId) existing.parentIssueId = parentIssueId;
  } else {
    registry.push({ workspacePath, parentIssueKey, parentIssueId });
  }
  saveRegistry(registry);
}

export function unregisterSwarm(workspacePath: string): void {
  const registry = loadRegistry().filter(r => r.workspacePath !== workspacePath);
  saveRegistry(registry);
  trackedSwarms.delete(workspacePath);
}

interface SwarmRegistryEntry {
  workspacePath: string;
  parentIssueKey?: string;
  parentIssueId?: string;
}

function loadRegistry(): SwarmRegistryEntry[] {
  const path = getRegistryPath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch { /* corrupted — reset */ }
  return [];
}

function saveRegistry(entries: SwarmRegistryEntry[]): void {
  const path = getRegistryPath();
  try {
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(entries, null, 2));
  } catch { /* best effort */ }
}

// ─── Main Monitor Function ───────────────────────────────────────────────

/**
 * Called every poll cycle from the serve monitor loop.
 * Scans registered swarms, detects state changes, sends notifications.
 */
export async function monitorSwarms(): Promise<void> {
  const registry = loadRegistry();
  if (registry.length === 0) return;

  for (const entry of registry) {
    try {
      await monitorSingleSwarm(entry);
    } catch (err) {
      // Don't let one swarm failure break the loop
      console.log(chalk.dim(`[swarm-monitor] Error monitoring ${entry.workspacePath}: ${(err as Error).message}`));
    }
  }

  // Cleanup: remove entries for workspaces where .swarm/ no longer exists
  const cleaned = registry.filter(e => existsSync(join(e.workspacePath, '.swarm', 'config.json')));
  if (cleaned.length !== registry.length) {
    saveRegistry(cleaned);
    // Also remove tracked state for cleaned entries
    for (const entry of registry) {
      if (!cleaned.find(c => c.workspacePath === entry.workspacePath)) {
        trackedSwarms.delete(entry.workspacePath);
      }
    }
  }
}

async function monitorSingleSwarm(entry: SwarmRegistryEntry): Promise<void> {
  const { workspacePath } = entry;
  const manager = new SwarmStateManager(workspacePath);
  if (!manager.exists()) return;

  const config = manager.getConfig();

  // Skip stopped/completed/failed swarms
  if (config.status !== 'running') {
    // If we were tracking it and it just stopped, clean up
    if (trackedSwarms.has(workspacePath)) {
      trackedSwarms.delete(workspacePath);
    }
    return;
  }

  const status = getSwarmStatus(workspacePath);
  const now = Date.now();

  // Initialize tracking if first time seeing this swarm
  let tracked = trackedSwarms.get(workspacePath);
  if (!tracked) {
    tracked = {
      workspacePath,
      swarmId: config.id,
      lastExperimentCount: status.totalExperiments,
      lastExperimentTime: now,
      lastProgressCommentTime: 0,
      lastNotifiedExperimentCount: status.totalExperiments,
      stallNotified: false,
      allDeadSince: null,
      completionNotified: false,
      parentIssueId: entry.parentIssueId || null,
      parentIssueKey: entry.parentIssueKey || null,
    };
    trackedSwarms.set(workspacePath, tracked);
    return; // Don't trigger notifications on first scan
  }

  // ─── 1. Detect new experiments ────────────────────────────────────

  if (status.totalExperiments > tracked.lastExperimentCount) {
    const newCount = status.totalExperiments - tracked.lastExperimentCount;
    tracked.lastExperimentCount = status.totalExperiments;
    tracked.lastExperimentTime = now;
    tracked.stallNotified = false; // Reset stall flag on new activity

    // Get the latest experiments for notification
    const experiments = manager.getExperiments();
    const newExperiments = experiments.slice(-newCount);

    await notifyNewExperiments(tracked, config, status, newExperiments);
  }

  // ─── 2. Detect stalls ────────────────────────────────────────────

  const timeSinceLastExperiment = now - tracked.lastExperimentTime;
  if (timeSinceLastExperiment >= STALL_THRESHOLD_MS && !tracked.stallNotified) {
    tracked.stallNotified = true;
    await notifyStall(tracked, config, status, timeSinceLastExperiment);
  }

  // ─── 3. Auto-stop on convergence or all agents dead ──────────────

  let shouldAutoStop = false;
  let autoStopReason = '';

  // Check convergence first: all agents stopped improving
  // Note: swarmConverged is a future extension of SwarmStatus
  if ((status as unknown as Record<string, unknown>).swarmConverged && !tracked.completionNotified) {
    shouldAutoStop = true;
    autoStopReason = 'all agents converged';
  }

  // Check if all tmux sessions are dead
  const aliveSessions = listSessionsByPrefix(`aos-swarm-${config.id}`);
  const allDead = aliveSessions.length === 0;

  if (allDead && !shouldAutoStop) {
    if (!tracked.allDeadSince) {
      tracked.allDeadSince = now;
    } else if (now - tracked.allDeadSince >= ALL_DEAD_GRACE_MS && !tracked.completionNotified) {
      shouldAutoStop = true;
      autoStopReason = 'all agents finished';
    }
  } else if (!allDead) {
    tracked.allDeadSince = null; // Reset if any agent is alive
  }

  if (shouldAutoStop) {
    tracked.completionNotified = true;
    stopSwarm(workspacePath);
    await notifyCompletion(tracked, config, workspacePath, autoStopReason);
    trackedSwarms.delete(workspacePath);
  }

  // ─── 4. Periodic progress comments on parent issue ────────────────

  if (tracked.parentIssueId && now - tracked.lastProgressCommentTime >= PROGRESS_COMMENT_INTERVAL_MS) {
    if (status.totalExperiments > tracked.lastNotifiedExperimentCount) {
      await postProgressComment(tracked, config, status, manager);
      tracked.lastProgressCommentTime = now;
      tracked.lastNotifiedExperimentCount = status.totalExperiments;
    }
  }
}

// ─── Notification Functions ─────────────────────────────────────────────

async function notifyNewExperiments(
  tracked: TrackedSwarm,
  config: SwarmConfig,
  status: SwarmStatus,
  newExperiments: Experiment[],
): Promise<void> {
  const improvements = newExperiments.filter(e => e.outcome === 'improvement');
  const regressions = newExperiments.filter(e => e.outcome === 'regression');
  const errors = newExperiments.filter(e => e.outcome === 'error');

  // Only notify on interesting events: improvements, or batch summaries
  if (improvements.length > 0) {
    const best = improvements.reduce((a, b) =>
      (a.metricValue ?? 0) > (b.metricValue ?? 0) ? a : b
    );
    const deltaStr = best.delta !== null
      ? ` (Δ${best.delta >= 0 ? '+' : ''}${best.delta.toFixed(4)})`
      : '';

    await postToGroupChat(
      'system',
      `🧬 **Swarm "${config.name}"** — ${improvements.length} improvement${improvements.length > 1 ? 's' : ''}! ` +
      `Best: ${config.metric}=${best.metricValue}${deltaStr}\n` +
      `Total: ${status.totalExperiments} experiments, ${status.frontierSize} ideas remaining`
    );
  }

  // Log all new experiments to console regardless
  const ts = new Date().toLocaleTimeString();
  for (const exp of newExperiments) {
    const icon = exp.outcome === 'improvement' ? '▲' :
                 exp.outcome === 'regression' ? '▼' :
                 exp.outcome === 'error' ? '✗' : '─';
    console.log(chalk.dim(`[${ts}] [swarm] ${icon} ${exp.id}: ${exp.hypothesis.substring(0, 60)} (${config.metric}=${exp.metricValue ?? 'N/A'})`));
  }
}

async function notifyStall(
  tracked: TrackedSwarm,
  config: SwarmConfig,
  status: SwarmStatus,
  stallDurationMs: number,
): Promise<void> {
  const stallMinutes = Math.round(stallDurationMs / 60_000);
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.yellow(`[${ts}] [swarm] Stall detected: "${config.name}" — no experiments for ${stallMinutes}min`));

  await postToGroupChat(
    'system',
    `⚠️ **Swarm "${config.name}" stalled** — no new experiments for ${stallMinutes} minutes.\n` +
    `Status: ${status.totalExperiments} experiments completed, ` +
    `best ${config.metric}=${status.bestMetric ?? 'N/A'}`
  );

  // Also post on parent issue if available
  if (tracked.parentIssueId) {
    try {
      const { addComment } = await import('../core/linear.js');
      await addComment(
        tracked.parentIssueId,
        `⚠️ **Swarm stalled** — no new experiments for ${stallMinutes} minutes.\n\n` +
        `- Total experiments: ${status.totalExperiments}\n` +
        `- Best ${config.metric}: ${status.bestMetric ?? 'N/A'}\n` +
        `- Baseline: ${status.baseline ?? 'N/A'}\n` +
        `- Agents alive: ${listSessionsByPrefix(`aos-swarm-${config.id}`).length}/${config.agentCount}`
      );
    } catch { /* best effort */ }
  }
}

async function notifyCompletion(
  tracked: TrackedSwarm,
  config: SwarmConfig,
  workspacePath: string,
  reason: string = 'all agents finished',
): Promise<void> {
  const report = generateSwarmReport(workspacePath);
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.green(`[${ts}] [swarm] Completed: "${config.name}" — ${reason}`));

  // Truncate report for chat notification
  const shortReport = report.split('\n').slice(0, 15).join('\n');
  await postToGroupChat(
    'system',
    `✅ **Swarm "${config.name}" completed** — ${reason}.\n\n${shortReport}`
  );

  // Post full report on parent issue
  if (tracked.parentIssueId) {
    try {
      const { addComment } = await import('../core/linear.js');
      await addComment(
        tracked.parentIssueId,
        `## Swarm Completed\n\n${reason}.\n\n${report}`
      );
    } catch { /* best effort */ }
  }
}

async function postProgressComment(
  tracked: TrackedSwarm,
  config: SwarmConfig,
  status: SwarmStatus,
  manager: SwarmStateManager,
): Promise<void> {
  if (!tracked.parentIssueId) return;

  const experiments = manager.getExperiments();
  const recentExps = experiments.slice(-5);
  const improvements = experiments.filter(e => e.outcome === 'improvement').length;
  const deltaStr = status.baseline !== null && status.bestMetric !== null
    ? `Δ${config.higherIsBetter ? '' : ''}${(status.bestMetric - status.baseline).toFixed(4)}`
    : 'N/A';

  const perAgent = config.directions.map((dir, i) => {
    const count = status.agentExperimentCounts[i] || 0;
    const alive = sessionExists(`aos-swarm-${config.id}-agent-${i}`);
    return `- Agent ${i} (${dir.focus}): ${count}/${config.maxExperimentsPerAgent} experiments ${alive ? '🟢' : '⭕'}`;
  }).join('\n');

  const recentLines = recentExps.map(e => {
    const icon = e.outcome === 'improvement' ? '▲' :
                 e.outcome === 'regression' ? '▼' :
                 e.outcome === 'error' ? '✗' : '─';
    return `- ${icon} ${e.id}: ${e.hypothesis.substring(0, 80)} (${config.metric}=${e.metricValue ?? 'N/A'})`;
  }).join('\n');

  try {
    const { addComment } = await import('../core/linear.js');
    await addComment(
      tracked.parentIssueId,
      `### Swarm Progress Update\n\n` +
      `**${config.name}** — ${status.totalExperiments} experiments (${improvements} improvements)\n` +
      `Baseline: ${status.baseline ?? 'N/A'} → Best: ${status.bestMetric ?? 'N/A'} (${deltaStr})\n\n` +
      `**Per-Agent:**\n${perAgent}\n\n` +
      `**Recent Experiments:**\n${recentLines}`
    );
  } catch { /* best effort */ }
}

// ─── Dashboard Data ─────────────────────────────────────────────────────

export interface SwarmDashboardData {
  name: string;
  status: string;
  metric: string;
  higherIsBetter: boolean;
  baseline: number | null;
  bestMetric: number | null;
  totalExperiments: number;
  frontierSize: number;
  swarmConverged: boolean;
  agents: {
    index: number;
    focus: string;
    experiments: number;
    maxExperiments: number;
    alive: boolean;
    converged: boolean;
    convergenceReason: string;
  }[];
  recentExperiments: {
    id: string;
    outcome: string;
    metricValue: number | null;
    delta: number | null;
    hypothesis: string;
  }[];
}

/**
 * Get swarm data for the dashboard /status endpoint.
 * Returns an array of active swarm statuses.
 */
export function getSwarmDashboardData(): SwarmDashboardData[] {
  const registry = loadRegistry();
  const results: SwarmDashboardData[] = [];

  for (const entry of registry) {
    try {
      const manager = new SwarmStateManager(entry.workspacePath);
      if (!manager.exists()) continue;

      const config = manager.getConfig();
      if (config.status !== 'running') continue;

      const status = getSwarmStatus(entry.workspacePath);
      const experiments = manager.getExperiments();
      const recentExps = experiments.slice(-5);

      results.push({
        name: config.name,
        status: config.status,
        metric: config.metric,
        higherIsBetter: config.higherIsBetter,
        baseline: status.baseline,
        bestMetric: status.bestMetric,
        totalExperiments: status.totalExperiments,
        frontierSize: status.frontierSize,
        swarmConverged: status.swarmConverged,
        agents: config.directions.map((dir, i) => ({
          index: i,
          focus: dir.focus,
          experiments: status.agentExperimentCounts[i] || 0,
          maxExperiments: config.maxExperimentsPerAgent,
          alive: sessionExists(`aos-swarm-${config.id}-agent-${i}`),
          converged: status.agentConvergence[i]?.converged ?? false,
          convergenceReason: status.agentConvergence[i]?.reason ?? 'unknown',
        })),
        recentExperiments: recentExps.map(e => ({
          id: e.id,
          outcome: e.outcome,
          metricValue: e.metricValue,
          delta: e.delta,
          hypothesis: e.hypothesis,
        })),
      });
    } catch { /* skip broken entries */ }
  }

  return results;
}

// ─── Test Helpers ───────────────────────────────────────────────────────

export function _resetTrackedSwarms(): void {
  trackedSwarms.clear();
}

export function _getTrackedSwarm(workspacePath: string): TrackedSwarm | undefined {
  return trackedSwarms.get(workspacePath);
}
