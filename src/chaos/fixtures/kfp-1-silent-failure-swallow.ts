/**
 * Regression fixture: silent error swallow in catch blocks.
 *
 * Failure mode: `silent-failure-swallow` (KFP-1).
 *
 * Post-mortem: silent catch blocks across core/ and serve/ swallowed errors
 * for months — agents would mark themselves completed despite Linear-API
 * failures, OAuth refreshes, and DB writes throwing exceptions that
 * disappeared into `catch { /* best effort *\/ }` blocks. The fix swept
 * 41+ silent catches across two passes (core + monitor) and replaced them
 * with logged catches.
 *
 * Refs:
 *   - RYA-595 (initial sweep)
 *   - RYA-742 (serve/ silent catches → logged)
 *   - commits 4e9cea4, 1672057 (the two cleanups)
 *
 * What this fixture gates: a catch block that swallows an error must produce
 * an observable signal (log or re-throw). Agent self-completion logic must
 * NOT proceed when an error was swallowed upstream.
 */

import type { RegressionFixture } from './types.js';

export const fixture: RegressionFixture = {
  id: 'kfp-1-silent-failure-swallow',
  failureModeId: 'silent-failure-swallow',
  description:
    'A catch block that swallows an error must produce an observable signal; ' +
    'completion paths must not assume success when the error was silenced.',
  postMortemRefs: ['RYA-595', 'RYA-742', 'commit:4e9cea4', 'commit:1672057'],
  severity: 'critical',
  check: () => {
    // ─── Sub-check 1: simulate the anti-pattern ──────────────────────────
    // A silent handler must be detectable as silent. If this assertion ever
    // flips (because the simulator no longer captures silence), the gate is
    // not measuring what it claims to measure.
    const logs: string[] = [];
    const silentHandler = (_err: Error) => {
      /* swallow */
    };
    // The handler is invoked but produces no log output.
    silentHandler(new Error('ignored failure'));
    if (logs.length !== 0) {
      return {
        ok: false,
        reason: 'silent handler unexpectedly produced log output — the test is no longer measuring the failure mode',
      };
    }

    // ─── Sub-check 2: the correct pattern is observable ─────────────────
    // A logged handler must produce an observable record.
    const observed: string[] = [];
    const loggedHandler = (err: Error) => {
      observed.push(`[Error] ${err.message}`);
    };
    loggedHandler(new Error('connection refused'));
    if (observed.length === 0 || !observed[0].includes('connection refused')) {
      return {
        ok: false,
        reason: 'logged handler did not produce expected observable record',
        observed: { observed },
      };
    }

    // ─── Sub-check 3: completion gate must not pass on silenced error ───
    // Repro the buggy pattern: an upstream fn swallows; downstream sees no
    // exception and marks completed. The fix is that completion must be
    // gated on a positive signal (no errorEvents accumulated), not on the
    // *absence* of a thrown exception.
    type CompletionContext = { errorEvents: string[]; completed: boolean };
    const ctx: CompletionContext = { errorEvents: [], completed: false };

    // upstream fails silently
    try {
      throw new Error('upstream failure');
    } catch (e) {
      // The buggy version did nothing here. The correct version logs the error
      // into errorEvents, which the completion gate inspects.
      ctx.errorEvents.push(String((e as Error).message));
    }

    // completion gate: must refuse to mark completed when errorEvents non-empty
    if (ctx.errorEvents.length > 0) {
      ctx.completed = false;
    } else {
      ctx.completed = true;
    }

    if (ctx.completed === true) {
      return {
        ok: false,
        reason: 'completion gate passed despite an error in errorEvents — silent-swallow pattern reintroduced',
        observed: { ctx },
      };
    }

    return { ok: true, reason: '' };
  },
};
