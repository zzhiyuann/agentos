import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('./linear-client.js', () => ({
  getReadClient: vi.fn(),
  getAgentClient: vi.fn(),
  hasAgentAccess: vi.fn(() => false),
  graphql: vi.fn(),
}));
vi.mock('./config.js', () => ({
  getConfig: () => ({ linearTeamId: 'test', linearTeamKey: 'RYA' }),
}));
vi.mock('./keychain.js', () => ({
  getLinearApiKey: () => 'test-key',
}));

import { graphql } from './linear-client.js';
import { isBlocked, getDependentIssues, isDuplicateOfDone } from './linear-relations.js';

function makeGraphqlResponse(relations: any[], inverseRelations: any[]) {
  return {
    issues: {
      nodes: [{
        id: 'issue-id',
        relations: { nodes: relations },
        inverseRelations: { nodes: inverseRelations },
      }],
    },
  };
}

describe('isBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns blocked=false when no relations exist', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], []));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('returns blocked=true when blocker is In Progress', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], [
      {
        id: 'rel-1',
        type: 'blocks',
        issue: { identifier: 'RYA-5', title: 'Blocker issue', state: { name: 'In Progress' } },
      },
    ]));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(true);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].issueKey).toBe('RYA-5');
  });

  it('returns blocked=false when blocker is Done', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], [
      {
        id: 'rel-1',
        type: 'blocks',
        issue: { identifier: 'RYA-5', title: 'Blocker issue', state: { name: 'Done' } },
      },
    ]));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(false);
    expect(result.blockers).toEqual([]);
  });

  it('returns blocked=false when blocker is Canceled', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], [
      {
        id: 'rel-1',
        type: 'blocks',
        issue: { identifier: 'RYA-5', title: 'Canceled issue', state: { name: 'Canceled' } },
      },
    ]));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(false);
  });

  it('handles mixed resolved and unresolved blockers', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], [
      {
        id: 'rel-1',
        type: 'blocks',
        issue: { identifier: 'RYA-5', title: 'Done blocker', state: { name: 'Done' } },
      },
      {
        id: 'rel-2',
        type: 'blocks',
        issue: { identifier: 'RYA-6', title: 'Still blocking', state: { name: 'Todo' } },
      },
    ]));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(true);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].issueKey).toBe('RYA-6');
  });

  it('returns blocked=false when all blockers are resolved', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], [
      {
        id: 'rel-1',
        type: 'blocks',
        issue: { identifier: 'RYA-5', title: 'Done blocker', state: { name: 'Done' } },
      },
      {
        id: 'rel-2',
        type: 'blocks',
        issue: { identifier: 'RYA-6', title: 'Canceled blocker', state: { name: 'Canceled' } },
      },
    ]));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(false);
  });

  it('fails open on API error', async () => {
    vi.mocked(graphql).mockRejectedValue(new Error('Network error'));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(false);
  });

  it('ignores non-blocking relations', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([
      {
        id: 'rel-1',
        type: 'related',
        relatedIssue: { identifier: 'RYA-5', title: 'Related issue', state: { name: 'In Progress' } },
      },
    ], []));
    const result = await isBlocked('RYA-10');
    expect(result.blocked).toBe(false);
  });
});

