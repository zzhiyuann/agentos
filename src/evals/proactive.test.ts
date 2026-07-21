/**
 * Proactive Channel eval — tests pure functions and prompt generation.
 *
 * Tests the proactive channel system's core logic:
 *   - Prompt generation for each role
 *   - Config loading with defaults and overrides
 *   - Board voting logic
 *
 * Run: npx vitest run src/evals/proactive.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evalTag } from './framework.js';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

vi.mock('../core/config.js', () => ({
  getConfig: vi.fn(() => ({
    linearTeamId: 'team-uuid',
    linearTeamKey: 'RYA',
    stateDir: '/tmp/test-aos',
  })),
  resolveStatePath: vi.fn((...args: string[]) => args.join('/')),
  STATE_DIR: '/tmp/test-aos',
}));

const {
  mockReadClientIssue,
  mockReadClientIssues,
  mockAgentCreateIssue,
  mockGetActiveAttempts,
  mockGetAttemptsByIssue,
} = vi.hoisted(() => ({
  mockReadClientIssue: vi.fn(),
  // Typed param matters: tests assert on `.mock.calls[0][0]` and pass through
  // `mockImplementation((args) => …)`. Without a typed first arg, vitest infers
  // the call tuple as `[]` and TS rejects both forms (TS2493 / TS2345).
  mockReadClientIssues: vi.fn(async (_args?: unknown) => ({ nodes: [] as unknown[] })),
  mockAgentCreateIssue: vi.fn(async () => ({ success: false })),
  mockGetActiveAttempts: vi.fn(() => [] as unknown[]),
  mockGetAttemptsByIssue: vi.fn((_k: string) => [] as unknown[]),
}));

vi.mock('../core/linear.js', () => ({
  getReadClient: vi.fn(() => ({ issue: mockReadClientIssue, issues: mockReadClientIssues })),
  getAgentClient: vi.fn(() => ({ createIssue: mockAgentCreateIssue })),
  getWorkflowStateId: vi.fn(async () => 'state-uuid'),
  addComment: vi.fn(async () => ({})),
}));

vi.mock('../core/db.js', () => ({
  getActiveAttempts: mockGetActiveAttempts,
  getActiveAttempt: vi.fn(() => null),
  getAttemptsByIssue: mockGetAttemptsByIssue,
}));

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  sendKeys: vi.fn(),
}));

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  loadAgentConfig: vi.fn(() => ({
    baseModel: 'cc',
    maxParallel: 8,
    linearUserId: 'user-uuid',
  })),
  getAgentLinearToken: vi.fn(() => 'mock-token'),
  listAgents: vi.fn(() => ['cto', 'cpo', 'research-lead', 'lead-engineer', 'coo']),
}));

vi.mock('./concurrency.js', async () => ({
  canStartNewSession: vi.fn(() => ({ allowed: true })),
  hasCapacity: vi.fn(() => true),
}));

vi.mock('./dispatch.js', () => ({
  handleDispatch: vi.fn(async () => ({ ok: true, action: 'started' })),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import {
  buildProactivePrompt,
  getProactiveConfig,
  getProactiveDashboardData,
  ensureParentIssue,
  isTrackedProactiveSessionRunning,
  applyCoolDownFromAttempt,
  isInCoolDown,
  proactiveChannelHeartbeat,
  proactiveTitlePrefix,
  hasOpenProactiveIssueForRole,
  hasOpenProactiveIssueForRoleTeamWide,
  hasRecentDispatchForRole,
  hasRecentParentHub,
  type ProactiveState,
} from '../serve/proactive.js';
import type { Attempt } from '../core/db.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

function makeState(overrides: Partial<ProactiveState> = {}): ProactiveState {
  return {
    parentIssueKey: 'RYA-362',
    parentIssueId: '427993d7-2567-4201-bace-ebe4538527d5',
    activeChannels: {},
    proposedIdeas: [],
    stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'important',
  behavior: 'Proactive channel: prompt generation and config',
}), () => {

  describe('buildProactivePrompt', () => {
    it('generates a valid prompt for each known role', () => {
      const roles = ['cto', 'cpo', 'research-lead', 'lead-engineer', 'coo'];
      for (const role of roles) {
        const prompt = buildProactivePrompt(role, 'RYA-100');
        expect(prompt.length).toBeGreaterThan(100);
        expect(prompt).toContain(role.toUpperCase());
        expect(prompt).toContain('RYA-100'); // Parent issue key
        expect(prompt).toContain('BOARD VOTE');
        expect(prompt).toContain('linear-tool');
      }
    });

    it('includes role-specific focus areas', () => {
      const ctoPrompt = buildProactivePrompt('cto', 'RYA-100');
      expect(ctoPrompt).toContain('technology');

      const cpoPrompt = buildProactivePrompt('cpo', 'RYA-100');
      expect(cpoPrompt).toContain('product');

      const researchPrompt = buildProactivePrompt('research-lead', 'RYA-100');
      expect(researchPrompt).toContain('research');
    });

    it('returns empty string for unknown role', () => {
      const prompt = buildProactivePrompt('unknown-role', 'RYA-100');
      expect(prompt).toBe('');
    });

    it('includes quality bar checklist', () => {
      const prompt = buildProactivePrompt('cto', 'RYA-100');
      expect(prompt).toContain('Transformative');
      expect(prompt).toContain('Feasible');
      expect(prompt).toContain('Viral + Meaningful');
    });

    it('includes the board quorum requirement', () => {
      const prompt = buildProactivePrompt('cto', 'RYA-100');
      // Should mention the quorum number
      expect(prompt).toMatch(/\d+ approval/);
    });
  });

  describe('getProactiveConfig', () => {
    it('returns default config for known roles', () => {
      const config = getProactiveConfig('cto');
      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(true);
      expect(config!.focusAreas.length).toBeGreaterThan(0);
      expect(config!.searchDirectives.length).toBeGreaterThan(0);
      expect(config!.thinkingPrompt.length).toBeGreaterThan(0);
    });

    it('returns null for unknown roles', () => {
      const config = getProactiveConfig('nonexistent');
      expect(config).toBeNull();
    });

    it('has configs for all standard roles', () => {
      const roles = ['cto', 'cpo', 'research-lead', 'lead-engineer', 'coo'];
      for (const role of roles) {
        const config = getProactiveConfig(role);
        expect(config).not.toBeNull();
        expect(config!.focusAreas.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getProactiveDashboardData', () => {
    it('returns valid dashboard structure with empty state', () => {
      const data = getProactiveDashboardData();
      expect(data).toHaveProperty('parentIssueKey');
      expect(data).toHaveProperty('activeChannels');
      expect(data).toHaveProperty('votingIdeas');
      expect(data).toHaveProperty('approvedIdeas');
      expect(data).toHaveProperty('totalProposed');
      expect(typeof data.votingIdeas).toBe('number');
      expect(typeof data.approvedIdeas).toBe('number');
    });
  });
});

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'important',
  behavior: 'Proactive channel: prompt structure and safety',
}), () => {

  it('prompts include kill switch env var reference in docs', () => {
    // The system should be disableable via AOS_NO_PROACTIVE=1
    // This is checked in the heartbeat function, not the prompt itself
    // But we verify the prompts don't contain hardcoded secrets or sensitive data
    const roles = ['cto', 'cpo', 'research-lead', 'lead-engineer', 'coo'];
    for (const role of roles) {
      const prompt = buildProactivePrompt(role, 'RYA-100');
      // No hardcoded tokens or secrets
      expect(prompt).not.toMatch(/sk-[a-zA-Z0-9]+/);
      expect(prompt).not.toMatch(/Bearer\s+[a-zA-Z0-9]+/);
      // Uses AGENT_ROLE variable correctly
      expect(prompt).toContain(`AGENT_ROLE=${role}`);
    }
  });

  it('prompts enforce the quality bar', () => {
    const roles = ['cto', 'cpo', 'research-lead', 'lead-engineer', 'coo'];
    for (const role of roles) {
      const prompt = buildProactivePrompt(role, 'RYA-100');
      // Must mention quality bar criteria
      expect(prompt).toContain('Transformative');
      expect(prompt).toContain('Feasible');
      expect(prompt).toContain('Non-obvious');
    }
  });

  it('prompts include exploration summary directive', () => {
    const prompt = buildProactivePrompt('cto', 'RYA-100');
    expect(prompt).toContain('Exploration summary');
  });
});

// ─── RYA-831: prefix-match single-slot lock & cross-format dedupe ────────────

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive channel: RYA-831 — prefix-match catches all suffix formats and any open child',
}), () => {
  beforeEach(() => {
    mockReadClientIssue.mockReset();
  });

  it('proactiveTitlePrefix returns canonical "[proactive] {role}: Strategic exploration"', () => {
    expect(proactiveTitlePrefix('cto')).toBe('[proactive] cto: Strategic exploration');
    expect(proactiveTitlePrefix('research-lead')).toBe('[proactive] research-lead: Strategic exploration');
  });

  it('hasOpenProactiveIssueForRole matches the new ISO-week title format', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-773',
      children: async () => ({
        nodes: [
          {
            identifier: 'RYA-900',
            title: '[proactive] cto: Strategic exploration (2026-W18)',
            state: Promise.resolve({ name: 'In Progress' }),
          },
        ],
      }),
    });
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(true);
  });

  it('hasOpenProactiveIssueForRole matches the OLD date title format', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-773',
      children: async () => ({
        nodes: [
          {
            identifier: 'RYA-820',
            title: '[proactive] cto: Strategic exploration (2026-04-23)',
            state: Promise.resolve({ name: 'In Progress' }),
          },
        ],
      }),
    });
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(true);
  });

  it('hasOpenProactiveIssueForRole ignores a different role with same prefix shape', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-773',
      children: async () => ({
        nodes: [
          {
            identifier: 'RYA-900',
            title: '[proactive] coo: Strategic exploration (2026-W18)',
            state: Promise.resolve({ name: 'In Progress' }),
          },
        ],
      }),
    });
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(false);
  });

  it('hasOpenProactiveIssueForRole ignores closed/canceled siblings', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-773',
      children: async () => ({
        nodes: [
          {
            identifier: 'RYA-820',
            title: '[proactive] cto: Strategic exploration (2026-04-23)',
            state: Promise.resolve({ name: 'Canceled' }),
          },
          {
            identifier: 'RYA-822',
            title: '[proactive] cto: Strategic exploration (2026-04-23)',
            state: Promise.resolve({ name: 'Done' }),
          },
        ],
      }),
    });
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(false);
  });

  it('RYA-1033: hasOpenProactiveIssueForRole fails CLOSED (returns true) on rate-limit so the heartbeat does not spawn duplicates', async () => {
    mockReadClientIssue.mockRejectedValue(new Error('Linear 429: Rate limit exceeded'));
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(true);
  });

  it('RYA-1033: hasOpenProactiveIssueForRole fails CLOSED (returns true) on network errors (ECONNRESET / ETIMEDOUT / fetch failed)', async () => {
    mockReadClientIssue.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(true);

    mockReadClientIssue.mockReset();
    mockReadClientIssue.mockRejectedValue(new Error('ETIMEDOUT connecting to api.linear.app'));
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(true);
  });

  it('RYA-1033: hasOpenProactiveIssueForRole still fails open (returns false) on non-transient Linear errors so a permanent schema/permission bug does not wedge the heartbeat', async () => {
    mockReadClientIssue.mockRejectedValue(new Error('GraphQL: invalid filter argument'));
    expect(await hasOpenProactiveIssueForRole('parent-uuid', 'cto')).toBe(false);
  });
});

// ─── RYA-1033: hasOpenProactiveIssueForRoleTeamWide fail-CLOSED on rate-limit ──

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive channel: RYA-1033 — team-wide open-issue guard fails CLOSED on rate-limit / network',
}), () => {
  beforeEach(() => {
    mockReadClientIssues.mockReset();
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
  });

  it('returns true when an open proactive issue exists team-wide for the role', async () => {
    mockReadClientIssues.mockResolvedValue({
      nodes: [{ identifier: 'RYA-900', title: '[proactive] cto: Strategic exploration (2026-W18)' }],
    });
    expect(await hasOpenProactiveIssueForRoleTeamWide('cto')).toBe(true);
  });

  it('returns false when no open proactive issue exists team-wide for the role', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    expect(await hasOpenProactiveIssueForRoleTeamWide('cto')).toBe(false);
  });

  it('passes correct filter: team + prefix-match title + open states only', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    await hasOpenProactiveIssueForRoleTeamWide('cpo');
    const callArg = (mockReadClientIssues.mock.calls[0] as unknown[] | undefined)?.[0] as {
      filter: {
        team: { id: { eq: string } };
        title: { startsWith: string };
        state: { name: { in: string[] } };
      };
    };
    expect(callArg.filter.team.id.eq).toBe('team-uuid');
    expect(callArg.filter.title.startsWith).toBe('[proactive] cpo: Strategic exploration');
    expect(callArg.filter.state.name.in.sort()).toEqual(['Backlog', 'In Progress', 'In Review', 'Todo']);
  });

  it('RYA-1033: fails CLOSED (returns true) on rate-limit so the heartbeat does not spawn duplicates', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('Linear 429: Rate limit exceeded'));
    expect(await hasOpenProactiveIssueForRoleTeamWide('cto')).toBe(true);
  });

  it('RYA-1033: fails CLOSED (returns true) on network errors', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    expect(await hasOpenProactiveIssueForRoleTeamWide('cto')).toBe(true);

    mockReadClientIssues.mockReset();
    mockReadClientIssues.mockRejectedValue(new Error('ENETUNREACH'));
    expect(await hasOpenProactiveIssueForRoleTeamWide('cto')).toBe(true);
  });

  it('RYA-1033: still fails open (returns false) on non-transient Linear errors', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('GraphQL: invalid filter argument'));
    expect(await hasOpenProactiveIssueForRoleTeamWide('cto')).toBe(false);
  });
});

// ─── RYA-831: ensureParentIssue adopts existing parent instead of duplicating ─

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive channel: RYA-831 — adopt existing live parent rather than creating duplicates',
}), () => {
  beforeEach(() => {
    mockReadClientIssue.mockReset();
    mockReadClientIssues.mockReset();
    mockAgentCreateIssue.mockReset();
    mockAgentCreateIssue.mockResolvedValue({ success: false });
    // Default: no cached parent lookup result
    mockReadClientIssue.mockResolvedValue(null);
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
  });

  it('adopts the OLDEST existing live parent when state is empty and one already exists', async () => {
    mockReadClientIssues.mockResolvedValue({
      nodes: [
        // Linear typically returns DESC by createdAt — provide that order.
        { id: 'parent-dupe-uuid', identifier: 'RYA-811', createdAt: '2026-04-23T12:11:15.498Z' },
        { id: 'parent-original-uuid', identifier: 'RYA-773', createdAt: '2026-04-23T08:55:10.103Z' },
      ],
    });

    const state = makeState({ parentIssueKey: null, parentIssueId: null });
    const result = await ensureParentIssue(state);

    expect(result).toEqual({ key: 'RYA-773', id: 'parent-original-uuid' });
    expect(mockAgentCreateIssue).not.toHaveBeenCalled();
    expect(state.parentIssueKey).toBe('RYA-773');
    expect(state.parentIssueId).toBe('parent-original-uuid');
  });

  it('creates a new parent only when none exists in the team', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    mockAgentCreateIssue.mockResolvedValue({
      success: true,
      issue: Promise.resolve({ identifier: 'RYA-999', id: 'new-parent-uuid' }),
    } as unknown as { success: boolean });

    const state = makeState({ parentIssueKey: null, parentIssueId: null });
    const result = await ensureParentIssue(state);

    expect(result).toEqual({ key: 'RYA-999', id: 'new-parent-uuid' });
    expect(mockAgentCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('falls back to creating a new parent when search throws', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('Search failed'));
    mockAgentCreateIssue.mockResolvedValue({
      success: true,
      issue: Promise.resolve({ identifier: 'RYA-999', id: 'new-parent-uuid' }),
    } as unknown as { success: boolean });

    const state = makeState({ parentIssueKey: null, parentIssueId: null });
    const result = await ensureParentIssue(state);

    expect(result).toEqual({ key: 'RYA-999', id: 'new-parent-uuid' });
    expect(mockAgentCreateIssue).toHaveBeenCalledTimes(1);
  });
});

// ─── ensureParentIssue: stale-parent detection (RYA-637) ────────────────────

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'important',
  behavior: 'Proactive channel: ensureParentIssue rejects stale cache for deleted/trashed/archived parents',
}), () => {
  beforeEach(() => {
    mockReadClientIssue.mockReset();
    mockAgentCreateIssue.mockReset();
    mockAgentCreateIssue.mockResolvedValue({ success: false });
  });

  it('returns the cached parent when the Linear issue is live', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: '427993d7-2567-4201-bace-ebe4538527d5',
      identifier: 'RYA-362',
      trashed: null,
      archivedAt: null,
    });
    const state = makeState();
    const result = await ensureParentIssue(state);
    expect(result).toEqual({ key: 'RYA-362', id: '427993d7-2567-4201-bace-ebe4538527d5' });
    expect(mockAgentCreateIssue).not.toHaveBeenCalled();
  });

  it('rejects a cached parent whose Linear issue is trashed', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: '427993d7-2567-4201-bace-ebe4538527d5',
      identifier: 'RYA-362',
      trashed: true,
      archivedAt: null,
    });
    const state = makeState();
    await ensureParentIssue(state);
    expect(state.parentIssueKey).toBeNull();
    expect(state.parentIssueId).toBeNull();
    expect(mockAgentCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects a cached parent whose Linear issue is archived', async () => {
    mockReadClientIssue.mockResolvedValue({
      id: '427993d7-2567-4201-bace-ebe4538527d5',
      identifier: 'RYA-362',
      trashed: null,
      archivedAt: '2026-04-01T00:00:00.000Z',
    });
    const state = makeState();
    await ensureParentIssue(state);
    expect(state.parentIssueKey).toBeNull();
    expect(state.parentIssueId).toBeNull();
    expect(mockAgentCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects a cached parent when Linear SDK returns null', async () => {
    mockReadClientIssue.mockResolvedValue(null);
    const state = makeState();
    await ensureParentIssue(state);
    expect(state.parentIssueKey).toBeNull();
    expect(state.parentIssueId).toBeNull();
    expect(mockAgentCreateIssue).toHaveBeenCalledTimes(1);
  });

  it('rejects a cached parent when Linear SDK throws', async () => {
    mockReadClientIssue.mockRejectedValue(new Error('Issue RYA-362 not found'));
    const state = makeState();
    await ensureParentIssue(state);
    expect(state.parentIssueKey).toBeNull();
    expect(state.parentIssueId).toBeNull();
    expect(mockAgentCreateIssue).toHaveBeenCalledTimes(1);
  });
});

// ─── RYA-698: proactive heartbeat zombie-spawn guard ───────────────────────

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'att-1',
    issue_id: 'issue-uuid',
    issue_key: 'RYA-100',
    agent_session_id: null,
    agent_type: 'coo',
    runner_session_id: null,
    tmux_session: null,
    attempt_number: 1,
    status: 'running',
    host: 'localhost',
    workspace_path: null,
    budget_usd: null,
    cost_usd: 0,
    created_at: '2026-04-23T00:00:00.000Z',
    updated_at: '2026-04-23T00:00:00.000Z',
    completed_at: null,
    error_log: null,
    ...overrides,
  };
}

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive channel: RYA-698 pure helpers — running detection via state, not substring',
}), () => {
  describe('isTrackedProactiveSessionRunning', () => {
    it('returns false when no tracked issue key (fresh state)', () => {
      const attempts = [makeAttempt({ issue_key: 'RYA-680', status: 'running' })];
      expect(isTrackedProactiveSessionRunning('coo', undefined, attempts)).toBe(false);
    });

    it('returns true when DB has a running attempt for the tracked key', () => {
      const attempts = [makeAttempt({ issue_key: 'RYA-680', status: 'running' })];
      expect(isTrackedProactiveSessionRunning('coo', 'RYA-680', attempts)).toBe(true);
    });

    it('returns false when tracked key mismatches (old filter relied on substring)', () => {
      // RYA-697 in state, only RYA-680 currently running — must NOT match.
      const attempts = [makeAttempt({ issue_key: 'RYA-680', status: 'running' })];
      expect(isTrackedProactiveSessionRunning('coo', 'RYA-697', attempts)).toBe(false);
    });

    it('returns false when tracked attempt is failed, not running', () => {
      const attempts = [makeAttempt({ issue_key: 'RYA-697', status: 'failed' })];
      expect(isTrackedProactiveSessionRunning('coo', 'RYA-697', attempts)).toBe(false);
    });

    it('returns false when tracked attempt is for a different role', () => {
      const attempts = [makeAttempt({ issue_key: 'RYA-680', status: 'running', agent_type: 'cto' })];
      expect(isTrackedProactiveSessionRunning('coo', 'RYA-680', attempts)).toBe(false);
    });

    it('regression: does NOT match by substring on "proactive" (legacy bug)', () => {
      // Simulates old bug: attempt issue_key contains no "proactive", so
      // any implementation that relied on includes('proactive') would be empty.
      // Our new impl returns true because issue_key matches tracked.
      const attempts = [makeAttempt({ issue_key: 'RYA-680', status: 'running' })];
      expect(isTrackedProactiveSessionRunning('coo', 'RYA-680', attempts)).toBe(true);
      // And confirm no attempt key ever contains 'proactive'
      expect(attempts.every(a => !a.issue_key.includes('proactive'))).toBe(true);
    });
  });

  describe('applyCoolDownFromAttempt', () => {
    type Channel = NonNullable<ProactiveState['activeChannels'][string]>;
    const baseChannel = (): Channel => ({
      issueKey: 'RYA-697',
      issueId: 'id-697',
      startedAt: '2026-04-23T00:00:00.000Z',
      lastHeartbeatAt: '2026-04-23T00:00:00.000Z',
    });

    it('does nothing when the latest attempt is still running', () => {
      const ch = baseChannel();
      applyCoolDownFromAttempt(ch, makeAttempt({ status: 'running' }));
      expect(ch.consecutiveFailures).toBeUndefined();
      expect(ch.cooldownUntil).toBeUndefined();
    });

    it('increments consecutiveFailures on a failed attempt without triggering cooldown at 1', () => {
      const ch = baseChannel();
      applyCoolDownFromAttempt(
        ch,
        makeAttempt({ status: 'failed', completed_at: '2026-04-23T00:01:00.000Z' }),
      );
      expect(ch.consecutiveFailures).toBe(1);
      expect(ch.cooldownUntil).toBeUndefined();
      expect(ch.lastFailureAt).toBe('2026-04-23T00:01:00.000Z');
    });

    it('triggers a 1h cool-down at the 3rd consecutive failure', () => {
      const ch = { ...baseChannel(), consecutiveFailures: 2 };
      const now = Date.parse('2026-04-23T00:00:00.000Z');
      applyCoolDownFromAttempt(ch, makeAttempt({ status: 'failed' }), now);
      expect(ch.consecutiveFailures).toBe(3);
      expect(ch.cooldownUntil).toBe(new Date(now + 60 * 60_000).toISOString());
    });

    it('triggers a 4h cool-down at the 5th consecutive failure', () => {
      const ch = { ...baseChannel(), consecutiveFailures: 4 };
      const now = Date.parse('2026-04-23T00:00:00.000Z');
      applyCoolDownFromAttempt(ch, makeAttempt({ status: 'failed' }), now);
      expect(ch.consecutiveFailures).toBe(5);
      expect(ch.cooldownUntil).toBe(new Date(now + 4 * 60 * 60_000).toISOString());
    });

    it('resets counters on a completed attempt', () => {
      const ch = {
        ...baseChannel(),
        consecutiveFailures: 7,
        cooldownUntil: '2027-01-01T00:00:00.000Z',
        lastFailureAt: '2026-04-22T23:00:00.000Z',
      };
      applyCoolDownFromAttempt(ch, makeAttempt({ status: 'completed' }));
      expect(ch.consecutiveFailures).toBe(0);
      expect(ch.cooldownUntil).toBeUndefined();
    });
  });

  describe('isInCoolDown', () => {
    it('returns false when no channel', () => {
      expect(isInCoolDown(undefined)).toBe(false);
    });

    it('returns false when no cooldownUntil', () => {
      expect(isInCoolDown({
        issueKey: 'RYA-1', issueId: 'id', startedAt: 't', lastHeartbeatAt: 't',
      })).toBe(false);
    });

    it('returns true when cooldownUntil is in the future', () => {
      const now = Date.parse('2026-04-23T00:00:00.000Z');
      expect(isInCoolDown({
        issueKey: 'RYA-1', issueId: 'id', startedAt: 't', lastHeartbeatAt: 't',
        cooldownUntil: new Date(now + 60_000).toISOString(),
      }, now)).toBe(true);
    });

    it('returns false when cooldownUntil has expired', () => {
      const now = Date.parse('2026-04-23T00:00:00.000Z');
      expect(isInCoolDown({
        issueKey: 'RYA-1', issueId: 'id', startedAt: 't', lastHeartbeatAt: 't',
        cooldownUntil: new Date(now - 60_000).toISOString(),
      }, now)).toBe(false);
    });
  });
});

// ─── RYA-698: heartbeat integration — one-session-per-role-per-day invariant ─
//
// Uses dynamic imports + vi.resetModules so each test starts with a fresh
// module instance (clears the lastProactiveHeartbeatAt cooldown AND picks up
// HOME overrides baked into the PROACTIVE_STATE_FILE constant at module load).

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive heartbeat: RYA-698 — tracked session / cooldown / open-issue guards block respawn',
}), () => {
  const TMP_HOME = '/tmp/test-aos-rya698';
  const origHome = process.env.HOME;
  const stateFile = join(TMP_HOME, '.aos', 'proactive', 'state.json');

  function writeState(state: ProactiveState) {
    mkdirSync(join(TMP_HOME, '.aos', 'proactive'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  function readState(): ProactiveState {
    return JSON.parse(readFileSync(stateFile, 'utf-8'));
  }

  async function freshHeartbeat(): Promise<typeof proactiveChannelHeartbeat> {
    vi.resetModules();
    const mod = await import('../serve/proactive.js');
    return mod.proactiveChannelHeartbeat;
  }

  const origProactiveEnabled = process.env.AOS_PROACTIVE_ENABLED;

  beforeEach(() => {
    process.env.HOME = TMP_HOME;
    // Heartbeat is opt-in (default off) since 2026-05-06; tests must enable it
    // to exercise the spawn/cooldown/guard logic.
    process.env.AOS_PROACTIVE_ENABLED = '1';
    if (existsSync(join(TMP_HOME, '.aos', 'proactive'))) {
      rmSync(join(TMP_HOME, '.aos', 'proactive'), { recursive: true, force: true });
    }
    mockReadClientIssue.mockReset();
    mockAgentCreateIssue.mockReset();
    mockGetActiveAttempts.mockReset();
    mockGetAttemptsByIssue.mockReset();
    mockGetActiveAttempts.mockReturnValue([]);
    mockGetAttemptsByIssue.mockReturnValue([]);
    mockAgentCreateIssue.mockResolvedValue({ success: false });
    // Default: live parent, no children
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-362',
      trashed: null,
      archivedAt: null,
      children: async () => ({ nodes: [] }),
    });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origProactiveEnabled === undefined) delete process.env.AOS_PROACTIVE_ENABLED;
    else process.env.AOS_PROACTIVE_ENABLED = origProactiveEnabled;
  });

  function cooCreateCalls(): unknown[][] {
    return mockAgentCreateIssue.mock.calls.filter((c: unknown[]) => {
      const arg = c[0] as { title?: string } | undefined;
      return typeof arg?.title === 'string' && arg.title.includes('coo:');
    });
  }

  it('does NOT spawn a new coo issue when the tracked proactive session is still running', async () => {
    writeState({
      parentIssueKey: 'RYA-362',
      parentIssueId: 'parent-uuid',
      activeChannels: {
        coo: {
          issueKey: 'RYA-680',
          issueId: 'uuid-680',
          startedAt: '2026-04-23T00:00:00.000Z',
          lastHeartbeatAt: '2026-04-23T00:00:00.000Z',
        },
      },
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    });
    mockGetActiveAttempts.mockReturnValue([
      makeAttempt({ issue_key: 'RYA-680', agent_type: 'coo', status: 'running' }),
    ]);

    const heartbeat = await freshHeartbeat();
    await heartbeat();

    expect(cooCreateCalls().length).toBe(0);
    // lastHeartbeatAt bumped on tracked channel.
    expect(new Date(readState().activeChannels.coo.lastHeartbeatAt).getTime())
      .toBeGreaterThan(new Date('2026-04-23T00:00:00.000Z').getTime());
  });

  it('skips spawn after 3 consecutive failed attempts (cool-down active)', async () => {
    writeState({
      parentIssueKey: 'RYA-362',
      parentIssueId: 'parent-uuid',
      activeChannels: {
        coo: {
          issueKey: 'RYA-697',
          issueId: 'uuid-697',
          startedAt: '2026-04-23T00:00:00.000Z',
          lastHeartbeatAt: '2026-04-23T00:00:00.000Z',
          consecutiveFailures: 2,
        },
      },
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    });
    mockGetActiveAttempts.mockReturnValue([]);
    mockGetAttemptsByIssue.mockImplementation((k: string) =>
      k === 'RYA-697'
        ? [makeAttempt({
            issue_key: 'RYA-697',
            agent_type: 'coo',
            status: 'failed',
            error_log: 'Rate limited at startup (/rate-limit-options prompt)',
            completed_at: '2026-04-23T00:05:00.000Z',
          })]
        : []
    );

    const heartbeat = await freshHeartbeat();
    await heartbeat();

    const s = readState();
    expect(s.activeChannels.coo.consecutiveFailures).toBe(3);
    expect(s.activeChannels.coo.cooldownUntil).toBeTruthy();
    expect(new Date(s.activeChannels.coo.cooldownUntil!).getTime()).toBeGreaterThan(Date.now());
    expect(cooCreateCalls().length).toBe(0);
  });

  it('skips spawn when Linear already has an open [proactive] issue for the role today (state-loss recovery)', async () => {
    writeState({
      parentIssueKey: 'RYA-362',
      parentIssueId: 'parent-uuid',
      activeChannels: {},
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    });
    mockGetActiveAttempts.mockReturnValue([]);
    const today = new Date().toISOString().split('T')[0];
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-362',
      trashed: null,
      archivedAt: null,
      children: async () => ({
        nodes: [
          {
            identifier: 'RYA-697',
            title: `[proactive] coo: Strategic exploration (${today})`,
            state: Promise.resolve({ name: 'In Progress' }),
          },
        ],
      }),
    });

    const heartbeat = await freshHeartbeat();
    await heartbeat();

    expect(cooCreateCalls().length).toBe(0);
  });

  // RYA-831: title-format mismatch let dupes slip past the dedupe.
  // Old issues used date format "(YYYY-MM-DD)"; current code uses ISO-week
  // "(YYYY-Wnn)". The prefix-match guard must catch BOTH so a switch in the
  // suffix scheme never silently re-opens the spawn floodgate.
  it('skips spawn when an open issue uses the OLD date-format title (prefix match)', async () => {
    writeState({
      parentIssueKey: 'RYA-362',
      parentIssueId: 'parent-uuid',
      activeChannels: {},
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    });
    mockGetActiveAttempts.mockReturnValue([]);
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-362',
      trashed: null,
      archivedAt: null,
      children: async () => ({
        nodes: [
          {
            identifier: 'RYA-820',
            // Old date-suffix format — a stuck issue from before the
            // week-key rollout. Prefix match must still see it.
            title: '[proactive] coo: Strategic exploration (2026-04-23)',
            state: Promise.resolve({ name: 'In Progress' }),
          },
        ],
      }),
    });

    const heartbeat = await freshHeartbeat();
    await heartbeat();

    expect(cooCreateCalls().length).toBe(0);
  });
});

// ─── RYA-912: same-role same-day cap & parent-hub same-week dedupe ───────────

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive scheduler: RYA-912 — same-role same-day cap blocks Done/Canceled cycle respawns',
}), () => {
  beforeEach(() => {
    mockReadClientIssues.mockReset();
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
  });

  it('returns true when ANY recent issue exists, regardless of state (Done counts)', async () => {
    mockReadClientIssues.mockResolvedValue({
      nodes: [
        {
          identifier: 'RYA-892',
          createdAt: '2026-05-06T08:00:00.000Z',
          // Done state — would NOT be caught by hasOpenProactiveIssueForRole
        },
      ],
    });
    const now = Date.parse('2026-05-06T18:00:00.000Z');
    expect(await hasRecentDispatchForRole('cpo', 24 * 60 * 60_000, now)).toBe(true);
  });

  it('returns true for a Canceled recent issue (the W19 RYA-897 case)', async () => {
    mockReadClientIssues.mockResolvedValue({
      nodes: [{ identifier: 'RYA-897', createdAt: '2026-05-06T11:00:00.000Z' }],
    });
    const now = Date.parse('2026-05-06T18:00:00.000Z');
    expect(await hasRecentDispatchForRole('cpo', 24 * 60 * 60_000, now)).toBe(true);
  });

  it('returns false when no issues match the role prefix', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    expect(await hasRecentDispatchForRole('cpo')).toBe(false);
  });

  it('passes correct filter: title startsWith prefix + createdAt gte cutoff', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    const now = Date.parse('2026-05-06T18:00:00.000Z');
    const windowMs = 24 * 60 * 60_000;
    await hasRecentDispatchForRole('cpo', windowMs, now);
    const callArg = (mockReadClientIssues.mock.calls[0] as unknown[] | undefined)?.[0] as {
      filter: { title: { startsWith: string }; createdAt: { gte: string } };
    };
    expect(callArg.filter.title.startsWith).toBe('[proactive] cpo: Strategic exploration');
    expect(callArg.filter.createdAt.gte).toBe(new Date(now - windowMs).toISOString());
  });

  it('respects custom window (env-configurable AOS_PROACTIVE_SAME_DAY_CAP_MS)', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    const now = Date.parse('2026-05-06T18:00:00.000Z');
    const customWindow = 6 * 60 * 60_000; // 6 hours
    await hasRecentDispatchForRole('cpo', customWindow, now);
    const callArg = (mockReadClientIssues.mock.calls[0] as unknown[] | undefined)?.[0] as {
      filter: { createdAt: { gte: string } };
    };
    expect(callArg.filter.createdAt.gte).toBe(new Date(now - customWindow).toISOString());
  });

  it('RYA-1032: fails CLOSED (returns true) on rate-limit so the heartbeat does not spawn duplicates', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('Linear 429: Rate limit exceeded'));
    expect(await hasRecentDispatchForRole('cpo')).toBe(true);
  });

  it('RYA-1032: fails CLOSED (returns true) on network errors (ECONNRESET / ETIMEDOUT / fetch failed)', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    expect(await hasRecentDispatchForRole('cpo')).toBe(true);

    mockReadClientIssues.mockReset();
    mockReadClientIssues.mockRejectedValue(new Error('ETIMEDOUT connecting to api.linear.app'));
    expect(await hasRecentDispatchForRole('cpo')).toBe(true);
  });

  it('still fails open (returns false) on non-transient Linear errors so the open-issue guards remain the fallback', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('GraphQL: invalid filter argument'));
    expect(await hasRecentDispatchForRole('cpo')).toBe(false);
  });
});

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive scheduler: RYA-912 — parent-hub same-week dedupe blocks phantom hub respawn',
}), () => {
  beforeEach(() => {
    mockReadClientIssues.mockReset();
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
  });

  it('returns true when a Canceled hub was created within the dedupe window', async () => {
    mockReadClientIssues.mockResolvedValue({
      nodes: [{ identifier: 'RYA-908', createdAt: '2026-05-06T08:00:00.000Z' }],
    });
    const now = Date.parse('2026-05-06T18:00:00.000Z');
    expect(await hasRecentParentHub(7 * 24 * 60 * 60_000, now)).toBe(true);
  });

  it('returns false when no hub has been created within the window', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    expect(await hasRecentParentHub()).toBe(false);
  });

  it('passes correct filter: exact title match + createdAt gte cutoff', async () => {
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
    const now = Date.parse('2026-05-06T18:00:00.000Z');
    const windowMs = 7 * 24 * 60 * 60_000;
    await hasRecentParentHub(windowMs, now);
    const callArg = (mockReadClientIssues.mock.calls[0] as unknown[] | undefined)?.[0] as {
      filter: { title: { eq: string }; createdAt: { gte: string } };
    };
    expect(callArg.filter.title.eq).toBe('Proactive: Strategic Exploration Hub');
    expect(callArg.filter.createdAt.gte).toBe(new Date(now - windowMs).toISOString());
  });

  it('RYA-1032: fails CLOSED (returns true) on rate-limit / network errors', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('429 Too Many Requests'));
    expect(await hasRecentParentHub()).toBe(true);

    mockReadClientIssues.mockReset();
    mockReadClientIssues.mockRejectedValue(new Error('fetch failed'));
    expect(await hasRecentParentHub()).toBe(true);
  });

  it('still fails open (returns false) on non-transient Linear errors', async () => {
    mockReadClientIssues.mockRejectedValue(new Error('GraphQL syntax error'));
    expect(await hasRecentParentHub()).toBe(false);
  });
});

// ─── RYA-912 heartbeat integration: same-day cap blocks the second dispatch ──

describe(evalTag({
  failurePattern: 0,
  category: 'proactive',
  severity: 'critical',
  behavior: 'Proactive heartbeat: RYA-912 — same-role same-day cap blocks Done/Canceled cycle respawn',
}), () => {
  const TMP_HOME = '/tmp/test-aos-rya912';
  const origHome = process.env.HOME;
  const stateFile = join(TMP_HOME, '.aos', 'proactive', 'state.json');

  function writeState(state: ProactiveState) {
    mkdirSync(join(TMP_HOME, '.aos', 'proactive'), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }

  async function freshHeartbeat(): Promise<typeof proactiveChannelHeartbeat> {
    vi.resetModules();
    const mod = await import('../serve/proactive.js');
    return mod.proactiveChannelHeartbeat;
  }

  beforeEach(() => {
    process.env.HOME = TMP_HOME;
    if (existsSync(join(TMP_HOME, '.aos', 'proactive'))) {
      rmSync(join(TMP_HOME, '.aos', 'proactive'), { recursive: true, force: true });
    }
    mockReadClientIssue.mockReset();
    mockReadClientIssues.mockReset();
    mockAgentCreateIssue.mockReset();
    mockGetActiveAttempts.mockReset();
    mockGetAttemptsByIssue.mockReset();
    mockGetActiveAttempts.mockReturnValue([]);
    mockGetAttemptsByIssue.mockReturnValue([]);
    mockAgentCreateIssue.mockResolvedValue({ success: false });
    mockReadClientIssue.mockResolvedValue({
      id: 'parent-uuid',
      identifier: 'RYA-362',
      trashed: null,
      archivedAt: null,
      children: async () => ({ nodes: [] }),
    });
    mockReadClientIssues.mockResolvedValue({ nodes: [] });
  });

  afterEach(() => {
    process.env.HOME = origHome;
  });

  function cpoCreateCalls(): unknown[][] {
    return mockAgentCreateIssue.mock.calls.filter((c: unknown[]) => {
      const arg = c[0] as { title?: string } | undefined;
      return typeof arg?.title === 'string' && arg.title.includes('cpo:');
    });
  }

  it('skips spawn when a Done [proactive] issue for the role was created today (W19 RYA-892 case)', async () => {
    writeState({
      parentIssueKey: 'RYA-362',
      parentIssueId: 'parent-uuid',
      activeChannels: {},
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    });
    // Existing recent dispatch — Done state, would NOT be caught by the
    // existing open-issue guards. Only the new same-day cap catches it.
    mockReadClientIssues.mockImplementation((async (args: unknown) => {
      const a = args as { filter: { createdAt?: unknown; title?: { eq?: string } } };
      // Hub dedupe lookup → match on `title.eq` to the canonical hub title.
      if (a.filter.title?.eq === 'Proactive: Strategic Exploration Hub') {
        return { nodes: [] };
      }
      // hasRecentDispatchForRole lookup uses createdAt filter.
      if (a.filter.createdAt) {
        return {
          nodes: [{ identifier: 'RYA-892', createdAt: new Date(Date.now() - 60 * 60_000).toISOString() }],
        };
      }
      return { nodes: [] };
    }) as () => Promise<{ nodes: unknown[] }>);

    const heartbeat = await freshHeartbeat();
    await heartbeat();

    // Same-day cap blocked the spawn — no createIssue calls for cpo.
    expect(cpoCreateCalls().length).toBe(0);
  });
});
