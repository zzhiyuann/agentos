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
    } catch (err: unknown) {
      console.debug(`[DB] stat check failed (proceeding normally):`, (err as Error).message);
    }
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

    CREATE TABLE IF NOT EXISTS task_enrichments (
      issue_key TEXT PRIMARY KEY,
      spec_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- RYA-895: per-Claude-session token attribution. One row per JSONL transcript.
    -- attempt_id is best-effort (NULL if we can't match an attempt by issue_key+role+window).
    CREATE TABLE IF NOT EXISTS attempt_attributions (
      session_id TEXT PRIMARY KEY,
      attempt_id TEXT,
      issue_key TEXT NOT NULL,
      role TEXT NOT NULL,
      task_tokens INTEGER NOT NULL DEFAULT 0,
      meta_tokens INTEGER NOT NULL DEFAULT 0,
      task_cost_usd REAL NOT NULL DEFAULT 0,
      meta_cost_usd REAL NOT NULL DEFAULT 0,
      task_messages INTEGER NOT NULL DEFAULT 0,
      meta_messages INTEGER NOT NULL DEFAULT 0,
      classification_confidence REAL NOT NULL DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      transcript_path TEXT,
      classified_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attributions_issue_key ON attempt_attributions(issue_key);
    CREATE INDEX IF NOT EXISTS idx_attributions_role ON attempt_attributions(role);
    CREATE INDEX IF NOT EXISTS idx_attributions_last_seen ON attempt_attributions(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_attributions_attempt ON attempt_attributions(attempt_id);

    -- A1.1: circuit breaker half-open state. One row per tripped issue;
    -- cleared when the issue completes successfully.
    CREATE TABLE IF NOT EXISTS breaker_state (
      issue_key TEXT PRIMARY KEY,
      agent_role TEXT NOT NULL,
      tripped_at INTEGER NOT NULL,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT
    );

    -- A1.3: persistent dedup backing for serve/state.ts in-memory maps.
    -- Serve restarts on every src commit (auto-deploy), wiping in-memory dedup;
    -- this table makes webhook/dispatch/handoff dedup survive restarts.
    CREATE TABLE IF NOT EXISTS dedup_keys (
      key TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dedup_keys_ts ON dedup_keys(ts);

    -- A2.0: per-attempt quality grades from the headless grader (quality system).
    -- One row per attempt; re-grading upserts on attempt_id.
    CREATE TABLE IF NOT EXISTS grades (
      attempt_id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      verdict TEXT NOT NULL,
      score REAL,
      critique TEXT,
      model TEXT,
      graded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_grades_issue_key ON grades(issue_key);
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

/** A4.1: set attempts.cost_usd to the total attributed cost for every attempt
 *  touched by attribution rows seen since `sinceIso`. Returns rows updated. */
export function rollupAttemptCosts(sinceIso: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE attempts SET cost_usd = (
      SELECT COALESCE(SUM(task_cost_usd + meta_cost_usd), 0)
      FROM attempt_attributions aa WHERE aa.attempt_id = attempts.id
    ), updated_at = datetime('now')
    WHERE id IN (
      SELECT DISTINCT attempt_id FROM attempt_attributions
      WHERE attempt_id IS NOT NULL AND last_seen_at >= ?
    )
  `).run(sinceIso);
  return result.changes;
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

// --- Task Enrichment Cache ---

/** Look up cached enrichment JSON for an issue */
export function getCachedEnrichment(issueKey: string): Record<string, unknown> | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT spec_json FROM task_enrichments WHERE issue_key = ?').get(issueKey) as { spec_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.spec_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Store enrichment JSON in cache */
export function cacheEnrichment(issueKey: string, spec: Record<string, unknown>): void {
  try {
    const db = getDb();
    db.prepare(
      'INSERT OR REPLACE INTO task_enrichments (issue_key, spec_json) VALUES (?, ?)'
    ).run(issueKey, JSON.stringify(spec));
  } catch {
    // Cache failure is non-fatal
  }
}

// --- Attribution (RYA-895) ---

export interface AttemptAttribution {
  session_id: string;
  attempt_id: string | null;
  issue_key: string;
  role: string;
  task_tokens: number;
  meta_tokens: number;
  task_cost_usd: number;
  meta_cost_usd: number;
  task_messages: number;
  meta_messages: number;
  classification_confidence: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  transcript_path: string | null;
  classified_at: string;
}

export interface UpsertAttributionInput {
  session_id: string;
  attempt_id?: string | null;
  issue_key: string;
  role: string;
  task_tokens: number;
  meta_tokens: number;
  task_cost_usd: number;
  meta_cost_usd: number;
  task_messages: number;
  meta_messages: number;
  classification_confidence: number;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  transcript_path?: string | null;
}

/** Insert or replace one per-session attribution row. Idempotent on session_id. */
export function upsertAttribution(input: UpsertAttributionInput): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO attempt_attributions (
      session_id, attempt_id, issue_key, role,
      task_tokens, meta_tokens, task_cost_usd, meta_cost_usd,
      task_messages, meta_messages, classification_confidence,
      first_seen_at, last_seen_at, transcript_path, classified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      attempt_id = excluded.attempt_id,
      issue_key = excluded.issue_key,
      role = excluded.role,
      task_tokens = excluded.task_tokens,
      meta_tokens = excluded.meta_tokens,
      task_cost_usd = excluded.task_cost_usd,
      meta_cost_usd = excluded.meta_cost_usd,
      task_messages = excluded.task_messages,
      meta_messages = excluded.meta_messages,
      classification_confidence = excluded.classification_confidence,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      transcript_path = excluded.transcript_path,
      classified_at = datetime('now')
  `).run(
    input.session_id,
    input.attempt_id ?? null,
    input.issue_key,
    input.role,
    input.task_tokens,
    input.meta_tokens,
    input.task_cost_usd,
    input.meta_cost_usd,
    input.task_messages,
    input.meta_messages,
    input.classification_confidence,
    input.first_seen_at ?? null,
    input.last_seen_at ?? null,
    input.transcript_path ?? null,
  );
}

export function getAttribution(sessionId: string): AttemptAttribution | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM attempt_attributions WHERE session_id = ?'
  ).get(sessionId) as AttemptAttribution | undefined;
}

export function getAttributionsForIssue(issueKey: string): AttemptAttribution[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM attempt_attributions WHERE issue_key = ? ORDER BY last_seen_at DESC'
  ).all(issueKey) as AttemptAttribution[];
}

export function getAttributionsSince(sinceIso: string): AttemptAttribution[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM attempt_attributions WHERE last_seen_at >= ? ORDER BY last_seen_at DESC'
  ).all(sinceIso) as AttemptAttribution[];
}

/**
 * Find the attempt_id whose [created_at, completed_at) interval covers the
 * given session window for the same issue+role. Best-effort heuristic — the
 * Claude Code transcript session UUID is not stored on attempts, so we match
 * on overlap of time windows. Returns NULL if no match.
 */
export function findAttemptForSession(
  issueKey: string,
  role: string,
  firstSeenIso: string | null,
  lastSeenIso: string | null,
): string | null {
  if (!firstSeenIso || !lastSeenIso) return null;
  const db = getDb();
  // A4.2: attempts timestamps are SQLite 'YYYY-MM-DD HH:MM:SS' while transcript
  // timestamps are ISO with 'T'/'Z' — raw string comparison always fails at
  // position 10 (' ' < 'T'). Normalize both sides via datetime(). A 5-minute
  // slack absorbs spawn-vs-transcript ordering jitter.
  const row = db.prepare(`
    SELECT id FROM attempts
    WHERE issue_key = ? AND agent_type = ?
      AND datetime(created_at) <= datetime(?)
      AND (completed_at IS NULL OR datetime(completed_at, '+5 minutes') >= datetime(?))
    ORDER BY created_at DESC
    LIMIT 1
  `).get(issueKey, role, lastSeenIso, firstSeenIso) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Map of issue_key → most recent non-default agent role (for analytics
 * attribution). Used by P&L analytics to label sessions found in Claude
 * Code transcripts (which don't carry the role themselves).
 */
export function getIssueRoleMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT a.issue_key, a.agent_type
      FROM attempts a
      INNER JOIN (
        SELECT issue_key, MAX(created_at) AS last_at
        FROM attempts
        WHERE agent_type != 'cc'
        GROUP BY issue_key
      ) latest
      ON a.issue_key = latest.issue_key AND a.created_at = latest.last_at
      WHERE a.agent_type != 'cc'
    `).all() as { issue_key: string; agent_type: string }[];
    for (const r of rows) {
      map.set(r.issue_key, r.agent_type);
    }
  } catch (err) {
    console.debug(`[db] getIssueRoleMap failed: ${(err as Error).message}`);
  }
  return map;
}

// --- Backward compat aliases ---
export const createSession = createAttempt;
export const getSessionByIssueKey = getActiveAttempt;
export const getActiveSessions = getActiveAttempts;
export const getAllSessions = getAllAttempts;
export const updateSessionStatus = updateAttemptStatus;
export const getSessionEvents = getAttemptEvents;

/** Check if a specific role recently completed work on an issue (within given minutes).
 *  DB-backed — survives server restarts (unlike in-memory dedup maps).
 *  Prevents duplicate dispatch when server restarts clear in-memory state. */
export function wasRecentlyCompletedByRole(issueKey: string, role: string, withinMinutes: number = 5): Attempt | undefined {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM attempts WHERE issue_key = ? AND agent_type = ? AND status = 'completed'
     AND completed_at > datetime('now', '-' || ? || ' minutes')
     ORDER BY completed_at DESC LIMIT 1`
  ).get(issueKey, role, withinMinutes) as Attempt | undefined;
}

/** Get completed attempts that still have tmux sessions (zombies to clean up). */
export function getCompletedWithTmux(olderThanMinutes: number = 2): Array<{ id: string; tmux_session: string; issue_key: string; agent_type: string }> {
  const db = getDb();
  return db.prepare(
    `SELECT id, tmux_session, issue_key, agent_type FROM attempts
     WHERE status = 'completed' AND tmux_session IS NOT NULL
     AND completed_at IS NOT NULL AND completed_at < datetime('now', '-${olderThanMinutes} minutes')`
  ).all() as Array<{ id: string; tmux_session: string; issue_key: string; agent_type: string }>;
}

/** Clear the tmux_session field for a completed attempt (after cleanup). */
export function clearAttemptTmuxSession(attemptId: string): void {
  const db = getDb();
  db.prepare("UPDATE attempts SET tmux_session = NULL WHERE id = ?").run(attemptId);
}

/** Mark stale running attempts as failed (no activity for given duration) */
export function markStaleAttemptsAsFailed(olderThanMs: number = 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db.prepare(
    "UPDATE attempts SET status = 'failed', error_log = 'Auto-marked stale', completed_at = datetime('now'), updated_at = datetime('now') WHERE status = 'running' AND updated_at < ?"
  ).run(cutoff);
  return result.changes;
}

/** Delete events older than the given retention window. Returns rows deleted. */
export function purgeOldEvents(retentionMs: number = 7 * 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const result = db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
  return result.changes;
}

// --- A1.1: circuit breaker half-open state ---

export interface BreakerState {
  issue_key: string;
  agent_role: string;
  tripped_at: number;
  reopen_count: number;
  last_reason: string | null;
}

export function getBreakerState(issueKey: string): BreakerState | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM breaker_state WHERE issue_key = ?').get(issueKey) as BreakerState | undefined;
}

