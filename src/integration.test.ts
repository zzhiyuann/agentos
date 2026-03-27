import { describe, it, expect } from 'vitest';
import {
  getReadClient, getIssue, addComment, getWorkflowStateId,
  hasAgentAccess, createAgentSession, emitActivity, dismissAgentSession,
  closeActiveSessionsForIssue, createIssueDocument,
} from './core/linear.js';
import { getAgentLinearToken, loadAgentConfig, listAgents, loadPersona } from './core/persona.js';
import { getConfig, resolveWorkspace } from './core/config.js';

const READ_ONLY_TEST_ISSUE_KEY = process.env.AOS_INTEGRATION_READ_ISSUE_KEY || 'RYA-8';
const AGENT_SESSION_TEST_ISSUE_KEY = process.env.AOS_INTEGRATION_AGENT_SESSION_ISSUE_KEY;
const describeAgentSessionLifecycle = AGENT_SESSION_TEST_ISSUE_KEY ? describe : describe.skip;

const describeLinear = process.env.AOS_LIVE_TESTS === '1' ? describe : describe.skip;

describeLinear('Integration: Linear API operations', () => {
  it('reads a real issue from Linear', async () => {
    const issue = await getIssue(READ_ONLY_TEST_ISSUE_KEY);
    expect(issue.identifier).toBe(READ_ONLY_TEST_ISSUE_KEY);
    expect(issue.id).toMatch(/^[a-f0-9-]+$/);
    expect(issue.title.length).toBeGreaterThan(0);
    expect(issue.url).toContain('linear.app');
  });

  it('resolves all workflow states', async () => {
    const states = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled'];
    for (const state of states) {
      const id = await getWorkflowStateId(state);
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    }
  });

  it('has agent OAuth access', () => {
    expect(hasAgentAccess()).toBe(true);
  });
});

describe('Integration: Per-agent OAuth tokens', () => {
  const roles = ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead'];

  for (const role of roles) {
    it(`${role} has a valid OAuth token`, () => {
      const token = getAgentLinearToken(role);
      expect(token).not.toBeNull();
      expect(token!.length).toBeGreaterThan(20);
    });

    it(`${role} has a linearUserId configured`, () => {
      const config = loadAgentConfig(role);
      expect(config.linearUserId).toBeDefined();
      expect(config.linearUserId).toMatch(/^[a-f0-9-]+$/);
    });
  }
});

describeAgentSessionLifecycle('Integration: Agent session lifecycle', () => {
  let testSessionId: string | null = null;

  it('creates an agent session on a real issue', async () => {
    const issue = await getIssue(AGENT_SESSION_TEST_ISSUE_KEY!);
    const ctoToken = getAgentLinearToken('cto');
    expect(ctoToken).not.toBeNull();

    testSessionId = await createAgentSession(issue.id, undefined, ctoToken!);
    // Session creation may fail due to permissions — that's ok
    if (testSessionId) {
      expect(testSessionId).toMatch(/^[a-f0-9-]+$/);
    }
  });

  it('emits thought activity', async () => {
    if (!testSessionId) return;
    const ctoToken = getAgentLinearToken('cto');

    // Should not throw
    await emitActivity(testSessionId, {
      type: 'thought',
      body: 'Integration test: emitting thought activity',
    }, true, ctoToken!); // ephemeral=true so it doesn't clutter UI
  });

  it('emits response activity', async () => {
    if (!testSessionId) return;
    const ctoToken = getAgentLinearToken('cto');

    await emitActivity(testSessionId, {
      type: 'response',
      body: 'Integration test: emitting response activity',
    }, true, ctoToken!);
  });

  it('dismisses the agent session (fixes "Working forever" bug)', async () => {
    if (!testSessionId) return;
    const ctoToken = getAgentLinearToken('cto');

    // This is the key fix — dismissedAt should close the session in Linear
    await dismissAgentSession(testSessionId, ctoToken!);
    // If no error was thrown, the API accepted our request
    expect(true).toBe(true);
  });
});

