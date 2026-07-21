/**
 * Regression-fixture types for the chaos-regression CI gate (RYA-873).
 *
 * A RegressionFixture is the smallest reproducible signature of a known
 * failure mode: a synthetic input the system must handle correctly + the
 * expected non-failure behavior. Fixtures are self-contained — they do not
 * touch real Linear, real tmux, or real DB. They run in <1s so the gate
 * stays fast enough for the pre-commit hook.
 *
 * Fixture lineage:
 *   FailureMode (src/chaos/seed-taxonomy.md)        ← what can break
 *     ↓ post-mortem (sub-task 3)
 *   RegressionFixture (this file)                   ← signature + check
 *     ↓ chaos-regression CI job
 *   Build pass/fail
 *
 * Adding a fixture: see src/chaos/README.md.
 */

// Local minimal stub. The full FailureMode interface lives in src/chaos/types.ts,
// which is uncommitted. Only the fields used below are mirrored here; replace this
// stub with the upstream import when src/chaos/types.ts lands in HEAD.
interface FailureMode {
  id: string;
  severity: 'critical' | 'important' | 'informational';
}

/**
 * One regression fixture: input + expected non-failure behavior.
 *
 * Each fixture corresponds to a post-mortem and gates against re-introduction
 * of that exact failure signature.
 */
export interface RegressionFixture {
  /** Stable id, e.g., "kfp-1-silent-failures". Must match a FailureMode id. */
  id: string;
  /** Reference to the failure mode this fixture exercises. */
  failureModeId: FailureMode['id'];
  /** What this fixture proves (one sentence). */
  description: string;
  /** Post-mortem provenance: Linear keys, retro paths, or commit shas. */
  postMortemRefs: string[];
  /** Severity inherited from the failure mode. */
  severity: FailureMode['severity'];
  /**
   * The behavioral assertion. Returns ok=true if the system handled the
   * input correctly (i.e., did NOT exhibit the known-failure signature).
   * On regression, returns ok=false with a `reason` string for the gate
   * to surface in CI logs.
   *
   * Implementations must be deterministic and synchronous-or-fast-async
   * (<200ms per fixture); they reproduce the failure-prone code path in
   * isolation, not the full system.
   */
  check: () => RegressionResult | Promise<RegressionResult>;
}

/**
 * Result of running a single fixture's check.
 */
export interface RegressionResult {
  /** True if the system handled the failure mode correctly. */
  ok: boolean;
  /** Human-readable reason on regression. Empty when ok=true. */
  reason: string;
  /** Optional structured details for debugging. */
  observed?: Record<string, unknown>;
}

/**
 * Run summary for the full fixture suite. Used by the CLI runner and CI gate.
 */
export interface RegressionRunSummary {
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ id: string; reason: string; severity: FailureMode['severity']; postMortemRefs: string[] }>;
  durationMs: number;
}
