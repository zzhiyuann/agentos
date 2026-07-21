import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock external dependencies so importing monitor.js (for the HandoffActions
// type used by the journal entries) stays hermetic — same setup as monitor.test.ts.
import { vi } from 'vitest';
vi.mock('../core/config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test', linearTeamId: 'test', linearTeamKey: 'RYA' }),
  resolveStatePath: vi.fn(),
  getIssueStateDir: vi.fn(() => '/tmp/aos-test/work'),
}));
vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(),
  hasAgentAccess: vi.fn(() => true),
  emitActivity: vi.fn(),
  addComment: vi.fn(),
  updateIssueState: vi.fn(),
  createIssueDocument: vi.fn(),
  dismissAgentSession: vi.fn(),
  generateHandoffSummary: vi.fn(() => 'summary'),
  getRecentCommentBodies: vi.fn(async () => []),
}));
vi.mock('../core/db.js', () => ({
  getActiveAttempts: vi.fn(() => []),
  getActiveAttempt: vi.fn(),
  getAttemptsByIssue: vi.fn(() => []),
  getRecentAttemptsByAgent: vi.fn(() => []),
  updateAttemptStatus: vi.fn(),
  logEvent: vi.fn(),
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
  loadAgentConfig: vi.fn(() => ({ baseModel: 'cc' })),
  listAgents: vi.fn(() => ['cto', 'coo', 'lead-engineer']),
}));
vi.mock('../core/queue.js', () => ({
  enqueue: vi.fn(),
  setCooldown: vi.fn(),
  cancelQueuedByRole: vi.fn(),
  getQueueItems: vi.fn(() => []),
}));
vi.mock('./helpers.js', () => ({
  postToGroupChat: vi.fn(),
  handoffContentHash: vi.fn(() => 'hash'),
  isHandoffAlreadyPosted: vi.fn(async () => false),
  countConsecutiveRateLimitFailures: vi.fn(() => 0),
  getRateLimitBackoffMs: vi.fn(() => 0),
  RATE_LIMIT_ESCALATION_MARKER: '🚨 RATE LIMIT',
}));

import {
  journalPendingActions, ackPendingActions, listPendingActions,
  PENDING_ACTIONS_MAX_AGE_MS, PendingActionsEntry,
} from './action-journal.js';
import type { HandoffActions } from './monitor.js';

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
    attemptId: 'attempt-1',
    issueKey: 'RYA-1',
    issueId: 'issue-uuid-1',
    agentType: 'lead-engineer',
    isFollowUp: false,
    actions: actions(),
    handoff: '---\nstatus_intent: in-review\n---\n# HANDOFF — RYA-1\n## Summary\nDid the thing.',
    createdAt: Date.now(),
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aos-action-journal-'));
  process.env.AOS_PENDING_ACTIONS_DIR = dir;
});

afterEach(() => {
  delete process.env.AOS_PENDING_ACTIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('journalPendingActions / listPendingActions / ackPendingActions', () => {
  it('round-trips an entry through write → list', () => {
    const e = entry({ actions: actions({ dispatches: [{ role: 'coo', issue: 'RYA-2', context: 'deploy it' }] }) });
    journalPendingActions(e);
    const listed = listPendingActions();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(e);
  });

  it('ack removes the entry and is idempotent', () => {
    journalPendingActions(entry());
    ackPendingActions('attempt-1');
    expect(listPendingActions()).toHaveLength(0);
    // Second ack (and ack of a never-journaled attempt) must not throw
    expect(() => ackPendingActions('attempt-1')).not.toThrow();
    expect(() => ackPendingActions('never-existed')).not.toThrow();
  });

  it('keys entries by attempt id — same attempt overwrites, different attempts coexist', () => {
    journalPendingActions(entry({ attemptId: 'a1', issueKey: 'RYA-1' }));
    journalPendingActions(entry({ attemptId: 'a1', issueKey: 'RYA-1-rewritten' }));
    journalPendingActions(entry({ attemptId: 'a2', issueKey: 'RYA-2' }));
    const listed = listPendingActions();
    expect(listed).toHaveLength(2);
    expect(listed.find(e => e.attemptId === 'a1')?.issueKey).toBe('RYA-1-rewritten');
  });

  it('drops and deletes entries older than the max age', () => {
    journalPendingActions(entry({ attemptId: 'old', createdAt: Date.now() - PENDING_ACTIONS_MAX_AGE_MS - 1000 }));
    journalPendingActions(entry({ attemptId: 'fresh' }));
    const listed = listPendingActions();
    expect(listed).toHaveLength(1);
    expect(listed[0].attemptId).toBe('fresh');
    // The expired file is physically removed, not just filtered
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('deletes corrupt and malformed entries instead of replaying them', () => {
    writeFileSync(join(dir, 'corrupt.json'), '{not json');
    writeFileSync(join(dir, 'missing-fields.json'), JSON.stringify({ version: 1 }));
    journalPendingActions(entry());
    const listed = listPendingActions();
    expect(listed).toHaveLength(1);
    expect(listed[0].attemptId).toBe('attempt-1');
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('ignores .tmp debris from a crash mid-write', () => {
    writeFileSync(join(dir, 'half-written.json.tmp'), '{"version":1');
    expect(listPendingActions()).toHaveLength(0);
  });

  it('sanitizes attempt ids so they cannot escape the journal dir', () => {
    journalPendingActions(entry({ attemptId: '../../evil' }));
    expect(existsSync(join(dir, '______evil.json'))).toBe(true);
    expect(listPendingActions()).toHaveLength(1);
    ackPendingActions('../../evil');
    expect(listPendingActions()).toHaveLength(0);
  });

  it('returns empty list when journal dir was never created', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(listPendingActions()).toEqual([]);
  });
});
