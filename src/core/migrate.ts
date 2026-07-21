/**
 * Memory frontmatter migration — RYA-852, sub-task 3 of RYA-753.
 *
 * One-shot migration that walks ~/.aos/agents/<role>/memory/*.md and
 * ~/.aos/shared-memory/*.md and writes provenance frontmatter into each
 * file (memory_id, derived_from, supersedes, confidence_decay, created_at,
 * expires_at, review_by, schema_version).
 *
 * Safety: dry-run by default, per-file .bak backup, atomic write (tmp+rename),
 * idempotent (schema_version: 1 marker), reversible. See
 * docs/migration-safety-spec.md for the full design.
 */

import {
  readFileSync, writeFileSync, statSync, existsSync, renameSync,
  unlinkSync, readdirSync, mkdirSync, rmdirSync, openSync, fsyncSync, closeSync,
} from 'fs';
import { homedir } from 'os';
import { join, basename, dirname } from 'path';
import { randomBytes, createHash } from 'crypto';
import chalk from 'chalk';
import {
  parseMemoryFile,
  deriveLegacyMemoryId,
  inferDerivedFrom,
  inferConfidenceDecay,
} from './provenance.js';

const SHARED_ROLE = 'shared';
const SCHEMA_VERSION = 1;

function stateDir(): string { return join(homedir(), '.aos'); }
function agentsDir(): string { return join(stateDir(), 'agents'); }
function sharedMemoryDir(): string { return join(stateDir(), 'shared-memory'); }
function migrationsDir(): string { return join(stateDir(), 'migrations'); }
function lockDir(): string { return join(migrationsDir(), '.lock'); }

export interface MigrationPlan {
  filePath: string;
  role: string;
  status: 'migrate' | 'skip-idempotent' | 'skip-malformed';
  reason?: string;
  originalContent: string;
  newContent: string;
  newFrontmatter: TargetFrontmatter;
}

export interface MigrationStats {
  scanned: number;
  migrated: number;
  skipped_idempotent: number;
  skipped_malformed: number;
  errors: number;
  collisions: number;
}

interface TargetFrontmatter {
  name: string;
  description: string;
  type: string;
  memory_id: string;
  derived_from: string[];
  supersedes: string[];
  confidence_decay: number | null;
  expires_at: string | null;
  review_by: string | null;
  created_at: string;
  schema_version: number;
}

// ---- Public API ----

export interface PlanOptions {
  role?: string;
  homeOverride?: string;  // for tests
}

/**
 * Compute migration plans for every memory file. No file writes.
 * Idempotency check: files with schema_version: 1 are tagged 'skip-idempotent'.
 * Collision check: target memory_ids are deduplicated by lengthening hash slice.
 */
export function planMigration(opts: PlanOptions = {}): { plans: MigrationPlan[]; stats: MigrationStats } {
  const home = opts.homeOverride ?? homedir();
  const stats: MigrationStats = {
    scanned: 0, migrated: 0, skipped_idempotent: 0,
    skipped_malformed: 0, errors: 0, collisions: 0,
  };
  const plans: MigrationPlan[] = [];

  for (const { role, dir } of memoryRoots(home, opts.role)) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md') && !f.endsWith('.bak'))
      .map(f => join(dir, f));

    for (const filePath of files) {
      stats.scanned++;
      try {
        const plan = planOneFile(role, filePath);
        plans.push(plan);
        if (plan.status === 'migrate') stats.migrated++;
        else if (plan.status === 'skip-idempotent') stats.skipped_idempotent++;
        else if (plan.status === 'skip-malformed') stats.skipped_malformed++;
      } catch (err) {
        stats.errors++;
        console.warn(`[migrate] plan failed for ${filePath}: ${(err as Error).message}`);
      }
    }
  }

  // Collision resolution: lengthen hash slice for any duplicate memory_ids
  resolveCollisions(plans, stats);

  return { plans, stats };
}

export interface ExecuteOptions {
  noBackup?: boolean;     // unsafe; tests only
  homeOverride?: string;  // for tests
}

