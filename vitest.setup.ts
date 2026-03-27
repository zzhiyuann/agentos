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
