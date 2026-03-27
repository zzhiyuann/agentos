import Database from 'better-sqlite3';
import { mkdirSync, statSync, copyFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { getConfig } from './config.js';

export interface Attempt {
  id: string;
  issue_id: string;
  issue_key: string;
  agent_session_id: string | null;
  agent_type: string;
  runner_session_id: string | null;
  tmux_session: string | null;
  attempt_number: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'hibernated' | 'idle';
  host: string;
  workspace_path: string | null;
  budget_usd: number | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_log: string | null;
}

export interface AttemptEvent {
  id: number;
  attempt_id: string;
  event_type: string;
  payload: string | null;
  created_at: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const config = getConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true });

  // Guard: detect empty/corrupted DB file before opening
  // better-sqlite3 will happily open a 0-byte file and create fresh tables,
  // silently losing all existing data. Check and attempt recovery first.
  if (existsSync(config.dbPath)) {
    try {
      const st = statSync(config.dbPath);
      if (st.size === 0) {
        console.error(`[DB] WARNING: state.db is 0 bytes — data lost. Checking for WAL recovery...`);
        // If WAL file exists, SQLite can sometimes recover from it
        const walPath = config.dbPath + '-wal';
        const backupPath = config.dbPath + '.corrupted-' + Date.now();
        if (existsSync(walPath)) {
          console.error(`[DB] WAL file found — attempting recovery by opening with WAL`);
          // Rename the empty file so SQLite can try to reconstruct from WAL
          copyFileSync(config.dbPath, backupPath);
        } else {
          // No WAL, check for backup
          const backupGlob = config.dbPath + '.backup';
          if (existsSync(backupGlob)) {
            console.error(`[DB] Restoring from backup: ${backupGlob}`);
            copyFileSync(backupGlob, config.dbPath);
          } else {
            console.error(`[DB] No WAL or backup found — starting with fresh database`);
            copyFileSync(config.dbPath, backupPath);
          }
        }
      }
    } catch { /* stat may fail — proceed normally */ }
  }

  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000'); // wait up to 5s on concurrent writes

  // Migrate: create new tables if they don't exist
  _db.exec(`
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      agent_session_id TEXT,
      agent_type TEXT NOT NULL DEFAULT 'cc',
      runner_session_id TEXT,
      tmux_session TEXT,
      attempt_number INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      host TEXT NOT NULL,
      workspace_path TEXT,
      budget_usd REAL,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      error_log TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_issue_key ON attempts(issue_key);
    CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status);
    CREATE INDEX IF NOT EXISTS idx_events_attempt ON events(attempt_id);
  `);

  // Migrate from v1 sessions table if it exists
  const hasSessionsTable = _db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get();

  if (hasSessionsTable) {
    const hasMigrated = _db.prepare("SELECT COUNT(*) as c FROM attempts").get() as { c: number };
    if (hasMigrated.c === 0) {
      _db.exec(`
        INSERT INTO attempts (id, issue_id, issue_key, agent_type, tmux_session, status, host, workspace_path, cost_usd, created_at, updated_at, error_log)
        SELECT id, issue_id, issue_key, agent_type, tmux_session, status, host, workspace_path, cost_usd, created_at, updated_at, error_log
        FROM sessions;

        INSERT INTO events (attempt_id, event_type, payload, created_at)
        SELECT session_id, event_type, payload, created_at FROM events WHERE session_id IN (SELECT id FROM sessions);
      `);
    }
  }

  return _db;
}

// --- Attempts ---

