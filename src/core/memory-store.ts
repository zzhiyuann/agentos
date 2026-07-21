import { createHash, randomUUID } from 'crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { STATE_DIR } from './config.js';
import { getAgentsDir, listAgents } from './persona.js';
import { mkdirSync, statSync } from 'fs';
import { dirname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Memory {
  id: string;
  agent_role: string;
  name: string;
  description: string | null;
  type: string | null;
  content: string;
  source_file: string | null;
  issue_keys: string | null;
  content_hash: string;
  char_count: number;
  created_at: string;
  updated_at: string;
  /** A3.4: times this memory was surfaced via search/retrieval. */
  retrieve_count: number;
  last_retrieved_at: string | null;
}

export interface RetrievedMemory {
  id: string;
  name: string;
  description: string | null;
  type: string | null;
  content: string;
  source_file: string | null;
  rank: number;
}

export interface MemoryStats {
  role: string;
  systemMemorySize: number;
  longTermCount: number;
  longTermChars: number;
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Database connection (reuses state.db)
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;

function getMemoryDb(): Database.Database {
  if (_db) return _db;

  // Use STATE_DIR directly — memory store doesn't need Linear config
  const dbPath = join(STATE_DIR, 'state.db');
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  // Check if memories table already exists to avoid re-running FTS setup
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
  ).get();

  if (exists) {
    migrateMemoriesSchema(db);
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_role TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT,
      content TEXT NOT NULL,
      source_file TEXT,
      issue_keys TEXT,
      content_hash TEXT NOT NULL,
      char_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      retrieve_count INTEGER DEFAULT 0,
      last_retrieved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_role ON memories(agent_role);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(agent_role, source_file);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      name, description, content, issue_keys,
      content='memories', content_rowid='rowid',
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, name, description, content, issue_keys)
      VALUES (new.rowid, new.name, new.description, new.content, new.issue_keys);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, content, issue_keys)
      VALUES ('delete', old.rowid, old.name, old.description, old.content, old.issue_keys);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, content, issue_keys)
      VALUES ('delete', old.rowid, old.name, old.description, old.content, old.issue_keys);
      INSERT INTO memories_fts(rowid, name, description, content, issue_keys)
      VALUES (new.rowid, new.name, new.description, new.content, new.issue_keys);
    END;
  `);
}

/**
 * A3.4: guarded additive migration — add retrieval-tracking columns to
 * pre-existing memories tables. Mirrors the additive CREATE TABLE pattern in
 * db.ts: check PRAGMA table_info, ALTER TABLE only when the column is missing.
 */
function migrateMemoriesSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
  const names = new Set(columns.map(c => c.name));
  if (!names.has('retrieve_count')) {
    db.exec('ALTER TABLE memories ADD COLUMN retrieve_count INTEGER DEFAULT 0');
  }
  if (!names.has('last_retrieved_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN last_retrieved_at TEXT');
  }
}

/**
 * A3.4: bump retrieval stats for memories that were just surfaced to an agent.
 * Best-effort — retrieval must never fail because tracking failed.
 */
function markRetrieved(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memories SET retrieve_count = COALESCE(retrieve_count, 0) + 1, last_retrieved_at = datetime('now') WHERE id IN (${placeholders})`
    ).run(...ids);
  } catch (err: unknown) {
    console.debug('[memory-store] retrieval tracking failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

export function parseFrontmatter(raw: string): { meta: Record<string, string>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, content: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, content: match[2] };
}

/** Extract issue keys like RYA-142 from text */
export function extractIssueKeys(text: string): string[] {
  const matches = text.match(/[A-Z]+-\d+/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Sync: files → DB
// ---------------------------------------------------------------------------

export function syncMemories(role: string): number {
  const db = getMemoryDb();
  const memoryDir = join(getAgentsDir(), role, 'memory');
  if (!existsSync(memoryDir)) return 0;

  const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
  const liveFiles = new Set(files);
  let changed = 0;

  // Track new/changed entries eligible for system memory auto-promotion
  const toPromote: { file: string; name: string; content: string }[] = [];

  const upsert = db.prepare(`
    INSERT INTO memories (id, agent_role, name, description, type, content, source_file, issue_keys, content_hash, char_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      type = excluded.type,
      content = excluded.content,
      issue_keys = excluded.issue_keys,
      content_hash = excluded.content_hash,
      char_count = excluded.char_count,
      updated_at = datetime('now')
    WHERE content_hash != excluded.content_hash
  `);

  const findByFile = db.prepare(
    'SELECT id, content_hash FROM memories WHERE agent_role = ? AND source_file = ?'
  );

  const tx = db.transaction(() => {
    for (const file of files) {
      const raw = readFileSync(join(memoryDir, file), 'utf-8');
      if (!raw.trim()) continue;

      const { meta, content } = parseFrontmatter(raw);
      const hash = contentHash(content);

      const existing = findByFile.get(role, file) as { id: string; content_hash: string } | undefined;

      if (existing && existing.content_hash === hash) continue; // unchanged

      const id = existing?.id ?? randomUUID();
      const name = meta.name || file.replace('.md', '');
      const description = meta.description || null;
      const type = meta.type || null;
      const issueKeys = extractIssueKeys(raw).join(',') || null;

      upsert.run(id, role, name, description, type, content, file, issueKeys, hash, content.length);
      changed++;

      // Auto-promote: feedback type or explicit layer: system
      if (meta.layer === 'system' || meta.type === 'feedback') {
        toPromote.push({ file, name, content });
      }
    }

    // Remove DB rows for deleted files
    const allDbFiles = db.prepare(
      'SELECT id, source_file FROM memories WHERE agent_role = ? AND source_file IS NOT NULL'
    ).all(role) as { id: string; source_file: string }[];

    for (const row of allDbFiles) {
      if (!liveFiles.has(row.source_file)) {
        db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
        changed++;
      }
    }
  });

  tx();

  // Drop tombstoned sections from system-memory.md whose source file no longer
  // exists. Must run unconditionally — a sync that only deletes files produces
  // no toPromote entries but still leaves dead sections in system-memory.md.
  pruneTombstonedSystemMemoryEntries(role, liveFiles);

  // Auto-promote eligible memories to system-memory.md
  if (toPromote.length > 0) {
    autoPromoteToSystemMemory(role, toPromote);
  }

  return changed;
}

/** Sync shared memory files (agent_role = '_shared') */
export function syncSharedMemories(): number {
  const db = getMemoryDb();
  const sharedDir = join(STATE_DIR, 'shared-memory');
  if (!existsSync(sharedDir)) return 0;

  const files = readdirSync(sharedDir).filter(f => f.endsWith('.md'));
  let changed = 0;
  const role = '_shared';

  const upsert = db.prepare(`
    INSERT INTO memories (id, agent_role, name, description, type, content, source_file, issue_keys, content_hash, char_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      content = excluded.content,
      issue_keys = excluded.issue_keys,
      content_hash = excluded.content_hash,
      char_count = excluded.char_count,
      updated_at = datetime('now')
    WHERE content_hash != excluded.content_hash
  `);

  const findByFile = db.prepare(
    'SELECT id, content_hash FROM memories WHERE agent_role = ? AND source_file = ?'
  );

  const tx = db.transaction(() => {
    const seenFiles = new Set<string>();

    for (const file of files) {
      seenFiles.add(file);
      const raw = readFileSync(join(sharedDir, file), 'utf-8');
      if (!raw.trim()) continue;

      const hash = contentHash(raw);
      const existing = findByFile.get(role, file) as { id: string; content_hash: string } | undefined;
      if (existing && existing.content_hash === hash) continue;

      const id = existing?.id ?? randomUUID();
      const name = file.replace('.md', '');
      const issueKeys = extractIssueKeys(raw).join(',') || null;

      upsert.run(id, role, name, null, 'shared', raw, file, issueKeys, hash, raw.length);
      changed++;
    }

    const allDbFiles = db.prepare(
      "SELECT id, source_file FROM memories WHERE agent_role = '_shared' AND source_file IS NOT NULL"
    ).all() as { id: string; source_file: string }[];

    for (const row of allDbFiles) {
      if (!seenFiles.has(row.source_file)) {
        db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
        changed++;
      }
    }
  });

  tx();
  return changed;
}

/** Sync all agent roles + shared memory */
export function syncAllMemories(): number {
  let total = 0;
  for (const role of listAgents()) {
    total += syncMemories(role);
  }
  total += syncSharedMemories();
  return total;
}

// ---------------------------------------------------------------------------
// Auto-promote to system memory
// ---------------------------------------------------------------------------

// Bumped 20K → 24K on 2026-05-07 (RYA-1042) so universal feedback rules
// (e.g., precommit-diff-stat-audit) can promote to all 6 agents even when
// the system-memory.md is already near-full. Proper LRU/relevance eviction
// is tracked as a follow-up (RYA-1042 sub-issue).
const SYSTEM_MEMORY_MAX_CHARS = 24_000;

/**
 * Auto-append new feedback/system-tagged memories to system-memory.md.
 * Deduplicates by source file marker. Respects size budget.
 */
function autoPromoteToSystemMemory(
  role: string,
  entries: { file: string; name: string; content: string }[],
): void {
  const systemPath = join(getAgentsDir(), role, 'system-memory.md');

  // Read existing system memory to check for duplicates and size
  let existing = '';
  if (existsSync(systemPath)) {
    existing = readFileSync(systemPath, 'utf-8');
  } else {
    // Bootstrap with header
    existing = `# System Memory — ${role}\n\nCore rules, patterns, and hard-won wisdom. Always loaded.\n\n`;
    writeFileSync(systemPath, existing, 'utf-8');
  }

  for (const entry of entries) {
    // Dedup: check if this source file is already referenced
    const marker = `<!-- source: ${entry.file} -->`;
    if (existing.includes(marker)) continue;

    // Budget check
    const section = `\n${marker}\n### ${entry.name}\n\n${entry.content}\n`;
    if (existing.length + section.length > SYSTEM_MEMORY_MAX_CHARS) {
      break; // stop promoting when budget exceeded
    }

    appendFileSync(systemPath, section, 'utf-8');
    existing += section;
  }
}

// Matches the auto-promote marker `<!-- source: <file> -->`. Capture group 1
// is the source filename. The pattern intentionally excludes `>` from the
// filename charset so it can't run past the closing `-->`.
const SOURCE_MARKER_RE = /<!-- source: ([^>\n]+?) -->/g;

/**
 * Remove sections in system-memory.md whose source file no longer exists in
 * the agent's memory directory. Without this, deleted memories leave dead
 * pointers ("tombstones") that accumulate indefinitely and waste budget.
 *
 * Sections are delimited by `<!-- source: <file> -->` markers (written by
 * autoPromoteToSystemMemory). Anything before the first marker is treated as
 * the file header and preserved verbatim.
 *
 * Returns true if any tombstones were pruned (file was rewritten).
 */
export function pruneTombstonedSystemMemoryEntries(
  role: string,
  liveFiles: Set<string>,
): boolean {
  const systemPath = join(getAgentsDir(), role, 'system-memory.md');
  if (!existsSync(systemPath)) return false;

  const content = readFileSync(systemPath, 'utf-8');
  const matches = [...content.matchAll(SOURCE_MARKER_RE)];
  if (matches.length === 0) return false;

  const header = content.slice(0, matches[0].index!);
  let rebuilt = header;
  let pruned = false;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const file = m[1].trim();
    const start = m.index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;

    if (liveFiles.has(file)) {
      rebuilt += content.slice(start, end);
    } else {
      pruned = true;
    }
  }

  if (pruned) {
    writeFileSync(systemPath, rebuilt, 'utf-8');
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// FTS5 Search
// ---------------------------------------------------------------------------

// FTS5 special characters that need escaping
const FTS5_SPECIAL = /['"()*:^~{}[\]!&|@<>\\]/g;

function escapeFts5(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Simple stopwords to filter from search queries */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
  'both', 'either', 'neither', 'each', 'every', 'all', 'any', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'only', 'same', 'than',
  'too', 'very', 'just', 'because', 'this', 'that', 'these', 'those',
  'it', 'its', 'if', 'then', 'else', 'when', 'up', 'out', 'about',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function buildFtsQuery(issueKey: string, title: string, description?: string): string {
  const parts: string[] = [];

  // Exact issue key (highest signal)
  if (issueKey) parts.push(escapeFts5(issueKey));

  // Title words
  if (title) {
    for (const word of tokenize(title)) {
      parts.push(escapeFts5(word));
    }
  }

  // First ~200 chars of description
  if (description) {
    for (const word of tokenize(description.substring(0, 200))) {
      parts.push(escapeFts5(word));
    }
  }

  if (parts.length === 0) return '';
  return parts.join(' OR ');
}

/** Search memories by free-text query */
export function searchMemories(
  role: string,
  query: string,
  limit = 10
): (Memory & { rank: number })[] {
  const db = getMemoryDb();

  const words = tokenize(query);
  // Also include raw issue key patterns
  const issueKeyMatches = query.match(/[A-Z]+-\d+/g) || [];
  const allTerms = [...issueKeyMatches.map(escapeFts5), ...words.map(escapeFts5)];

  if (allTerms.length === 0) return [];

  const ftsQuery = allTerms.join(' OR ');

  const results = db.prepare(`
    SELECT m.*, memories_fts.rank
    FROM memories m
    JOIN memories_fts ON memories_fts.rowid = m.rowid
    WHERE memories_fts MATCH ?
      AND m.agent_role IN (?, '_shared')
    ORDER BY memories_fts.rank
    LIMIT ?
  `).all(ftsQuery, role, limit) as (Memory & { rank: number })[];

  markRetrieved(db, results.map(m => m.id));
  return results;
}

// ---------------------------------------------------------------------------
// Retrieval for spawn
// ---------------------------------------------------------------------------

const MAX_RETRIEVED_CHARS = 30_000;

export function retrieveMemoriesForIssue(
  role: string,
  issueKey: string,
  issueTitle: string,
  issueDescription?: string,
  maxChars = MAX_RETRIEVED_CHARS
): RetrievedMemory[] {
  const db = getMemoryDb();

  const selected: RetrievedMemory[] = [];
  let totalChars = 0;

  // 1. Exact issue key matches (always included)
  const exactMatches = db.prepare(`
    SELECT * FROM memories
    WHERE agent_role IN (?, '_shared')
      AND issue_keys LIKE ?
    ORDER BY updated_at DESC
  `).all(role, `%${issueKey}%`) as Memory[];

  const seenIds = new Set<string>();
  for (const mem of exactMatches) {
    // Verify the issue key is an exact match (not substring like RYA-1 matching RYA-10)
    const keys = (mem.issue_keys || '').split(',');
    if (!keys.includes(issueKey)) continue;

    if (totalChars + mem.content.length > maxChars) continue;
    selected.push({
      id: mem.id,
      name: mem.name,
      description: mem.description,
      type: mem.type,
      content: mem.content,
      source_file: mem.source_file,
      rank: -100, // highest priority
    });
    totalChars += mem.content.length;
    seenIds.add(mem.id);
  }

  // 2. FTS5 ranked results
  const ftsQuery = buildFtsQuery(issueKey, issueTitle, issueDescription);
  if (ftsQuery) {
    const ftsResults = db.prepare(`
      SELECT m.*, memories_fts.rank
      FROM memories m
      JOIN memories_fts ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
        AND m.agent_role IN (?, '_shared')
      ORDER BY memories_fts.rank
      LIMIT 30
    `).all(ftsQuery, role) as (Memory & { rank: number })[];

    for (const mem of ftsResults) {
      if (seenIds.has(mem.id)) continue;
      if (totalChars + mem.content.length > maxChars) continue;

      selected.push({
        id: mem.id,
        name: mem.name,
        description: mem.description,
        type: mem.type,
        content: mem.content,
        source_file: mem.source_file,
        rank: mem.rank,
      });
      totalChars += mem.content.length;
      seenIds.add(mem.id);

      if (totalChars >= maxChars) break;
    }
  }

  markRetrieved(db, selected.map(m => m.id));
  return selected;
}

// ---------------------------------------------------------------------------
// A3.5: retrieval info for distill prune proposals
// ---------------------------------------------------------------------------

export interface MemoryRetrievalInfo {
  source_file: string;
  retrieve_count: number;
  last_retrieved_at: string | null;
  updated_at: string;
}

/** Per-file retrieval stats for a role, keyed by source_file. */
export function getMemoryRetrievalInfo(role: string): Map<string, MemoryRetrievalInfo> {
  const db = getMemoryDb();
  const rows = db.prepare(`
    SELECT source_file, COALESCE(retrieve_count, 0) AS retrieve_count, last_retrieved_at, updated_at
    FROM memories WHERE agent_role = ? AND source_file IS NOT NULL
  `).all(role) as MemoryRetrievalInfo[];
  const map = new Map<string, MemoryRetrievalInfo>();
  for (const row of rows) map.set(row.source_file, row);
  return map;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function getMemoryStats(role: string): MemoryStats {
  const db = getMemoryDb();

  const counts = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(char_count), 0) as chars
    FROM memories WHERE agent_role = ?
  `).get(role) as { count: number; chars: number };

  const lastSync = db.prepare(`
    SELECT MAX(updated_at) as last_sync FROM memories WHERE agent_role = ?
  `).get(role) as { last_sync: string | null };

  // System memory from file
  const systemPath = join(getAgentsDir(), role, 'system-memory.md');
  let systemSize = 0;
  if (existsSync(systemPath)) {
    systemSize = statSync(systemPath).size;
  }

  return {
    role,
    systemMemorySize: systemSize,
    longTermCount: counts.count,
    longTermChars: counts.chars,
    lastSyncAt: lastSync.last_sync,
  };
}

export function getMemoryCount(role: string): number {
  const db = getMemoryDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM memories WHERE agent_role = ?').get(role) as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// For testing: close DB connection
// ---------------------------------------------------------------------------

export function closeMemoryDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Override DB path for testing */
export function _setTestDb(db: Database.Database): void {
  _db = db;
  initSchema(db);
}
