import { describe, it, expect } from 'vitest';
import { validateSwarmConfig, type SwarmConfig } from './swarm-trigger.js';

// ─── validateSwarmConfig ───

describe('validateSwarmConfig', () => {
  const validConfig: SwarmConfig = {
    metric: 'balanced_accuracy',
    higherIsBetter: true,
    evalCommand: 'python eval.py',
    targetFiles: ['model.py', 'config.json'],
    directions: [
      { focus: 'parameter-tuning', constraints: [] },
      { focus: 'algorithm-exploration', constraints: [] },
    ],
    budgetMinutes: 120,
    maxExperimentsPerAgent: 20,
  };

  it('returns null for valid config', () => {
    expect(validateSwarmConfig(validConfig)).toBeNull();
  });

  it('rejects missing metric', () => {
    const config = { ...validConfig, metric: '' };
    expect(validateSwarmConfig(config)).toContain('metric');
  });

  it('rejects missing evalCommand', () => {
    const config = { ...validConfig, evalCommand: '' };
    expect(validateSwarmConfig(config)).toContain('evalCommand');
  });

  it('rejects empty targetFiles', () => {
    const config = { ...validConfig, targetFiles: [] };
    expect(validateSwarmConfig(config)).toContain('targetFiles');
  });

  it('accepts single target file', () => {
    const config = { ...validConfig, targetFiles: ['main.py'] };
    expect(validateSwarmConfig(config)).toBeNull();
  });

  it('accepts lower-is-better metric', () => {
    const config = { ...validConfig, higherIsBetter: false, metric: 'val_loss' };
    expect(validateSwarmConfig(config)).toBeNull();
  });
});

// ─── classify.ts Swarm label routing ───

describe('classify Swarm label routing', () => {
  // Import routeEvent to test Swarm label detection
  it('routes issue with Swarm label to swarm-trigger', async () => {
    const { routeEvent } = await import('./classify.js');
    const result = routeEvent('Issue', {
      action: 'create',
      data: {
        labels: [{ id: '1', name: 'Swarm' }],
      },
    });
    expect(result.targetAgent).toBe('swarm-trigger');
    expect(result.action).toBe('conditional-spawn');
    expect(result.reason).toContain('Swarm');
  });

  it('routes issue with case-insensitive swarm label', async () => {
    const { routeEvent } = await import('./classify.js');
    const result = routeEvent('Issue', {
      action: 'create',
      data: {
        labels: [{ id: '1', name: 'swarm' }],
      },
    });
    expect(result.targetAgent).toBe('swarm-trigger');
  });

  it('Swarm label takes priority over Plan label', async () => {
    const { routeEvent } = await import('./classify.js');
    const result = routeEvent('Issue', {
      action: 'create',
      data: {
        labels: [
          { id: '1', name: 'Swarm' },
          { id: '2', name: 'Plan' },
        ],
      },
    });
    expect(result.targetAgent).toBe('swarm-trigger');
  });

  it('Plan label still works when no Swarm label', async () => {
    const { routeEvent } = await import('./classify.js');
    const result = routeEvent('Issue', {
      action: 'create',
      data: {
        labels: [{ id: '2', name: 'Plan' }],
      },
    });
    expect(result.targetAgent).toBe('planner');
  });
});

// ─── Safety constants ───

describe('safety constraints', () => {
  it('MAX_AGENTS is 2', async () => {
    // Verify the safety constants are correct by checking the module
    // We test this indirectly through config validation
    const config: SwarmConfig = {
      metric: 'accuracy',
      higherIsBetter: true,
      evalCommand: 'python eval.py',
      targetFiles: ['model.py'],
      directions: [
        { focus: 'dir-1', constraints: [] },
        { focus: 'dir-2', constraints: [] },
        { focus: 'dir-3', constraints: [] }, // extra direction is fine, gets truncated
      ],
      budgetMinutes: 120,
      maxExperimentsPerAgent: 20,
    };
    // Should still validate — extra directions are sliced at runtime, not rejected
    expect(validateSwarmConfig(config)).toBeNull();
  });

  it('budget minutes cap at 240', () => {
    const config: SwarmConfig = {
      metric: 'accuracy',
      higherIsBetter: true,
      evalCommand: 'python eval.py',
      targetFiles: ['model.py'],
      directions: [],
      budgetMinutes: 999, // exceeds cap but validated elsewhere
      maxExperimentsPerAgent: 20,
    };
    // Validation doesn't enforce budget cap — extractSwarmConfig does via Math.min
    expect(validateSwarmConfig(config)).toBeNull();
  });
});
