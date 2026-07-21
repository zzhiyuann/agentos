import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock external dependencies so importing monitor.js (for
// replayPendingHandoffActions) stays hermetic — same setup as monitor.test.ts,
// plus dispatch.js so replayed dispatches are observable.
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
  resolveStatePath: vi.fn(),
  getIssueStateDir: vi.fn(() => '/tmp/aos-test/work'),
}));
vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(async () => ({ id: 'issue-uuid', title: 'Test issue', description: '' })),
  hasAgentAccess: vi.fn(() => true),
  emitActivity: vi.fn(),
  addComment: vi.fn(),
  updateIssueState: vi.fn(),
  createIssueDocument: vi.fn(),
  createIssueAttachment: vi.fn(),
  dismissAgentSession: vi.fn(),
  generateHandoffSummary: vi.fn(() => 'summary'),
  getRecentCommentBodies: vi.fn(async () => []),
  closeActiveSessionsForIssue: vi.fn(async () => {}),
  getAgentCommentCountSince: vi.fn(() => 0),
  addLabelToIssue: vi.fn(),
}));
vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
  getActiveAttempt: vi.fn(),
  getIdleAttempts: vi.fn(() => []),
  getAttemptsByIssue: vi.fn(() => []),
  getRecentAttemptsByAgent: vi.fn(() => []),
  updateAttemptStatus: vi.fn(),
  logEvent: vi.fn(),
  getCompletedWithTmux: vi.fn(() => []),
  clearAttemptTmuxSession: vi.fn(),
  getHibernatedAttempts: vi.fn(() => []),
}));
// Quality gate runs inside monitorSessions Case 1 before the journal write —
// mock it to pass so the dedup-exit test below reaches the claim/journal path.
vi.mock('./quality-gate.js', () => ({
  evaluateHandoff: vi.fn(() => ({ pass: true, failures: [] })),
  qualityGateMode: vi.fn(() => 'warn'),
  qualityGateDecision: vi.fn(() => 'warn'),
  formatGateFailures: vi.fn(() => ''),
}));
vi.mock('../core/tmux.js', () => ({
  sessionExists: vi.fn(() => false),
  readFileOnRemote: vi.fn(() => null),
  capturePane: vi.fn(() => ''),
  killSession: vi.fn(),
  sendKeys: vi.fn(),
}));
vi.mock('../core/persona.js', () => ({
  agentExists: vi.fn(() => true),
  getAgentLinearToken: vi.fn(() => 'test-token'),
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc', linearUserId: 'user-1' })),
  listAgents: vi.fn(() => ['cto', 'coo', 'lead-engineer']),
}));
vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
  setCooldown: vi.fn(),
  cancelQueuedByRole: vi.fn(),
  getQueueItems: vi.fn(() => []),
}));
vi.mock('./state.js', () => ({
  reportedHandoffs: new Set(),
  trustPromptHandled: new Set(),
  followUpMeta: new Map(),
  FOLLOW_UP_TTL_MS: 600_000,
  reactivatedAt: new Map(),
  reactivationContext: new Map(),
  discordSourceContext: new Map(),
  DISCORD_SOURCE_TTL_MS: 3_600_000,
  gcStateMaps: vi.fn(),
  persistentDedupCheck: vi.fn(() => false),
  persistentDedupRecord: vi.fn(),
}));
vi.mock('./dispatch.js', () => ({
  handleDispatch: vi.fn(async () => ({ ok: true, action: 'started' })),
}));
vi.mock('./helpers.js', () => ({
  postToGroupChat: vi.fn(),
  handoffContentHash: vi.fn(() => 'hash'),
  isHandoffAlreadyPosted: vi.fn(async () => false),
  countConsecutiveRateLimitFailures: vi.fn(() => 0),
  getRateLimitBackoffMs: vi.fn(() => 0),
  RATE_LIMIT_ESCALATION_MARKER: '🚨 RATE LIMIT',
}));
vi.mock('./discord-bot.js', () => ({
  sendDiscordReply: vi.fn(async () => true),
}));

import { replayPendingHandoffActions, monitorSessions } from './monitor.js';
import type { HandoffActions } from './monitor.js';
import {
  journalPendingActions, listPendingActions, PendingActionsEntry,
} from './action-journal.js';
import { handleDispatch } from './dispatch.js';
import { persistentDedupCheck, persistentDedupRecord } from './state.js';
import { getActiveAttempts, logEvent } from '../core/db.js';
import { resolveStatePath } from '../core/config.js';
import { readFileOnRemote } from '../core/tmux.js';
import { isHandoffAlreadyPosted } from './helpers.js';

