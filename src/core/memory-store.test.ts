import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

// vi.mock is hoisted, so the factory can't reference module-level variables.
// Use a hardcoded path (matches cost-attribution.test.ts pattern).
vi.mock('./config.js', () => ({
  STATE_DIR: '/tmp/aos-memstore-test',
}));

const TEST_STATE_DIR = '/tmp/aos-memstore-test';

import {
  pruneTombstonedSystemMemoryEntries,
  syncMemories,
  closeMemoryDb,
  _setTestDb,
  searchMemories,
  retrieveMemoriesForIssue,
} from './memory-store.js';

const ROLE = 'test-role';
const ROLE_DIR = join(TEST_STATE_DIR, 'agents', ROLE);
const MEMORY_DIR = join(ROLE_DIR, 'memory');
const SYSTEM_PATH = join(ROLE_DIR, 'system-memory.md');

function writeSystemMemory(sections: { file: string; name: string; content: string }[]): void {
  let body = `# System Memory — ${ROLE}\n\nCore rules, patterns, and hard-won wisdom. Always loaded.\n\n`;
  for (const s of sections) {
    body += `\n<!-- source: ${s.file} -->\n### ${s.name}\n\n${s.content}\n`;
  }
  mkdirSync(ROLE_DIR, { recursive: true });
  writeFileSync(SYSTEM_PATH, body, 'utf-8');
}

function writeMemoryFile(file: string, content: string): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(join(MEMORY_DIR, file), content, 'utf-8');
}

function resetDir(): void {
  rmSync(ROLE_DIR, { recursive: true, force: true });
}

