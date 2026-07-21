import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  initSwarm,
  runEvaluation,
  safeRunEvaluation,
  recordBaseline,
  seedFrontier,
  buildResearcherGrounding,
  getSwarmStatus,
  stopSwarm,
  generateSwarmReport,
  checkConvergence,
  isSwarmConverged,
  type SwarmInitOptions,
  type EvalResult,
} from './swarm-coordinator.js';
import { SwarmStateManager } from './swarm-state.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `swarm-coord-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeInitOptions(workspacePath: string, overrides: Partial<SwarmInitOptions> = {}): SwarmInitOptions {
  return {
    name: 'Test Swarm',
    workspacePath,
    metric: 'accuracy',
    higherIsBetter: true,
    evalCommand: 'echo 0.75',
    targetFiles: ['model.py'],
    agentCount: 2,
    maxExperimentsPerAgent: 5,
    budgetMinutes: 30,
    directions: [
      { focus: 'architecture', constraints: ['keep params under 1M'] },
      { focus: 'hyperparams', constraints: ['learning rate', 'batch size'] },
    ],
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('initSwarm', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new swarm and returns a manager', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    expect(manager).toBeInstanceOf(SwarmStateManager);
    expect(manager.exists()).toBe(true);
  });

  it('sets config with correct fields', () => {
    const manager = initSwarm(makeInitOptions(tempDir, { name: 'Init Test' }));
    const config = manager.getConfig();

    expect(config.name).toBe('Init Test');
    expect(config.metric).toBe('accuracy');
    expect(config.higherIsBetter).toBe(true);
    expect(config.status).toBe('running');
    expect(config.agentCount).toBe(2);
    expect(config.id).toMatch(/^swarm-\d+$/);
  });

  it('maps directions with agentIndex', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    const config = manager.getConfig();

    expect(config.directions).toHaveLength(2);
    expect(config.directions[0].agentIndex).toBe(0);
    expect(config.directions[0].focus).toBe('architecture');
    expect(config.directions[1].agentIndex).toBe(1);
    expect(config.directions[1].focus).toBe('hyperparams');
  });

  it('throws if swarm already exists', () => {
    initSwarm(makeInitOptions(tempDir));
    expect(() => initSwarm(makeInitOptions(tempDir))).toThrow(/already exists/);
  });
});

describe('runEvaluation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts number from simple echo', () => {
    const result = runEvaluation(tempDir, 'echo 0.75');
    expect(result).toBe(0.75);
  });

  it('extracts last number from multi-line output', () => {
    const result = runEvaluation(tempDir, 'echo "info: training done\naccuracy: 0.82"');
    expect(result).toBe(0.82);
  });

  it('handles negative numbers', () => {
    const result = runEvaluation(tempDir, 'echo -1.5');
    expect(result).toBe(-1.5);
  });

  it('handles integer output', () => {
    const result = runEvaluation(tempDir, 'echo 42');
    expect(result).toBe(42);
  });

  it('throws when eval command produces no numbers', () => {
    expect(() => runEvaluation(tempDir, 'echo "no numbers here"')).toThrow(/no numbers/);
  });

  it('throws when eval command fails', () => {
    expect(() => runEvaluation(tempDir, 'false')).toThrow(/Eval command failed/);
  });

  it('throws on non-existent command', () => {
    expect(() => runEvaluation(tempDir, 'nonexistent_command_xyz')).toThrow(/Eval command failed/);
  });
});