/** Record a trip: insert at reopen_count=0, or bump reopen_count and refresh tripped_at. */
export function bumpBreakerState(issueKey: string, agentRole: string, reason: string): BreakerState {
  const db = getDb();
  db.prepare(`
    INSERT INTO breaker_state (issue_key, agent_role, tripped_at, reopen_count, last_reason)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(issue_key) DO UPDATE SET
      reopen_count = reopen_count + 1,
      tripped_at = excluded.tripped_at,
      agent_role = excluded.agent_role,
      last_reason = excluded.last_reason
  `).run(issueKey, agentRole, Date.now(), reason);
  return getBreakerState(issueKey)!;
}

export function clearBreakerState(issueKey: string): void {
  const db = getDb();
  db.prepare('DELETE FROM breaker_state WHERE issue_key = ?').run(issueKey);
}

// --- A1.3: persistent dedup (backs serve/state.ts in-memory maps across restarts) ---

/** Read-only check: was `key` recorded within `windowMs`? */
export function dedupCheck(key: string, windowMs: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT ts FROM dedup_keys WHERE key = ?').get(key) as { ts: number } | undefined;
  return !!row && Date.now() - row.ts < windowMs;
}

/** Record `key` at the current timestamp (upsert). */
export function recordDedup(key: string): void {
  const db = getDb();
  db.prepare('INSERT INTO dedup_keys (key, ts) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts')
    .run(key, Date.now());
}

