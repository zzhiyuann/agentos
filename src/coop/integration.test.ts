/**
 * Integration test for the COOP pipeline.
 *
 * Runs the full build against checked-in fixtures and asserts:
 *  (1) every expected page is written
 *  (2) the output contains no redactor-flagged strings (strict audit passes)
 *  (3) the shared-memory whitelist is honored (private-note.md is NOT published)
 *  (4) the stub redactor actually scrubbed the email in the fixture retro
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { build } from './build.js';
import { StubRedactor } from './redactor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES = join(__dirname, 'fixtures');

describe('coop pipeline', () => {
  const outDir = join(tmpdir(), `coop-test-${Date.now()}`);

  beforeAll(async () => {
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  });

  it('builds the full site in strict mode against fixtures', async () => {
    const result = await build(
      {
        outDir,
        strict: true,
        now: new Date('2026-04-22T12:00:00Z'),
        agentsDir: join(FIXTURES, 'agents'),
        sharedMemoryDir: join(FIXTURES, 'shared-memory'),
        budgetFile: join(FIXTURES, 'budget.json'), // missing file → empty cost
        gitRoot: join(FIXTURES, 'repo'),            // not a git repo → empty git
      },
      {
        // Skip live Linear entirely for fixture builds.
        linear: { offline: true, cacheDir: join(outDir, '_cache') },
        // Use the stub redactor — same code path as production default.
        redactor: new StubRedactor(),
      },
    );

    // (1) Every route produced a file.
    const expected = [
      '/index.html',
      '/agents/index.html',
      '/agents/cto/index.html',
      '/retros/index.html',
      '/decisions/index.html',
      '/shipped/index.html',
      '/costs/index.html',
      '/about/index.html',
    ];
    for (const p of expected) {
      expect(existsSync(join(outDir, p.replace(/^\//, '')))).toBe(true);
    }
    expect(result.pages.length).toBeGreaterThanOrEqual(expected.length);
    expect(result.auditViolations).toBe(0);
  });

  it('redacts sensitive strings from the retro fixture', () => {
    const retros = readFileSync(join(outDir, 'retros', 'index.html'), 'utf-8');
    // The fixture retro contained a bare email and a /Users/ path.
    // After redaction, neither should appear verbatim.
    expect(retros).not.toMatch(/test@example\.com/);
    expect(retros).not.toMatch(/\/Users\/someone\/secrets/);
    // Redaction markers should appear instead.
    expect(retros).toMatch(/REDACTED_EMAIL/);
    expect(retros).toMatch(/Users\/\[REDACTED\]/);
  });

  it('honors the public: true whitelist', () => {
    // private-note.md has no public: true — it must not appear anywhere.
    const decisions = readFileSync(join(outDir, 'decisions', 'index.html'), 'utf-8');
    expect(decisions).not.toMatch(/hunter2/);
    expect(decisions).not.toMatch(/Private note/);
    // The public decision should be there.
    expect(decisions).toMatch(/Ship everything in public/);
  });

  it('passes the strict audit over every rendered page', () => {
    // No page should contain raw emails, /Users/<name> paths, or bearer tokens.
    const emailRe = /[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const homePath = /\/Users\/(?!\[REDACTED)/;
    const pages = ['index.html', 'retros/index.html', 'decisions/index.html', 'agents/cto/index.html'];
    for (const p of pages) {
      const full = join(outDir, p);
      if (!existsSync(full)) continue;
      const text = readFileSync(full, 'utf-8');
      expect(text, `${p} contained an unredacted email`).not.toMatch(emailRe);
      expect(text, `${p} contained an unredacted /Users/ path`).not.toMatch(homePath);
    }
  });

  it('writes the bundle.json audit trail', () => {
    const bundlePath = join(outDir, 'bundle.json');
    expect(existsSync(bundlePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(bundlePath, 'utf-8'));
    expect(parsed.linear.source).toBe('linear');
    expect(parsed.retros.source).toBe('retros');
    expect(parsed.memory.source).toBe('memory');
    expect(parsed.git.source).toBe('git');
    expect(parsed.cost.source).toBe('cost');
    expect(typeof parsed.retros.redactions).toBe('number');
  });
});
