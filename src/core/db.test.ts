import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createAttempt, getActiveAttempt, getActiveAttempts, getAllAttempts,
  getAttemptsByIssue, updateAttemptStatus, logEvent, getAttemptEvents,
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
      } catch { /* ignore */ }
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
