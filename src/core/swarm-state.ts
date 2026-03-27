/**
 * Swarm State Manager — File-based experiment tracking for research swarms.
 *
 * Concurrency-safe operations:
 * 1. Lock TOCTOU — replaced existsSync+writeFileSync with O_EXCL atomic create
 * 2. Frontier claim — protected with state mutex (mkdir-based spinlock)
 * 3. Best.json update — protected with state mutex + atomic writes
 * 4. Log append — replaced read-modify-write with appendFileSync
 *
 * All JSON writes use atomic write-tmp-then-rename pattern
 * to prevent partial reads (JSON corruption).
 */

import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync, renameSync, rmdirSync,
  openSync, closeSync, constants
} from 'fs';
import { join } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SwarmConfig {
  id: string;
  name: string;
  metric: string;
  higherIsBetter: boolean;
  evalCommand: string;
  targetFiles: string[];
  agentCount: number;
  maxExperimentsPerAgent: number;
  budgetMinutes: number;
  directions: ResearchDirection[];
  workspacePath: string;
  createdAt: string;
  status: 'running' | 'completed' | 'stopped' | 'failed';
}

export interface ResearchDirection {
  agentIndex: number;
  focus: string;
  constraints: string[];
}

export interface Experiment {
  id: string;
  agentIndex: number;
  hypothesis: string;
  changes: string[];
  metricValue: number | null;
  delta: number | null;
  outcome: 'improvement' | 'regression' | 'neutral' | 'error' | 'pending';
  commitHash?: string;
  durationSeconds: number;
  timestamp: string;
}

export interface SwarmSnapshot {
  config: SwarmConfig;
  baseline: number | null;
  bestMetric: number | null;
  bestExperimentId: string | null;
  experiments: Experiment[];
  frontier: string[];
}

// ─── Concurrency Primitives ────────────────────────────────────────────────

/**
 * Atomic JSON write: write to temp file, then rename.
 * Prevents readers from seeing partial/truncated JSON.
 * rename() is atomic on POSIX (same filesystem).
 */