describe('safeRunEvaluation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns success with value for valid output', () => {
    const result = safeRunEvaluation(tempDir, 'echo 0.85');
    expect(result.success).toBe(true);
    expect(result.value).toBe(0.85);
    expect(result.error).toBeUndefined();
  });

  it('returns error result for failing command', () => {
    const result = safeRunEvaluation(tempDir, 'false');
    expect(result.success).toBe(false);
    expect(result.value).toBeNull();
    expect(result.error).toContain('Eval command failed');
  });

  it('returns error result for non-existent command', () => {
    const result = safeRunEvaluation(tempDir, 'nonexistent_xyz_cmd');
    expect(result.success).toBe(false);
    expect(result.value).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('returns error result when no numbers in output', () => {
    const result = safeRunEvaluation(tempDir, 'echo "no numbers here"');
    expect(result.success).toBe(false);
    expect(result.value).toBeNull();
    expect(result.error).toContain('no numbers');
  });

  it('handles multi-line output correctly', () => {
    const result = safeRunEvaluation(tempDir, 'echo "info\nmetric: 0.92"');
    expect(result.success).toBe(true);
    expect(result.value).toBe(0.92);
  });

  it('handles negative numbers', () => {
    const result = safeRunEvaluation(tempDir, 'echo -2.5');
    expect(result.success).toBe(true);
    expect(result.value).toBe(-2.5);
  });

  it('truncates long error messages', () => {
    // A command that produces a long error
    const result = safeRunEvaluation(tempDir, 'echo "' + 'x'.repeat(1000) + '" && false');
    // The error should be truncated — check it doesn't exceed a reasonable length
    if (result.error) {
      expect(result.error.length).toBeLessThanOrEqual(600);
    }
  });
});

describe('recordBaseline', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs evaluation and sets baseline', () => {
    const manager = initSwarm(makeInitOptions(tempDir, { evalCommand: 'echo 0.65' }));
    const baseline = recordBaseline(manager);

    expect(baseline).toBe(0.65);
    expect(manager.getBaseline()).toBe(0.65);
  });

  it('sets bestMetric to baseline value', () => {
    const manager = initSwarm(makeInitOptions(tempDir, { evalCommand: 'echo 0.70' }));
    recordBaseline(manager);

    expect(manager.getBest().bestMetric).toBe(0.70);
  });

  it('returns null on eval failure instead of throwing', () => {
    const manager = initSwarm(makeInitOptions(tempDir, { evalCommand: 'false' }));
    const baseline = recordBaseline(manager);

    expect(baseline).toBeNull();
    expect(manager.getBaseline()).toBeNull();
  });

  it('does not set baseline on failure', () => {
    const manager = initSwarm(makeInitOptions(tempDir, { evalCommand: 'nonexistent_cmd_xyz' }));
    recordBaseline(manager);

    expect(manager.getBaseline()).toBeNull();
    expect(manager.getBest().bestMetric).toBeNull();
  });
});

describe('seedFrontier', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = initSwarm(makeInitOptions(tempDir));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('seeds with custom ideas when provided', () => {
    seedFrontier(manager, ['custom idea 1', 'custom idea 2']);
    const frontier = manager.getFrontier();

    expect(frontier).toEqual(['custom idea 1', 'custom idea 2']);
  });

  it('generates template ideas from directions when no custom ideas', () => {
    seedFrontier(manager);
    const frontier = manager.getFrontier();

    // Should have ideas for both directions
    expect(frontier.length).toBeGreaterThan(0);
    expect(frontier.some(i => i.includes('[architecture]'))).toBe(true);
    expect(frontier.some(i => i.includes('[hyperparams]'))).toBe(true);
  });

  it('generates ideas from constraints', () => {
    seedFrontier(manager);
    const frontier = manager.getFrontier();

    // Direction 1 has constraints 'learning rate', 'batch size'
    expect(frontier.some(i => i.includes('learning rate'))).toBe(true);
    expect(frontier.some(i => i.includes('batch size'))).toBe(true);
  });

  it('includes target file references', () => {
    seedFrontier(manager);
    const frontier = manager.getFrontier();

    expect(frontier.some(i => i.includes('model.py'))).toBe(true);
  });

  it('uses empty custom ideas array as truthy — falls through to templates', () => {
    seedFrontier(manager, []);
    const frontier = manager.getFrontier();

    // Empty array → generates template ideas (not empty frontier)
    expect(frontier.length).toBeGreaterThan(0);
  });
});

