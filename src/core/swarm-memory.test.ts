/**
 * Tests for swarm-memory.ts — findings extraction, memory generation, and writing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import type { SwarmSnapshot, SwarmConfig, Experiment } from './swarm-state.js';
import {
  extractSwarmFindings,
  generateMemoryContent,
  writeToAgentMemory,
  type SwarmFindings,
} from './swarm-memory.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = join(tmpdir(), `swarm-memory-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: overrides.id ?? `agent-0-exp-1`,
    agentIndex: overrides.agentIndex ?? 0,
    hypothesis: overrides.hypothesis ?? 'Test hypothesis',
    changes: overrides.changes ?? ['file.ts:10 — changed param'],
    metricValue: overrides.metricValue ?? 0.75,
    delta: overrides.delta ?? 0.05,
    outcome: overrides.outcome ?? 'improvement',
    durationSeconds: overrides.durationSeconds ?? 120,
    timestamp: overrides.timestamp ?? '2026-03-26T10:00:00Z',
    ...(overrides.commitHash ? { commitHash: overrides.commitHash } : {}),
  };
}

function makeConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    id: 'swarm-test-123',
    name: 'Test Swarm',
    metric: 'balanced_accuracy',
    higherIsBetter: true,
    evalCommand: 'python eval.py',
    targetFiles: ['model.py'],
    agentCount: 2,
    maxExperimentsPerAgent: 10,
    budgetMinutes: 60,
    directions: [
      { agentIndex: 0, focus: 'hyperparameter tuning', constraints: [] },
      { agentIndex: 1, focus: 'feature engineering', constraints: [] },
    ],
    workspacePath: '/tmp/test-workspace',
    createdAt: '2026-03-26T09:00:00Z',
    status: 'completed',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SwarmSnapshot> = {}): SwarmSnapshot {
  return {
    config: overrides.config ?? makeConfig(),
    baseline: overrides.baseline ?? 0.50,
    bestMetric: overrides.bestMetric ?? 0.75,
    bestExperimentId: overrides.bestExperimentId ?? 'agent-0-exp-3',
    experiments: overrides.experiments ?? [],
    frontier: overrides.frontier ?? [],
  };
}

// ─── extractSwarmFindings Tests ──────────────────────────────────────────────

describe('extractSwarmFindings', () => {
  it('extracts basic swarm info', () => {
    const snapshot = makeSnapshot({
      experiments: [makeExperiment()],
    });

    const findings = extractSwarmFindings(snapshot);

    expect(findings.swarmName).toBe('Test Swarm');
    expect(findings.swarmId).toBe('swarm-test-123');
    expect(findings.metric).toBe('balanced_accuracy');
    expect(findings.higherIsBetter).toBe(true);
    expect(findings.baseline).toBe(0.50);
    expect(findings.bestMetric).toBe(0.75);
    expect(findings.bestDelta).toBe(0.25);
  });

  it('counts experiment outcomes correctly', () => {
    const experiments = [
      makeExperiment({ id: 'exp-1', outcome: 'improvement' }),
      makeExperiment({ id: 'exp-2', outcome: 'improvement' }),
      makeExperiment({ id: 'exp-3', outcome: 'regression', delta: -0.05 }),
      makeExperiment({ id: 'exp-4', outcome: 'neutral', delta: 0.001 }),
      makeExperiment({ id: 'exp-5', outcome: 'error', metricValue: null, delta: null }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));

    expect(findings.totalExperiments).toBe(5);
    expect(findings.improvements).toBe(2);
    expect(findings.regressions).toBe(1);
    expect(findings.errors).toBe(1);
  });

  it('identifies best experiment', () => {
    const experiments = [
      makeExperiment({ id: 'agent-0-exp-1', metricValue: 0.60, delta: 0.10 }),
      makeExperiment({ id: 'agent-0-exp-3', metricValue: 0.75, delta: 0.25, commitHash: 'abc123' }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({
      experiments,
      bestExperimentId: 'agent-0-exp-3',
    }));

    expect(findings.bestExperiment).not.toBeNull();
    expect(findings.bestExperiment!.id).toBe('agent-0-exp-3');
    expect(findings.bestExperiment!.metricValue).toBe(0.75);
    expect(findings.bestExperiment!.commitHash).toBe('abc123');
  });

  it('returns null bestExperiment when no best exists', () => {
    const findings = extractSwarmFindings(makeSnapshot({
      bestExperimentId: null,
      experiments: [makeExperiment({ outcome: 'regression', delta: -0.05 })],
    }));

    expect(findings.bestExperiment).toBeNull();
  });

  it('ranks top improvements by delta magnitude', () => {
    const experiments = [
      makeExperiment({ id: 'exp-1', outcome: 'improvement', delta: 0.01, metricValue: 0.51 }),
      makeExperiment({ id: 'exp-2', outcome: 'improvement', delta: 0.10, metricValue: 0.60 }),
      makeExperiment({ id: 'exp-3', outcome: 'improvement', delta: 0.25, metricValue: 0.75 }),
      makeExperiment({ id: 'exp-4', outcome: 'improvement', delta: 0.05, metricValue: 0.55 }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));

    expect(findings.topImprovements.length).toBe(4);
    expect(findings.topImprovements[0].id).toBe('exp-3'); // largest delta first
    expect(findings.topImprovements[1].id).toBe('exp-2');
  });

  it('limits top improvements to 5', () => {
    const experiments = Array.from({ length: 8 }, (_, i) =>
      makeExperiment({
        id: `exp-${i}`,
        outcome: 'improvement',
        delta: 0.01 * (i + 1),
        metricValue: 0.50 + 0.01 * (i + 1),
      })
    );

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));
    expect(findings.topImprovements.length).toBe(5);
  });

  it('collects failed approaches (regressions + errors)', () => {
    const experiments = [
      makeExperiment({ id: 'exp-1', outcome: 'regression', hypothesis: 'Try ReLU', delta: -0.05 }),
      makeExperiment({ id: 'exp-2', outcome: 'error', hypothesis: 'Try GELU', metricValue: null, delta: null }),
      makeExperiment({ id: 'exp-3', outcome: 'improvement', hypothesis: 'Try Swish', delta: 0.10 }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));

    expect(findings.failedApproaches.length).toBe(2);
    expect(findings.failedApproaches[0].hypothesis).toBe('Try ReLU');
    expect(findings.failedApproaches[1].hypothesis).toBe('Try GELU');
  });

  it('limits failed approaches to 10', () => {
    const experiments = Array.from({ length: 15 }, (_, i) =>
      makeExperiment({ id: `exp-${i}`, outcome: 'regression', delta: -0.01 })
    );

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));
    expect(findings.failedApproaches.length).toBe(10);
  });

  it('generates per-agent summaries', () => {
    const experiments = [
      makeExperiment({ id: 'a0-1', agentIndex: 0, outcome: 'improvement' }),
      makeExperiment({ id: 'a0-2', agentIndex: 0, outcome: 'regression' }),
      makeExperiment({ id: 'a1-1', agentIndex: 1, outcome: 'improvement' }),
      makeExperiment({ id: 'a1-2', agentIndex: 1, outcome: 'improvement' }),
      makeExperiment({ id: 'a1-3', agentIndex: 1, outcome: 'neutral' }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));

    expect(findings.agentSummaries.length).toBe(2);
    expect(findings.agentSummaries[0].focus).toBe('hyperparameter tuning');
    expect(findings.agentSummaries[0].experiments).toBe(2);
    expect(findings.agentSummaries[0].improvements).toBe(1);
    expect(findings.agentSummaries[1].experiments).toBe(3);
    expect(findings.agentSummaries[1].improvements).toBe(2);
  });

  it('detects agent convergence (3+ consecutive non-improving)', () => {
    const experiments = [
      makeExperiment({ id: 'a0-1', agentIndex: 0, outcome: 'improvement' }),
      makeExperiment({ id: 'a0-2', agentIndex: 0, outcome: 'regression' }),
      makeExperiment({ id: 'a0-3', agentIndex: 0, outcome: 'regression' }),
      makeExperiment({ id: 'a0-4', agentIndex: 0, outcome: 'neutral' }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));

    expect(findings.agentSummaries[0].converged).toBe(true);
    expect(findings.agentSummaries[0].convergenceReason).toContain('consecutive non-improving');
  });

  it('handles empty experiments', () => {
    const findings = extractSwarmFindings(makeSnapshot({ experiments: [] }));

    expect(findings.totalExperiments).toBe(0);
    expect(findings.improvements).toBe(0);
    expect(findings.bestExperiment).toBeNull();
    expect(findings.topImprovements).toEqual([]);
    expect(findings.failedApproaches).toEqual([]);
    expect(findings.surprises).toEqual([]);
  });

  it('handles null baseline and bestMetric', () => {
    const snapshot: SwarmSnapshot = {
      config: makeConfig(),
      baseline: null,
      bestMetric: null,
      bestExperimentId: null,
      experiments: [],
      frontier: [],
    };

    const findings = extractSwarmFindings(snapshot);

    expect(findings.baseline).toBeNull();
    expect(findings.bestMetric).toBeNull();
    expect(findings.bestDelta).toBeNull();
  });

  it('handles all-error experiments', () => {
    const experiments = Array.from({ length: 5 }, (_, i) =>
      makeExperiment({
        id: `exp-${i}`,
        outcome: 'error',
        metricValue: null,
        delta: null,
      })
    );

    const findings = extractSwarmFindings(makeSnapshot({
      experiments,
      bestExperimentId: null,
      bestMetric: null,
    }));

    expect(findings.errors).toBe(5);
    expect(findings.improvements).toBe(0);
    expect(findings.bestExperiment).toBeNull();
    expect(findings.surprises).toEqual([]);
  });
});

// ─── detectSurprises Tests ──────────────────────────────────────────────────

describe('extractSwarmFindings surprises', () => {
  it('detects large unexpected improvements', () => {
    const experiments = [
      makeExperiment({ id: 'exp-1', outcome: 'improvement', delta: 0.01, metricValue: 0.51 }),
      makeExperiment({ id: 'exp-2', outcome: 'improvement', delta: 0.02, metricValue: 0.52 }),
      makeExperiment({ id: 'exp-3', outcome: 'regression', delta: -0.01, metricValue: 0.49 }),
      makeExperiment({ id: 'exp-4', outcome: 'regression', delta: -0.02, metricValue: 0.48 }),
      makeExperiment({ id: 'exp-5', outcome: 'improvement', delta: 0.50, metricValue: 1.00 }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));

    // exp-5 has a delta way above Q3 — should be flagged
    expect(findings.surprises.length).toBeGreaterThan(0);
    const surprise = findings.surprises.find(s => s.id === 'exp-5');
    expect(surprise).toBeDefined();
    expect(surprise!.why).toContain('Unexpectedly large improvement');
  });

  it('requires at least 4 experiments for surprise detection', () => {
    const experiments = [
      makeExperiment({ id: 'exp-1', outcome: 'improvement', delta: 0.50, metricValue: 1.00 }),
    ];

    const findings = extractSwarmFindings(makeSnapshot({ experiments }));
    expect(findings.surprises).toEqual([]);
  });
});

// ─── generateMemoryContent Tests ────────────────────────────────────────────

describe('generateMemoryContent', () => {
  function makeFindings(overrides: Partial<SwarmFindings> = {}): SwarmFindings {
    return {
      swarmName: 'BIR Sleep Quality',
      swarmId: 'swarm-123',
      completedAt: '2026-03-26T15:00:00Z',
      metric: 'balanced_accuracy',
      higherIsBetter: true,
      baseline: 0.510,
      bestMetric: 0.559,
      bestDelta: 0.049,
      totalExperiments: 12,
      improvements: 4,
      regressions: 5,
      errors: 3,
      bestExperiment: {
        id: 'agent-0-exp-5',
        hypothesis: 'XGBoost with BIR features + PCA reduction',
        changes: ['model.py:42 — changed classifier', 'features.py:18 — added PCA'],
        metricValue: 0.559,
        commitHash: 'abc123',
      },
      topImprovements: [
        { id: 'agent-0-exp-5', hypothesis: 'XGBoost + PCA', metricValue: 0.559, delta: 0.049 },
        { id: 'agent-1-exp-2', hypothesis: 'Feature selection', metricValue: 0.540, delta: 0.030 },
      ],
      failedApproaches: [
        { id: 'agent-0-exp-1', hypothesis: 'Raw sensor only', outcome: 'regression', metricValue: 0.490, delta: -0.020 },
      ],
      surprises: [
        { id: 'agent-1-exp-3', hypothesis: 'Remove sleep debt', why: 'Unexpectedly large regression (Δ-0.0800)', metricValue: 0.430, delta: -0.080 },
      ],
      agentSummaries: [
        { index: 0, focus: 'model selection', experiments: 6, improvements: 2, converged: true, convergenceReason: '3 consecutive non-improving' },
        { index: 1, focus: 'feature engineering', experiments: 6, improvements: 2, converged: false, convergenceReason: 'still active' },
      ],
      ...overrides,
    };
  }

  it('generates valid frontmatter', () => {
    const content = generateMemoryContent(makeFindings(), 'LLM summary here');

    expect(content).toContain('---');
    expect(content).toContain('name: swarm-bir-sleep-quality-results');
    expect(content).toContain('type: project');
    expect(content).toContain('balanced_accuracy 0.51 → 0.559');
  });

  it('includes best configuration section', () => {
    const content = generateMemoryContent(makeFindings(), '');

    expect(content).toContain('### Best Configuration Found');
    expect(content).toContain('agent-0-exp-5');
    expect(content).toContain('XGBoost with BIR features + PCA reduction');
    expect(content).toContain('abc123');
  });

  it('includes top improvements', () => {
    const content = generateMemoryContent(makeFindings(), '');

    expect(content).toContain('### Top Improvements');
    expect(content).toContain('XGBoost + PCA');
    expect(content).toContain('Feature selection');
  });

  it('includes failed approaches', () => {
    const content = generateMemoryContent(makeFindings(), '');

    expect(content).toContain('### Failed Approaches');
    expect(content).toContain('Raw sensor only');
    expect(content).toContain('regression');
  });

  it('includes surprising findings', () => {
    const content = generateMemoryContent(makeFindings(), '');

    expect(content).toContain('### Surprising Findings');
    expect(content).toContain('Remove sleep debt');
    expect(content).toContain('Unexpectedly large regression');
  });

  it('includes per-agent performance', () => {
    const content = generateMemoryContent(makeFindings(), '');

    expect(content).toContain('### Per-Agent Performance');
    expect(content).toContain('model selection');
    expect(content).toContain('feature engineering');
    expect(content).toContain('3 consecutive non-improving');
  });

  it('includes LLM analysis when provided', () => {
    const content = generateMemoryContent(makeFindings(), 'The best strategy was XGBoost with PCA.');

    expect(content).toContain('### Analysis');
    expect(content).toContain('The best strategy was XGBoost with PCA.');
  });

  it('omits analysis section when LLM summary is empty', () => {
    const content = generateMemoryContent(makeFindings(), '');

    expect(content).not.toContain('### Analysis');
  });

  it('handles findings with no improvements', () => {
    const findings = makeFindings({
      bestExperiment: null,
      topImprovements: [],
      improvements: 0,
      bestMetric: null,
      bestDelta: null,
    });

    const content = generateMemoryContent(findings, '');

    expect(content).toContain('balanced_accuracy — no improvement');
    expect(content).not.toContain('### Best Configuration Found');
    expect(content).not.toContain('### Top Improvements');
  });

  it('handles findings with no failed approaches', () => {
    const findings = makeFindings({ failedApproaches: [] });
    const content = generateMemoryContent(findings, '');

    expect(content).not.toContain('### Failed Approaches');
  });
});

// ─── writeToAgentMemory Tests ───────────────────────────────────────────────

describe('writeToAgentMemory', () => {
  let tempHome: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tempHome = createTempDir();
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  function makeFindings(overrides: Partial<SwarmFindings> = {}): SwarmFindings {
    return {
      swarmName: 'Test Optimization',
      swarmId: 'swarm-test',
      completedAt: '2026-03-26T15:00:00Z',
      metric: 'accuracy',
      higherIsBetter: true,
      baseline: 0.50,
      bestMetric: 0.75,
      bestDelta: 0.25,
      totalExperiments: 5,
      improvements: 2,
      regressions: 2,
      errors: 1,
      bestExperiment: null,
      topImprovements: [],
      failedApproaches: [],
      surprises: [],
      agentSummaries: [],
      ...overrides,
    };
  }

  it('creates memory file in agent directory', () => {
    const findings = makeFindings();
    const content = '# Test memory content';

    const filepath = writeToAgentMemory('lead-engineer', findings, content);

    expect(existsSync(filepath)).toBe(true);
    expect(filepath).toContain('.aos/agents/lead-engineer/memory/swarm-test-optimization-results.md');
    expect(readFileSync(filepath, 'utf-8')).toBe(content);
  });

  it('creates memory directory if it does not exist', () => {
    const memoryDir = join(tempHome, '.aos', 'agents', 'cto', 'memory');
    expect(existsSync(memoryDir)).toBe(false);

    writeToAgentMemory('cto', makeFindings(), 'content');

    expect(existsSync(memoryDir)).toBe(true);
  });

  it('appends entry to MEMORY.md index', () => {
    const indexPath = join(tempHome, '.aos', 'agents', 'lead-engineer', 'MEMORY.md');
    mkdirSync(join(tempHome, '.aos', 'agents', 'lead-engineer'), { recursive: true });
    writeFileSync(indexPath, '# Memory Index\n\n- `memory/existing.md` — Some existing memory\n');

    writeToAgentMemory('lead-engineer', makeFindings(), 'content');

    const index = readFileSync(indexPath, 'utf-8');
    expect(index).toContain('memory/existing.md');
    expect(index).toContain('swarm-test-optimization-results.md');
    expect(index).toContain('accuracy 0.5 → 0.75');
  });

  it('creates MEMORY.md if it does not exist', () => {
    const indexPath = join(tempHome, '.aos', 'agents', 'cto', 'MEMORY.md');

    writeToAgentMemory('cto', makeFindings(), 'content');

    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, 'utf-8');
    expect(index).toContain('swarm-test-optimization-results.md');
  });

  it('updates existing index entry instead of duplicating', () => {
    const indexPath = join(tempHome, '.aos', 'agents', 'lead-engineer', 'MEMORY.md');
    mkdirSync(join(tempHome, '.aos', 'agents', 'lead-engineer'), { recursive: true });
    writeFileSync(indexPath, '- `memory/swarm-test-optimization-results.md` — old entry\n');

    writeToAgentMemory('lead-engineer', makeFindings(), 'updated content');

    const index = readFileSync(indexPath, 'utf-8');
    // Should have exactly one entry for this swarm, not two
    const matches = index.match(/swarm-test-optimization-results/g);
    expect(matches?.length).toBe(1);
    // Should have updated content
    expect(index).toContain('accuracy 0.5 → 0.75');
    expect(index).not.toContain('old entry');
  });

  it('generates correct slug from swarm name with special characters', () => {
    const findings = makeFindings({ swarmName: 'BIR Sleep Quality (v2)' });
    const filepath = writeToAgentMemory('cto', findings, 'content');

    expect(filepath).toContain('swarm-bir-sleep-quality-v2-results.md');
  });
});