function actions(overrides: Partial<HandoffActions> = {}): HandoffActions {
  return {
    statusIntent: { status: 'in-review' },
    dispatches: [],
    delegate: null,
    parentStatus: null,
    reviewDispatch: null,
    reviewLevel: null,
    ...overrides,
  };
}

function entry(overrides: Partial<PendingActionsEntry> = {}): PendingActionsEntry {
  return {
    version: 1,
    attemptId: `attempt-${Math.random().toString(36).slice(2)}`,
    issueKey: 'RYA-10',
    issueId: 'issue-uuid-10',
    agentType: 'lead-engineer',
    isFollowUp: false,
    actions: actions(),
    handoff: '---\nstatus_intent: in-review\n---\n# HANDOFF — RYA-10\n## Summary\nDid the thing.',
    createdAt: Date.now(),
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aos-action-replay-'));
  process.env.AOS_PENDING_ACTIONS_DIR = dir;
  vi.mocked(handleDispatch).mockClear();
  vi.mocked(persistentDedupCheck).mockClear().mockReturnValue(false);
  vi.mocked(persistentDedupRecord).mockClear();
  vi.mocked(logEvent).mockClear();
});

afterEach(() => {
  delete process.env.AOS_PENDING_ACTIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('replayPendingHandoffActions', () => {
  it('is a no-op on an empty journal', async () => {
    await expect(replayPendingHandoffActions()).resolves.toBeUndefined();
    expect(handleDispatch).not.toHaveBeenCalled();
  });

  it('replays journaled dispatches and acks the entry', async () => {
    const e = entry({
      actions: actions({
        statusIntent: { status: 'done' }, // no reviewer half — dispatch only
        dispatches: [{ role: 'coo', issue: 'RYA-11', context: 'deploy after merge' }],
      }),
    });
    journalPendingActions(e);

    await replayPendingHandoffActions();

    expect(handleDispatch).toHaveBeenCalledTimes(1);
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coo', issueKey: 'RYA-11', message: 'deploy after merge',
    }));
    // Acked: journal empty, idempotency markers recorded
    expect(listPendingActions()).toHaveLength(0);
    // Markers are scoped to attempt + content hash (mocked handoffContentHash → 'hash');
    // the exec-half marker is recorded right after execution (RYA-1207), the
    // full marker at ack.
    expect(persistentDedupRecord).toHaveBeenCalledWith(`handoff-actions-exec:${e.attemptId}:hash`);
    expect(persistentDedupRecord).toHaveBeenCalledWith(`handoff-actions:${e.attemptId}:hash`);
    expect(logEvent).toHaveBeenCalledWith(e.attemptId, 'handoff_actions_replayed', expect.any(Object));
  });

  it('skips the executed half when the exec marker exists but the entry is un-acked (RYA-1207)', async () => {
    // Crash window: executeHandoffActions finished (exec marker recorded) but
    // the process died before the reviewer-settled ack. Replay must NOT re-run
    // the dispatches (a new_issue dispatch would mint a duplicate sub-issue) —
    // only the reviewer half, which is safely re-runnable.
    const e = entry({
      actions: actions({
        dispatches: [{ role: 'coo', issue: 'RYA-14', context: 'x' }],
        reviewDispatch: 'cto',
      }),
    });
    journalPendingActions(e);
    vi.mocked(persistentDedupCheck).mockImplementation(
      (key: string) => key === `handoff-actions-exec:${e.attemptId}:hash`,
    );

    await replayPendingHandoffActions();

    // Only the reviewer dispatch ran — the coo dispatch was NOT replayed
    expect(handleDispatch).toHaveBeenCalledTimes(1);
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'cto', issueKey: 'RYA-10', from: 'monitor:auto-review',
    }));
    // Entry acked and the full marker recorded
    expect(listPendingActions()).toHaveLength(0);
    expect(persistentDedupRecord).toHaveBeenCalledWith(`handoff-actions:${e.attemptId}:hash`);
  });

  it('replays the review_dispatch half for non-follow-up in-review completions', async () => {
    const e = entry({ actions: actions({ reviewDispatch: 'cto' }) });
    journalPendingActions(e);

    await replayPendingHandoffActions();

    expect(handleDispatch).toHaveBeenCalledTimes(1);
    expect(handleDispatch).toHaveBeenCalledWith(expect.objectContaining({
      role: 'cto', issueKey: 'RYA-10', from: 'monitor:auto-review',
    }));
    expect(listPendingActions()).toHaveLength(0);
  });

  it('skips the reviewer half for follow-up entries and non-in-review intents', async () => {
    journalPendingActions(entry({ attemptId: 'a-followup', isFollowUp: true, actions: actions({ reviewDispatch: 'cto' }) }));
    journalPendingActions(entry({ attemptId: 'a-done', actions: actions({ statusIntent: { status: 'done' }, reviewDispatch: 'cto' }) }));

    await replayPendingHandoffActions();

    expect(handleDispatch).not.toHaveBeenCalled();
    expect(listPendingActions()).toHaveLength(0); // still acked — nothing left to do
  });

  it('skips entries whose actions were already applied (crash between execute and ack)', async () => {
    const e = entry({ actions: actions({ dispatches: [{ role: 'coo', issue: 'RYA-12', context: 'x' }] }) });
    journalPendingActions(e);
    vi.mocked(persistentDedupCheck).mockImplementation(
      (key: string) => key === `handoff-actions:${e.attemptId}:hash`,
    );

    await replayPendingHandoffActions();

    expect(handleDispatch).not.toHaveBeenCalled();
    expect(listPendingActions()).toHaveLength(0); // acked without re-executing
  });

  it('acks even when a dispatch fails (mirrors normal completion flow)', async () => {
    vi.mocked(handleDispatch).mockRejectedValue(new Error('linear down'));
    journalPendingActions(entry({
      actions: actions({ statusIntent: { status: 'done' }, dispatches: [{ role: 'coo', issue: 'RYA-13', context: 'x' }] }),
    }));

    await expect(replayPendingHandoffActions()).resolves.toBeUndefined();
    expect(listPendingActions()).toHaveLength(0);
  });

  it('acks the freshly journaled entry on the alreadyPosted dedup-exit (RYA-1207)', async () => {
    // The journal write must land BEFORE the isHandoffAlreadyPosted await
    // (claim→journal gap), and the dedup-exit must ack it so a deduped
    // handoff doesn't leave a phantom entry that replays on next startup.
    const attempt = {
      id: 'attempt-dedup-exit',
      issue_key: 'RYA-99',
      issue_id: 'issue-uuid-99',
      agent_type: 'lead-engineer',
      attempt_number: 1,
      tmux_session: 'aos-le-RYA-99',
      workspace_path: '/tmp/ws-rya-99',
      created_at: new Date().toISOString(),
      agent_session_id: null,
    };
    vi.mocked(getActiveAttempts).mockReturnValue([attempt] as never[]);
    vi.mocked(resolveStatePath).mockImplementation(
      (...callArgs: unknown[]) => `/tmp/aos-test/state/${callArgs[2]}`,
    );
    const handoffContent = [
      '---',
      'status_intent: done',
      'dispatches:',
      '  - role: coo',
      '    issue: RYA-98',
      '    context: "follow-on work"',
      '---',
      '# HANDOFF — RYA-99',
      '## Summary',
      'Did the thing end to end.',
    ].join('\n');
    vi.mocked(readFileOnRemote).mockImplementation(
      (path: unknown) => (typeof path === 'string' && path.endsWith('HANDOFF.md') ? handoffContent : null),
    );
    // Capture journal state at the moment of the Linear dedup call — proves
    // the entry was journaled before the await, not after.
    let journaledBeforeDedupCheck = -1;
    vi.mocked(isHandoffAlreadyPosted).mockImplementation(async () => {
      journaledBeforeDedupCheck = listPendingActions().length;
      return true;
    });

    try {
      await monitorSessions();

      expect(journaledBeforeDedupCheck).toBe(1);
      // Dedup-exit acked the entry — no phantom left for replay
      expect(listPendingActions()).toHaveLength(0);
      // And the deduped completion executed nothing
      expect(handleDispatch).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getActiveAttempts).mockReturnValue([]);
      vi.mocked(readFileOnRemote).mockReturnValue(null);
      vi.mocked(isHandoffAlreadyPosted).mockResolvedValue(false);
      vi.mocked(resolveStatePath).mockReset();
    }
  });

  it('replays multiple entries independently', async () => {
    journalPendingActions(entry({
      attemptId: 'a1', issueKey: 'RYA-20', issueId: 'id-20',
      actions: actions({ statusIntent: { status: 'done' }, dispatches: [{ role: 'coo', issue: 'RYA-21', context: 'one' }] }),
    }));
    journalPendingActions(entry({
      attemptId: 'a2', issueKey: 'RYA-30', issueId: 'id-30',
      actions: actions({ reviewDispatch: 'cto' }),
    }));

    await replayPendingHandoffActions();

    expect(handleDispatch).toHaveBeenCalledTimes(2);
    expect(listPendingActions()).toHaveLength(0);
  });
});