/** Check-and-record: returns true if seen within `windowMs`; otherwise records now. */
export function dedupSeen(key: string, windowMs: number): boolean {
  if (dedupCheck(key, windowMs)) return true;
  recordDedup(key);
  return false;
}

/** Delete dedup keys older than the retention window. Returns rows deleted. */
export function gcDedupKeys(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM dedup_keys WHERE ts < ?').run(Date.now() - maxAgeMs);
  return result.changes;
}

// ─── A2.0: grades (quality system) ──────────────────────────────────────────
// Self-contained block — grades table helpers live here; keep additions to
// this region so the quality-system workstream owns a single db.ts diff.

export interface Grade {
  attempt_id: string;
  issue_key: string;
  verdict: string;
  score: number | null;
  critique: string | null;
  model: string | null;
  graded_at: string;
}

/** Insert (or replace) the grade for an attempt. Idempotent on attempt_id. */
export function insertGrade(grade: {
  attempt_id: string;
  issue_key: string;
  verdict: string;
  score?: number | null;
  critique?: string | null;
  model?: string | null;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO grades (attempt_id, issue_key, verdict, score, critique, model, graded_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(attempt_id) DO UPDATE SET
      issue_key = excluded.issue_key,
      verdict = excluded.verdict,
      score = excluded.score,
      critique = excluded.critique,
      model = excluded.model,
      graded_at = datetime('now')
  `).run(
    grade.attempt_id,
    grade.issue_key,
    grade.verdict,
    grade.score ?? null,
    grade.critique ?? null,
    grade.model ?? null,
  );
}

export function getGrade(attemptId: string): Grade | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM grades WHERE attempt_id = ?').get(attemptId) as Grade | undefined;
}

export function getGradesForIssue(issueKey: string): Grade[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM grades WHERE issue_key = ? ORDER BY graded_at DESC'
  ).all(issueKey) as Grade[];
}

/** A4.3: total attributed cost (task+meta USD) for a role across sessions
 *  last seen since `sinceIso`. Backs the cost-velocity guard. Timestamps are
 *  normalized via datetime() because attribution rows carry ISO strings with
 *  'T'/'Z' (same normalization rationale as findAttemptForSession, A4.2). */
export function getRoleAttributedCostSince(role: string, sinceIso: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(task_cost_usd + meta_cost_usd), 0) AS c
    FROM attempt_attributions
    WHERE role = ? AND last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime(?)
  `).get(role, sinceIso) as { c: number } | undefined;
  return row?.c ?? 0;
}

// ─── end A2.0 grades block ───────────────────────────────────────────────────

// ─── A3.5: dream (nightly reflection) queries ───────────────────────────────

/** Grades for attempts run by `role` since `sinceIso` (ISO timestamp). */
export function getGradesForRoleSince(role: string, sinceIso: string): Grade[] {
  const db = getDb();
  return db.prepare(`
    SELECT g.* FROM grades g
    JOIN attempts a ON a.id = g.attempt_id
    WHERE a.agent_type = ? AND datetime(g.graded_at) >= datetime(?)
    ORDER BY g.graded_at DESC
  `).all(role, sinceIso) as Grade[];
}

/** Completed attempts for `role` since `sinceIso` (ISO timestamp). */
export function getCompletedAttemptsForRoleSince(role: string, sinceIso: string): Attempt[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM attempts
    WHERE agent_type = ? AND status = 'completed'
      AND completed_at IS NOT NULL AND datetime(completed_at) >= datetime(?)
    ORDER BY completed_at DESC
  `).all(role, sinceIso) as Attempt[];
}

// ─── end A3.5 dream block ────────────────────────────────────────────────────

export function closeDb(): void {
  if (_db) {
    try {
      // Force WAL checkpoint before closing — ensures all data is written to main DB file
      _db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err: unknown) {
      console.debug(`[DB] WAL checkpoint failed (best effort):`, (err as Error).message);
    }
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
  } catch (err: unknown) {
    console.debug(`[DB] backup failed (best effort):`, (err as Error).message);
  }
}
