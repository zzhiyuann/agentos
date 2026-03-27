import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SwarmStateManager, type SwarmConfig, type Experiment } from './swarm-state.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `swarm-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    id: `swarm-${Date.now()}`,
    name: 'Test Swarm',
    metric: 'accuracy',
    higherIsBetter: true,
    evalCommand: 'echo 0.75',
    targetFiles: ['model.py'],
    agentCount: 2,
    maxExperimentsPerAgent: 5,
    budgetMinutes: 30,
    directions: [
      { agentIndex: 0, focus: 'architecture', constraints: ['keep params under 1M'] },
      { agentIndex: 1, focus: 'hyperparams', constraints: [] },
    ],
    workspacePath: '/tmp/test',
    createdAt: new Date().toISOString(),
    status: 'running',
    ...overrides,
  };
}

function makeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: `agent-0-exp-${Date.now()}`,
    agentIndex: 0,
    hypothesis: 'Test hypothesis',
    changes: ['model.py:10 — added layer'],
    metricValue: 0.80,
    delta: 0.05,
    outcome: 'improvement',
    commitHash: 'abc123',
    durationSeconds: 120,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('SwarmStateManager', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = new SwarmStateManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Init & Existence ──────────────────────────────────────────────

  describe('init', () => {
    it('creates .swarm directory structure', () => {
      const config = makeConfig({ workspacePath: tempDir });
      manager.init(config);

      expect(existsSync(join(tempDir, '.swarm'))).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'experiments'))).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'locks'))).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'config.json'))).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'best.json'))).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'frontier.json'))).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'experiment-log.md'))).toBe(true);
    });

    it('writes config.json with provided config', () => {
      const config = makeConfig({ workspacePath: tempDir, name: 'My Swarm' });
      manager.init(config);

      const stored = JSON.parse(readFileSync(join(tempDir, '.swarm', 'config.json'), 'utf-8'));
      expect(stored.name).toBe('My Swarm');
      expect(stored.metric).toBe('accuracy');
      expect(stored.status).toBe('running');
    });

    it('initializes best.json with nulls', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      const best = JSON.parse(readFileSync(join(tempDir, '.swarm', 'best.json'), 'utf-8'));
      expect(best.baseline).toBeNull();
      expect(best.bestMetric).toBeNull();
      expect(best.bestExperimentId).toBeNull();
    });

    it('initializes frontier.json as empty array', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      const frontier = JSON.parse(readFileSync(join(tempDir, '.swarm', 'frontier.json'), 'utf-8'));
      expect(frontier).toEqual([]);
    });

    it('initializes experiment-log.md with header', () => {
      manager.init(makeConfig({ workspacePath: tempDir, name: 'Log Test' }));

      const log = readFileSync(join(tempDir, '.swarm', 'experiment-log.md'), 'utf-8');
      expect(log).toContain('# Experiment Log — Log Test');
    });
  });

  describe('exists', () => {
    it('returns false before init', () => {
      expect(manager.exists()).toBe(false);
    });

    it('returns true after init', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      expect(manager.exists()).toBe(true);
    });
  });

  describe('getSwarmDir', () => {
    it('returns .swarm path under workspace', () => {
      expect(manager.getSwarmDir()).toBe(join(tempDir, '.swarm'));
    });
  });

  // ─── Config & Status ───────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns the stored config', () => {
      const config = makeConfig({ workspacePath: tempDir, name: 'Config Read' });
      manager.init(config);

      const retrieved = manager.getConfig();
      expect(retrieved.name).toBe('Config Read');
      expect(retrieved.agentCount).toBe(2);
      expect(retrieved.directions).toHaveLength(2);
    });
  });

  describe('setStatus', () => {
    it('updates the status in config.json', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      expect(manager.getConfig().status).toBe('running');

      manager.setStatus('stopped');
      expect(manager.getConfig().status).toBe('stopped');
    });

    it('transitions through all valid statuses', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      for (const status of ['completed', 'failed', 'stopped', 'running'] as const) {
        manager.setStatus(status);
        expect(manager.getConfig().status).toBe(status);
      }
    });
  });

  // ─── Baseline ──────────────────────────────────────────────────────

  describe('setBaseline / getBaseline', () => {
    it('stores and retrieves baseline value', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      expect(manager.getBaseline()).toBeNull();

      manager.setBaseline(0.75);
      expect(manager.getBaseline()).toBe(0.75);
    });

    it('sets bestMetric to baseline when bestMetric is null', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      manager.setBaseline(0.65);
      const best = manager.getBest();
      expect(best.bestMetric).toBe(0.65);
    });

    it('does not overwrite bestMetric when already set', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      // Manually set bestMetric first
      const bestPath = join(tempDir, '.swarm', 'best.json');
      writeFileSync(bestPath, JSON.stringify({
        baseline: null,
        bestMetric: 0.90,
        bestExperimentId: 'exp-1',
      }));

      manager.setBaseline(0.50);
      const best = manager.getBest();
      expect(best.bestMetric).toBe(0.90); // unchanged
      expect(manager.getBaseline()).toBe(0.50);
    });
  });

  describe('getBest', () => {
    it('returns nulls before any experiments', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      const best = manager.getBest();
      expect(best.bestMetric).toBeNull();
      expect(best.bestExperimentId).toBeNull();
    });
  });

  // ─── Experiments ───────────────────────────────────────────────────

  describe('recordExperiment', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      manager.setBaseline(0.75);
    });

    it('writes experiment JSON file', () => {
      const exp = makeExperiment({ id: 'agent-0-exp-1' });
      manager.recordExperiment(exp);

      const stored = JSON.parse(
        readFileSync(join(tempDir, '.swarm', 'experiments', 'agent-0-exp-1.json'), 'utf-8')
      );
      expect(stored.id).toBe('agent-0-exp-1');
      expect(stored.hypothesis).toBe('Test hypothesis');
    });

    it('updates bestMetric on improvement (higher is better)', () => {
      const exp = makeExperiment({
        id: 'exp-better',
        metricValue: 0.85,
        outcome: 'improvement',
      });
      manager.recordExperiment(exp);

      const best = manager.getBest();
      expect(best.bestMetric).toBe(0.85);
      expect(best.bestExperimentId).toBe('exp-better');
    });

    it('does not update bestMetric on regression', () => {
      const exp = makeExperiment({
        id: 'exp-worse',
        metricValue: 0.50,
        outcome: 'regression',
      });
      manager.recordExperiment(exp);

      const best = manager.getBest();
      expect(best.bestMetric).toBe(0.75); // still baseline
    });

    it('does not update bestMetric when outcome is not improvement', () => {
      const exp = makeExperiment({
        id: 'exp-neutral',
        metricValue: 0.99, // higher value but neutral outcome
        outcome: 'neutral',
      });
      manager.recordExperiment(exp);

      expect(manager.getBest().bestMetric).toBe(0.75);
    });

    it('does not update bestMetric when metricValue is null', () => {
      const exp = makeExperiment({
        id: 'exp-null',
        metricValue: null,
        outcome: 'improvement',
      });
      manager.recordExperiment(exp);

      expect(manager.getBest().bestMetric).toBe(0.75);
    });

    it('only updates best when new value is actually better (higher is better)', () => {
      // First improvement to 0.85
      manager.recordExperiment(makeExperiment({
        id: 'exp-1',
        metricValue: 0.85,
        outcome: 'improvement',
      }));
      expect(manager.getBest().bestMetric).toBe(0.85);

      // Second "improvement" at 0.80 — lower, should not replace
      manager.recordExperiment(makeExperiment({
        id: 'exp-2',
        metricValue: 0.80,
        outcome: 'improvement',
      }));
      expect(manager.getBest().bestMetric).toBe(0.85);
      expect(manager.getBest().bestExperimentId).toBe('exp-1');
    });

    it('handles lower-is-better correctly', () => {
      // Re-init with higherIsBetter=false
      rmSync(join(tempDir, '.swarm'), { recursive: true, force: true });
      manager.init(makeConfig({ workspacePath: tempDir, higherIsBetter: false }));
      manager.setBaseline(1.5);

      manager.recordExperiment(makeExperiment({
        id: 'exp-lower',
        metricValue: 1.2,
        outcome: 'improvement',
      }));
      expect(manager.getBest().bestMetric).toBe(1.2);

      // Higher value should NOT replace when lower is better
      manager.recordExperiment(makeExperiment({
        id: 'exp-higher',
        metricValue: 1.4,
        outcome: 'improvement',
      }));
      expect(manager.getBest().bestMetric).toBe(1.2);
      expect(manager.getBest().bestExperimentId).toBe('exp-lower');
    });

    it('appends to experiment-log.md', () => {
      const exp = makeExperiment({ id: 'exp-log', hypothesis: 'Log test hyp' });
      manager.recordExperiment(exp);

      const log = readFileSync(join(tempDir, '.swarm', 'experiment-log.md'), 'utf-8');
      expect(log).toContain('## exp-log — IMPROVEMENT');
      expect(log).toContain('Log test hyp');
    });

    it('handles experiment with null delta', () => {
      const exp = makeExperiment({ id: 'exp-null-delta', delta: null });
      manager.recordExperiment(exp);

      const log = readFileSync(join(tempDir, '.swarm', 'experiment-log.md'), 'utf-8');
      expect(log).toContain('ΔN/A');
    });

    it('handles experiment without commitHash', () => {
      const exp = makeExperiment({ id: 'exp-no-commit', commitHash: undefined });
      manager.recordExperiment(exp);

      const log = readFileSync(join(tempDir, '.swarm', 'experiment-log.md'), 'utf-8');
      expect(log).not.toContain('**Commit**');
    });
  });

  describe('getExperiments', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      manager.setBaseline(0.75);
    });

    it('returns empty array when no experiments', () => {
      expect(manager.getExperiments()).toEqual([]);
    });

    it('returns experiments sorted by timestamp', () => {
      const ts1 = '2026-01-01T00:00:00.000Z';
      const ts2 = '2026-01-01T00:01:00.000Z';
      const ts3 = '2026-01-01T00:02:00.000Z';

      // Record out of order
      manager.recordExperiment(makeExperiment({ id: 'exp-3', timestamp: ts3 }));
      manager.recordExperiment(makeExperiment({ id: 'exp-1', timestamp: ts1 }));
      manager.recordExperiment(makeExperiment({ id: 'exp-2', timestamp: ts2 }));

      const exps = manager.getExperiments();
      expect(exps.map(e => e.id)).toEqual(['exp-1', 'exp-2', 'exp-3']);
    });

    it('returns all experiment fields', () => {
      const exp = makeExperiment({
        id: 'exp-full',
        agentIndex: 1,
        hypothesis: 'full fields test',
        changes: ['a.py:1 — change1', 'b.py:2 — change2'],
        metricValue: 0.88,
        delta: 0.13,
        outcome: 'improvement',
        commitHash: 'def456',
        durationSeconds: 60,
      });
      manager.recordExperiment(exp);

      const [stored] = manager.getExperiments();
      expect(stored.id).toBe('exp-full');
      expect(stored.agentIndex).toBe(1);
      expect(stored.hypothesis).toBe('full fields test');
      expect(stored.changes).toHaveLength(2);
      expect(stored.metricValue).toBe(0.88);
      expect(stored.delta).toBe(0.13);
      expect(stored.outcome).toBe('improvement');
      expect(stored.commitHash).toBe('def456');
      expect(stored.durationSeconds).toBe(60);
    });
  });

  describe('getAgentExperiments', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      manager.setBaseline(0.75);
    });

    it('filters experiments by agentIndex', () => {
      manager.recordExperiment(makeExperiment({ id: 'a0-1', agentIndex: 0 }));
      manager.recordExperiment(makeExperiment({ id: 'a1-1', agentIndex: 1 }));
      manager.recordExperiment(makeExperiment({ id: 'a0-2', agentIndex: 0 }));

      const agent0Exps = manager.getAgentExperiments(0);
      expect(agent0Exps).toHaveLength(2);
      expect(agent0Exps.map(e => e.id)).toEqual(expect.arrayContaining(['a0-1', 'a0-2']));

      const agent1Exps = manager.getAgentExperiments(1);
      expect(agent1Exps).toHaveLength(1);
      expect(agent1Exps[0].id).toBe('a1-1');
    });

    it('returns empty array for agent with no experiments', () => {
      manager.recordExperiment(makeExperiment({ id: 'a0-1', agentIndex: 0 }));
      expect(manager.getAgentExperiments(1)).toEqual([]);
    });
  });

  describe('getExperimentCount', () => {
    it('returns 0 before any experiments', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      expect(manager.getExperimentCount()).toBe(0);
    });

    it('counts experiments correctly', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      manager.setBaseline(0.75);

      manager.recordExperiment(makeExperiment({ id: 'e1' }));
      manager.recordExperiment(makeExperiment({ id: 'e2' }));
      manager.recordExperiment(makeExperiment({ id: 'e3' }));

      expect(manager.getExperimentCount()).toBe(3);
    });
  });

  // ─── Frontier ──────────────────────────────────────────────────────

  describe('addToFrontier / getFrontier', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
    });

    it('starts with empty frontier', () => {
      expect(manager.getFrontier()).toEqual([]);
    });

    it('adds ideas to frontier', () => {
      manager.addToFrontier(['idea A', 'idea B']);
      expect(manager.getFrontier()).toEqual(['idea A', 'idea B']);
    });

    it('appends to existing frontier', () => {
      manager.addToFrontier(['idea A']);
      manager.addToFrontier(['idea B', 'idea C']);
      expect(manager.getFrontier()).toEqual(['idea A', 'idea B', 'idea C']);
    });

    it('deduplicates ideas', () => {
      manager.addToFrontier(['idea A', 'idea B']);
      manager.addToFrontier(['idea B', 'idea C']);
      expect(manager.getFrontier()).toEqual(['idea A', 'idea B', 'idea C']);
    });

    it('handles empty input', () => {
      manager.addToFrontier(['idea A']);
      manager.addToFrontier([]);
      expect(manager.getFrontier()).toEqual(['idea A']);
    });
  });

  describe('claimFromFrontier', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      manager.addToFrontier(['idea A', 'idea B', 'idea C']);
    });

    it('returns true and removes idea when present', () => {
      const claimed = manager.claimFromFrontier('idea B');
      expect(claimed).toBe(true);
      expect(manager.getFrontier()).toEqual(['idea A', 'idea C']);
    });

    it('returns false when idea not in frontier', () => {
      const claimed = manager.claimFromFrontier('nonexistent');
      expect(claimed).toBe(false);
      expect(manager.getFrontier()).toHaveLength(3);
    });

    it('prevents double claim of same idea', () => {
      expect(manager.claimFromFrontier('idea A')).toBe(true);
      expect(manager.claimFromFrontier('idea A')).toBe(false);
    });

    it('can claim all ideas one by one', () => {
      expect(manager.claimFromFrontier('idea A')).toBe(true);
      expect(manager.claimFromFrontier('idea B')).toBe(true);
      expect(manager.claimFromFrontier('idea C')).toBe(true);
      expect(manager.getFrontier()).toEqual([]);
    });
  });

  // ─── Experiment Locking ────────────────────────────────────────────

  describe('acquireLock / releaseLock', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
    });

    it('acquires lock successfully', () => {
      expect(manager.acquireLock('exp-1', 0)).toBe(true);
      expect(existsSync(join(tempDir, '.swarm', 'locks', 'exp-1.lock'))).toBe(true);
    });

    it('lock file contains agent info', () => {
      manager.acquireLock('exp-lock-info', 2);
      const lock = JSON.parse(
        readFileSync(join(tempDir, '.swarm', 'locks', 'exp-lock-info.lock'), 'utf-8')
      );
      expect(lock.agentIndex).toBe(2);
      expect(lock.timestamp).toBeDefined();
    });

    it('fails to acquire same lock twice', () => {
      expect(manager.acquireLock('exp-dup', 0)).toBe(true);
      expect(manager.acquireLock('exp-dup', 1)).toBe(false);
    });

    it('different experiments get independent locks', () => {
      expect(manager.acquireLock('exp-a', 0)).toBe(true);
      expect(manager.acquireLock('exp-b', 1)).toBe(true);
    });

    it('releases lock by renaming to .done', () => {
      manager.acquireLock('exp-release', 0);
      manager.releaseLock('exp-release');

      expect(existsSync(join(tempDir, '.swarm', 'locks', 'exp-release.lock'))).toBe(false);
      expect(existsSync(join(tempDir, '.swarm', 'locks', 'exp-release.done'))).toBe(true);
    });

    it('can acquire lock after previous holder releases', () => {
      manager.acquireLock('exp-reuse', 0);
      manager.releaseLock('exp-reuse');
      expect(manager.acquireLock('exp-reuse', 1)).toBe(true);
    });

    it('releasing non-existent lock does not throw', () => {
      expect(() => manager.releaseLock('nonexistent')).not.toThrow();
    });

    it('detects and takes over stale locks (>10 min old)', () => {
      // Create a stale lock manually
      const lockFile = join(tempDir, '.swarm', 'locks', 'exp-stale.lock');
      const staleTimestamp = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      writeFileSync(lockFile, JSON.stringify({ agentIndex: 0, timestamp: staleTimestamp }));

      // Another agent should be able to take over
      expect(manager.acquireLock('exp-stale', 1)).toBe(true);
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      expect(lock.agentIndex).toBe(1);
    });

    it('does not take over fresh locks', () => {
      // Create a fresh lock
      const lockFile = join(tempDir, '.swarm', 'locks', 'exp-fresh.lock');
      const freshTimestamp = new Date().toISOString();
      writeFileSync(lockFile, JSON.stringify({ agentIndex: 0, timestamp: freshTimestamp }));

      expect(manager.acquireLock('exp-fresh', 1)).toBe(false);
    });
  });

  // ─── Snapshot ──────────────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('returns full swarm state', () => {
      manager.init(makeConfig({ workspacePath: tempDir, name: 'Snapshot Test' }));
      manager.setBaseline(0.75);
      manager.addToFrontier(['idea X']);
      manager.recordExperiment(makeExperiment({ id: 'snap-exp-1' }));

      const snapshot = manager.getSnapshot();
      expect(snapshot.config.name).toBe('Snapshot Test');
      expect(snapshot.baseline).toBe(0.75);
      expect(snapshot.bestMetric).toBe(0.80); // from experiment
      expect(snapshot.bestExperimentId).toBe('snap-exp-1');
      expect(snapshot.experiments).toHaveLength(1);
      expect(snapshot.frontier).toEqual(['idea X']);
    });

    it('returns empty state for fresh swarm', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      const snapshot = manager.getSnapshot();
      expect(snapshot.baseline).toBeNull();
      expect(snapshot.bestMetric).toBeNull();
      expect(snapshot.bestExperimentId).toBeNull();
      expect(snapshot.experiments).toEqual([]);
      expect(snapshot.frontier).toEqual([]);
    });
  });

  // ─── Edge Cases ───────────────────────────────────────────────────

  describe('edge cases', () => {
    beforeEach(() => {
      manager.init(makeConfig({ workspacePath: tempDir }));
      manager.setBaseline(0.75);
    });

    it('metricValue=0 is treated as valid (not falsy)', () => {
      manager.recordExperiment(makeExperiment({
        id: 'exp-zero',
        metricValue: 0,
        delta: -0.75,
        outcome: 'improvement',
      }));

      // 0 is a valid metric value, and since higherIsBetter=true
      // and 0 < 0.75, it should NOT update best
      expect(manager.getBest().bestMetric).toBe(0.75);
    });

    it('metricValue=0 updates best when lower is better', () => {
      // Re-init with higherIsBetter=false
      rmSync(join(tempDir, '.swarm'), { recursive: true, force: true });
      manager.init(makeConfig({ workspacePath: tempDir, higherIsBetter: false }));
      manager.setBaseline(0.5);

      manager.recordExperiment(makeExperiment({
        id: 'exp-zero-lower',
        metricValue: 0,
        delta: -0.5,
        outcome: 'improvement',
      }));

      expect(manager.getBest().bestMetric).toBe(0);
      expect(manager.getBest().bestExperimentId).toBe('exp-zero-lower');
    });

    it('acquireLock handles corrupted lock file gracefully', () => {
      const lockFile = join(tempDir, '.swarm', 'locks', 'exp-corrupt.lock');
      writeFileSync(lockFile, 'not valid json{{{');

      // Should return false (can't parse, falls through)
      expect(manager.acquireLock('exp-corrupt', 1)).toBe(false);
    });

    it('releaseLock on already-released lock does not throw', () => {
      manager.acquireLock('exp-double', 0);
      manager.releaseLock('exp-double');
      // Second release — .lock is already renamed to .done
      expect(() => manager.releaseLock('exp-double')).not.toThrow();
    });

    it('negative metricValue works correctly', () => {
      manager.recordExperiment(makeExperiment({
        id: 'exp-neg',
        metricValue: -0.5,
        delta: -1.25,
        outcome: 'improvement',
      }));

      // -0.5 < 0.75, so should NOT update best (higherIsBetter=true)
      expect(manager.getBest().bestMetric).toBe(0.75);
    });

    it('very large metricValue updates best correctly', () => {
      manager.recordExperiment(makeExperiment({
        id: 'exp-large',
        metricValue: 999999.99,
        delta: 999999.24,
        outcome: 'improvement',
      }));

      expect(manager.getBest().bestMetric).toBe(999999.99);
      expect(manager.getBest().bestExperimentId).toBe('exp-large');
    });

    it('experiment log handles negative delta formatting', () => {
      const exp = makeExperiment({ id: 'exp-neg-delta', delta: -0.1234 });
      manager.recordExperiment(exp);

      const log = readFileSync(join(tempDir, '.swarm', 'experiment-log.md'), 'utf-8');
      expect(log).toContain('Δ-0.1234');
    });

    it('experiment log handles positive delta formatting', () => {
      const exp = makeExperiment({ id: 'exp-pos-delta', delta: 0.0567 });
      manager.recordExperiment(exp);

      const log = readFileSync(join(tempDir, '.swarm', 'experiment-log.md'), 'utf-8');
      expect(log).toContain('Δ+0.0567');
    });

    it('getExperiments ignores non-JSON files in experiments dir', () => {
      manager.recordExperiment(makeExperiment({ id: 'exp-real' }));
      // Write a non-JSON file into experiments/
      writeFileSync(join(tempDir, '.swarm', 'experiments', 'README.txt'), 'not an experiment');

      const exps = manager.getExperiments();
      expect(exps).toHaveLength(1);
      expect(exps[0].id).toBe('exp-real');
    });

    it('multiple setBaseline calls update correctly', () => {
      manager.setBaseline(0.5);
      expect(manager.getBaseline()).toBe(0.5);

      manager.setBaseline(0.9);
      expect(manager.getBaseline()).toBe(0.9);
      // bestMetric was set to 0.5 on first call, should NOT change on second
      // because bestMetric is already non-null
      expect(manager.getBest().bestMetric).toBe(0.75); // original from beforeEach baseline
    });

    it('addToFrontier with duplicate ideas within same call', () => {
      manager.addToFrontier(['idea A', 'idea A', 'idea B']);
      // Dedup only checks against existing frontier, not within the new batch
      const frontier = manager.getFrontier();
      expect(frontier).toContain('idea A');
      expect(frontier).toContain('idea B');
    });

    it('claimFromFrontier returns false on empty frontier', () => {
      expect(manager.claimFromFrontier('anything')).toBe(false);
    });
  });

  // ─── State Lock Error Handling ──────────────────────────────────

  describe('state lock error handling', () => {
    it('setStatus throws when lock cannot be acquired (lock dir is a file)', () => {
      manager.init(makeConfig({ workspacePath: tempDir }));

      // Make the lock dir path a file instead of a directory
      const lockDir = join(tempDir, '.swarm', '.state-lock');
      writeFileSync(lockDir, 'blocker');

      // setStatus uses withStateLock → acquireStateLock → mkdirSync
      // mkdirSync on a file path that exists as a file will throw ENOTDIR or EEXIST
      // The busy-wait loop will eventually timeout and try to force-remove
      // Since it's a file, rmdirSync will fail → returns false → throws
      expect(() => manager.setStatus('stopped')).toThrow();
    });
  });
});
