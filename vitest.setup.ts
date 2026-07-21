/**
 * Vitest setup — provide sensible defaults for AOS_* env vars so unit tests
 * don't crash when `getConfig()` is called transitively at module scope
 * or inside test helpers. Only sets vars that are missing — existing values
 * (e.g. from a developer's shell) are preserved.
 *
 * Integration tests that need real API access gate themselves behind
 * AOS_LIVE_TESTS=1 and are unaffected by these defaults.
 */

process.env.AOS_LINEAR_TEAM_ID ??= 'test-team-id';
process.env.AOS_LINEAR_TEAM_KEY ??= 'TEST';
process.env.AOS_HOST ??= 'localhost';
process.env.AOS_USER ??= 'testuser';

// Isolate sqlite writes from the production ~/.aos/state.db. Without this,
// any test that touches src/core/db.ts inserts rows into the real DB
// (RYA-1198: grader.test.ts left TEST-RUBRIC-* enrichments, dispatch/
// scheduler tests left thousands of TEST-* attempts/grades/queue rows).
// Only the DB path is redirected — many unit tests legitimately READ live
// machine state under ~/.aos (personas, OAuth tokens, workspace-map.json),
// so a blanket AOS_STATE_DIR tmpdir would break them. Full state-dir
// isolation remains available via AOS_STATE_DIR for callers that want it.
// Respect an explicit override from the shell, otherwise use a fresh tmpdir.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join as joinPath } from 'path';

process.env.AOS_DB_PATH ??= joinPath(mkdtempSync(joinPath(tmpdir(), 'aos-test-state-')), 'state.db');

// RYA-1199: scrub git's hook-exported env. When vitest runs inside a git
// hook from a linked worktree, GIT_DIR/GIT_INDEX_FILE point at the real
// repo and are inherited by every child process tests spawn. Tests that
// `git init`/`git add` temp fixtures then hit the REAL repo instead —
// 11 tests fail, and a fixture `git init` rewrites the main repo's config
// with core.bare=true. The pre-commit hook also unsets these, but tests
// must be safe to run from any environment.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
