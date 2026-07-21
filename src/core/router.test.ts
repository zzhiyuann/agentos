import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAgentRegistry, resolveAgentType, resolveAgentRole, getAgentDefinition, canSpawnAgent } from './router.js';
import type { LinearIssueInfo } from '../types.js';

const hasLocalEnv = existsSync(join(homedir(), '.aos', 'agents'));
const describeLocal = hasLocalEnv ? describe : describe.skip;

const TEST_ENV = {
  AOS_LINEAR_TEAM_ID: 'test-team-uuid',
  AOS_LINEAR_TEAM_KEY: 'TST',
  AOS_HOST: '10.0.0.1',
  AOS_USER: 'testuser',
};

function makeIssue(labels: string[] = [], title = 'Test issue', project?: string): LinearIssueInfo {
  return {
    id: 'test-id',
    identifier: 'TST-999',
    title,
    description: undefined,
    priority: 2,
    labels,
    state: 'Todo',
    url: 'https://linear.app/test',
    project,
  };
}

describeLocal('getAgentRegistry', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, val] of Object.entries(TEST_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = val;
    }
  });

  afterEach(() => {
    for (const [key] of Object.entries(TEST_ENV)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('returns registry with cc and codex', () => {
    const registry = getAgentRegistry();
    expect(registry.cc).toBeDefined();
    expect(registry.codex).toBeDefined();
  });

  it('cc has correct properties', () => {
    const registry = getAgentRegistry();
    const cc = registry.cc;
    expect(cc.label).toBe('agent:cc');
    expect(cc.maxConcurrent).toBeGreaterThan(0);
    expect(cc.capabilities).toContain('code');
    expect(cc.host).toBe('10.0.0.1');
  });
});

describeLocal('resolveAgentRole', () => {
  it('routes label:ops to coo', () => {
    const issue = makeIssue(['ops']);
    expect(resolveAgentRole(issue)).toBe('coo');
  });

  it('routes label:qa to cto (QA absorbed per RYA-150)', () => {
    const issue = makeIssue(['qa']);
    expect(resolveAgentRole(issue)).toBe('cto');
  });

  it('routes AgentOS project to cto', () => {
    const issue = makeIssue([], 'Test', 'AgentOS');
    expect(resolveAgentRole(issue)).toBe('cto');
  });

  it('defaults to lead-engineer when no match', () => {
    const issue = makeIssue([]);
    expect(resolveAgentRole(issue)).toBe('lead-engineer');
  });
});

describeLocal('resolveAgentType', () => {
  it('resolves agent:cc label to cc', () => {
    const issue = makeIssue(['agent:cc']);
    const result = resolveAgentType(issue);
    expect(result).toBe('cc');
  });

  it('resolves agent:codex label to codex', () => {
    const issue = makeIssue(['agent:codex']);
    const result = resolveAgentType(issue);
    expect(result).toBe('codex');
  });

  it('resolves default (lead-engineer) to cc baseModel', () => {
    const issue = makeIssue([]);
    const result = resolveAgentType(issue);
    expect(result).toBe('cc'); // lead-engineer's baseModel (switched from codex)
  });

  it('resolves AgentOS project (cto) to cc baseModel', () => {
    const issue = makeIssue([], 'Test', 'AgentOS');
    const result = resolveAgentType(issue);
    expect(result).toBe('cc'); // cto's baseModel
  });
});

describeLocal('getAgentDefinition', () => {
  it('returns definition for known agent type', () => {
    const def = getAgentDefinition('cc');
    expect(def.label).toBe('agent:cc');
    expect(def.command).toContain('claude');
    expect(typeof def.maxConcurrent).toBe('number');
  });

  it('returns definition for codex', () => {
    const def = getAgentDefinition('codex');
    expect(def.label).toBe('agent:codex');
    expect(def.command).toContain('codex');
  });

  it('throws for unknown agent type', () => {
    expect(() => getAgentDefinition('nonexistent')).toThrow('Unknown agent type');
  });
});

describeLocal('canSpawnAgent', () => {
  it('returns allowed when capacity available', () => {
    const result = canSpawnAgent('cc');
    expect(typeof result.allowed).toBe('boolean');
    if (!result.allowed) {
      expect(result.reason).toBeDefined();
    }
  });
});