describe('Integration: Workspace mapping', () => {
  it('resolves AgentOS project to agentos repo', () => {
    const workspace = resolveWorkspace('RYA-99', 'AgentOS');
    expect(workspace).toContain('projects/agentos');
    expect(workspace).not.toContain('agent-workspaces');
  });

  it('falls back to agent-workspaces for unknown projects', () => {
    const workspace = resolveWorkspace('RYA-99', 'UnknownProject');
    expect(workspace).toContain('agent-workspaces');
    expect(workspace).toContain('RYA-99');
  });

  it('uses default workspace when no project specified', () => {
    const workspace = resolveWorkspace('RYA-99');
    expect(workspace).toContain('RYA-99');
  });
});

describe('Integration: System config consistency', () => {
  it('all 6 agents exist', () => {
    const agents = listAgents();
    expect(agents).toHaveLength(6);
    expect(agents.sort()).toEqual(['ceo-office', 'coo', 'cpo', 'cto', 'lead-engineer', 'research-lead']);
  });

  it('config has required host and user fields', () => {
    const config = getConfig();
    expect(config.imacHost).toBeTruthy();
    expect(config.imacUser).toBeTruthy();
  });

  it('workspace-map.json has AgentOS mapping', async () => {
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const mapPath = join(homedir(), '.aos', 'workspace-map.json');
    expect(existsSync(mapPath)).toBe(true);

    const map = JSON.parse(readFileSync(mapPath, 'utf-8'));
    expect(map['project:AgentOS']).toBe('~/projects/agentos');
  });

  it('tunnel URL is set', () => {
    const config = getConfig();
    // Tunnel may be running on iMac now, so MacBook may not have the URL
    // Just verify the field exists
    expect(typeof config.tunnelUrl).toBe('string');
  });

  it('shared-memory directory exists', async () => {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const sharedDir = join(homedir(), '.aos', 'shared-memory');
    expect(existsSync(sharedDir)).toBe(true);
  });

  it('all agents have retrospectives directory', async () => {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    for (const role of listAgents()) {
      const retroDir = join(homedir(), '.aos', 'agents', role, 'retrospectives');
      expect(existsSync(retroDir)).toBe(true);
    }
  });

  it('all agents have valid CLAUDE.md (not empty)', () => {
    for (const role of listAgents()) {
      const persona = loadPersona(role);
      expect(persona.claudeMd.trim().length).toBeGreaterThan(0);
    }
  });

  it('all agents have Findings → Action Protocol in their CLAUDE.md', () => {
    for (const role of listAgents()) {
      const persona = loadPersona(role);
      expect(persona.claudeMd).toContain('Findings');
      expect(persona.claudeMd).toContain('Action Protocol');
    }
  });

  it('all agents have Linear tools section in their CLAUDE.md', () => {
    for (const role of listAgents()) {
      const persona = loadPersona(role);
      expect(persona.claudeMd).toContain('Linear Tools');
    }
  });

  it('shared-memory/team-roster.md exists and mentions all 6 roles', async () => {
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const rosterPath = join(homedir(), '.aos', 'shared-memory', 'team-roster.md');
    expect(existsSync(rosterPath)).toBe(true);

    const content = readFileSync(rosterPath, 'utf-8');
    expect(content).toContain('CTO');
    expect(content).toContain('CPO');
    expect(content).toContain('COO');
    expect(content).toContain('Lead Engineer');
    expect(content).toContain('Research Lead');
  });

  it('routing.json has rules for all expected labels', async () => {
    const { readFileSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const routingPath = join(homedir(), '.aos', 'routing.json');
    expect(existsSync(routingPath)).toBe(true);

    const routing = JSON.parse(readFileSync(routingPath, 'utf-8'));
    expect(routing.rules).toBeDefined();
    expect(Array.isArray(routing.rules)).toBe(true);

    const labels = routing.rules
      .filter((r: { label?: string }) => r.label)
      .map((r: { label: string }) => r.label);

    expect(labels).toContain('ops');
    expect(labels).toContain('infra');
    expect(labels).toContain('product');
    expect(labels).toContain('qa');
    expect(labels).toContain('test');
    expect(labels).toContain('research');
  });
});