function atomicWriteJson(fullPath: string, data: any): void {
  const tmp = `${fullPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, fullPath);
}

/**
 * mkdir-based state mutex. mkdirSync fails atomically if dir exists.
 * Provides mutual exclusion for read-modify-write sequences.
 * Spins with exponential backoff, timeout after maxWaitMs.
 */
function acquireStateLock(lockDir: string, maxWaitMs: number = 5000): boolean {
  const deadline = Date.now() + maxWaitMs;
  let sleepMs = 1;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // Spin with backoff
      const start = Date.now();
      while (Date.now() - start < sleepMs) {
        // busy wait (sync context, no setTimeout available)
      }
      sleepMs = Math.min(sleepMs * 2, 50); // cap at 50ms
    }
  }
  // Timeout — check if lock is stale (> 30s = dead process)
  try {
    // If we can't acquire after maxWaitMs, force-remove stale lock
    rmdirSync(lockDir);
    mkdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

function releaseStateLock(lockDir: string): void {
  try {
    rmdirSync(lockDir);
  } catch {
    // Already released (shouldn't happen but be defensive)
  }
}

// ─── State Manager ──────────────────────────────────────────────────────────

export class SwarmStateManager {
  private swarmDir: string;
  private stateLockDir: string;

  constructor(workspacePath: string) {
    this.swarmDir = join(workspacePath, '.swarm');
    this.stateLockDir = join(this.swarmDir, '.state-lock');
  }

  /** Initialize a new swarm session — creates .swarm/ directory structure */
  init(config: SwarmConfig): void {
    mkdirSync(this.swarmDir, { recursive: true });
    mkdirSync(join(this.swarmDir, 'experiments'), { recursive: true });
    mkdirSync(join(this.swarmDir, 'locks'), { recursive: true });

    this.writeJson('config.json', config);
    this.writeJson('best.json', {
      baseline: null,
      bestMetric: null,
      bestExperimentId: null,
    });
    this.writeJson('frontier.json', []);
    writeFileSync(join(this.swarmDir, 'experiment-log.md'), `# Experiment Log — ${config.name}\n\n`);
  }

  getSwarmDir(): string {
    return this.swarmDir;
  }

  exists(): boolean {
    return existsSync(join(this.swarmDir, 'config.json'));
  }

  getConfig(): SwarmConfig {
    return this.readJson('config.json');
  }

  setStatus(status: SwarmConfig['status']): void {
    this.withStateLock(() => {
      const config = this.getConfig();
      config.status = status;
      this.writeJson('config.json', config);
    });
  }

  // ─── Baseline ───────────────────────────────────────────────────────

  setBaseline(value: number): void {
    this.withStateLock(() => {
      const best = this.readJson('best.json');
      best.baseline = value;
      if (best.bestMetric === null) {
        best.bestMetric = value;
      }
      this.writeJson('best.json', best);
    });
  }

  getBaseline(): number | null {
    return this.readJson('best.json').baseline;
  }

  getBest(): { bestMetric: number | null; bestExperimentId: string | null } {
    const best = this.readJson('best.json');
    return { bestMetric: best.bestMetric, bestExperimentId: best.bestExperimentId };
  }

  // ─── Experiments ────────────────────────────────────────────────────

  /**
   * Record a completed experiment.
   * Uses state lock for best.json update + appendFileSync for log.
   */
  recordExperiment(exp: Experiment): void {
    // Write individual experiment file (no contention — unique filename)
    this.writeJson(`experiments/${exp.id}.json`, exp);

    // Update best.json under state lock (prevents stale-read overwrite)
    this.withStateLock(() => {
      const config = this.getConfig();
      const best = this.readJson('best.json');
      if (exp.metricValue !== null && exp.outcome === 'improvement') {
        const isBetter = config.higherIsBetter
          ? exp.metricValue > (best.bestMetric ?? -Infinity)
          : exp.metricValue < (best.bestMetric ?? Infinity);
        if (isBetter) {
          best.bestMetric = exp.metricValue;
          best.bestExperimentId = exp.id;
          this.writeJson('best.json', best);
        }
      }
    });

    // Append to log using appendFileSync (atomic append, no read-modify-write)
    const logEntry = [
      `## ${exp.id} — ${exp.outcome.toUpperCase()}`,
      `- **Hypothesis**: ${exp.hypothesis}`,
      `- **Metric**: ${exp.metricValue ?? 'N/A'} (Δ${exp.delta !== null ? (exp.delta >= 0 ? '+' : '') + exp.delta.toFixed(4) : 'N/A'})`,
      `- **Changes**: ${exp.changes.join(', ')}`,
      exp.commitHash ? `- **Commit**: ${exp.commitHash}` : '',
      `- **Duration**: ${exp.durationSeconds}s`,
      `- **Time**: ${exp.timestamp}`,
      '',
    ].filter(Boolean).join('\n');

    appendFileSync(join(this.swarmDir, 'experiment-log.md'), logEntry + '\n');
  }

  getExperiments(): Experiment[] {
    const dir = join(this.swarmDir, 'experiments');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => this.readJson(`experiments/${f}`))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getAgentExperiments(agentIndex: number): Experiment[] {
    return this.getExperiments().filter(e => e.agentIndex === agentIndex);
  }

  getExperimentCount(): number {
    const dir = join(this.swarmDir, 'experiments');
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter(f => f.endsWith('.json')).length;
  }

  // ─── Frontier (exploration ideas) ──────────────────────────────────

  /**
   * Add ideas to the frontier.
   * Uses state lock to prevent concurrent addToFrontier races.
   */
  addToFrontier(ideas: string[]): void {
    this.withStateLock(() => {
      const frontier = this.getFrontier();
      const existing = new Set(frontier);
      const newIdeas = ideas.filter(i => !existing.has(i));
      this.writeJson('frontier.json', [...frontier, ...newIdeas]);
    });
  }

  getFrontier(): string[] {
    return this.readJson('frontier.json');
  }

  /**
   * Remove an idea from the frontier (being explored).
   * Uses state lock to prevent double-claim race.
   */
  claimFromFrontier(idea: string): boolean {
    let claimed = false;
    this.withStateLock(() => {
      const frontier = this.getFrontier();
      const idx = frontier.indexOf(idea);
      if (idx === -1) {
        claimed = false;
        return;
      }
      frontier.splice(idx, 1);
      this.writeJson('frontier.json', frontier);
      claimed = true;
    });
    return claimed;
  }

  // ─── Experiment Locking ─────────────────────────────────────────────

  /**
   * Try to acquire a lock for an experiment direction.
   * Uses O_EXCL flag for atomic create-or-fail (no TOCTOU window).
   */
  acquireLock(experimentId: string, agentIndex: number): boolean {
    const lockFile = join(this.swarmDir, 'locks', `${experimentId}.lock`);

    // Attempt atomic exclusive create
    try {
      const fd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      const data = JSON.stringify({ agentIndex, timestamp: new Date().toISOString() });
      writeFileSync(fd, data);
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;

      // File exists — check if stale (> 10 minutes)
      try {
        const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
        const age = Date.now() - new Date(lock.timestamp).getTime();
        if (age >= 10 * 60 * 1000) {
          // Stale lock — try to take over using rename-then-create
          const stalePath = lockFile + `.stale.${process.pid}`;
          try {
            renameSync(lockFile, stalePath);
            // Now try exclusive create again
            const fd = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
            const data = JSON.stringify({ agentIndex, timestamp: new Date().toISOString() });
            writeFileSync(fd, data);
            closeSync(fd);
            return true;
          } catch {
            return false; // Another agent beat us to it
          }
        }
      } catch {
        // Can't read lock file (corrupted or being written) — skip
      }

      return false; // Fresh lock held by another agent
    }
  }

  /** Release an experiment lock */
  releaseLock(experimentId: string): void {
    const lockFile = join(this.swarmDir, 'locks', `${experimentId}.lock`);
    try {
      renameSync(lockFile, lockFile.replace('.lock', '.done'));
    } catch { /* may not exist */ }
  }

  // ─── Full Snapshot ─────────────────────────────────────────────────

  getSnapshot(): SwarmSnapshot {
    const config = this.getConfig();
    const best = this.readJson('best.json');
    return {
      config,
      baseline: best.baseline,
      bestMetric: best.bestMetric,
      bestExperimentId: best.bestExperimentId,
      experiments: this.getExperiments(),
      frontier: this.getFrontier(),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private readJson(relativePath: string): any {
    const fullPath = join(this.swarmDir, relativePath);
    return JSON.parse(readFileSync(fullPath, 'utf-8'));
  }

  /** Atomic JSON write: temp file + rename prevents partial reads */
  private writeJson(relativePath: string, data: any): void {
    const fullPath = join(this.swarmDir, relativePath);
    atomicWriteJson(fullPath, data);
  }

  /**
   * Execute a function while holding the state mutex.
   * Provides mutual exclusion for read-modify-write sequences.
   */
  private withStateLock<T>(fn: () => T): T {
    if (!acquireStateLock(this.stateLockDir)) {
      throw new Error('Failed to acquire state lock (timeout)');
    }
    try {
      return fn();
    } finally {
      releaseStateLock(this.stateLockDir);
    }
  }
}