describe('buildResearcherGrounding', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);
    manager.addToFrontier(['idea Alpha', 'idea Beta']);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns a non-empty string', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding.length).toBeGreaterThan(100);
  });

  it('includes swarm protocol header', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('## Research Swarm Protocol');
  });

  it('identifies the agent index', () => {
    const grounding = buildResearcherGrounding(manager, 1);
    expect(grounding).toContain('Researcher Agent 1');
  });

  it('includes metric info and direction', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('accuracy');
    expect(grounding).toContain('higher is better');
    expect(grounding).toContain('architecture');
  });

  it('includes baseline and best metric', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('0.75');
  });

  it('includes frontier ideas', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('idea Alpha');
    expect(grounding).toContain('idea Beta');
  });

  it('includes eval command', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('echo 0.75');
  });

  it('includes target files', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('model.py');
  });

  it('includes direction-specific constraints', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('keep params under 1M');
  });

  it('shows recent experiments for the agent', () => {
    manager.recordExperiment({
      id: 'agent-0-exp-1',
      agentIndex: 0,
      hypothesis: 'Test wider layers',
      changes: ['model.py:10'],
      metricValue: 0.78,
      delta: 0.03,
      outcome: 'improvement',
      durationSeconds: 60,
      timestamp: new Date().toISOString(),
    });

    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('agent-0-exp-1');
    expect(grounding).toContain('Test wider layers');
  });

  it('does not show other agents experiments', () => {
    manager.recordExperiment({
      id: 'agent-1-exp-1',
      agentIndex: 1,
      hypothesis: 'Agent 1 thing',
      changes: [],
      metricValue: 0.78,
      delta: 0.03,
      outcome: 'improvement',
      durationSeconds: 60,
      timestamp: new Date().toISOString(),
    });

    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).not.toContain('Agent 1 thing');
  });

  it('handles missing direction gracefully', () => {
    // Agent 5 has no direction in a 2-agent swarm
    const grounding = buildResearcherGrounding(manager, 5);
    expect(grounding).toContain('No specific direction assigned');
  });

  it('includes max experiments per agent', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('5'); // maxExperimentsPerAgent
  });

  it('includes coordination rules and experiment loop', () => {
    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('Coordination Rules');
    expect(grounding).toContain('Experiment Loop');
    expect(grounding).toContain('Recording Experiments');
  });
});

describe('getSwarmStatus', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty status when no swarm exists', () => {
    const status = getSwarmStatus(tempDir);
    expect(status.running).toBe(false);
    expect(status.config).toBeNull();
    expect(status.baseline).toBeNull();
    expect(status.totalExperiments).toBe(0);
    expect(status.agentExperimentCounts).toEqual([]);
  });

  it('returns correct status for initialized swarm', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    const status = getSwarmStatus(tempDir);
    expect(status.running).toBe(true);
    expect(status.config).not.toBeNull();
    expect(status.config!.name).toBe('Test Swarm');
    expect(status.baseline).toBe(0.75);
    expect(status.bestMetric).toBe(0.75);
    expect(status.frontierSize).toBe(0);
    expect(status.agentExperimentCounts).toEqual([0, 0]);
  });

  it('counts experiments per agent', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    manager.recordExperiment({
      id: 'a0-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.76, delta: 0.01, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'a0-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.77, delta: 0.02, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });
    manager.recordExperiment({
      id: 'a1-1', agentIndex: 1, hypothesis: 'h', changes: [],
      metricValue: 0.74, delta: -0.01, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:02:00Z',
    });

    const status = getSwarmStatus(tempDir);
    expect(status.totalExperiments).toBe(3);
    expect(status.agentExperimentCounts).toEqual([2, 1]);
    expect(status.bestMetric).toBe(0.77);
    expect(status.bestExperimentId).toBe('a0-2');
  });

  it('reports frontier size', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.addToFrontier(['idea1', 'idea2', 'idea3']);

    const status = getSwarmStatus(tempDir);
    expect(status.frontierSize).toBe(3);
  });
});

describe('stopSwarm', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('sets swarm status to stopped', () => {
    initSwarm(makeInitOptions(tempDir));
    stopSwarm(tempDir);

    const manager = new SwarmStateManager(tempDir);
    expect(manager.getConfig().status).toBe('stopped');
  });

  it('throws when no swarm exists', () => {
    expect(() => stopSwarm(tempDir)).toThrow(/No swarm found/);
  });

  it('makes status report running=false', () => {
    initSwarm(makeInitOptions(tempDir));
    stopSwarm(tempDir);

    const status = getSwarmStatus(tempDir);
    expect(status.running).toBe(false);
  });
});

