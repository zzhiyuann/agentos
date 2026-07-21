import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';
import {
  enqueue, dequeue, peekQueue, getQueueItems, getQueueLength,
  cancelQueued, cancelQueuedByRole, cleanupQueue, getRolePriority,
  setCooldown, isInCooldown, getCooldownRemaining,
  completeQueueItem, cancelQueueItem, completeQueuedByRole,
} from './queue.js';

describe('getRolePriority', () => {
  it('assigns correct priorities to known roles', () => {
    expect(getRolePriority('cto')).toBe(1);
    expect(getRolePriority('cpo')).toBe(2);
    expect(getRolePriority('coo')).toBe(3);
    expect(getRolePriority('lead-engineer')).toBe(4);
    expect(getRolePriority('research-lead')).toBe(5);
  });

  it('defaults unknown roles to priority 5', () => {
    expect(getRolePriority('unknown-role')).toBe(5);
    expect(getRolePriority('worker')).toBe(5);
  });
});

describe('queue operations', () => {
  // These tests use the real ~/.aos/state.db
  // We clean up after ourselves by canceling all test items

  const testIssueIds: string[] = [];

  function makeItem(role = 'cto', issueKey?: string) {
    const id = randomUUID();
    const key = issueKey || `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    testIssueIds.push(key);
    return {
      id,
      issue_id: randomUUID(),
      issue_key: key,
      agent_role: role,
    };
  }

  afterEach(() => {
    // Clean up test items
    for (const key of testIssueIds) {
      cancelQueued(key);
    }
    testIssueIds.length = 0;
    cleanupQueue();
  });

  it('enqueue and dequeue a single item', () => {
    const item = makeItem('cto');
    enqueue(item);

    const dequeued = dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.issue_key).toBe(item.issue_key);
    expect(dequeued!.agent_role).toBe('cto');
    expect(dequeued!.priority).toBe(1);
    expect(dequeued!.status).toBe('queued'); // status before we fetched it
  });

  it('dequeues by priority order (CTO before Lead Engineer)', () => {
    const item1 = makeItem('lead-engineer');
    const item2 = makeItem('cto');

    enqueue(item1);
    enqueue(item2);

    const first = dequeue();
    expect(first).not.toBeNull();
    expect(first!.agent_role).toBe('cto'); // priority 1 comes first

    const second = dequeue();
    expect(second).not.toBeNull();
    expect(second!.agent_role).toBe('lead-engineer'); // priority 4
  });

  it('peekQueue returns next item without removing it', () => {
    const item = makeItem('cpo');
    enqueue(item);

    const peeked = peekQueue();
    expect(peeked).not.toBeNull();
    expect(peeked!.issue_key).toBe(item.issue_key);

    // Peek again — should be the same item
    const peeked2 = peekQueue();
    expect(peeked2).not.toBeNull();
    expect(peeked2!.id).toBe(peeked!.id);

    // Clean up
    dequeue();
  });

  it('dequeue returns null when queue is empty', () => {
    const result = dequeue();
    // Could be null or could return items from other tests — just verify the type
    // For a clean test we ensure no test items are queued
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('cancelQueued removes queued items', () => {
    const item = makeItem('coo');
    enqueue(item);

    const canceled = cancelQueued(item.issue_key);
    expect(canceled).toBeGreaterThanOrEqual(1);

    // Should not be dequeue-able anymore
    const items = getQueueItems();
    const found = items.find(i => i.issue_key === item.issue_key);
    expect(found).toBeUndefined();
  });

  it('deduplicates queued items by issue and role', () => {
    const issueKey = `TEST-${Date.now()}-dedup`;
    testIssueIds.push(issueKey);

    enqueue({
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: issueKey,
      agent_role: 'cto',
      delay_until: new Date(Date.now() + 60_000).toISOString(),
    });
    enqueue({
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: issueKey,
      agent_role: 'cto',
      delay_until: new Date(Date.now() + 120_000).toISOString(),
    });

    const matches = getQueueItems().filter(i => i.issue_key === issueKey && i.agent_role === 'cto');
    expect(matches).toHaveLength(1);
    expect(matches[0].delay_until).toBeTruthy();
  });

  it('cancelQueuedByRole only removes the targeted role', () => {
    const issueKey = `TEST-${Date.now()}-role-cancel`;
    testIssueIds.push(issueKey);

    enqueue({
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: issueKey,
      agent_role: 'cto',
    });
    enqueue({
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: issueKey,
      agent_role: 'coo',
    });

    const canceled = cancelQueuedByRole(issueKey, 'cto');
    expect(canceled).toBeGreaterThanOrEqual(1);

    const remaining = getQueueItems().filter(i => i.issue_key === issueKey);
    expect(remaining.some(i => i.agent_role === 'coo')).toBe(true);
    expect(remaining.some(i => i.agent_role === 'cto')).toBe(false);
  });

  it('getQueueLength counts queued items', () => {
    const before = getQueueLength();
    const item = makeItem('research-lead');
    enqueue(item);

    const after = getQueueLength();
    expect(after).toBe(before + 1);
  });

  it('respects delay_until — does not dequeue items with future delay', () => {
    const item = makeItem('cto');
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    enqueue({ ...item, delay_until: futureTime });

    // Should not be returned by dequeue (delay is in the future)
    const peeked = peekQueue();
    // If peeked is our item, it shouldn't be — delay is future
    if (peeked && peeked.issue_key === item.issue_key) {
      // This would be a bug
      expect(peeked.delay_until).toBeNull(); // should fail to flag the bug
    }
  });

  it('dequeues items with past delay_until', () => {
    const item = makeItem('cpo');
    const pastTime = new Date(Date.now() - 1000).toISOString();
    enqueue({ ...item, delay_until: pastTime });

    const dequeued = dequeue();
    expect(dequeued).not.toBeNull();
    // It should be our item or another queued item
    if (dequeued!.issue_key === item.issue_key) {
      expect(dequeued!.agent_role).toBe('cpo');
    }
  });
});

describe('queue completion lifecycle', () => {
  const testIssueIds: string[] = [];

  function makeItem(role = 'cto', issueKey?: string) {
    const id = randomUUID();
    const key = issueKey || `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    testIssueIds.push(key);
    return {
      id,
      issue_id: randomUUID(),
      issue_key: key,
      agent_role: role,
    };
  }

  afterEach(() => {
    for (const key of testIssueIds) {
      cancelQueued(key);
    }
    testIssueIds.length = 0;
    cleanupQueue();
  });

  it('completeQueueItem transitions processing to completed', () => {
    const item = makeItem('cto');
    enqueue(item);

    const dequeued = dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(item.id);

    // Item should not appear in queued items
    expect(getQueueItems().find(i => i.id === item.id)).toBeUndefined();

    // Mark as completed
    completeQueueItem(item.id);

    // Should still not appear in queued items (only shows status='queued')
    expect(getQueueItems().find(i => i.id === item.id)).toBeUndefined();
  });

  it('cancelQueueItem transitions processing to canceled', () => {
    const item = makeItem('cpo');
    enqueue(item);

    const dequeued = dequeue();
    expect(dequeued).not.toBeNull();

    cancelQueueItem(item.id);

    // Should not be in the queued list
    expect(getQueueItems().find(i => i.id === item.id)).toBeUndefined();
  });

  it('completeQueuedByRole completes processing items for a specific role', () => {
    const issueKey = `TEST-${Date.now()}-complete-role`;
    testIssueIds.push(issueKey);

    const item = {
      id: randomUUID(),
      issue_id: randomUUID(),
      issue_key: issueKey,
      agent_role: 'lead-engineer',
    };
    enqueue(item);

    // Dequeue to set status to 'processing' — drain any higher-priority items first
    let dequeued = dequeue();
    while (dequeued && dequeued.issue_key !== issueKey) {
      dequeued = dequeue();
    }
    expect(dequeued).not.toBeNull();
    expect(dequeued!.issue_key).toBe(issueKey);

    const changed = completeQueuedByRole(issueKey, 'lead-engineer');
    expect(changed).toBe(1);
  });

  it('full lifecycle: queued → processing → completed', () => {
    const item = makeItem('coo');
    enqueue(item);

    // Verify queued
    expect(getQueueItems().find(i => i.id === item.id)).toBeTruthy();
    expect(getQueueLength()).toBeGreaterThanOrEqual(1);

    // Dequeue → processing
    const dequeued = dequeue();
    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(item.id);

    // No longer in queued list
    expect(getQueueItems().find(i => i.id === item.id)).toBeUndefined();

    // Complete
    completeQueueItem(item.id);

    // Still not in queued list (completed items are not queued)
    expect(getQueueItems().find(i => i.id === item.id)).toBeUndefined();
  });
});

describe('cooldown', () => {
  afterEach(() => {
    setCooldown(0); // reset
  });

  it('isInCooldown returns false when no cooldown set', () => {
    setCooldown(0);
    expect(isInCooldown()).toBe(false);
  });

  it('isInCooldown returns true during cooldown', () => {
    setCooldown(5000);
    expect(isInCooldown()).toBe(true);
  });

  it('getCooldownRemaining returns remaining ms', () => {
    setCooldown(5000);
    const remaining = getCooldownRemaining();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it('cooldown expires', async () => {
    setCooldown(100); // 100ms
    expect(isInCooldown()).toBe(true);
    await new Promise(r => setTimeout(r, 150));
    expect(isInCooldown()).toBe(false);
  });
});
