import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks must be declared before the module under test is imported.
vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(),
  getAgentClient: vi.fn(() => ({ updateIssue: mockAgentClientUpdateIssue })),
  getReadClient: vi.fn(() => ({ updateIssue: vi.fn(async () => {}), issueLabels: vi.fn(async () => ({ nodes: [] })) })),
}));

const mockAgentClientUpdateIssue = vi.fn(async () => {});

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc', linearUserId: 'agent-user-uuid' })),
}));

vi.mock('../commands/spawn.js', () => ({
  spawnCommand: vi.fn(async () => {}),
}));

vi.mock('../commands/agent.js', () => ({
  agentStartCommand: vi.fn(async () => 'started'),
}));

vi.mock('./planner.js', () => ({
  planAndDispatch: vi.fn(async () => ({ createdIssues: [] })),
}));

vi.mock('./state.js', () => ({
  handledSessions: new Map<string, number>(),
  DEDUP_WINDOW_MS: 60_000,
  persistentDedupCheck: vi.fn(() => false),
  persistentDedupRecord: vi.fn(),
  autoRoutedSpawns: new Map(),
}));

vi.mock('./helpers.js', () => ({
  getAgentUserIds: vi.fn(() => new Set(['creator-uuid'])),
  getAgentRoleByUserId: vi.fn(() => 'cto'),
}));

import { handleIssueCreated } from './issues.js';
import { agentStartCommand } from '../commands/agent.js';
import { spawnCommand } from '../commands/spawn.js';
import { handledSessions } from './state.js';

function createdPayload(identifier: string, title: string) {
  return {
    action: 'create',
    data: {
      id: `${identifier}-uuid`,
      identifier,
      title,
      creatorId: 'creator-uuid',
    },
  };
}

describe('handleIssueCreated — [to decide] guard (RYA-1231)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (handledSessions as Map<string, number>).clear();
  });

  it('does NOT auto-route agent-created issues titled [to decide]', async () => {
    await handleIssueCreated(createdPayload('RYA-9001', '[to decide] Push commit X to public repo'));

    expect(agentStartCommand).not.toHaveBeenCalled();
    expect(spawnCommand).not.toHaveBeenCalled();
    expect(mockAgentClientUpdateIssue).not.toHaveBeenCalled();
  });

  it('is case-insensitive and tolerates leading whitespace', async () => {
    await handleIssueCreated(createdPayload('RYA-9002', '  [TO DECIDE] Budget approval'));

    expect(agentStartCommand).not.toHaveBeenCalled();
    expect(spawnCommand).not.toHaveBeenCalled();
  });

  it('still auto-routes normal agent-created issues to the creator role', async () => {
    await handleIssueCreated(createdPayload('RYA-9003', 'Fix: flaky integration test'));

    expect(agentStartCommand).toHaveBeenCalledWith('cto', 'RYA-9003');
  });

  it('does not block titles that merely mention [to decide] mid-string', async () => {
    await handleIssueCreated(createdPayload('RYA-9004', 'Fix: "[to decide]" prefix handling'));

    expect(agentStartCommand).toHaveBeenCalledWith('cto', 'RYA-9004');
  });
});