/**
 * Execute migration plans. Acquires the global migration lock first.
 * Per file: writes .bak (if not present), then atomic tmp+rename.
 * Returns updated stats with errors counted.
 */
export function executeMigration(
  plans: MigrationPlan[],
  opts: ExecuteOptions = {},
): { writtenFiles: string[]; errors: Array<{ file: string; error: string }> } {
  const home = opts.homeOverride ?? homedir();
  const lock = acquireLock(home);
  const writtenFiles: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  try {
    ensureMigrationsDir(home);

    for (const plan of plans) {
      if (plan.status !== 'migrate') continue;
      try {
        writeOneFile(plan, opts.noBackup === true);
        writtenFiles.push(plan.filePath);
      } catch (err) {
        errors.push({ file: plan.filePath, error: (err as Error).message });
        console.warn(`[migrate] write failed for ${plan.filePath}: ${(err as Error).message}`);
      }
    }
  } finally {
    releaseLock(lock);
  }

  return { writtenFiles, errors };
}

/**
 * Restore a single file from its .bak. Atomic. Refuses if .bak doesn't exist.
 * After successful restore, .bak is deleted (the file is now the original again).
 */
export function rollbackFile(filePath: string): void {
  const bak = filePath + '.bak';
  if (!existsSync(bak)) {
    throw new Error(`No backup at ${bak}`);
  }
  if (!existsSync(filePath)) {
    throw new Error(`Target ${filePath} missing — refusing to overwrite (use --force-prune)`);
  }
  // rename atomic; replaces the migrated file with the .bak
  renameSync(bak, filePath);
}

/**
 * Walk every .bak under memory roots and rollback. Returns per-file outcome.
 * Idempotent: missing .bak files are skipped silently.
 */
export function rollbackAll(opts: { role?: string; homeOverride?: string } = {}): {
  restored: string[];
  errors: Array<{ file: string; error: string }>;
} {
  const home = opts.homeOverride ?? homedir();
  const restored: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  for (const { dir } of memoryRoots(home, opts.role)) {
    if (!existsSync(dir)) continue;
    const baks = readdirSync(dir)
      .filter(f => f.endsWith('.md.bak'))
      .map(f => join(dir, f));

    for (const bakPath of baks) {
      const filePath = bakPath.replace(/\.bak$/, '');
      try {
        rollbackFile(filePath);
        restored.push(filePath);
      } catch (err) {
        errors.push({ file: filePath, error: (err as Error).message });
      }
    }
  }
  return { restored, errors };
}

// ---- Diff for human display ----

export function unifiedDiffSnippet(plan: MigrationPlan, contextLines: number = 0): string {
  // Simple frontmatter-only diff: show original frontmatter (or "(none)") and new frontmatter.
  const parsed = parseMemoryFile(plan.originalContent);
  const oldFm = parsed.rawFrontmatter
    ? '---\n' + parsed.rawFrontmatter + '\n---'
    : '(no frontmatter)';
  const newFm = serializeFrontmatter(plan.newFrontmatter);
  return `--- ${plan.filePath}\n+++ ${plan.filePath}\n@@ frontmatter @@\n` +
    oldFm.split('\n').map(l => `- ${l}`).join('\n') + '\n' +
    newFm.split('\n').map(l => `+ ${l}`).join('\n');
}

// ---- Internals ----