describe('getDependentIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns issues that this issue blocks', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([
      {
        id: 'rel-1',
        type: 'blocks',
        relatedIssue: { identifier: 'RYA-20', title: 'Dependent A', state: { name: 'Todo' } },
      },
      {
        id: 'rel-2',
        type: 'blocks',
        relatedIssue: { identifier: 'RYA-21', title: 'Dependent B', state: { name: 'Backlog' } },
      },
    ], []));
    const result = await getDependentIssues('RYA-10');
    expect(result).toHaveLength(2);
    expect(result[0].issueKey).toBe('RYA-20');
    expect(result[1].issueKey).toBe('RYA-21');
  });

  it('returns empty array when no dependents', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([], []));
    const result = await getDependentIssues('RYA-10');
    expect(result).toEqual([]);
  });

  it('returns empty array on API error', async () => {
    vi.mocked(graphql).mockRejectedValue(new Error('API error'));
    const result = await getDependentIssues('RYA-10');
    expect(result).toEqual([]);
  });

  it('does not return related or duplicate issues', async () => {
    vi.mocked(graphql).mockResolvedValue(makeGraphqlResponse([
      {
        id: 'rel-1',
        type: 'related',
        relatedIssue: { identifier: 'RYA-20', title: 'Related', state: { name: 'Todo' } },
      },
      {
        id: 'rel-2',
        type: 'duplicate',
        relatedIssue: { identifier: 'RYA-21', title: 'Duplicate', state: { name: 'Todo' } },
      },
    ], []));
    const result = await getDependentIssues('RYA-10');
    expect(result).toEqual([]);
  });
});

describe('isDuplicateOfDone (RYA-1071)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeForwardDupResponse(type: string, state: string, identifier = 'RYA-1065') {
    return {
      issues: {
        nodes: [{
          relations: {
            nodes: [{
              type,
              relatedIssue: { identifier, state: { name: state } },
            }],
          },
        }],
      },
    };
  }

  it('returns canonical key when forward duplicate points to a Done issue', async () => {
    vi.mocked(graphql).mockResolvedValue(makeForwardDupResponse('duplicate', 'Done'));
    const result = await isDuplicateOfDone('RYA-1067');
    expect(result).toEqual({ canonicalKey: 'RYA-1065', canonicalState: 'Done' });
  });

  it('returns canonical key when forward duplicate points to a Canceled issue', async () => {
    vi.mocked(graphql).mockResolvedValue(makeForwardDupResponse('duplicate', 'Canceled', 'RYA-900'));
    const result = await isDuplicateOfDone('RYA-1067');
    expect(result).toEqual({ canonicalKey: 'RYA-900', canonicalState: 'Canceled' });
  });

  it('returns null when canonical is still open (In Progress)', async () => {
    vi.mocked(graphql).mockResolvedValue(makeForwardDupResponse('duplicate', 'In Progress'));
    const result = await isDuplicateOfDone('RYA-1067');
    expect(result).toBeNull();
  });

  it('returns null when canonical is still open (Todo)', async () => {
    vi.mocked(graphql).mockResolvedValue(makeForwardDupResponse('duplicate', 'Todo'));
    expect(await isDuplicateOfDone('RYA-1067')).toBeNull();
  });

  it('returns null when no relations exist', async () => {
    vi.mocked(graphql).mockResolvedValue({
      issues: { nodes: [{ relations: { nodes: [] } }] },
    });
    expect(await isDuplicateOfDone('RYA-1067')).toBeNull();
  });

  it('returns null when only a "related" relation exists (not duplicate)', async () => {
    vi.mocked(graphql).mockResolvedValue(makeForwardDupResponse('related', 'Done'));
    expect(await isDuplicateOfDone('RYA-1067')).toBeNull();
  });

  it('returns null when issue is not found', async () => {
    vi.mocked(graphql).mockResolvedValue({ issues: { nodes: [] } });
    expect(await isDuplicateOfDone('RYA-9999')).toBeNull();
  });

  it('fails open on API error (returns null, does not throw)', async () => {
    vi.mocked(graphql).mockRejectedValue(new Error('Network'));
    const result = await isDuplicateOfDone('RYA-1067');
    expect(result).toBeNull();
  });

  it('is case-insensitive on state name (DONE / done)', async () => {
    vi.mocked(graphql).mockResolvedValue(makeForwardDupResponse('duplicate', 'DONE'));
    const result = await isDuplicateOfDone('RYA-1067');
    expect(result).not.toBeNull();
    expect(result?.canonicalKey).toBe('RYA-1065');
  });
});
