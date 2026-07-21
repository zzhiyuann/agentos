import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks must be declared before the module under test is imported.
vi.mock('../core/config.js', () => ({
  getConfig: vi.fn(() => ({ workspaceBase: '/tmp/ws' })),
  resolveWorkspace: vi.fn(() => '/tmp/ws/RYA-0'),
  resolveStatePath: vi.fn(() => '/tmp/state/RYA-0/HANDOFF.md'),
}));

vi.mock('../core/linear.js', () => ({
  emitActivity: vi.fn(async () => {}),
  getIssue: vi.fn(),
  dismissAgentSession: vi.fn(async () => {}),
  getLatestUserComment: vi.fn(async () => null),
}));

vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
  getActiveAttempt: vi.fn(() => undefined),
  getIdleAttempt: vi.fn(() => undefined),
  getAttemptsByIssue: vi.fn(() => []),
  updateAttemptStatus: vi.fn(),
  updateAttemptAgentSession: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../core/tmux.js', () => ({
  readFileOnRemote: vi.fn(() => null),
  sessionExists: vi.fn(() => false),
  sendKeys: vi.fn(),
}));

vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  getAgentLinearToken: vi.fn(() => 'tok'),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc', linearUserId: 'agent-user-uuid' })),
  listAgents: vi.fn(() => ['cto']),
  buildAgentRoleRegex: vi.fn(() => /@(cto|coo|cpo|ceo-office|lead-engineer|research-lead)\b/i),
  normalizeAgentRole: vi.fn((s: string) => s),
}));

vi.mock('../commands/spawn.js', () => ({
  spawnCommand: vi.fn(async () => {}),
}));

vi.mock('../commands/agent.js', () => ({
  agentStartCommand: vi.fn(async () => 'started'),
}));

vi.mock('./state.js', () => ({
  handledSessions: new Map<string, number>(),
  followUpMeta: new Map(),
  activeFollowUpLock: new Map(),
  DEDUP_WINDOW_MS: 60_000,
  reactivatedAt: new Map(),
  reactivationContext: new Map(),
  checkAndRecordDedup: vi.fn(() => false),
  persistentDedupCheck: vi.fn(() => false),
  persistentDedupRecord: vi.fn(),
}));

vi.mock('./helpers.js', () => ({
  resolveAgentForIssue: vi.fn(() => 'cto'),
  resolveAgentFromWebhook: vi.fn(() => 'cto'),
  hasExplicitRouting: vi.fn(() => true),
  getAgentUserIds: vi.fn(() => new Set<string>()),
  getAgentRoleByUserId: vi.fn(() => undefined),
  isAgentOrSystemComment: vi.fn(() => false),
  downloadCommentImages: vi.fn(async (text: string) => ({ text, imagePaths: [] })),
  wrapFollowUpMessage: vi.fn((_k: string, m: string) => m),
}));

vi.mock('./follow-up.js', () => ({
  spawnFollowUp: vi.fn(async () => {}),
}));

vi.mock('./circuit-breaker.js', () => ({
  checkCircuitBreaker: vi.fn(() => ({ tripped: false })),
  tripCircuitBreaker: vi.fn(async () => {}),
}));

vi.mock('./session-manager.js', () => ({
  resolveSession: vi.fn(() => ({ action: 'spawn', useContinue: false })),
}));

// The predicate itself is unit-tested in dispatch.test.ts; here we test the
// webhook wiring, so a faithful inline mock avoids dispatch.ts's heavy imports.
vi.mock('./dispatch.js', () => ({
  isToDecidePrefix: (title: string | undefined | null) => /^\s*\[to decide\]/i.test(title || ''),
}));

import { handleWebhook } from './webhook.js';
import { getIssue, dismissAgentSession, getLatestUserComment } from '../core/linear.js';
import { agentStartCommand } from '../commands/agent.js';
import { spawnCommand } from '../commands/spawn.js';
import { spawnFollowUp } from './follow-up.js';
import { resolveSession } from './session-manager.js';
import { handledSessions } from './state.js';

function createdPayload(identifier: string, title: string, commentBody?: string) {
  return {
    action: 'created',
    type: 'AgentSession',
    agentSession: {
      id: `session-${identifier}`,
      status: 'pending',
      issue: { id: `${identifier}-uuid`, identifier, title },
      ...(commentBody ? { comment: { id: 'comment-1', body: commentBody } } : {}),
    },
  };
}

describe('handleWebhook — [to decide] guard on AgentSession created (RYA-1237)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (handledSessions as Map<string, number>).clear();
    vi.mocked(getIssue).mockResolvedValue({
      id: 'issue-uuid', state: 'Backlog', title: 't', labels: [], project: undefined,
      delegateId: undefined, assigneeId: undefined, description: '',
    } as any);
  });

  it('does NOT spawn a task session for a [to decide] issue; dismisses the session', async () => {
    await handleWebhook(createdPayload('RYA-9101', '[to decide] Ratify private repo flips') as any);

    expect(resolveSession).not.toHaveBeenCalled();
    expect(agentStartCommand).not.toHaveBeenCalled();
    expect(spawnCommand).not.toHaveBeenCalled();
    expect(dismissAgentSession).toHaveBeenCalledWith(
      'session-RYA-9101', undefined, expect.stringContaining('awaiting CEO decision'),
    );
  });

  it('is case-insensitive and tolerates leading whitespace', async () => {
    await handleWebhook(createdPayload('RYA-9102', '  [TO DECIDE] Budget approval') as any);

    expect(resolveSession).not.toHaveBeenCalled();
    expect(agentStartCommand).not.toHaveBeenCalled();
  });

  it('still spawns normal issues through resolveSession', async () => {
    await handleWebhook(createdPayload('RYA-9103', 'Fix: flaky integration test') as any);

    expect(resolveSession).toHaveBeenCalled();
    expect(agentStartCommand).toHaveBeenCalledWith('cto', 'RYA-9103', expect.objectContaining({
      webhookSessionId: 'session-RYA-9103',
    }));
  });

  it('does not block titles that merely mention [to decide] mid-string', async () => {
    await handleWebhook(createdPayload('RYA-9104', 'Fix: "[to decide]" prefix handling') as any);

    expect(resolveSession).toHaveBeenCalled();
    expect(agentStartCommand).toHaveBeenCalled();
  });

  it('still allows follow-up Q&A on a completed [to decide] issue', async () => {
    vi.mocked(getIssue).mockResolvedValue({
      id: 'issue-uuid', state: 'Done', title: 't', labels: [], project: undefined,
      delegateId: undefined, assigneeId: undefined, description: '',
    } as any);
    vi.mocked(getLatestUserComment).mockResolvedValue({
      body: '@cto what made this unsafe?', threadRootId: 'thread-1',
    } as any);

    await handleWebhook(createdPayload('RYA-9105', '[to decide] Purge git history?', '@cto what made this unsafe?') as any);

    expect(spawnFollowUp).toHaveBeenCalledWith(expect.objectContaining({
      agentRole: 'cto', issueKey: 'RYA-9105',
    }));
  });
});
