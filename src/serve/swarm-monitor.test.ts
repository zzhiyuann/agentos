import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Mocks ──────────────────────────────────────────────────────────────

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  listSessionsByPrefix: vi.fn(() => []),
}));

vi.mock('./helpers.js', () => ({
  postToGroupChat: vi.fn(async () => true),
}));

vi.mock('../core/linear.js', () => ({
  addComment: vi.fn(async () => {}),
  getIssue: vi.fn(async () => ({ id: 'issue-uuid', title: 'Test', labels: [], state: 'In Progress' })),
}));

vi.mock('../core/swarm-coordinator.js', async () => {
  const actual = await vi.importActual<typeof import('../core/swarm-coordinator.js')>('../core/swarm-coordinator.js');
  return {
    ...actual,
    stopSwarm: vi.fn(),
  };
});

import {
  monitorSwarms,
  registerSwarm,
  unregisterSwarm,
  getSwarmDashboardData,
  _resetTrackedSwarms,
  _getTrackedSwarm,
} from './swarm-monitor.js';
import { sessionExists, listSessionsByPrefix } from '../core/tmux.js';
import { postToGroupChat } from './helpers.js';
import { addComment } from '../core/linear.js';
import { stopSwarm } from '../core/swarm-coordinator.js';
import { SwarmStateManager } from '../core/swarm-state.js';

// ─── Test Helpers ───────────────────────────────────────────────────────

const TEST_WORKSPACE = '/tmp/aos-swarm-monitor-test';
const SWARM_DIR = join(TEST_WORKSPACE, '.swarm');

function createTestSwarm(overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(SWARM_DIR, 'experiments'), { recursive: true });
  mkdirSync(join(SWARM_DIR, 'locks'), { recursive: true });

  const config = {
    id: 'swarm-test-123',
    name: 'Test Swarm',
    metric: 'accuracy',
    higherIsBetter: true,
    evalCommand: 'echo 0.85',
    targetFiles: ['model.py'],
    agentCount: 2,
    maxExperimentsPerAgent: 10,
    budgetMinutes: 0,
    directions: [
      { agentIndex: 0, focus: 'architecture', constraints: [] },
      { agentIndex: 1, focus: 'hyperparameters', constraints: [] },
    ],
    workspacePath: TEST_WORKSPACE,
    createdAt: new Date().toISOString(),
    status: 'running',
    ...overrides,
  };

  writeFileSync(join(SWARM_DIR, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(SWARM_DIR, 'best.json'), JSON.stringify({
    baseline: 0.80,
    bestMetric: 0.80,
    bestExperimentId: null,
  }));
  writeFileSync(join(SWARM_DIR, 'frontier.json'), JSON.stringify(['idea1', 'idea2']));
  writeFileSync(join(SWARM_DIR, 'experiment-log.md'), '# Experiment Log\n\n');
}

function addExperiment(id: string, agentIndex: number, outcome: string, metricValue: number): void {
  const exp = {
    id,
    agentIndex,
    hypothesis: `Test hypothesis for ${id}`,
    changes: ['model.py:10'],
    metricValue,
    delta: metricValue - 0.80,
    outcome,
    durationSeconds: 60,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(SWARM_DIR, 'experiments', `${id}.json`), JSON.stringify(exp, null, 2));
}

// ─── Setup / Teardown ──────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetTrackedSwarms();

  // Clean up test workspace
  if (existsSync(TEST_WORKSPACE)) {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }

  // Reset registry
  const registryPath = join(process.env.HOME || '/tmp', '.aos', 'swarm-registry.json');
  if (existsSync(registryPath)) {
    writeFileSync(registryPath, '[]');
  }
});