describe('generateSwarmReport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns "No swarm found" for missing swarm', () => {
    expect(generateSwarmReport(tempDir)).toBe('No swarm found.');
  });

  it('generates report with swarm name and metric', () => {
    initSwarm(makeInitOptions(tempDir, { name: 'Report Test' }));
    const report = generateSwarmReport(tempDir);

    expect(report).toContain('# Swarm Report — Report Test');
    expect(report).toContain('accuracy');
    expect(report).toContain('higher is better');
  });

  it('includes baseline and best metrics', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('0.7');
  });

  it('includes experiment breakdown', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    manager.recordExperiment({
      id: 'r-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.75, delta: 0.05, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'r-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.65, delta: -0.05, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });
    manager.recordExperiment({
      id: 'r-3', agentIndex: 1, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:02:00Z',
    });

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('Total: 3');
    expect(report).toContain('Improvements: 1');
    expect(report).toContain('Regressions: 1');
    expect(report).toContain('Errors: 1');
  });

  it('includes per-agent summary', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    manager.recordExperiment({
      id: 'pa-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.75, delta: 0.05, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('Agent 0 (architecture)');
    expect(report).toContain('Agent 1 (hyperparams)');
  });

  it('includes delta from baseline to best', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    manager.recordExperiment({
      id: 'd-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.80, delta: 0.10, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('+0.1000');
  });

  it('shows frontier count', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.addToFrontier(['idea1', 'idea2']);

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('2 ideas remaining');
  });

  it('reports status', () => {
    initSwarm(makeInitOptions(tempDir));
    stopSwarm(tempDir);

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('stopped');
  });

  it('includes convergence info in per-agent summary', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    // 3 consecutive regressions for agent 0 → converged
    manager.recordExperiment({
      id: 'conv-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.68, delta: -0.02, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'conv-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.67, delta: -0.03, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });
    manager.recordExperiment({
      id: 'conv-3', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:02:00Z',
    });

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('CONVERGED');
    expect(report).toContain('1 errors');
  });
});

// ─── Convergence Detection ────────────────────────────────────────────────

