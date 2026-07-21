/**
 * Chaos drill type definitions.
 *
 * Schema-first design: the taxonomy is data (markdown + frontmatter) that
 * conforms to FailureMode, the generator produces DrillScenario instances,
 * and the observer emits DrillOutcome based on classified events.
 *
 * This file is the contract between sub-task 1 (COO taxonomy) and RYA-861
 * (this infrastructure). Changing it changes the boundary.
 */

// ─── Taxonomy (input from sub-task 1) ──────────────────────────────────────

/**
 * One row in the chaos drill taxonomy. COO populates these from the incident
 * log; the generator reads them to synthesize concrete drills.
 */
export interface FailureMode {
  /** Stable id, e.g., "rate-limit-cascade" or "kfp-1-silent-failures". */
  id: string;
  /** Short title for human reading. */
  title: string;
  /** One-line description of the failure mode. */
  description: string;
  /** Which org-layer surface this hits. */
  surface: 'dispatch' | 'handoff' | 'memory' | 'rate-limit' | 'auth' | 'identity' | 'state' | 'recovery' | 'other';
  /** Severity if it hits production. */
  severity: 'critical' | 'important' | 'informational';
  /**
   * How the failure manifests as observable events. The observer uses these
   * patterns to detect the failure during a drill.
   */
  symptoms: FailureSymptom[];
  /** Behaviour we expect from the org if working correctly. */
  expectedRecovery: string;
  /** Optional reference to a real incident (Linear key, retro). */
  incidentRefs?: string[];
}

/**
 * One observable signature of a failure. The observer matches injected events
 * (and resulting org behaviour) against these patterns to classify a drill.
 */
export interface FailureSymptom {
  /** Which event channel produces this symptom. */
  channel: 'logs' | 'linear-comments' | 'linear-status' | 'session-state' | 'discord' | 'metrics';
  /** A simple matcher: substring or regex source. */
  pattern: string;
  /** Whether this symptom must appear (required) or may appear (optional). */
  required: boolean;
}

// ─── Drill scenarios (output of the generator) ────────────────────────────

/**
 * A concrete drill: failure mode + parameters + target. The generator turns
 * a FailureMode into a DrillScenario with concrete numbers ("17 rate-limit
 * failures on TEST-42 within 5 minutes").
 */
export interface DrillScenario {
  /** Unique scenario id, e.g., "drill-2026-05-03-rate-limit-cascade-42". */
  id: string;
  /** Which failure mode this scenario instantiates. */
  failureModeId: string;
  /** Concrete target (always TEST-* in sandbox mode). */
  targetIssueKey: string;
  /** Concrete params injected at runtime. */
  injection: DrillInjection;
  /** Expected behaviour labels — the observer compares actual against these. */
  expected: DrillExpectation;
  /** When the scenario was generated. */
  generatedAt: string;
  /** Whether this scenario is sandbox-only (default true). */
  sandboxOnly: boolean;
}

export interface DrillInjection {
  /** Type of perturbation. */
  type: 'rate-limit' | 'auth-failure' | 'dispatch-drop' | 'handoff-loss' | 'zombie-spawn' | 'memory-corruption' | 'concurrent-kill' | 'silent-error';
  /** Rate / count / magnitude. */
  count: number;
  /** Window in milliseconds. */
  windowMs: number;
  /** Optional seed for reproducibility. */
  seed?: number;
}

export interface DrillExpectation {
  /** Should the org detect this failure? */
  detected: boolean;
  /** Should it recover without human intervention? */
  recoveredWithoutHuman: boolean;
  /** Target MTTR in milliseconds (null if undetected expected). */
  targetMttrMs: number | null;
  /** Symptoms the observer must see for "detected". */
  detectionSymptoms: FailureSymptom[];
  /** Symptoms that indicate recovery. */
  recoverySymptoms: FailureSymptom[];
}

// ─── Observation (input to classifier) ────────────────────────────────────

/**
 * A single observed event during a drill. Channels normalize different
 * sources (Linear comments, logs, metrics) into a uniform stream.
 */
export interface ObservedEvent {
  /** Monotonic timestamp (ms). */
  ts: number;
  /** Source channel. */
  channel: FailureSymptom['channel'];
  /** Event kind: 'inject' (drill cause), 'org' (org response), 'noise' (unrelated). */
  kind: 'inject' | 'org' | 'noise';
  /** Event payload — short description. */
  message: string;
  /** Optional tags for filtering. */
  tags?: string[];
}

// ─── Outcome (output of classifier) ───────────────────────────────────────

/**
 * Classification of a drill outcome. The observer produces this from the
 * event stream + the expected labels.
 */
export type OutcomeClass =
  | 'detected_recovered'        // detected and recovered without human
  | 'detected_human_rescue'     // detected but needed human intervention
  | 'undetected_recovered'      // not detected but self-healed (silent OK)
  | 'undetected_failed'         // not detected and failed silently — worst case
  | 'false_positive';           // observer flagged a drill where none occurred

export interface DrillOutcome {
  scenarioId: string;
  outcomeClass: OutcomeClass;
  /** Time from first inject event to first detection symptom. Null if undetected. */
  mttrMs: number | null;
  /** Whether the actual outcome matched DrillExpectation. */
  matchedExpectation: boolean;
  /** Detection symptoms observed (for human review). */
  observedDetectionSymptoms: string[];
  /** Recovery symptoms observed. */
  observedRecoverySymptoms: string[];
  /** Free-form notes. */
  notes: string[];
  /** Run boundaries. */
  startedAt: number;
  endedAt: number;
}

// ─── Run (top-level) ──────────────────────────────────────────────────────

export interface DrillRun {
  id: string;
  scenario: DrillScenario;
  events: ObservedEvent[];
  outcome: DrillOutcome;
  sandbox: boolean;
}
