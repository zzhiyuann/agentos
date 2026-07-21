/**
 * Drill generator: synthesizes a concrete DrillScenario from a FailureMode.
 *
 * Example: generate('rate-limit-cascade', { rng }) →
 *   "inject 17 rate-limit failures on TEST-42 within 5 minutes"
 *
 * The generator is deterministic given a seed — same seed produces the same
 * scenario id, target, and parameters. Useful for replayable evals.
 */

import { FailureMode, DrillScenario, DrillInjection, DrillExpectation } from './types.js';

export interface GenerateOptions {
  /** Seed for the RNG. Default: derived from current ms. */
  seed?: number;
  /** Target issue key. Default: synthesized TEST-* key. Must match TEST-/CHAOS- in sandbox. */
  targetIssueKey?: string;
  /** Override injection parameters. */
  injectionOverride?: Partial<DrillInjection>;
  /** ISO date for scenario id and generatedAt. Default: now. */
  now?: Date;
}

/** Map a failure mode surface → concrete injection type. */
const SURFACE_TO_INJECTION: Record<FailureMode['surface'], DrillInjection['type']> = {
  'rate-limit': 'rate-limit',
  'auth': 'auth-failure',
  'dispatch': 'dispatch-drop',
  'handoff': 'handoff-loss',
  'state': 'zombie-spawn',
  'memory': 'memory-corruption',
  'recovery': 'silent-error',
  'identity': 'auth-failure',
  'other': 'silent-error',
};

/** Default injection parameters per type — sane starting values, override-able. */
const DEFAULT_PARAMS: Record<DrillInjection['type'], { count: number; windowMs: number }> = {
  'rate-limit':       { count: 15,  windowMs: 5 * 60_000 },
  'auth-failure':     { count: 5,   windowMs: 2 * 60_000 },
  'dispatch-drop':    { count: 1,   windowMs: 60_000 },
  'handoff-loss':     { count: 1,   windowMs: 60_000 },
  'zombie-spawn':     { count: 1,   windowMs: 30_000 },
  'memory-corruption':{ count: 1,   windowMs: 60_000 },
  'concurrent-kill':  { count: 2,   windowMs: 10_000 },
  'silent-error':     { count: 3,   windowMs: 60_000 },
};

/** Generate a concrete drill scenario from a failure mode. */
export function generateDrill(mode: FailureMode, opts: GenerateOptions = {}): DrillScenario {
  const now = opts.now ?? new Date();
  const seed = opts.seed ?? Math.floor(now.getTime() / 1000);
  const rng = mulberry32(seed);

  const injectionType = SURFACE_TO_INJECTION[mode.surface];
  const defaults = DEFAULT_PARAMS[injectionType];

  // Jitter count by ±30% so consecutive drills aren't identical.
  const jitterCount = Math.max(1, Math.round(defaults.count * (0.85 + rng() * 0.3)));
  const injection: DrillInjection = {
    type: injectionType,
    count: opts.injectionOverride?.count ?? jitterCount,
    windowMs: opts.injectionOverride?.windowMs ?? defaults.windowMs,
    seed,
  };

  const targetIssueKey = opts.targetIssueKey ?? synthesizeTestKey(rng);
  const dateStr = now.toISOString().slice(0, 10);
  const scenarioId = `drill-${dateStr}-${mode.id}-${seed.toString(36)}`;

  const expected = deriveExpectation(mode, injection);

  return {
    id: scenarioId,
    failureModeId: mode.id,
    targetIssueKey,
    injection,
    expected,
    generatedAt: now.toISOString(),
    sandboxOnly: true,
  };
}

/**
 * Derive expected behaviour labels from the failure mode + injection.
 *
 * Critical failures with required symptoms → expect detection within target MTTR.
 * Informational with no required symptoms → expect undetected_recovered.
 */
function deriveExpectation(mode: FailureMode, injection: DrillInjection): DrillExpectation {
  const requiredSymptoms = mode.symptoms.filter(s => s.required);
  const optionalSymptoms = mode.symptoms.filter(s => !s.required);
  const detected = requiredSymptoms.length > 0;

  // Critical → expect tight MTTR. Important → loose MTTR. Informational → undetected ok.
  let targetMttrMs: number | null = null;
  if (detected) {
    if (mode.severity === 'critical') {
      targetMttrMs = Math.min(30_000, injection.windowMs / 2);
    } else if (mode.severity === 'important') {
      targetMttrMs = Math.min(injection.windowMs, 5 * 60_000);
    } else {
      targetMttrMs = injection.windowMs;
    }
  }

  return {
    detected,
    recoveredWithoutHuman: mode.severity !== 'critical',
    targetMttrMs,
    detectionSymptoms: requiredSymptoms,
    recoverySymptoms: optionalSymptoms.length > 0 ? optionalSymptoms : requiredSymptoms,
  };
}

/** Synthesize a fake TEST-* issue key for sandbox runs. */
function synthesizeTestKey(rng: () => number): string {
  const num = 1000 + Math.floor(rng() * 9000);
  return `TEST-${num}`;
}

/** Deterministic RNG: mulberry32. Same seed → same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
