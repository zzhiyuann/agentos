import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  listAgents, agentExists, loadPersona, loadAgentConfig,
  getAgentLinearToken, buildGroundingPrompt, buildTaskPrompt,
  buildWorkerPersona, getAgentsDir,
} from './persona.js';

// All persona tests require ~/.aos/agents/ directory with agent configs
const hasDeployedAgents = existsSync(join(homedir(), '.aos', 'agents'));
const describeDeployed = hasDeployedAgents ? describe : describe.skip;

describeDeployed('listAgents', () => {
  it('returns array of agent role names', () => {
    const agents = listAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBe(6);
    expect(agents).toContain('ceo-office');
    expect(agents).toContain('cto');
    expect(agents).toContain('cpo');
    expect(agents).toContain('coo');
    expect(agents).toContain('lead-engineer');
    expect(agents).toContain('research-lead');
  });
});

describeDeployed('agentExists', () => {
  it('returns true for existing agents', () => {
    expect(agentExists('cto')).toBe(true);
    expect(agentExists('cpo')).toBe(true);
    expect(agentExists('lead-engineer')).toBe(true);
  });

  it('returns false for non-existent agents', () => {
    expect(agentExists('nonexistent')).toBe(false);
    expect(agentExists('worker-999')).toBe(false);
  });
});

describeDeployed('loadAgentConfig', () => {
  it('loads config with baseModel', () => {
    const config = loadAgentConfig('cto');
    expect(config.baseModel).toBe('cc');
    expect(config.linearClientId).toBeDefined();
    expect(config.linearClientSecret).toBeDefined();
  });

  it('loads lead-engineer with cc model', () => {
    const config = loadAgentConfig('lead-engineer');
    expect(config.baseModel).toBe('cc');
  });

  it('includes linearUserId', () => {
    const config = loadAgentConfig('cto');
    expect(config.linearUserId).toBeDefined();
    expect(config.linearUserId).toMatch(/^[a-f0-9-]+$/);
  });

  it('loads research-lead with cc model', () => {
    const config = loadAgentConfig('research-lead');
    expect(config.baseModel).toBe('cc');
  });

  it('loads cpo with cc model', () => {
    const config = loadAgentConfig('cpo');
    expect(config.baseModel).toBe('cc');
  });

  it('returns default config for unknown agent', () => {
    const config = loadAgentConfig('nonexistent');
    expect(config.baseModel).toBe('cc');
  });
});

describeDeployed('getAgentLinearToken', () => {
  it('returns token for agents with OAuth tokens', () => {
    const token = getAgentLinearToken('cto');
    expect(token).not.toBeNull();
    expect(typeof token).toBe('string');
    expect(token!.length).toBeGreaterThan(10);
  });

  it('returns null for non-existent agent', () => {
    const token = getAgentLinearToken('nonexistent');
    expect(token).toBeNull();
  });
});

describeDeployed('loadPersona', () => {
  it('loads full persona for CTO', () => {
    const persona = loadPersona('cto');
    expect(persona.role).toBe('cto');
    expect(persona.claudeMd).toBeTruthy();
    expect(persona.claudeMd).toContain('CTO');
    expect(persona.config.baseModel).toBe('cc');
    expect(Array.isArray(persona.memories)).toBe(true);
  });

  it('throws for non-existent agent', () => {
    expect(() => loadPersona('nonexistent')).toThrow();
  });

  it('loads full persona for Research Lead', () => {
    const persona = loadPersona('research-lead');
    expect(persona.role).toBe('research-lead');
    expect(persona.claudeMd).toBeTruthy();
    expect(persona.claudeMd).toContain('Research Lead');
    expect(persona.config.baseModel).toBe('cc');
    expect(Array.isArray(persona.memories)).toBe(true);
  });

  it('loads full persona for CPO', () => {
    const persona = loadPersona('cpo');
    expect(persona.role).toBe('cpo');
    expect(persona.claudeMd).toBeTruthy();
    expect(persona.claudeMd).toContain('CPO');
    expect(persona.config.baseModel).toBe('cc');
    expect(Array.isArray(persona.memories)).toBe(true);
  });
});

describeDeployed('buildGroundingPrompt', () => {
  it('includes persona CLAUDE.md content', () => {
    const persona = loadPersona('cto');
    const prompt = buildGroundingPrompt(persona);
    expect(prompt).toContain('CTO');
  });

  it('includes memory index if present', () => {
    const persona = loadPersona('cto');
    const prompt = buildGroundingPrompt(persona);
    // Should at minimum include the CLAUDE.md content
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('includes Memory Persistence section for research-lead', () => {
    const persona = loadPersona('research-lead');
    const prompt = buildGroundingPrompt(persona);
    expect(prompt).toContain('Memory Persistence');
  });

  it('includes Memory Persistence section for cpo', () => {
    const persona = loadPersona('cpo');
    const prompt = buildGroundingPrompt(persona);
    expect(prompt).toContain('Memory Persistence');
  });
});

describeDeployed('buildTaskPrompt', () => {
  it('includes issue key and title', () => {
    const prompt = buildTaskPrompt('cto', 'ENG-42', 'Fix the auth bug', 'Users cannot login');
    expect(prompt).toContain('ENG-42');
    expect(prompt).toContain('Fix the auth bug');
    expect(prompt).toContain('Users cannot login');
    expect(prompt).toContain('cto');
  });

  it('works without description', () => {
    const prompt = buildTaskPrompt('cpo', 'ENG-1', 'New feature');
    expect(prompt).toContain('ENG-1');
    expect(prompt).toContain('New feature');
  });
});

describeDeployed('buildWorkerPersona', () => {
  it('creates minimal persona for ephemeral workers', () => {
    const persona = buildWorkerPersona('ENG-99', 'Test task', 'Do something');
    expect(persona).toContain('Worker Agent');
    expect(persona).toContain('ENG-99');
    expect(persona).toContain('Test task');
    expect(persona).toContain('Do something');
    expect(persona).toContain('HANDOFF.md');
  });

  it('works without description', () => {
    const persona = buildWorkerPersona('ENG-1', 'Simple task');
    expect(persona).toContain('ENG-1');
    expect(persona).toContain('Simple task');
  });
});

describe('getAgentsDir', () => {
  it('returns path containing .aos/agents', () => {
    const dir = getAgentsDir();
    expect(dir).toContain('.aos');
    expect(dir).toContain('agents');
  });
});