describe('checkConvergence', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns not converged when no experiments', () => {
    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe('not enough experiments');
    expect(result.nonImprovingStreak).toBe(0);
  });

  it('returns not converged with fewer than 3 experiments', () => {
    manager.recordExperiment({
      id: 'c-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.74, delta: -0.01, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'c-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.73, delta: -0.02, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe('not enough experiments');
  });

  it('detects convergence after 3 consecutive regressions', () => {
    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `reg-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.74 - i * 0.01, delta: -(0.01 + i * 0.01), outcome: 'regression',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(true);
    expect(result.nonImprovingStreak).toBe(3);
    expect(result.reason).toContain('3 consecutive non-improving');
  });

  it('detects convergence with mixed non-improving outcomes', () => {
    // regression, neutral, error — all non-improving
    manager.recordExperiment({
      id: 'mix-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.74, delta: -0.01, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'mix-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.75, delta: 0, outcome: 'neutral',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });
    manager.recordExperiment({
      id: 'mix-3', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:02:00Z',
    });

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(true);
    expect(result.nonImprovingStreak).toBe(3);
  });

  it('resets streak after an improvement', () => {
    // Use a config with higher maxExperiments to avoid hitting the budget limit
    rmSync(join(tempDir, '.swarm'), { recursive: true, force: true });
    manager = initSwarm(makeInitOptions(tempDir, { maxExperimentsPerAgent: 20 }));
    manager.setBaseline(0.75);

    // 2 regressions, then improvement, then 2 regressions — NOT converged
    manager.recordExperiment({
      id: 'r-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.73, delta: -0.02, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'r-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.72, delta: -0.03, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });
    manager.recordExperiment({
      id: 'i-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.80, delta: 0.05, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:02:00Z',
    });
    manager.recordExperiment({
      id: 'r-3', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.78, delta: -0.02, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:03:00Z',
    });
    manager.recordExperiment({
      id: 'r-4', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.77, delta: -0.03, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:04:00Z',
    });

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(false);
    expect(result.nonImprovingStreak).toBe(2);
    expect(result.reason).toBe('still improving');
  });

  it('detects convergence when max experiments reached', () => {
    // maxExperimentsPerAgent is 5 in our test config
    for (let i = 0; i < 5; i++) {
      manager.recordExperiment({
        id: `max-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.80 + i * 0.01, delta: 0.01, outcome: 'improvement',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(true);
    expect(result.reason).toBe('max experiments reached');
  });

  it('only counts experiments for the specified agent', () => {
    // Agent 1 has 3 regressions, agent 0 has none
    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `a1-${i}`, agentIndex: 1, hypothesis: 'h', changes: [],
        metricValue: 0.74, delta: -0.01, outcome: 'regression',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    expect(checkConvergence(manager, 0).converged).toBe(false);
    expect(checkConvergence(manager, 1).converged).toBe(true);
  });

  it('supports custom threshold', () => {
    // 2 regressions — not converged at threshold=3, converged at threshold=2
    manager.recordExperiment({
      id: 'th-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.73, delta: -0.02, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'th-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.72, delta: -0.03, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });

    expect(checkConvergence(manager, 0, 3).converged).toBe(false);
    expect(checkConvergence(manager, 0, 2).converged).toBe(true);
  });

  it('counts errors toward non-improving streak', () => {
    manager.recordExperiment({
      id: 'e-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'e-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });
    manager.recordExperiment({
      id: 'e-3', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:02:00Z',
    });

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(true);
    expect(result.nonImprovingStreak).toBe(3);
  });
});

describe('isSwarmConverged', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when no agents have converged', () => {
    expect(isSwarmConverged(manager)).toBe(false);
  });

  it('returns false when only some agents have converged', () => {
    // Agent 0 converges (3 regressions), agent 1 has no experiments
    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `sc-0-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.74, delta: -0.01, outcome: 'regression',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    expect(isSwarmConverged(manager)).toBe(false);
  });

  it('returns true when all agents have converged', () => {
    // Both agents get 3 regressions each
    for (let agent = 0; agent < 2; agent++) {
      for (let i = 0; i < 3; i++) {
        manager.recordExperiment({
          id: `all-${agent}-${i}`, agentIndex: agent, hypothesis: 'h', changes: [],
          metricValue: 0.74, delta: -0.01, outcome: 'regression',
          durationSeconds: 10, timestamp: `2026-01-01T0${agent}:0${i}:00Z`,
        });
      }
    }

    expect(isSwarmConverged(manager)).toBe(true);
  });

  it('returns true when agents converged by different reasons', () => {
    // Agent 0: max experiments (5)
    for (let i = 0; i < 5; i++) {
      manager.recordExperiment({
        id: `mixed-0-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.80 + i * 0.01, delta: 0.01, outcome: 'improvement',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }
    // Agent 1: 3 regressions
    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `mixed-1-${i}`, agentIndex: 1, hypothesis: 'h', changes: [],
        metricValue: 0.74, delta: -0.01, outcome: 'regression',
        durationSeconds: 10, timestamp: `2026-01-01T01:0${i}:00Z`,
      });
    }

    expect(isSwarmConverged(manager)).toBe(true);
  });
});