afterEach(() => {
  if (existsSync(TEST_WORKSPACE)) {
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('registerSwarm / unregisterSwarm', () => {
  it('registers and unregisters a swarm workspace', () => {
    registerSwarm('/tmp/test-ws', 'ENG-42', 'uuid-42');
    // Should be in the registry now — verify via getSwarmDashboardData (no swarm dir, so empty)
    unregisterSwarm('/tmp/test-ws');
    // No error means success
  });

  it('updates existing registration with new issue info', () => {
    registerSwarm('/tmp/test-ws');
    registerSwarm('/tmp/test-ws', 'ENG-99', 'uuid-99');
    // Should not create duplicates — no error
  });
});

describe('monitorSwarms', () => {
  it('does nothing when no swarms registered', async () => {
    await monitorSwarms();
    expect(postToGroupChat).not.toHaveBeenCalled();
  });

  it('initializes tracking on first scan without triggering notifications', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    await monitorSwarms();

    // First scan should not notify
    expect(postToGroupChat).not.toHaveBeenCalled();
    // But should be tracked
    expect(_getTrackedSwarm(TEST_WORKSPACE)).toBeDefined();
  });

  it('detects new experiments and notifies on improvements', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    // First scan — initialize tracking
    await monitorSwarms();
    expect(postToGroupChat).not.toHaveBeenCalled();

    // Add an improvement experiment
    addExperiment('agent-0-exp-1', 0, 'improvement', 0.85);

    // Second scan — should detect and notify
    await monitorSwarms();
    expect(postToGroupChat).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('improvement'),
    );
  });

  it('does not notify on neutral/regression experiments (only logs)', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    await monitorSwarms();

    // Add a regression
    addExperiment('agent-0-exp-1', 0, 'regression', 0.75);

    await monitorSwarms();
    // Should NOT post to group chat for regressions (only improvements)
    expect(postToGroupChat).not.toHaveBeenCalled();
  });

  it('detects stall and notifies', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    // First scan
    await monitorSwarms();

    // Manually set the lastExperimentTime way back
    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.lastExperimentTime = Date.now() - 20 * 60_000; // 20 minutes ago

    await monitorSwarms();
    expect(postToGroupChat).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('stalled'),
    );
  });

  it('does not notify stall twice', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    await monitorSwarms();

    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.lastExperimentTime = Date.now() - 20 * 60_000;

    await monitorSwarms();
    expect(postToGroupChat).toHaveBeenCalledTimes(1);

    // Second call should not notify again
    await monitorSwarms();
    expect(postToGroupChat).toHaveBeenCalledTimes(1);
  });

  it('resets stall flag on new experiment', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    await monitorSwarms();

    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.lastExperimentTime = Date.now() - 20 * 60_000;

    await monitorSwarms();
    expect(tracked.stallNotified).toBe(true);

    // Add a new experiment
    addExperiment('agent-0-exp-1', 0, 'neutral', 0.80);

    await monitorSwarms();
    expect(tracked.stallNotified).toBe(false);
  });

  it('auto-stops swarm when all agents dead for grace period', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);
    vi.mocked(listSessionsByPrefix).mockReturnValue([]);

    // First scan — initialize
    await monitorSwarms();

    // Set allDeadSince to trigger auto-stop
    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.allDeadSince = Date.now() - 120_000; // 2 min ago (> 60s grace)

    await monitorSwarms();

    expect(stopSwarm).toHaveBeenCalledWith(TEST_WORKSPACE);
    expect(postToGroupChat).toHaveBeenCalledWith(
      'system',
      expect.stringContaining('completed'),
    );
  });

  it('does not auto-stop when agents are still alive', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);
    vi.mocked(listSessionsByPrefix).mockReturnValue(['aos-swarm-test-123-agent-0']);

    await monitorSwarms();
    await monitorSwarms();

    expect(stopSwarm).not.toHaveBeenCalled();
    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    expect(tracked.allDeadSince).toBeNull();
  });

  it('posts progress comment on parent issue when experiments accumulate', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE, 'ENG-42', 'issue-uuid-42');

    // First scan
    await monitorSwarms();

    // Add experiments
    addExperiment('agent-0-exp-1', 0, 'improvement', 0.85);

    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.lastProgressCommentTime = 0; // Force comment by resetting timer

    await monitorSwarms();

    expect(addComment).toHaveBeenCalledWith(
      'issue-uuid-42',
      expect.stringContaining('Swarm Progress Update'),
    );
  });

  it('skips stopped swarms', async () => {
    createTestSwarm({ status: 'stopped' });
    registerSwarm(TEST_WORKSPACE);

    await monitorSwarms();
    expect(_getTrackedSwarm(TEST_WORKSPACE)).toBeUndefined();
  });

  it('cleans up registry when .swarm/ directory is deleted', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    await monitorSwarms();
    expect(_getTrackedSwarm(TEST_WORKSPACE)).toBeDefined();

    // Delete .swarm directory
    rmSync(SWARM_DIR, { recursive: true, force: true });

    await monitorSwarms();
    // Tracked state should be cleaned up
    expect(_getTrackedSwarm(TEST_WORKSPACE)).toBeUndefined();
  });
});

describe('getSwarmDashboardData', () => {
  it('returns empty array when no swarms registered', () => {
    expect(getSwarmDashboardData()).toEqual([]);
  });

  it('returns swarm data for active swarms', () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE);

    addExperiment('agent-0-exp-1', 0, 'improvement', 0.85);

    const data = getSwarmDashboardData();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Test Swarm');
    expect(data[0].metric).toBe('accuracy');
    expect(data[0].baseline).toBe(0.80);
    expect(data[0].totalExperiments).toBe(1);
    expect(data[0].agents).toHaveLength(2);
    expect(data[0].agents[0].focus).toBe('architecture');
    expect(data[0].recentExperiments).toHaveLength(1);
  });

  it('excludes stopped swarms', () => {
    createTestSwarm({ status: 'stopped' });
    registerSwarm(TEST_WORKSPACE);

    const data = getSwarmDashboardData();
    expect(data).toHaveLength(0);
  });
});

describe('stall notification includes parent issue comment', () => {
  it('posts stall warning to parent issue', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE, 'ENG-42', 'issue-uuid-42');

    await monitorSwarms();

    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.lastExperimentTime = Date.now() - 20 * 60_000;

    await monitorSwarms();

    // Should post to both group chat AND parent issue
    expect(postToGroupChat).toHaveBeenCalledWith('system', expect.stringContaining('stalled'));
    expect(addComment).toHaveBeenCalledWith(
      'issue-uuid-42',
      expect.stringContaining('Swarm stalled'),
    );
  });
});

describe('completion notification includes parent issue comment', () => {
  it('posts completion report to parent issue', async () => {
    createTestSwarm();
    registerSwarm(TEST_WORKSPACE, 'ENG-42', 'issue-uuid-42');
    vi.mocked(listSessionsByPrefix).mockReturnValue([]);

    await monitorSwarms();

    const tracked = _getTrackedSwarm(TEST_WORKSPACE)!;
    tracked.allDeadSince = Date.now() - 120_000;

    await monitorSwarms();

    expect(addComment).toHaveBeenCalledWith(
      'issue-uuid-42',
      expect.stringContaining('Swarm Completed'),
    );
  });
});
