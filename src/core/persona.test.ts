import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  listAgents, agentExists, loadPersona, loadAgentConfig,
  getAgentLinearToken, buildGroundingPrompt, buildTaskPrompt,
  buildWorkerPersona, getAgentsDir, getLastGroundingStats,
  loadCommonTemplate, stripTemplateSections, extractSectionHeadings,
  COMMON_TEMPLATE_MARKER,
  type AgentPersona,
} from './persona.js';

/** Synthetic persona for tests — role doesn't exist on disk, so file-based
 *  sections (system memory, mailbox, retros) are absent and tests stay
 *  deterministic regardless of the local ~/.aos state. */
function syntheticPersona(claudeMd = '# Test Agent\n\nYou are a synthetic test agent.'): AgentPersona {
  return {
    role: 'synthetic-test-role',
    claudeMd,
    memoryIndex: '',
    memories: [],
    config: { baseModel: 'cc' },
  };
}

const hasLocalEnv = existsSync(join(homedir(), '.aos', 'agents'));
const describeLocal = hasLocalEnv ? describe : describe.skip;

describeLocal('listAgents', () => {
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

describeLocal('agentExists', () => {
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

describeLocal('loadAgentConfig', () => {
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

describeLocal('getAgentLinearToken', () => {
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

describeLocal('loadPersona', () => {
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

describeLocal('buildGroundingPrompt', () => {
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

describe('grounding prompt layout + budgets (A3.2/A3.3)', () => {
  const bigMem = (name: string, sourceFile: string, chars: number) => ({
    id: name, name, description: `desc for ${name}`, type: null,
    content: 'x'.repeat(chars), source_file: sourceFile, rank: 0,
  });

  it('orders stable sections before volatile ones', () => {
    const persona = syntheticPersona('# Test Agent\n\nUNIQUE_PERSONA_TOKEN');
    const retrieved = [bigMem('mem-a', 'mem-a.md', 100)];
    const prompt = buildGroundingPrompt(persona, 'task', retrieved, 'RYA-1');

    const idxIdentity = prompt.indexOf('CRITICAL: Identity Rules');
    const idxClaudeMd = prompt.indexOf('UNIQUE_PERSONA_TOKEN');
    const idxCommon = prompt.indexOf('## Linear Tools');
    const idxInstructions = prompt.indexOf('## Memory Persistence (MANDATORY)');
    const idxMemOverview = prompt.indexOf('## Memory System');
    const idxRetrieved = prompt.indexOf('## Retrieved Memories');

    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxClaudeMd).toBeGreaterThan(idxIdentity);
    expect(idxCommon).toBeGreaterThan(idxClaudeMd);
    expect(idxInstructions).toBeGreaterThan(idxCommon);
    // Volatile content comes after ALL static instruction blocks
    const idxLastInstruction = prompt.indexOf('## Linking Deliverables');
    expect(idxLastInstruction).toBeGreaterThan(idxInstructions);
    expect(idxMemOverview).toBeGreaterThan(idxLastInstruction);
    expect(idxRetrieved).toBeGreaterThan(idxMemOverview);
  });

  it('injects the common template with role substituted', () => {
    const prompt = buildGroundingPrompt(syntheticPersona(), 'task');
    expect(prompt).toContain('## Linear Tools');
    expect(prompt).toContain('AGENT_ROLE=synthetic-test-role');
    expect(prompt).not.toContain('{role}');
  });

  it('keeps full retrieved memories under budget', () => {
    const retrieved = [bigMem('small-mem', 'small-mem.md', 200)];
    const prompt = buildGroundingPrompt(syntheticPersona(), 'task', retrieved, 'RYA-9');
    expect(prompt).toContain('### small-mem');
    expect(prompt).toContain('x'.repeat(200));
    expect(prompt).not.toContain('over context budget');
  });

  it('degrades over-budget retrieved memories to an index', () => {
    process.env.AOS_CTX_RETRIEVED_BUDGET = '500';
    try {
      const retrieved = [
        bigMem('unrelated-mem', 'unrelated-mem.md', 2000),
        bigMem('other-mem', 'other-mem.md', 2000),
      ];
      const prompt = buildGroundingPrompt(syntheticPersona(), 'task', retrieved, 'RYA-77');
      expect(prompt).not.toContain('x'.repeat(2000));
      expect(prompt).toContain('over context budget');
      expect(prompt).toContain('- unrelated-mem — desc for unrelated-mem (~/.aos/agents/synthetic-test-role/memory/unrelated-mem.md)');
      expect(prompt).toContain('linear-tool recall');
    } finally {
      delete process.env.AOS_CTX_RETRIEVED_BUDGET;
    }
  });

  it('keeps full content for issue-key-matched memories even over budget', () => {
    process.env.AOS_CTX_RETRIEVED_BUDGET = '500';
    try {
      const retrieved = [
        bigMem('rya-77-findings', 'rya-77-findings.md', 2000),
        bigMem('unrelated-mem', 'unrelated-mem.md', 2000),
      ];
      const prompt = buildGroundingPrompt(syntheticPersona(), 'task', retrieved, 'RYA-77');
      // Issue-key match (case-insensitive) keeps full content
      expect(prompt).toContain('### rya-77-findings');
      expect(prompt).toContain('x'.repeat(2000));
      // Non-matching memory is indexed
      expect(prompt).toContain('- unrelated-mem — desc for unrelated-mem');
      expect(prompt).not.toContain('### unrelated-mem');
    } finally {
      delete process.env.AOS_CTX_RETRIEVED_BUDGET;
    }
  });
});

describe('stripTemplateSections (A3.2 template dedup)', () => {
  const template = loadCommonTemplate();

  it('template exists and exposes the marker heading', () => {
    expect(template).toBeTruthy();
    expect(template!).toContain(COMMON_TEMPLATE_MARKER);
    const headings = extractSectionHeadings(template!);
    expect(headings).toContain('## Linear Tools');
    expect(headings).toContain('### Collaboration');
    expect(headings).toContain('### Status Transitions');
    // Fenced example headings must NOT be section boundaries
    expect(headings).not.toContain('### What went well');
  });

  it('strips sections whose heading exactly matches a template heading', () => {
    const claudeMd = [
      '# Role',
      '',
      '## Identity',
      'I am a role.',
      '',
      '## Linear Tools',
      'duplicated boilerplate here',
      '',
      '### Collaboration',
      'more duplicated content',
      '',
      '### Role-Specific Output Requirements',
      'KEEP_THIS_ROLE_SPECIFIC',
      '',
      '### Status Transitions',
      'duplicated again',
      '',
    ].join('\n');
    const { stripped, removed } = stripTemplateSections(claudeMd, template!);
    expect(removed).toContain('## Linear Tools');
    expect(removed).toContain('### Collaboration');
    expect(removed).toContain('### Status Transitions');
    expect(stripped).not.toContain('duplicated boilerplate here');
    expect(stripped).not.toContain('more duplicated content');
    expect(stripped).not.toContain('duplicated again');
    // Role-specific sections survive, even nested inside the boilerplate region
    expect(stripped).toContain('KEEP_THIS_ROLE_SPECIFIC');
    expect(stripped).toContain('## Identity');
  });

  it('is a no-op when the marker heading is absent', () => {
    const claudeMd = '# Role\n\n## Identity\nNo boilerplate here.\n\n### Status Transitions\ncustom content\n';
    const { stripped, removed } = stripTemplateSections(claudeMd, template!);
    expect(removed).toEqual([]);
    expect(stripped).toBe(claudeMd);
  });

  it('ignores headings inside code fences', () => {
    const claudeMd = [
      '## Linear Tools',
      'dup',
      '',
      '## My Section',
      '```markdown',
      '## Linear Tools',
      'example inside fence',
      '```',
      'KEEP_AFTER_FENCE',
      '',
    ].join('\n');
    const { stripped } = stripTemplateSections(claudeMd, template!);
    expect(stripped).toContain('## My Section');
    expect(stripped).toContain('example inside fence');
    expect(stripped).toContain('KEEP_AFTER_FENCE');
    expect(stripped).not.toContain('\ndup');
  });
});

describeLocal('persona dedup shrinks claudeMd (A3.2)', () => {
  it('cto claudeMd contribution drops below 13KB after template dedup', () => {
    const persona = loadPersona('cto');
    // Boilerplate sections stripped at load time
    expect(persona.claudeMd).not.toContain('## Linear Tools');
    expect(persona.claudeMd.length).toBeLessThan(13_000);
    // Role-specific content retained
    expect(persona.claudeMd).toContain('CTO');
  });
});

describe('getLastGroundingStats (A3.0 instrumentation)', () => {
  it('records per-section char counts that sum to ~total', () => {
    const persona = syntheticPersona();
    const retrieved = [
      { id: 'm1', name: 'mem-one', description: 'first', type: null, content: 'alpha '.repeat(50), source_file: 'mem-one.md', rank: -1 },
    ];
    const prompt = buildGroundingPrompt(persona, 'task', retrieved);
    const stats = getLastGroundingStats();
    expect(stats).not.toBeNull();
    expect(stats!.role).toBe('synthetic-test-role');
    expect(stats!.mode).toBe('task');
    expect(stats!.total).toBe(prompt.length);

    // All sections present as numbers
    for (const key of ['identity', 'claudeMd', 'common', 'instructions', 'systemMemory', 'retrieved', 'team', 'mailbox', 'retros'] as const) {
      expect(typeof stats![key]).toBe('number');
    }

    // Sections that must be populated for this input
    expect(stats!.identity).toBeGreaterThan(0);
    expect(stats!.claudeMd).toBe(persona.claudeMd.length);
    expect(stats!.instructions).toBeGreaterThan(0);
    expect(stats!.retrieved).toBeGreaterThan(0);

    // Sum of sections ≈ total (difference is only the '\n\n' join separators)
    const sum = stats!.identity + stats!.claudeMd + stats!.common + stats!.instructions +
      stats!.systemMemory + stats!.retrieved + stats!.team + stats!.mailbox + stats!.retros;
    expect(sum).toBeLessThanOrEqual(stats!.total);
    expect(stats!.total - sum).toBeLessThan(200);
  });

  it('reflects conversation mode and empty retrieved set', () => {
    buildGroundingPrompt(syntheticPersona(), 'conversation');
    const stats = getLastGroundingStats();
    expect(stats!.mode).toBe('conversation');
    expect(stats!.retrieved).toBe(0);
    expect(stats!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('buildTaskPrompt', () => {
  it('includes issue key and title', () => {
    const prompt = buildTaskPrompt('cto', 'RYA-42', 'Fix the auth bug', 'Users cannot login');
    expect(prompt).toContain('RYA-42');
    expect(prompt).toContain('Fix the auth bug');
    expect(prompt).toContain('Users cannot login');
    expect(prompt).toContain('cto');
  });

  it('works without description', () => {
    const prompt = buildTaskPrompt('cpo', 'RYA-1', 'New feature');
    expect(prompt).toContain('RYA-1');
    expect(prompt).toContain('New feature');
  });

  it('includes team context when provided', () => {
    const teamCtx = '## Team Context\n\n**Active sibling work:**\n- RYA-11: Auth refactor (cto working)';
    const prompt = buildTaskPrompt('lead-engineer', 'RYA-10', 'Fix auth', 'Desc', '/ws', 'In Progress', undefined, teamCtx);
    expect(prompt).toContain('## Team Context');
    expect(prompt).toContain('RYA-11');
    expect(prompt).toContain('cto working');
  });

  it('works without team context', () => {
    const prompt = buildTaskPrompt('lead-engineer', 'RYA-10', 'Fix auth');
    expect(prompt).not.toContain('Team Context');
  });
});

describe('buildWorkerPersona', () => {
  it('creates minimal persona for ephemeral workers', () => {
    const persona = buildWorkerPersona('RYA-99', 'Test task', 'Do something');
    expect(persona).toContain('Worker Agent');
    expect(persona).toContain('RYA-99');
    expect(persona).toContain('Test task');
    expect(persona).toContain('Do something');
    expect(persona).toContain('HANDOFF.md');
  });

  it('works without description', () => {
    const persona = buildWorkerPersona('RYA-1', 'Simple task');
    expect(persona).toContain('RYA-1');
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