describe('getSwarmStatus convergence fields', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty convergence for non-existent swarm', () => {
    const status = getSwarmStatus(tempDir);
    expect(status.agentConvergence).toEqual([]);
    expect(status.swarmConverged).toBe(false);
  });

  it('includes per-agent convergence info', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    const status = getSwarmStatus(tempDir);
    expect(status.agentConvergence).toHaveLength(2);
    expect(status.agentConvergence[0].converged).toBe(false);
    expect(status.agentConvergence[1].converged).toBe(false);
    expect(status.swarmConverged).toBe(false);
  });

  it('reflects convergence when agent stops improving', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `st-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.74, delta: -0.01, outcome: 'regression',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const status = getSwarmStatus(tempDir);
    expect(status.agentConvergence[0].converged).toBe(true);
    expect(status.agentConvergence[1].converged).toBe(false);
    expect(status.swarmConverged).toBe(false);
  });

  it('swarmConverged is true when all agents converged', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    // Both agents: 3 regressions each
    for (let agent = 0; agent < 2; agent++) {
      for (let i = 0; i < 3; i++) {
        manager.recordExperiment({
          id: `sw-${agent}-${i}`, agentIndex: agent, hypothesis: 'h', changes: [],
          metricValue: 0.74, delta: -0.01, outcome: 'regression',
          durationSeconds: 10, timestamp: `2026-01-01T0${agent}:0${i}:00Z`,
        });
      }
    }

    const status = getSwarmStatus(tempDir);
    expect(status.swarmConverged).toBe(true);
    expect(status.agentConvergence[0].converged).toBe(true);
    expect(status.agentConvergence[1].converged).toBe(true);
  });
});

// ─── Additional Edge Cases ────────────────────────────────────────────────

describe('checkConvergence edge cases', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = initSwarm(makeInitOptions(tempDir, { maxExperimentsPerAgent: 20 }));
    manager.setBaseline(0.75);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('threshold=1 converges after single non-improving experiment', () => {
    manager.recordExperiment({
      id: 'th1-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.74, delta: -0.01, outcome: 'regression',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });

    const result = checkConvergence(manager, 0, 1);
    expect(result.converged).toBe(true);
    expect(result.nonImprovingStreak).toBe(1);
  });

  it('streak counts consecutive non-improving from the end (not total)', () => {
    // improvement, regression, improvement, regression, regression
    const outcomes: Array<{ outcome: 'improvement' | 'regression'; metric: number }> = [
      { outcome: 'improvement', metric: 0.80 },
      { outcome: 'regression', metric: 0.74 },
      { outcome: 'improvement', metric: 0.82 },
      { outcome: 'regression', metric: 0.73 },
      { outcome: 'regression', metric: 0.72 },
    ];

    for (let i = 0; i < outcomes.length; i++) {
      manager.recordExperiment({
        id: `streak-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: outcomes[i].metric, delta: outcomes[i].metric - 0.75,
        outcome: outcomes[i].outcome,
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(false);
    expect(result.nonImprovingStreak).toBe(2); // only last 2 regressions
  });

  it('pending outcome is non-improving', () => {
    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `pend-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: null, delta: null, outcome: 'pending',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(true);
    expect(result.nonImprovingStreak).toBe(3);
  });

  it('max experiments check takes priority over streak check', () => {
    // 5 improvements — max experiments reached, converged by budget
    rmSync(join(tempDir, '.swarm'), { recursive: true, force: true });
    manager = initSwarm(makeInitOptions(tempDir, { maxExperimentsPerAgent: 5 }));
    manager.setBaseline(0.75);

    for (let i = 0; i < 5; i++) {
      manager.recordExperiment({
        id: `budget-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.80 + i * 0.01, delta: 0.01, outcome: 'improvement',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const result = checkConvergence(manager, 0);
    expect(result.converged).toBe(true);
    expect(result.reason).toBe('max experiments reached');
    expect(result.nonImprovingStreak).toBe(0);
  });

  it('agent with no experiments for given index returns not converged', () => {
    // Agent 99 does not exist in config but function handles it
    const result = checkConvergence(manager, 99);
    expect(result.converged).toBe(false);
    expect(result.reason).toBe('not enough experiments');
  });
});

