#!/usr/bin/env node
/**
 * CLI runner for the chaos-regression fixture suite (RYA-873).
 *
 * This is the fast-feedback path used by the pre-commit hook — it runs the
 * fixtures directly, without the vitest harness, so contributors get a
 * sub-second pass/fail signal before the full test suite spins up.
 *
 * Exit code: 0 if all fixtures pass, 1 if any fail.
 *
 * Usage (npm script): `npm run chaos:check`
 * Usage (direct):     `npx tsx src/chaos/run-fixtures.ts`
 */

import { fixtures } from './fixtures/index.js';
import type { RegressionRunSummary } from './fixtures/types.js';

async function main(): Promise<RegressionRunSummary> {
  const start = Date.now();
  const summary: RegressionRunSummary = {
    total: fixtures.length,
    passed: 0,
    failed: 0,
    failures: [],
    durationMs: 0,
  };

  for (const f of fixtures) {
    try {
      const result = await f.check();
      if (result.ok) {
        summary.passed += 1;
      } else {
        summary.failed += 1;
        summary.failures.push({
          id: f.id,
          reason: result.reason,
          severity: f.severity,
          postMortemRefs: f.postMortemRefs,
        });
      }
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({
        id: f.id,
        reason: `fixture threw: ${(err as Error).message}`,
        severity: f.severity,
        postMortemRefs: f.postMortemRefs,
      });
    }
  }

  summary.durationMs = Date.now() - start;
  return summary;
}

main().then(summary => {
  if (summary.failed === 0) {
    console.log(`[chaos-regression] ${summary.passed}/${summary.total} fixtures passed (${summary.durationMs}ms)`);
    process.exit(0);
  }

  console.error(`[chaos-regression] ${summary.failed}/${summary.total} signatures REGRESSED:`);
  for (const f of summary.failures) {
    console.error(`  - [${f.severity}] ${f.id}`);
    console.error(`    reason: ${f.reason}`);
    console.error(`    post-mortem: ${f.postMortemRefs.join(', ')}`);
  }
  console.error('');
  console.error('A known failure-mode signature has reappeared. Either fix the regression');
  console.error('or, if intentional, update the fixture and document the change in src/chaos/README.md.');
  process.exit(1);
});
