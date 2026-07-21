import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createAttempt, getActiveAttempt, getActiveAttempts, getAllAttempts,
  getAttemptsByIssue, updateAttemptStatus, logEvent, getAttemptEvents,
  wasRecentlyCompletedByRole,
  dedupCheck, recordDedup, dedupSeen, gcDedupKeys,
  insertGrade, getGrade, getGradesForIssue,
  upsertAttribution, getRoleAttributedCostSince,
} from './db.js';

describe('db - attempts', () => {
  const testAttemptIds: string[] = [];

  function makeAttempt(issueKey: string, agentType = 'cto') {
    const id = randomUUID();
    testAttemptIds.push(id);
    return {
      id,
      issue_id: randomUUID(),
      issue_key: issueKey,
      agent_type: agentType,
      host: 'test-host',
      tmux_session: `test-${id.slice(0, 8)}`,
      workspace_path: `/tmp/test-workspace/${issueKey}`,
    };
  }

  afterEach(() => {
    // Mark test attempts as completed so they don't pollute active queries
    for (const id of testAttemptIds) {
      try {
        updateAttemptStatus(id, 'completed', 'test cleanup');
      } catch (err: unknown) {
        console.debug(`[db.test] cleanup failed for attempt ${id}:`, (err as Error).message);
      }
    }
    testAttemptIds.length = 0;
  });

  it('creates an attempt and retrieves it', () => {
    const key = `TEST-${Date.now()}`;
    const attempt = makeAttempt(key);
    createAttempt(attempt);

    const active = getActiveAttempt(key);
    expect(active).toBeDefined();
    expect(active!.issue_key).toBe(key);
    expect(active!.agent_type).toBe('cto');
    expect(active!.status).toBe('running');
    expect(active!.attempt_number).toBeGreaterThanOrEqual(1);
  });

  it('auto-increments attempt_number per issue', () => {
    const key = `TEST-INC-${Date.now()}`;

    const a1 = makeAttempt(key);
    createAttempt(a1);
    updateAttemptStatus(a1.id, 'completed');

    const a2 = makeAttempt(key);
    createAttempt(a2);

    const attempts = getAttemptsByIssue(key);
    const numbers = attempts.map(a => a.attempt_number).sort();
    expect(numbers.length).toBe(2);
    expect(numbers[0]).toBe(1);
    expect(numbers[1]).toBe(2);
  });

  it('updateAttemptStatus changes status', () => {
    const key = `TEST-STATUS-${Date.now()}`;
    const attempt = makeAttempt(key);
    createAttempt(attempt);

    updateAttemptStatus(attempt.id, 'failed', 'test error');

    const retrieved = getAttemptsByIssue(key);
    const found = retrieved.find(a => a.id === attempt.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('failed');
    expect(found!.error_log).toBe('test error');
    expect(found!.completed_at).not.toBeNull();
  });

  it('getActiveAttempts only returns pending/running', () => {
    const key = `TEST-ACTIVE-${Date.now()}`;
    const a1 = makeAttempt(key);
    const a2 = makeAttempt(key);
    createAttempt(a1);
    createAttempt(a2);
    updateAttemptStatus(a1.id, 'completed');

    const active = getActiveAttempts();
    const testActive = active.filter(a => a.issue_key === key);
    expect(testActive.length).toBe(1);
    expect(testActive[0].id).toBe(a2.id);
  });

  it('getAllAttempts returns recent attempts with limit', () => {
    const all = getAllAttempts(5);
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeLessThanOrEqual(5);
  });
});

describe('db - events', () => {
  it('logs and retrieves events', () => {
    const attemptId = randomUUID();
    // Create a dummy attempt first
    createAttempt({
      id: attemptId,
      issue_id: randomUUID(),
      issue_key: `TEST-EVT-${Date.now()}`,
      agent_type: 'cto',
      host: 'test-host',
    });

    logEvent(attemptId, 'test_event', { foo: 'bar' });
    logEvent(attemptId, 'test_event_2');

    const events = getAttemptEvents(attemptId);
    expect(events.length).toBeGreaterThanOrEqual(2);

    const testEvents = events.filter(e => e.event_type.startsWith('test_'));
    expect(testEvents.length).toBe(2);
    expect(JSON.parse(testEvents[0].payload!)).toEqual({ foo: 'bar' });
    expect(testEvents[1].payload).toBeNull();

    // Cleanup
    updateAttemptStatus(attemptId, 'completed');
  });
});

describe('db - wasRecentlyCompletedByRole', () => {
  it('returns completed attempt for same role within window', () => {
    const key = `TEST-RECENT-${Date.now()}`;
    const attempt = {
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: key,
      agent_type: 'cto',
      host: 'test-host',
    };
    createAttempt(attempt);
    updateAttemptStatus(attempt.id, 'completed');

    const recent = wasRecentlyCompletedByRole(key, 'cto', 5);
    expect(recent).toBeDefined();
    expect(recent!.issue_key).toBe(key);
    expect(recent!.agent_type).toBe('cto');
  });

  it('returns undefined for different role', () => {
    const key = `TEST-DIFF-ROLE-${Date.now()}`;
    const attempt = {
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: key,
      agent_type: 'cto',
      host: 'test-host',
    };
    createAttempt(attempt);
    updateAttemptStatus(attempt.id, 'completed');

    const recent = wasRecentlyCompletedByRole(key, 'lead-engineer', 5);
    expect(recent).toBeUndefined();
  });

  it('returns undefined for running (non-completed) attempt', () => {
    const key = `TEST-RUNNING-${Date.now()}`;
    const attempt = {
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: key,
      agent_type: 'cto',
      host: 'test-host',
    };
    createAttempt(attempt);
    // Don't complete — leave as running

    const recent = wasRecentlyCompletedByRole(key, 'cto', 5);
    expect(recent).toBeUndefined();

    // Cleanup
    updateAttemptStatus(attempt.id, 'completed', 'test cleanup');
  });

  it('returns undefined for unknown issue', () => {
    const recent = wasRecentlyCompletedByRole('NONEXISTENT-999', 'cto', 5);
    expect(recent).toBeUndefined();
  });
});

describe('db - dedup_keys (A1.3)', () => {

  it('dedupSeen returns false first, true within window', () => {
    const key = `test:dedup:${randomUUID()}`;
    expect(dedupSeen(key, 60_000)).toBe(false);
    expect(dedupSeen(key, 60_000)).toBe(true);
  });

  it('dedupCheck is read-only (does not record)', () => {
    const key = `test:dedup:${randomUUID()}`;
    expect(dedupCheck(key, 60_000)).toBe(false);
    expect(dedupCheck(key, 60_000)).toBe(false);
    recordDedup(key);
    expect(dedupCheck(key, 60_000)).toBe(true);
  });

  it('expires keys outside the window', async () => {
    const key = `test:dedup:${randomUUID()}`;
    recordDedup(key);
    await new Promise(r => setTimeout(r, 10));
    expect(dedupCheck(key, 5)).toBe(false);
    expect(dedupCheck(key, 60_000)).toBe(true);
  });

  it('gcDedupKeys removes aged keys only', async () => {
    const key = `test:dedup:${randomUUID()}`;
    recordDedup(key);
    await new Promise(r => setTimeout(r, 10));
    gcDedupKeys(5); // anything older than 5ms is purged
    expect(dedupCheck(key, 60_000)).toBe(false);
  });
});

describe('db - grades (A2.0)', () => {
  it('inserts and retrieves a grade', () => {
    const attemptId = randomUUID();
    const issueKey = `TEST-GRADE-${Date.now()}`;
    insertGrade({
      attempt_id: attemptId,
      issue_key: issueKey,
      verdict: 'pass',
      score: 8.5,
      critique: 'Solid work, tests included.',
      model: 'claude-fable-5',
    });

    const grade = getGrade(attemptId);
    expect(grade).toBeDefined();
    expect(grade!.issue_key).toBe(issueKey);
    expect(grade!.verdict).toBe('pass');
    expect(grade!.score).toBe(8.5);
    expect(grade!.critique).toBe('Solid work, tests included.');
    expect(grade!.model).toBe('claude-fable-5');
    expect(grade!.graded_at).toBeTruthy();
  });

  it('defaults optional fields to null', () => {
    const attemptId = randomUUID();
    insertGrade({
      attempt_id: attemptId,
      issue_key: `TEST-GRADE-NULL-${Date.now()}`,
      verdict: 'error',
    });

    const grade = getGrade(attemptId);
    expect(grade).toBeDefined();
    expect(grade!.score).toBeNull();
    expect(grade!.critique).toBeNull();
    expect(grade!.model).toBeNull();
  });

  it('upserts on attempt_id (re-grade replaces)', () => {
    const attemptId = randomUUID();
    const issueKey = `TEST-GRADE-UPSERT-${Date.now()}`;
    insertGrade({ attempt_id: attemptId, issue_key: issueKey, verdict: 'fail', score: 3 });
    insertGrade({ attempt_id: attemptId, issue_key: issueKey, verdict: 'pass', score: 7, critique: 'fixed' });

    const grade = getGrade(attemptId);
    expect(grade!.verdict).toBe('pass');
    expect(grade!.score).toBe(7);
    expect(grade!.critique).toBe('fixed');
    // Still exactly one row for the attempt
    const all = getGradesForIssue(issueKey).filter(g => g.attempt_id === attemptId);
    expect(all.length).toBe(1);
  });

  it('getGradesForIssue returns all grades for the issue', () => {
    const issueKey = `TEST-GRADE-LIST-${Date.now()}`;
    insertGrade({ attempt_id: randomUUID(), issue_key: issueKey, verdict: 'fail', score: 4 });
    insertGrade({ attempt_id: randomUUID(), issue_key: issueKey, verdict: 'pass', score: 9 });

    const grades = getGradesForIssue(issueKey);
    expect(grades.length).toBe(2);
    expect(grades.every(g => g.issue_key === issueKey)).toBe(true);
  });

  it('getGrade returns undefined for unknown attempt', () => {
    expect(getGrade(`nonexistent-${randomUUID()}`)).toBeUndefined();
  });
});

describe('db - getRoleAttributedCostSince (A4.3)', () => {
  function makeAttribution(role: string, taskCost: number, metaCost: number, lastSeenIso: string) {
    return {
      session_id: randomUUID(),
      issue_key: `TEST-COST-${Date.now()}`,
      role,
      task_tokens: 100,
      meta_tokens: 10,
      task_cost_usd: taskCost,
      meta_cost_usd: metaCost,
      task_messages: 1,
      meta_messages: 1,
      classification_confidence: 1,
      first_seen_at: lastSeenIso,
      last_seen_at: lastSeenIso,
    };
  }

  it('sums task+meta cost for the role within the window', () => {
    const role = `test-role-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    upsertAttribution(makeAttribution(role, 2.5, 0.5, now));
    upsertAttribution(makeAttribution(role, 1.0, 1.0, now));

    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(getRoleAttributedCostSince(role, since)).toBeCloseTo(5.0, 5);
  });

  it('excludes sessions outside the window and other roles', () => {
    const role = `test-role-${randomUUID().slice(0, 8)}`;
    const otherRole = `test-role-${randomUUID().slice(0, 8)}`;
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const now = new Date().toISOString();
    upsertAttribution(makeAttribution(role, 9, 0, twoHoursAgo)); // outside window
    upsertAttribution(makeAttribution(otherRole, 7, 0, now));    // different role

    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(getRoleAttributedCostSince(role, since)).toBe(0);
    expect(getRoleAttributedCostSince(otherRole, since)).toBeCloseTo(7, 5);
  });

  it('returns 0 for a role with no attributions', () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(getRoleAttributedCostSince(`no-such-role-${randomUUID()}`, since)).toBe(0);
  });
});