function* memoryRoots(home: string, roleFilter?: string): Generator<{ role: string; dir: string }> {
  const ag = join(home, '.aos', 'agents');
  if (!roleFilter || roleFilter === SHARED_ROLE) {
    yield { role: SHARED_ROLE, dir: join(home, '.aos', 'shared-memory') };
  }
  if (existsSync(ag)) {
    const roles = readdirSync(ag, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(r => !roleFilter || r === roleFilter);
    for (const role of roles) {
      yield { role, dir: join(ag, role, 'memory') };
    }
  }
}

function planOneFile(role: string, filePath: string): MigrationPlan {
  const original = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath);

  let parsed: ReturnType<typeof parseMemoryFile>;
  try {
    parsed = parseMemoryFile(original);
  } catch (err) {
    return {
      filePath, role,
      status: 'skip-malformed',
      reason: (err as Error).message,
      originalContent: original,
      newContent: original,
      newFrontmatter: {} as TargetFrontmatter,
    };
  }

  const fm = parsed.frontmatter;

  // Idempotency: schema_version: 1 means already-migrated. Treat any explicit
  // schema_version (parsed as number; future schemas welcome) as "leave alone."
  const rawHasSchemaVersion = /^schema_version\s*:/m.test(parsed.rawFrontmatter);
  if (rawHasSchemaVersion) {
    return {
      filePath, role,
      status: 'skip-idempotent',
      originalContent: original,
      newContent: original,
      newFrontmatter: {} as TargetFrontmatter,
    };
  }

  // Build target frontmatter, preserving any existing field
  const target: TargetFrontmatter = {
    name: fm.name ?? fileName.replace(/\.md$/, ''),
    description: fm.description ?? '',
    type: fm.type ?? inferType(fileName),
    memory_id: fm.memory_id ?? deriveLegacyMemoryId(role, fileName),
    derived_from: (fm.derived_from && fm.derived_from.length > 0)
      ? fm.derived_from
      : inferDerivedFrom(fileName, parsed.body),
    supersedes: fm.supersedes ?? [],
    confidence_decay: fm.confidence_decay !== undefined
      ? fm.confidence_decay
      : inferConfidenceDecay(fm.type ?? inferType(fileName), fileName),
    expires_at: null,
    review_by: null,
    created_at: fm.created_at ?? mtimeIsoDate(filePath),
    schema_version: SCHEMA_VERSION,
  };

  const newFrontmatterBlock = serializeFrontmatter(target);
  const newContent = newFrontmatterBlock + '\n' + parsed.body;

  return {
    filePath, role,
    status: 'migrate',
    originalContent: original,
    newContent,
    newFrontmatter: target,
  };
}

function inferType(fileName: string): string {
  if (/^feedback-/i.test(fileName)) return 'feedback';
  if (/^proactive-/i.test(fileName)) return 'feedback';
  if (/^daily-retro-/i.test(fileName)) return 'project';
  return 'project';
}

function mtimeIsoDate(filePath: string): string {
  const ms = statSync(filePath).mtimeMs;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Render a frontmatter block. Field order is fixed for deterministic diffs.
 * Strings with special chars are wrapped in single quotes; arrays inlined.
 */
function serializeFrontmatter(t: TargetFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${yamlString(t.name)}`);
  lines.push(`description: ${yamlString(t.description)}`);
  lines.push(`type: ${yamlString(t.type)}`);
  lines.push(`memory_id: ${t.memory_id}`);
  lines.push(`derived_from: ${yamlArray(t.derived_from)}`);
  lines.push(`supersedes: ${yamlArray(t.supersedes)}`);
  lines.push(`confidence_decay: ${t.confidence_decay === null ? 'null' : String(t.confidence_decay)}`);
  lines.push(`expires_at: ${t.expires_at === null ? 'null' : t.expires_at}`);
  lines.push(`review_by: ${t.review_by === null ? 'null' : t.review_by}`);
  lines.push(`created_at: ${t.created_at}`);
  lines.push(`schema_version: ${t.schema_version}`);
  lines.push('---');
  return lines.join('\n');
}

function yamlString(s: string): string {
  // Empty string → '' (quoted to avoid being parsed as null)
  if (s === '') return "''";
  // If safe scalar (no special chars), emit bare. Else single-quote.
  if (/^[A-Za-z0-9_./()\- :;,?!]+$/.test(s) && !/^[-?:&*!|>%@`]/.test(s) && s.indexOf(': ') === -1) {
    return s;
  }
  // Single-quote: in YAML, '' inside single quotes is literal '
  return "'" + s.replace(/'/g, "''") + "'";
}

function yamlArray(items: string[]): string {
  if (items.length === 0) return '[]';
  return '[' + items.map(i => i).join(', ') + ']';
}

/**
 * If two plans target the same memory_id, lengthen the hash slice for the
 * second-and-later occurrences until unique. This is essentially never hit
 * in practice (~1e-7 collision probability at our scale) but the spec
 * (RYA-849 hard blocker #3) requires the check.
 */