export function createAttempt(attempt: {
  id: string;
  issue_id: string;
  issue_key: string;
  agent_type: string;
  host: string;
  agent_session_id?: string;
  runner_session_id?: string;
  tmux_session?: string;
  workspace_path?: string;
  budget_usd?: number;
}): void {
  const db = getDb();
  // Transaction: read max attempt_number + insert atomically
  const insertTx = db.transaction(() => {
    const last = db.prepare(
      'SELECT MAX(attempt_number) as n FROM attempts WHERE issue_key = ?'
    ).get(attempt.issue_key) as { n: number | null };
    const attemptNumber = (last?.n ?? 0) + 1;

    db.prepare(`
      INSERT INTO attempts (id, issue_id, issue_key, agent_session_id, agent_type, runner_session_id, tmux_session, attempt_number, status, host, workspace_path, budget_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(
      attempt.id, attempt.issue_id, attempt.issue_key,
      attempt.agent_session_id ?? null, attempt.agent_type,
      attempt.runner_session_id ?? null, attempt.tmux_session ?? null,
      attemptNumber, attempt.host, attempt.workspace_path ?? null,
      attempt.budget_usd ?? null
    );
  });
  insertTx();
}

export function getActiveAttempt(issueKey: string): Attempt | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM attempts WHERE issue_key = ? AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1"
  ).get(issueKey) as Attempt | undefined;
}

export function getActiveAttempts(): Attempt[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM attempts WHERE status IN ('pending', 'running') ORDER BY created_at DESC"
  ).all() as Attempt[];
}

/** Get an idle attempt for an issue — session is alive at prompt, waiting for reactivation. */
export function getIdleAttempt(issueKey: string): Attempt | undefined {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM attempts WHERE issue_key = ? AND status = 'idle' ORDER BY created_at DESC LIMIT 1"
  ).get(issueKey) as Attempt | undefined;
}

export function getIdleAttempts(): Attempt[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM attempts WHERE status = 'idle' ORDER BY created_at DESC"
  ).all() as Attempt[];
}

export function getHibernatedAttempts(): Attempt[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM attempts WHERE status = 'hibernated' ORDER BY created_at ASC"
  ).all() as Attempt[];
}

export function getAttemptById(id: string): Attempt | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as Attempt | undefined;
}

export function getAllAttempts(limit = 20): Attempt[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM attempts ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as Attempt[];
}

export function getAttemptsByIssue(issueKey: string): Attempt[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM attempts WHERE issue_key = ? ORDER BY attempt_number DESC'
  ).all(issueKey) as Attempt[];
}

/** Get attempts created by a specific agent type within the last N minutes (excluding a given attempt) */
export function getRecentAttemptsByAgent(agentType: string, withinMinutes: number, excludeAttemptId?: string): Attempt[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - withinMinutes * 60_000).toISOString();
  if (excludeAttemptId) {
    return db.prepare(
      'SELECT * FROM attempts WHERE agent_type = ? AND created_at > ? AND id != ? ORDER BY created_at DESC'
    ).all(agentType, cutoff, excludeAttemptId) as Attempt[];
  }
  return db.prepare(
    'SELECT * FROM attempts WHERE agent_type = ? AND created_at > ? ORDER BY created_at DESC'
  ).all(agentType, cutoff) as Attempt[];
}

export function updateAttemptStatus(id: string, status: Attempt['status'], errorLog?: string): void {
  const db = getDb();
  const completedAt = (status === 'completed' || status === 'failed') ? "datetime('now')" : 'NULL';
  if (errorLog) {
    db.prepare(`
      UPDATE attempts SET status = ?, error_log = ?, completed_at = ${completedAt}, updated_at = datetime('now') WHERE id = ?
    `).run(status, errorLog, id);
  } else {
    db.prepare(`
      UPDATE attempts SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now') WHERE id = ?
    `).run(status, id);
  }
}

export function updateAttemptAgentSession(id: string, agentSessionId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE attempts SET agent_session_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(agentSessionId, id);
}

export function updateAttemptCost(id: string, costUsd: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE attempts SET cost_usd = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(costUsd, id);
}

// --- Events ---

export function logEvent(attemptId: string, eventType: string, payload?: object): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO events (attempt_id, event_type, payload) VALUES (?, ?, ?)'
  ).run(attemptId, eventType, payload ? JSON.stringify(payload) : null);
}

export function getAttemptEvents(attemptId: string): AttemptEvent[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM events WHERE attempt_id = ? ORDER BY created_at ASC'
  ).all(attemptId) as AttemptEvent[];
}

export function getRecentEvents(limit = 20): (AttemptEvent & { issue_key: string; agent_type: string })[] {
  const db = getDb();
  return db.prepare(
    'SELECT e.*, a.issue_key, a.agent_type FROM events e JOIN attempts a ON e.attempt_id = a.id ORDER BY e.created_at DESC LIMIT ?'
  ).all(limit) as (AttemptEvent & { issue_key: string; agent_type: string })[];
}

// --- Backward compat aliases ---
export const createSession = createAttempt;
export const getSessionByIssueKey = getActiveAttempt;
export const getActiveSessions = getActiveAttempts;
export const getAllSessions = getAllAttempts;
export const updateSessionStatus = updateAttemptStatus;
export const getSessionEvents = getAttemptEvents;

/** Mark stale running attempts as failed (no activity for given duration) */
export function markStaleAttemptsAsFailed(olderThanMs: number = 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db.prepare(
    "UPDATE attempts SET status = 'failed', error_log = 'Auto-marked stale', completed_at = datetime('now'), updated_at = datetime('now') WHERE status = 'running' AND updated_at < ?"
  ).run(cutoff);
  return result.changes;
}

export function closeDb(): void {
  if (_db) {
    try {
      // Force WAL checkpoint before closing — ensures all data is written to main DB file
      _db.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* best effort */ }
    _db.close();
    _db = null;
  }
}

/** Create a backup of the database file. Called periodically by serve.ts. */
export async function backupDb(): Promise<void> {
  try {
    const config = getConfig();
    const backupPath = config.dbPath + '.backup';
    if (existsSync(config.dbPath)) {
      const st = statSync(config.dbPath);
      if (st.size > 0) {
        // Use SQLite backup API for consistency (better than file copy during writes)
        const db = getDb();
        try {
          await db.backup(backupPath);
        } catch {
          // fallback: direct file copy (less safe but better than nothing)
          copyFileSync(config.dbPath, backupPath);
        }
      }
    }
  } catch { /* best effort */ }
}