describe('initSwarm edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('handles empty directions array', () => {
    const manager = initSwarm(makeInitOptions(tempDir, { directions: [], agentCount: 0 }));
    const config = manager.getConfig();
    expect(config.directions).toEqual([]);
    expect(config.agentCount).toBe(0);
  });

  it('handles single direction', () => {
    const manager = initSwarm(makeInitOptions(tempDir, {
      directions: [{ focus: 'solo', constraints: [] }],
      agentCount: 1,
    }));
    const config = manager.getConfig();
    expect(config.directions).toHaveLength(1);
    expect(config.directions[0].agentIndex).toBe(0);
    expect(config.directions[0].focus).toBe('solo');
  });

  it('preserves all constraint entries', () => {
    const constraints = ['lr < 0.01', 'batch size > 16', 'no dropout'];
    const manager = initSwarm(makeInitOptions(tempDir, {
      directions: [{ focus: 'tuning', constraints }],
      agentCount: 1,
    }));
    expect(manager.getConfig().directions[0].constraints).toEqual(constraints);
  });
});

describe('buildResearcherGrounding edge cases', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('handles empty targetFiles', () => {
    manager = initSwarm(makeInitOptions(tempDir, { targetFiles: [] }));
    manager.setBaseline(0.75);

    const grounding = buildResearcherGrounding(manager, 0);
    // Should still render — targetFiles join produces empty string
    expect(grounding).toContain('**Target files**:');
    expect(grounding).toContain('Research Swarm Protocol');
  });

  it('truncates frontier display to 10 ideas', () => {
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    const manyIdeas = Array.from({ length: 15 }, (_, i) => `idea-${i}`);
    manager.addToFrontier(manyIdeas);

    const grounding = buildResearcherGrounding(manager, 0);
    // Should show first 10 only
    expect(grounding).toContain('idea-0');
    expect(grounding).toContain('idea-9');
    expect(grounding).not.toContain('idea-10');
    expect(grounding).not.toContain('idea-14');
  });

  it('shows only last 5 recent experiments', () => {
    manager = initSwarm(makeInitOptions(tempDir, { maxExperimentsPerAgent: 20 }));
    manager.setBaseline(0.75);

    // Record 8 experiments for agent 0
    for (let i = 0; i < 8; i++) {
      manager.recordExperiment({
        id: `a0-exp-${i}`, agentIndex: 0, hypothesis: `hyp-${i}`, changes: [],
        metricValue: 0.76 + i * 0.01, delta: 0.01, outcome: 'improvement',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const grounding = buildResearcherGrounding(manager, 0);
    // Should show experiments 3-7 (last 5), not 0-2
    expect(grounding).not.toContain('a0-exp-0');
    expect(grounding).not.toContain('a0-exp-2');
    expect(grounding).toContain('a0-exp-3');
    expect(grounding).toContain('a0-exp-7');
  });

  it('includes convergence warning when converged', () => {
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    // 3 regressions → converged
    for (let i = 0; i < 3; i++) {
      manager.recordExperiment({
        id: `conv-${i}`, agentIndex: 0, hypothesis: 'h', changes: [],
        metricValue: 0.74, delta: -0.01, outcome: 'regression',
        durationSeconds: 10, timestamp: `2026-01-01T00:0${i}:00Z`,
      });
    }

    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('CONVERGED');
    expect(grounding).toContain('stop experimenting');
  });

  it('shows lower is better text', () => {
    manager = initSwarm(makeInitOptions(tempDir, { higherIsBetter: false }));
    manager.setBaseline(1.5);

    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('lower is better');
  });

  it('handles no frontier gracefully', () => {
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('Empty');
    expect(grounding).toContain('generate your own');
  });

  it('handles no experiments gracefully', () => {
    manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.75);

    const grounding = buildResearcherGrounding(manager, 0);
    expect(grounding).toContain('None yet');
    expect(grounding).toContain('starting fresh');
  });
});

describe('seedFrontier edge cases', () => {
  let tempDir: string;
  let manager: SwarmStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates ideas per constraint', () => {
    manager = initSwarm(makeInitOptions(tempDir, {
      directions: [
        { focus: 'arch', constraints: ['constraint-a', 'constraint-b', 'constraint-c'] },
      ],
      agentCount: 1,
    }));

    seedFrontier(manager);
    const frontier = manager.getFrontier();

    // 3 template ideas + 3 constraint ideas
    expect(frontier.some(i => i.includes('constraint-a'))).toBe(true);
    expect(frontier.some(i => i.includes('constraint-b'))).toBe(true);
    expect(frontier.some(i => i.includes('constraint-c'))).toBe(true);
  });

  it('does not duplicate ideas when seeded twice', () => {
    manager = initSwarm(makeInitOptions(tempDir));

    seedFrontier(manager, ['idea-1', 'idea-2']);
    seedFrontier(manager, ['idea-2', 'idea-3']);

    const frontier = manager.getFrontier();
    expect(frontier.filter(i => i === 'idea-2')).toHaveLength(1);
  });
});

