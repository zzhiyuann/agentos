import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('./linear-client.js', () => ({
  getReadClient: vi.fn(),
  getAgentClient: vi.fn(),
  hasAgentAccess: vi.fn(() => false),
  graphql: vi.fn(),
}));
vi.mock('./config.js', () => ({
  getConfig: () => ({ linearTeamId: 'test', linearTeamKey: 'RYA', stateDir: '/tmp/aos-test', workspaceBase: '/tmp/workspaces' }),
  getIssueStateDir: (key: string) => `/tmp/aos-test/work/${key}`,
  resolveStatePath: (key: string, ws: string, f: string) => `/tmp/aos-test/work/${key}/${f}`,
  STATE_DIR: '/tmp/aos-test',
}));
vi.mock('./keychain.js', () => ({
  getLinearApiKey: () => 'test-key',
}));
vi.mock('./db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
}));
vi.mock('./linear-relations.js', () => ({
  getIssueRelations: vi.fn(() => []),
}));
vi.mock('./linear-issues.js', () => ({
  generateHandoffSummary: vi.fn(() => 'Task completed successfully.'),
}));
vi.mock('./tmux.js', () => ({
  sendKeys: vi.fn(),
  sessionExists: vi.fn(() => true),
}));

import { graphql } from './linear-client.js';
import { getActiveAttempts } from './db.js';
import { getIssueRelations } from './linear-relations.js';
import { sendKeys, sessionExists } from './tmux.js';
import { getSiblingIssues, buildTeamContext, broadcastCompletion } from './team-context.js';

function makeSiblingResponse(children: any[], hasParent = true) {
  return {
    issues: {
      nodes: [{
        id: 'issue-id',
        parent: hasParent ? {
          id: 'parent-id',
          identifier: 'RYA-100',
          children: { nodes: children },
        } : null,
      }],
    },
  };
}

describe('getSiblingIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sibling issues excluding self', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'Current issue', state: { name: 'In Progress' } },
      { identifier: 'RYA-11', title: 'Sibling A', state: { name: 'Todo' } },
      { identifier: 'RYA-12', title: 'Sibling B', state: { name: 'Done' } },
    ]));

    const result = await getSiblingIssues('RYA-10');
    expect(result).toHaveLength(2);
    expect(result[0].issueKey).toBe('RYA-11');
    expect(result[1].issueKey).toBe('RYA-12');
    expect(result[1].state).toBe('Done');
  });

  it('returns empty array when issue has no parent', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([], false));

    const result = await getSiblingIssues('RYA-10');
    expect(result).toEqual([]);
  });

  it('returns empty array on API error', async () => {
    vi.mocked(graphql).mockRejectedValue(new Error('API error'));

    const result = await getSiblingIssues('RYA-10');
    expect(result).toEqual([]);
  });

  it('returns empty array when issue not found', async () => {
    vi.mocked(graphql).mockResolvedValue({ issues: { nodes: [] } });

    const result = await getSiblingIssues('RYA-999');
    expect(result).toEqual([]);
  });
});