function resolveCollisions(plans: MigrationPlan[], stats: MigrationStats): void {
  const ids = new Map<string, MigrationPlan[]>();
  for (const p of plans) {
    if (p.status !== 'migrate') continue;
    const arr = ids.get(p.newFrontmatter.memory_id) ?? [];
    arr.push(p);
    ids.set(p.newFrontmatter.memory_id, arr);
  }
  for (const [id, group] of ids) {
    if (group.length <= 1) continue;
    stats.collisions += group.length - 1;
    // Keep the first (it stays at 8-hex), lengthen the rest.
    for (let i = 1; i < group.length; i++) {
      const p = group[i];
      const longer = lengthenedId(p.role, basename(p.filePath));
      p.newFrontmatter.memory_id = longer;
      // Re-serialize the frontmatter to reflect the new id
      const parsed = parseMemoryFile(p.originalContent);
      const newFm = serializeFrontmatter(p.newFrontmatter);
      p.newContent = newFm + '\n' + parsed.body;
    }
    console.warn(`[migrate] collision on ${id} across ${group.length} files; lengthened ${group.length - 1}`);
  }
}

function lengthenedId(role: string, fileName: string): string {
  // 16 hex chars instead of 8. Same input → same output (deterministic).
  // Reuses sha256 from deriveLegacyMemoryId by computing a longer slice.
  const { createHash } = eval('require')('crypto');
  const hash = createHash('sha256').update(`${role}::${fileName}`).digest('hex').slice(0, 16);
  return `mem_${role}_${hash}`;
}

function writeOneFile(plan: MigrationPlan, noBackup: boolean): void {
  const filePath = plan.filePath;
  const bakPath = filePath + '.bak';

  // Step 1: backup if not present
  if (!noBackup && !existsSync(bakPath)) {
    writeFileSync(bakPath, plan.originalContent, 'utf-8');
    fsync(bakPath);
  }

  // Step 2: tmp file
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, plan.newContent, 'utf-8');
    fsync(tmpPath);
    // Step 3: atomic rename
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupErr) {
      console.log(chalk.dim(`[migrate] tmp cleanup failed for ${tmpPath}: ${(cleanupErr as Error).message}`));
    }
    throw err;
  }
}

function fsync(filePath: string): void {
  // Best-effort fsync. Failures are non-fatal but logged.
  try {
    const fd = openSync(filePath, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch (err) {
    console.debug(`[migrate] fsync failed for ${filePath}: ${(err as Error).message}`);
  }
}

function ensureMigrationsDir(home: string): void {
  const d = join(home, '.aos', 'migrations');
  mkdirSync(d, { recursive: true });
}

interface LockHandle { dir: string }

function acquireLock(home: string): LockHandle {
  const d = join(home, '.aos', 'migrations', '.lock');
  ensureMigrationsDir(home);
  try {
    mkdirSync(d, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `Migration lock held at ${d}. Another migration may be running. ` +
        `If stale, remove with: rm -rf ${d}`
      );
    }
    throw err;
  }
  try {
    writeFileSync(join(d, 'pid'), String(process.pid), 'utf-8');
  } catch (err) {
    console.log(chalk.dim(`[migrate] pid file write failed in ${d}: ${(err as Error).message} — informational only, lock still held`));
  }
  return { dir: d };
}

function releaseLock(lock: LockHandle): void {
  try {
    unlinkSync(join(lock.dir, 'pid'));
  } catch (err) {
    console.log(chalk.dim(`[migrate] pid file cleanup failed in ${lock.dir}: ${(err as Error).message}`));
  }
  try { rmdirSync(lock.dir); } catch (err) {
    console.debug(`[migrate] failed to release lock: ${(err as Error).message}`);
  }
}

/**
 * Test-only: reset module state. No state currently — placeholder for future.
 */
export function _resetForTests(): void {
  // intentionally empty
}

// Suppress unused-import warning for `dirname` until/unless we add nested-dir support.
void dirname;