describe('generateSwarmReport edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('shows negative delta for lower-is-better improvement', () => {
    const manager = initSwarm(makeInitOptions(tempDir, {
      higherIsBetter: false,
      evalCommand: 'echo 1.5',
    }));
    manager.setBaseline(1.5);

    manager.recordExperiment({
      id: 'lib-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 1.2, delta: -0.3, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });

    const report = generateSwarmReport(tempDir);
    // Lower is better: delta should be negative (1.2 - 1.5 = -0.3)
    expect(report).toContain('-0.3000');
  });

  it('shows N/A delta when baseline is null', () => {
    initSwarm(makeInitOptions(tempDir));
    // Don't set baseline
    const report = generateSwarmReport(tempDir);
    expect(report).toContain('ΔN/A');
  });

  it('includes error count in per-agent summary', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    manager.recordExperiment({
      id: 'err-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });
    manager.recordExperiment({
      id: 'err-2', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: null, delta: null, outcome: 'error',
      durationSeconds: 10, timestamp: '2026-01-01T00:01:00Z',
    });

    const report = generateSwarmReport(tempDir);
    expect(report).toContain('2 errors');
  });

  it('omits error label when no errors', () => {
    const manager = initSwarm(makeInitOptions(tempDir));
    manager.setBaseline(0.70);

    manager.recordExperiment({
      id: 'ok-1', agentIndex: 0, hypothesis: 'h', changes: [],
      metricValue: 0.75, delta: 0.05, outcome: 'improvement',
      durationSeconds: 10, timestamp: '2026-01-01T00:00:00Z',
    });

    const report = generateSwarmReport(tempDir);
    // Per-agent summary for agent 0 should not contain "errors"
    const agentLine = report.split('\n').find(l => l.includes('Agent 0'));
    expect(agentLine).not.toContain('error');
  });

  it('shows all-zero experiment summary for fresh swarm', () => {
    initSwarm(makeInitOptions(tempDir));
    const report = generateSwarmReport(tempDir);

    expect(report).toContain('Total: 0');
    expect(report).toContain('Improvements: 0');
    expect(report).toContain('Regressions: 0');
    expect(report).toContain('Errors: 0');
  });
});

describe('safeRunEvaluation edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts last number when multiple numbers in output', () => {
    const result = safeRunEvaluation(tempDir, 'echo "step 1/10 loss=2.5 acc=0.87"');
    expect(result.success).toBe(true);
    expect(result.value).toBe(0.87);
  });

  it('handles zero as valid output', () => {
    const result = safeRunEvaluation(tempDir, 'echo 0');
    expect(result.success).toBe(true);
    expect(result.value).toBe(0);
  });

  it('handles scientific-looking notation', () => {
    // echo "1.5" — simple float
    const result = safeRunEvaluation(tempDir, 'echo 1.5');
    expect(result.success).toBe(true);
    expect(result.value).toBe(1.5);
  });

  it('handles whitespace-only output as no numbers', () => {
    const result = safeRunEvaluation(tempDir, 'echo "   "');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no numbers');
  });

  it('handles empty output as no numbers', () => {
    const result = safeRunEvaluation(tempDir, 'echo ""');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no numbers');
  });
});

describe('stopSwarm edge cases', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('can stop an already-stopped swarm', () => {
    initSwarm(makeInitOptions(tempDir));
    stopSwarm(tempDir);

    // Stopping again should not throw
    expect(() => stopSwarm(tempDir)).not.toThrow();
    expect(new SwarmStateManager(tempDir).getConfig().status).toBe('stopped');
  });
});
