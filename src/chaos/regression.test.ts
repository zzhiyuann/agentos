/**
 * Chaos-regression CI gate (RYA-873).
 *
 * Each fixture in src/chaos/fixtures/ encodes a known failure-mode signature
 * that has reached production at least once and produced a post-mortem. This
 * suite runs every fixture and fails the build if any signature reappears.
 *
 * Run locally:   npx vitest run src/chaos/regression.test.ts
 * CI invocation: chaos-regression job in .github/workflows/ci.yml
 *
 * Adding a fixture: see src/chaos/README.md.
 */

import { describe, it, expect } from 'vitest';
import { fixtures } from './fixtures/index.js';

describe('[chaos-regression] known failure-mode signatures', () => {
  it('registry has the minimum gated signatures (RYA-873 acceptance)', () => {
    // Acceptance criterion from the task spec: at least 2 known failure
    // signatures gated by Day 75. Track this as a hard floor — sub-task 3
    // post-mortems extend it upward but never below.
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
  });

  it('every fixture has a stable id, post-mortem refs, and a check', () => {
    for (const f of fixtures) {
      expect(f.id, `fixture missing id`).toBeTruthy();
      expect(f.failureModeId, `fixture ${f.id} missing failureModeId`).toBeTruthy();
      expect(f.postMortemRefs.length, `fixture ${f.id} has no post-mortem refs`).toBeGreaterThan(0);
      expect(typeof f.check, `fixture ${f.id} check is not a function`).toBe('function');
    }
  });

  it('fixture ids are unique', () => {
    const ids = fixtures.map(f => f.id);
    const unique = new Set(ids);
    expect(unique.size, 'duplicate fixture ids in registry').toBe(ids.length);
  });

  // Generate one test per fixture so vitest reports each by id.
  for (const f of fixtures) {
    it(`[${f.severity}] ${f.id} — ${f.description.slice(0, 80)}`, async () => {
      const result = await f.check();
      if (!result.ok) {
        const refs = f.postMortemRefs.join(', ');
        throw new Error(
          `chaos-regression: signature ${f.id} reappeared. ` +
            `reason: ${result.reason}. post-mortem refs: ${refs}. ` +
            `Either fix the regression or, if this is an intentional behavior change, ` +
            `update the fixture and document the new post-mortem in src/chaos/README.md.`,
        );
      }
    });
  }
});
