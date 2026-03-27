import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all external dependencies
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ imacHost: 'test-host', stateDir: '/tmp/aos-test' }),
  resolveWorkspace: vi.fn((_key: string, _proj?: string) => `/tmp/workspaces/TEST-1`),
}));

vi.mock('../core/persona.js', () => ({
  loadPersona: vi.fn(() => ({
    config: { baseModel: 'cc' },
    systemPrompt: 'test prompt',
  })),
  buildGroundingPrompt: vi.fn(() => 'grounding prompt'),
  getAgentLinearToken: vi.fn(() => 'test-token'),
}));

vi.mock('../core/linear.js', () => ({
  emitActivity: vi.fn(async () => {}),
  hasAgentAccess: vi.fn(() => true),
}));

vi.mock('../core/db.js', () => ({
  createAttempt: vi.fn(),
}));

vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  killSession: vi.fn(),
}));

vi.mock('../adapters/index.js', () => ({
  getAdapter: vi.fn(() => ({
    spawn: vi.fn(async () => ({ tmuxSession: 'aos-cto-TEST-1' })),
  })),
}));

vi.mock('./helpers.js', () => ({
  downloadCommentImages: vi.fn(async (body: string) => ({
    text: body,
    imagePaths: [],
  })),
}));

import { spawnFollowUp } from './follow-up.js';
import { createAttempt } from '../core/db.js';
import { emitActivity } from '../core/linear.js';
import { sessionExists, killSession } from '../core/tmux.js';
import { getAdapter } from '../adapters/index.js';
import { followUpMeta, spawnClaims } from './state.js';
import { downloadCommentImages } from './helpers.js';

describe('spawnFollowUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    followUpMeta.clear();
    spawnClaims.clear();
  });

  const baseOpts = {
    agentRole: 'cto',
    issueKey: 'TEST-1',
    issueId: 'issue-uuid-1',
    issueTitle: 'Test issue',
    issueState: 'In Review',
    userMessage: 'How does this work?',
  };

  it('spawns adapter with correct follow-up prompt', async () => {
    const result = await spawnFollowUp(baseOpts);

    const adapter = (getAdapter as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(adapter.spawn).toHaveBeenCalledOnce();
    const spawnCall = adapter.spawn.mock.calls[0][0];
    expect(spawnCall.issueKey).toBe('TEST-1');
    expect(spawnCall.agentRole).toBe('cto');
    expect(spawnCall.isFollowUp).toBe(true);
    expect(spawnCall.initialPrompt).toContain('How does this work?');
    expect(spawnCall.initialPrompt).toContain('CONVERSATION, not a task');
    expect(result).not.toBeNull();
    expect(result!.attemptId).toBeTruthy();
  });

  it('includes "already completed" note for Done/In Review issues', async () => {
    await spawnFollowUp({ ...baseOpts, issueState: 'Done' });

    const adapter = (getAdapter as ReturnType<typeof vi.fn>).mock.results[0].value;
    const prompt = adapter.spawn.mock.calls[0][0].initialPrompt;
    expect(prompt).toContain('already completed, do NOT re-do the task');
  });

  it('omits "already completed" note for active issues', async () => {
    await spawnFollowUp({ ...baseOpts, issueState: 'In Progress' });

    const adapter = (getAdapter as ReturnType<typeof vi.fn>).mock.results[0].value;
    const prompt = adapter.spawn.mock.calls[0][0].initialPrompt;
    expect(prompt).not.toContain('already completed');
  });

  it('creates attempt with agentSessionId when provided', async () => {
    await spawnFollowUp({ ...baseOpts, agentSessionId: 'session-123' });

    expect(createAttempt).toHaveBeenCalledWith(expect.objectContaining({
      agent_session_id: 'session-123',
      issue_key: 'TEST-1',
      agent_type: 'cto',
    }));
  });

  it('emits activity on agentSessionId when provided', async () => {
    await spawnFollowUp({ ...baseOpts, agentSessionId: 'session-123' });

    expect(emitActivity).toHaveBeenCalledWith(
      'session-123',
      expect.objectContaining({ type: 'thought' }),
      false,
      'test-token',
    );
  });

  it('does not emit activity when no agentSessionId', async () => {
    await spawnFollowUp(baseOpts);

    expect(emitActivity).not.toHaveBeenCalled();
  });

  it('tracks followUpMeta when commentId is provided', async () => {
    const result = await spawnFollowUp({ ...baseOpts, commentId: 'comment-abc' });

    expect(result).not.toBeNull();
    expect(followUpMeta.has(result!.attemptId)).toBe(true);
    expect(followUpMeta.get(result!.attemptId)?.commentId).toBe('comment-abc');
  });

  it('does not track followUpMeta when no commentId', async () => {
    const result = await spawnFollowUp(baseOpts);

    expect(result).not.toBeNull();
    expect(followUpMeta.has(result!.attemptId)).toBe(false);
  });

  it('kills stale tmux session before spawning', async () => {
    vi.mocked(sessionExists).mockReturnValue(true);

    await spawnFollowUp(baseOpts);

    expect(killSession).toHaveBeenCalledWith('aos-cto');
  });

  it('skips image download when imagePaths are pre-provided', async () => {
    await spawnFollowUp({
      ...baseOpts,
      imagePaths: ['/tmp/img1.png'],
    });

    expect(downloadCommentImages).not.toHaveBeenCalled();
    const adapter = (getAdapter as ReturnType<typeof vi.fn>).mock.results[0].value;
    const prompt = adapter.spawn.mock.calls[0][0].initialPrompt;
    expect(prompt).toContain('1 image(s)');
    expect(prompt).toContain('/tmp/img1.png');
  });

  it('downloads images when none pre-provided', async () => {
    await spawnFollowUp(baseOpts);

    expect(downloadCommentImages).toHaveBeenCalledWith(
      'How does this work?',
      '/tmp/workspaces/TEST-1',
    );
  });

  it('deduplicates concurrent spawn calls for the same issue', async () => {
    const result1 = await spawnFollowUp(baseOpts);
    const result2 = await spawnFollowUp(baseOpts);

    expect(result1).not.toBeNull();
    expect(result2).toBeNull();
    // Adapter should only be called once
    const adapter = (getAdapter as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(adapter.spawn).toHaveBeenCalledTimes(1);
  });

  it('allows spawns for different issues', async () => {
    const result1 = await spawnFollowUp(baseOpts);
    const result2 = await spawnFollowUp({ ...baseOpts, issueKey: 'TEST-2' });

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
  });
});
