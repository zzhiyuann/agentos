import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { getConfig } from './config.js';

export interface QueueItem {
  id: string;
  issue_id: string;
  issue_key: string;
  agent_role: string;
  priority: number;
  agent_session_id: string | null;
  follow_up_prompt: string | null;
  queued_at: string;
  delay_until: string | null;
  status: 'queued' | 'processing' | 'completed' | 'canceled';
}

// Lower number = higher priority
const ROLE_PRIORITY: Record<string, number> = {
  'cto': 1,
  'cpo': 2,
  'coo': 3,
  'lead-engineer': 4,
  'research-lead': 5,
};

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const config = getConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });

  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      priority INTEGER DEFAULT 5,
      agent_session_id TEXT,
      follow_up_prompt TEXT,
      queued_at TEXT DEFAULT (datetime('now')),
      delay_until TEXT,
      status TEXT DEFAULT 'queued'
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority, queued_at);
  `);

  return _db;
}

export function getRolePriority(role: string): number {
  return ROLE_PRIORITY[role] ?? 5;
}

export function enqueue(item: {
  id: string;
  issue_id: string;
  issue_key: string;
  agent_role: string;
  agent_session_id?: string;
  follow_up_prompt?: string;
  delay_until?: string;
}): void {
  const db = getDb();
  const priority = getRolePriority(item.agent_role);

  const existing = db.prepare(`
    SELECT id FROM queue
    WHERE issue_key = ? AND agent_role = ? AND status = 'queued'
    ORDER BY queued_at DESC
    LIMIT 1
  `).get(item.issue_key, item.agent_role) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE queue
      SET issue_id = ?, priority = ?, agent_session_id = ?, follow_up_prompt = ?, delay_until = ?
      WHERE id = ?
    `).run(
      item.issue_id, priority, item.agent_session_id ?? null,
      item.follow_up_prompt ?? null, item.delay_until ?? null, existing.id
    );
    return;
  }

  db.prepare(`
    INSERT INTO queue (id, issue_id, issue_key, agent_role, priority, agent_session_id, follow_up_prompt, delay_until)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id, item.issue_id, item.issue_key, item.agent_role,
    priority, item.agent_session_id ?? null,
    item.follow_up_prompt ?? null, item.delay_until ?? null
  );
}

/** Get the next item ready to be processed (respects delay_until) */
export function dequeue(): QueueItem | null {
  const db = getDb();
  const now = new Date().toISOString();

  const item = db.prepare(`
    SELECT * FROM queue
    WHERE status = 'queued' AND (delay_until IS NULL OR delay_until <= ?)
    ORDER BY priority ASC, queued_at ASC
    LIMIT 1
  `).get(now) as QueueItem | undefined;

  if (!item) return null;

  db.prepare("UPDATE queue SET status = 'processing' WHERE id = ?").run(item.id);
  return item;
}

/** Peek at the next item without changing its status */
export function peekQueue(): QueueItem | null {
  const db = getDb();
  const now = new Date().toISOString();

  return (db.prepare(`
    SELECT * FROM queue
    WHERE status = 'queued' AND (delay_until IS NULL OR delay_until <= ?)
    ORDER BY priority ASC, queued_at ASC
    LIMIT 1
  `).get(now) as QueueItem | undefined) ?? null;
}

export function cancelQueued(issueKey: string): number {
  const db = getDb();
  const result = db.prepare(
    "UPDATE queue SET status = 'canceled' WHERE issue_key = ? AND status = 'queued'"
  ).run(issueKey);
  return result.changes;
}

export function cancelQueuedByRole(issueKey: string, agentRole: string): number {
  const db = getDb();
  const result = db.prepare(
    "UPDATE queue SET status = 'canceled' WHERE issue_key = ? AND agent_role = ? AND status = 'queued'"
  ).run(issueKey, agentRole);
  return result.changes;
}

/** Mark a queue item as completed after successful agent spawn */
export function completeQueueItem(id: string): void {
  const db = getDb();
  db.prepare("UPDATE queue SET status = 'completed' WHERE id = ?").run(id);
}

/** Mark a queue item as canceled by id */
export function cancelQueueItem(id: string): void {
  const db = getDb();
  db.prepare("UPDATE queue SET status = 'canceled' WHERE id = ?").run(id);
}

/** Mark a queue item as completed by issue key and role */
export function completeQueuedByRole(issueKey: string, agentRole: string): number {
  const db = getDb();
  const result = db.prepare(
    "UPDATE queue SET status = 'completed' WHERE issue_key = ? AND agent_role = ? AND status = 'processing'"
  ).run(issueKey, agentRole);
  return result.changes;
}

export function getQueueItems(): QueueItem[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM queue WHERE status = 'queued' ORDER BY priority ASC, queued_at ASC"
  ).all() as QueueItem[];
}

export function getQueueLength(): number {
  const db = getDb();
  const result = db.prepare(
    "SELECT COUNT(*) as count FROM queue WHERE status = 'queued'"
  ).get() as { count: number };
  return result.count;
}

/** Remove completed/canceled items older than 1 hour */
export function cleanupQueue(): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM queue WHERE status IN ('completed', 'processing', 'canceled')
    AND queued_at < datetime('now', '-1 hour')
  `).run();
}

// --- Concurrency Manager ---

let _cooldownUntil = 0;

export function setCooldown(durationMs: number): void {
  _cooldownUntil = Date.now() + durationMs;
}

export function isInCooldown(): boolean {
  return Date.now() < _cooldownUntil;
}

export function getCooldownRemaining(): number {
  return Math.max(0, _cooldownUntil - Date.now());
}

/** Mark stuck processing queue items as canceled */
export function timeoutStuckProcessing(olderThanMs: number = 10 * 60 * 1000): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db.prepare(
    "UPDATE queue SET status = 'canceled' WHERE status = 'processing' AND queued_at < ?"
  ).run(cutoff);
  return result.changes;
}