describe('buildTeamContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty string when no siblings exist', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([], false));

    const result = await buildTeamContext('RYA-10');
    expect(result).toBe('');
  });

  it('includes active sibling work section', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'My issue', state: { name: 'In Progress' } },
      { identifier: 'RYA-11', title: 'Auth refactor', state: { name: 'In Progress' } },
    ]));
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-11', agent_type: 'lead-engineer', status: 'running' } as any,
    ]);

    const result = await buildTeamContext('RYA-10');
    expect(result).toContain('## Team Context');
    expect(result).toContain('Active sibling work');
    expect(result).toContain('RYA-11');
    expect(result).toContain('lead-engineer working');
  });

  it('includes related issues with active agents', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'My issue', state: { name: 'In Progress' } },
    ]));
    // No active siblings, but has a related issue
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-50', agent_type: 'cto', status: 'running' } as any,
    ]);
    vi.mocked(getIssueRelations).mockResolvedValue([
      { id: 'r1', type: 'related', issueKey: 'RYA-50', issueTitle: 'API design' },
    ]);

    const result = await buildTeamContext('RYA-10');
    expect(result).toContain('Active related work');
    expect(result).toContain('RYA-50');
    expect(result).toContain('cto working');
  });

  it('returns empty string when all queries fail', async () => {
    vi.mocked(graphql).mockRejectedValue(new Error('Network error'));
    vi.mocked(getIssueRelations).mockRejectedValue(new Error('Network error'));
    vi.mocked(getActiveAttempts).mockReturnValue([]);

    const result = await buildTeamContext('RYA-10');
    expect(result).toBe('');
  });

  it('still returns related context when sibling query fails', async () => {
    vi.mocked(graphql).mockRejectedValue(new Error('Network error'));
    vi.mocked(getIssueRelations).mockResolvedValue([
      { id: 'r1', type: 'related', issueKey: 'RYA-50', issueTitle: 'API design' },
    ]);
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-50', agent_type: 'cto', status: 'running' } as any,
    ]);

    const result = await buildTeamContext('RYA-10');
    expect(result).toContain('Active related work');
    expect(result).toContain('RYA-50');
  });
});

describe('broadcastCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts completion to sibling agents via tmux', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'Completed', state: { name: 'Done' } },
      { identifier: 'RYA-11', title: 'Still working', state: { name: 'In Progress' } },
    ]));
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-11', agent_type: 'cto', status: 'running', tmux_session: 'aos-cto-RYA-11' } as any,
    ]);
    vi.mocked(sessionExists).mockReturnValue(true);

    await broadcastCompletion('RYA-10', 'lead-engineer', 'Fixed the auth bug');

    expect(sendKeys).toHaveBeenCalledWith(
      'aos-cto-RYA-11',
      expect.stringContaining('lead-engineer completed RYA-10'),
    );
  });

  it('skips agents without tmux sessions', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'Completed', state: { name: 'Done' } },
      { identifier: 'RYA-11', title: 'Still working', state: { name: 'In Progress' } },
    ]));
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-11', agent_type: 'cto', status: 'running', tmux_session: null } as any,
    ]);

    await broadcastCompletion('RYA-10', 'lead-engineer', 'Fixed the auth bug');

    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('does not fail when no siblings exist', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([], false));

    await expect(broadcastCompletion('RYA-10', 'lead-engineer', 'Summary')).resolves.not.toThrow();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('truncates long summaries', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'Completed', state: { name: 'Done' } },
      { identifier: 'RYA-11', title: 'Still working', state: { name: 'In Progress' } },
    ]));
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-11', agent_type: 'cto', status: 'running', tmux_session: 'aos-cto-RYA-11' } as any,
    ]);
    vi.mocked(sessionExists).mockReturnValue(true);

    const longSummary = 'A'.repeat(500);
    await expect(broadcastCompletion('RYA-10', 'lead-engineer', longSummary)).resolves.not.toThrow();
    expect(sendKeys).toHaveBeenCalledWith(
      'aos-cto-RYA-11',
      expect.stringContaining('...'),
    );
  });

  it('silently handles sendKeys errors', async () => {
    vi.mocked(graphql).mockResolvedValue(makeSiblingResponse([
      { identifier: 'RYA-10', title: 'Completed', state: { name: 'Done' } },
      { identifier: 'RYA-11', title: 'Still working', state: { name: 'In Progress' } },
    ]));
    vi.mocked(getActiveAttempts).mockReturnValue([
      { issue_key: 'RYA-11', agent_type: 'cto', status: 'running', tmux_session: 'aos-cto-RYA-11' } as any,
    ]);
    vi.mocked(sessionExists).mockReturnValue(true);
    vi.mocked(sendKeys).mockImplementation(() => { throw new Error('tmux error'); });

    await expect(broadcastCompletion('RYA-10', 'lead-engineer', 'Summary')).resolves.not.toThrow();
  });
});
