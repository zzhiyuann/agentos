/**
 * Behavioral eval framework for agent infrastructure.
 *
 * Inspired by Deep Agents' eval architecture:
 * - Two-tier assertions: hard (must pass) vs soft (efficiency metrics)
 * - Eval taxonomy with category tags
 * - Ideal trajectory definitions with deviation measurement
 * - Trend tracking: persist eval results to baselines.json for ratchet enforcement
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

// ─── Baselines / Trend Tracking ───

const BASELINES_PATH = path.resolve(import.meta.dirname, 'baselines.json');

export interface BaselineEntry {
  /** Current count (the ratchet ceiling). */
  count: number;
  /** ISO date when this baseline was last updated. */
  updatedAt: string;
  /** History of count changes: [date, count] tuples, newest first. Max 50 entries. */
  history: [string, number][];
}

export type Baselines = Record<string, BaselineEntry>;

/** Load baselines from disk. Returns empty object if file doesn't exist. */
export function loadBaselines(): Baselines {
  if (!existsSync(BASELINES_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINES_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

/** Save baselines to disk (pretty-printed for readability). */
export function saveBaselines(baselines: Baselines): void {
  writeFileSync(BASELINES_PATH, JSON.stringify(baselines, null, 2) + '\n', 'utf-8');
}

/**
 * Ratchet assertion: current count must not exceed stored baseline.
 * If current < baseline, updates the baseline (ratchets down).
 * If no baseline exists, records the current count as the initial baseline.
 * Returns the baseline count used for assertion.
 */
export function ratchet(scanId: string, currentCount: number): number {
  const baselines = loadBaselines();
  const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const existing = baselines[scanId];

  if (!existing) {
    // First run — record initial baseline
    baselines[scanId] = {
      count: currentCount,
      updatedAt: now,
      history: [[now, currentCount]],
    };
    saveBaselines(baselines);
    return currentCount;
  }

  if (currentCount < existing.count) {
    // Progress! Ratchet down.
    existing.history.unshift([now, currentCount]);
    if (existing.history.length > 50) existing.history.length = 50;
    existing.count = currentCount;
    existing.updatedAt = now;
    saveBaselines(baselines);
  } else if (currentCount > existing.count) {
    // Regression — record in history but don't update baseline (test will fail)
    existing.history.unshift([now, currentCount]);
    if (existing.history.length > 50) existing.history.length = 50;
    saveBaselines(baselines);
  }
  // If equal, no update needed

  return existing.count;
}

// ─── Taxonomy ───

export type EvalCategory =
  | 'dispatch'        // Agent routing, session creation, dedup
  | 'identity'        // Correct Linear client, agent persona, token usage
  | 'state'           // DB records match reality (tmux sessions, attempt status)
  | 'recovery'        // Error handling, circuit breaker, transient retries
  | 'memory'          // Agent memory persistence, validation, indexing
  | 'proactive';      // Proactive channel, strategic exploration, board voting

export type EvalSeverity = 'critical' | 'important' | 'informational';

export interface EvalMetadata {
  /** Which known failure pattern this eval targets (1-10), if any. */
  failurePattern?: number;
  /** Taxonomy category. */
  category: EvalCategory;
  /** How severe is a failure of this eval. */
  severity: EvalSeverity;
  /** Human-readable description of what behavior is being tested. */
  behavior: string;
}

// ─── Trajectory Assertions ───

export interface TrajectoryStep {
  /** Human-readable label for this step. */
  label: string;
  /** Function that checks whether this step occurred. Returns true if step was observed. */
  check: () => boolean | Promise<boolean>;
  /** If true, this step is optional (deviation is logged but not a failure). */
  optional?: boolean;
}

export interface TrajectoryResult {
  /** Name of the trajectory being asserted. */
  name: string;
  /** Steps that passed in order. */
  passedSteps: string[];
  /** Steps that were skipped or failed. */
  deviations: { step: string; reason: string }[];
  /** Whether all required steps passed in the expected order. */
  success: boolean;
  /** Total steps vs passed. */
  completionRatio: number;
}

/**
 * Assert an ideal trajectory: a sequence of steps that should occur in order.
 * Required steps must all pass. Optional steps are logged but don't fail.
 */
export async function assertTrajectory(
  name: string,
  steps: TrajectoryStep[],
): Promise<TrajectoryResult> {
  const passedSteps: string[] = [];
  const deviations: TrajectoryResult['deviations'] = [];
  let allRequiredPassed = true;

  for (const step of steps) {
    const passed = await step.check();
    if (passed) {
      passedSteps.push(step.label);
    } else if (step.optional) {
      deviations.push({ step: step.label, reason: 'optional step skipped' });
    } else {
      deviations.push({ step: step.label, reason: 'required step failed' });
      allRequiredPassed = false;
    }
  }

  const totalRequired = steps.filter(s => !s.optional).length;
  const passedRequired = totalRequired - deviations.filter(d => d.reason === 'required step failed').length;

  return {
    name,
    passedSteps,
    deviations,
    success: allRequiredPassed,
    completionRatio: totalRequired > 0 ? passedRequired / totalRequired : 1,
  };
}

// ─── Test Helpers ───

/**
 * Tag a vitest test with eval metadata. Used for filtering and reporting.
 * Returns the metadata for use in test descriptions.
 */
export function evalTag(meta: EvalMetadata): string {
  const parts = [`[${meta.category}]`];
  if (meta.failurePattern) parts.push(`[KFP-${meta.failurePattern}]`);
  parts.push(`[${meta.severity}]`);
  parts.push(meta.behavior);
  return parts.join(' ');
}

/**
 * Create a mock attempt record for eval scenarios.
 */
export function mockAttempt(overrides: Partial<{
  id: string;
  issue_key: string;
  agent_type: string;
  status: string;
  tmux_session: string | null;
  workspace_path: string | null;
  agent_session_id: string | null;
  created_at: string;
  completed_at: string | null;
  error_log: string | null;
}>): Record<string, unknown> {
  return {
    id: `attempt-${Math.random().toString(36).slice(2, 8)}`,
    issue_id: 'issue-uuid',
    issue_key: 'RYA-99',
    agent_session_id: null,
    agent_type: 'lead-engineer',
    runner_session_id: null,
    tmux_session: null,
    attempt_number: 1,
    status: 'running',
    host: 'test-host',
    workspace_path: '/tmp/test-workspace',
    budget_usd: null,
    cost_usd: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
    error_log: null,
    ...overrides,
  };
}

/**
 * Simulate an error-swallowing catch block for eval purposes.
 * Returns whether the error was observable (logged/thrown) or silently swallowed.
 */
export function simulateErrorHandling(
  handler: (err: Error) => void,
  error: Error = new Error('test error'),
): { observable: boolean; output: string } {
  const logs: string[] = [];
  const origLog = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  try {
    handler(error);
  } catch {
    // Error was re-thrown — observable
    console.error = origLog;
    return { observable: true, output: logs.join('\n') };
  }

  console.error = origLog;
  return { observable: logs.length > 0, output: logs.join('\n') };
}