beforeAll(() => {
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

describe('pruneTombstonedSystemMemoryEntries', () => {
  beforeEach(() => {
    resetDir();
  });

  afterEach(() => {
    resetDir();
  });

  it('returns false when system-memory.md does not exist', () => {
    const pruned = pruneTombstonedSystemMemoryEntries(ROLE, new Set(['a.md']));
    expect(pruned).toBe(false);
  });

  it('returns false when no source markers are present', () => {
    mkdirSync(ROLE_DIR, { recursive: true });
    writeFileSync(SYSTEM_PATH, '# System Memory\n\nNo sections yet.\n', 'utf-8');
    const pruned = pruneTombstonedSystemMemoryEntries(ROLE, new Set(['a.md']));
    expect(pruned).toBe(false);
    // File untouched
    expect(readFileSync(SYSTEM_PATH, 'utf-8')).toContain('No sections yet.');
  });

  it('drops sections whose source file is not in the live set', () => {
    writeSystemMemory([
      { file: 'live-1.md', name: 'live-1', content: 'live one' },
      { file: 'tombstone.md', name: 'tombstone', content: 'should be removed' },
      { file: 'live-2.md', name: 'live-2', content: 'live two' },
    ]);

    const pruned = pruneTombstonedSystemMemoryEntries(
      ROLE,
      new Set(['live-1.md', 'live-2.md']),
    );

    expect(pruned).toBe(true);
    const after = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(after).toContain('<!-- source: live-1.md -->');
    expect(after).toContain('<!-- source: live-2.md -->');
    expect(after).not.toContain('<!-- source: tombstone.md -->');
    expect(after).not.toContain('should be removed');
    // Header preserved
    expect(after.startsWith(`# System Memory — ${ROLE}`)).toBe(true);
  });

  it('preserves the file header (everything before the first marker)', () => {
    writeSystemMemory([
      { file: 'a.md', name: 'a', content: 'A' },
      { file: 'b.md', name: 'b', content: 'B' },
    ]);

    const pruned = pruneTombstonedSystemMemoryEntries(ROLE, new Set(['a.md']));
    expect(pruned).toBe(true);

    const after = readFileSync(SYSTEM_PATH, 'utf-8');
    // Original header line and prose preserved verbatim
    expect(after).toContain(`# System Memory — ${ROLE}`);
    expect(after).toContain('Core rules, patterns, and hard-won wisdom. Always loaded.');
    expect(after).toContain('<!-- source: a.md -->');
    expect(after).not.toContain('<!-- source: b.md -->');
  });

  it('returns false and leaves file untouched when all sections are live', () => {
    writeSystemMemory([
      { file: 'a.md', name: 'a', content: 'A' },
      { file: 'b.md', name: 'b', content: 'B' },
    ]);
    const before = readFileSync(SYSTEM_PATH, 'utf-8');

    const pruned = pruneTombstonedSystemMemoryEntries(ROLE, new Set(['a.md', 'b.md']));
    expect(pruned).toBe(false);
    expect(readFileSync(SYSTEM_PATH, 'utf-8')).toBe(before);
  });

  it('drops all sections when none are live', () => {
    writeSystemMemory([
      { file: 'a.md', name: 'a', content: 'A' },
      { file: 'b.md', name: 'b', content: 'B' },
    ]);

    const pruned = pruneTombstonedSystemMemoryEntries(ROLE, new Set());
    expect(pruned).toBe(true);

    const after = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(after).not.toContain('<!-- source:');
    expect(after.startsWith(`# System Memory — ${ROLE}`)).toBe(true);
  });
});

describe('syncMemories — tombstone cleanup integration', () => {
  beforeEach(() => {
    // Fresh in-memory DB per test for isolation.
    _setTestDb(new Database(':memory:'));
    resetDir();
  });

  afterEach(() => {
    closeMemoryDb();
    resetDir();
  });

  it('removes the deleted file\'s marker from system-memory.md on next sync', () => {
    // Three feedback memories: two will stay, one will be deleted.
    writeMemoryFile(
      'feedback-keep-1.md',
      `---\nname: keep-one\ndescription: keeper\ntype: feedback\n---\nKeep rule one.\n`,
    );
    writeMemoryFile(
      'feedback-keep-2.md',
      `---\nname: keep-two\ndescription: keeper\ntype: feedback\n---\nKeep rule two.\n`,
    );
    writeMemoryFile(
      'feedback-doomed.md',
      `---\nname: doomed\ndescription: tombstone\ntype: feedback\n---\nThis will be deleted.\n`,
    );

    // First sync: all three promoted to system-memory.md.
    syncMemories(ROLE);

    let sysMem = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(sysMem).toContain('<!-- source: feedback-keep-1.md -->');
    expect(sysMem).toContain('<!-- source: feedback-keep-2.md -->');
    expect(sysMem).toContain('<!-- source: feedback-doomed.md -->');
    expect(sysMem).toContain('This will be deleted.');

    // Delete the source file and re-sync.
    rmSync(join(MEMORY_DIR, 'feedback-doomed.md'));
    syncMemories(ROLE);

    sysMem = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(sysMem).toContain('<!-- source: feedback-keep-1.md -->');
    expect(sysMem).toContain('<!-- source: feedback-keep-2.md -->');
    expect(sysMem).not.toContain('<!-- source: feedback-doomed.md -->');
    expect(sysMem).not.toContain('This will be deleted.');
  });

  it('prunes tombstones even when no new files are added (delete-only sync)', () => {
    writeMemoryFile(
      'feedback-a.md',
      `---\nname: a\ntype: feedback\n---\nRule A.\n`,
    );
    writeMemoryFile(
      'feedback-b.md',
      `---\nname: b\ntype: feedback\n---\nRule B.\n`,
    );

    // First sync: both promoted.
    syncMemories(ROLE);
    expect(readFileSync(SYSTEM_PATH, 'utf-8')).toContain('<!-- source: feedback-b.md -->');

    // Delete one. No new/changed files — toPromote will be empty.
    rmSync(join(MEMORY_DIR, 'feedback-b.md'));
    syncMemories(ROLE);

    const after = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(after).toContain('<!-- source: feedback-a.md -->');
    expect(after).not.toContain('<!-- source: feedback-b.md -->');
  });

  it('does not re-add a deleted entry on subsequent sync (no resurrection)', () => {
    writeMemoryFile(
      'feedback-x.md',
      `---\nname: x\ntype: feedback\n---\nRule X.\n`,
    );
    syncMemories(ROLE);
    expect(readFileSync(SYSTEM_PATH, 'utf-8')).toContain('<!-- source: feedback-x.md -->');

    rmSync(join(MEMORY_DIR, 'feedback-x.md'));
    syncMemories(ROLE);
    syncMemories(ROLE); // Idempotent

    const after = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(after).not.toContain('<!-- source: feedback-x.md -->');
  });

  it('preserves live entries when an unrelated entry is deleted', () => {
    writeMemoryFile(
      'feedback-a.md',
      `---\nname: a\ntype: feedback\n---\nA content.\n`,
    );
    writeMemoryFile(
      'feedback-b.md',
      `---\nname: b\ntype: feedback\n---\nB content.\n`,
    );
    writeMemoryFile(
      'feedback-c.md',
      `---\nname: c\ntype: feedback\n---\nC content.\n`,
    );

    syncMemories(ROLE);
    rmSync(join(MEMORY_DIR, 'feedback-b.md'));
    syncMemories(ROLE);

    const after = readFileSync(SYSTEM_PATH, 'utf-8');
    expect(after).toContain('A content.');
    expect(after).toContain('C content.');
    expect(after).not.toContain('B content.');
  });
});

describe('retrieval tracking (A3.4)', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    _setTestDb(db);
    resetDir();
  });

  afterEach(() => {
    closeMemoryDb();
    resetDir();
  });

  function getTracking(name: string): { retrieve_count: number; last_retrieved_at: string | null } {
    return db.prepare(
      'SELECT retrieve_count, last_retrieved_at FROM memories WHERE name = ?'
    ).get(name) as { retrieve_count: number; last_retrieved_at: string | null };
  }

  it('creates retrieve_count and last_retrieved_at columns on fresh DBs', () => {
    const cols = (db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('retrieve_count');
    expect(cols).toContain('last_retrieved_at');
  });

  it('migrates pre-existing memories tables missing the columns (guarded ALTER)', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE memories (
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
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    legacy.prepare(
      "INSERT INTO memories (id, agent_role, name, content, content_hash) VALUES ('m1', 'r', 'n', 'c', 'h')"
    ).run();

    _setTestDb(legacy); // runs initSchema → migration path
    db = legacy; // afterEach closes via closeMemoryDb

    const cols = (legacy.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('retrieve_count');
    expect(cols).toContain('last_retrieved_at');
    const row = legacy.prepare('SELECT retrieve_count, last_retrieved_at FROM memories WHERE id = ?').get('m1') as {
      retrieve_count: number | null; last_retrieved_at: string | null;
    };
    expect(row.retrieve_count ?? 0).toBe(0);
    expect(row.last_retrieved_at).toBeNull();

    // Re-running the migration is a no-op (guarded ALTER must not throw)
    _setTestDb(legacy);
    expect(
      (legacy.prepare('PRAGMA table_info(memories)').all() as { name: string }[])
        .filter(c => c.name === 'retrieve_count').length
    ).toBe(1);
  });

  it('searchMemories increments retrieve_count and stamps last_retrieved_at', () => {
    writeMemoryFile('rya-500-auth.md', '---\nname: rya-500-auth\ndescription: auth notes\n---\nOAuth token rotation findings for the auth subsystem.\n');
    syncMemories(ROLE);

    expect(getTracking('rya-500-auth').retrieve_count).toBe(0);

    const results = searchMemories(ROLE, 'oauth token rotation');
    expect(results.length).toBeGreaterThan(0);

    const after = getTracking('rya-500-auth');
    expect(after.retrieve_count).toBe(1);
    expect(after.last_retrieved_at).toBeTruthy();

    searchMemories(ROLE, 'oauth token rotation');
    expect(getTracking('rya-500-auth').retrieve_count).toBe(2);
  });

  it('retrieveMemoriesForIssue increments retrieve_count for selected memories', () => {
    writeMemoryFile('rya-600-findings.md', '---\nname: rya-600-findings\n---\nFindings for RYA-600: dispatcher backoff tuning.\n');
    writeMemoryFile('unrelated.md', '---\nname: unrelated-zzz\n---\nCompletely different topic: quarterly marketing plan brainstorm.\n');
    syncMemories(ROLE);

    const retrieved = retrieveMemoriesForIssue(ROLE, 'RYA-600', 'dispatcher backoff tuning');
    expect(retrieved.some(m => m.name === 'rya-600-findings')).toBe(true);

    expect(getTracking('rya-600-findings').retrieve_count).toBe(1);
    expect(getTracking('rya-600-findings').last_retrieved_at).toBeTruthy();
    // Memory not surfaced must not be bumped
    expect(getTracking('unrelated-zzz').retrieve_count).toBe(0);
  });
});
