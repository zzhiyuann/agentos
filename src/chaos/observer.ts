/**
 * Observer agent: passive event collector + outcome classifier.
 *
 * The observer takes a stream of ObservedEvents (org behaviour + injection
 * events) and a DrillScenario, and produces a DrillOutcome.
 *
 * Telemetry contract: precision/recall ≥ 80% on the labeled fixture set
 * (see precision-recall.test.ts).
 *
 * Classification rules (in priority order):
 *   1. No 'inject' event present → 'false_positive' if observer claims any
 *      detection, otherwise the run is invalid (caller filters).
 *   2. ≥1 detection symptom matched within scenario.expected.targetMttrMs →
 *      'detected_*'. MTTR is the gap from first 'inject' to first detection.
 *   3. ≥1 recovery symptom matched after detection AND no human-rescue
 *      marker (linear-comments containing "human" or status flipping back
 *      from In Progress to Todo) → 'detected_recovered'.
 *   4. Detection + human-rescue marker → 'detected_human_rescue'.
 *   5. No detection symptom but recovery symptom OR no further error
 *      events for windowMs after last inject → 'undetected_recovered'.
 *   6. No detection AND no recovery → 'undetected_failed'.
 */

import {
  DrillScenario, DrillOutcome, ObservedEvent, OutcomeClass, FailureSymptom,
} from './types.js';

export class Observer {
  private events: ObservedEvent[] = [];
  private scenario: DrillScenario;
  private startedAt: number;

  constructor(scenario: DrillScenario, startedAt: number = Date.now()) {
    this.scenario = scenario;
    this.startedAt = startedAt;
  }

  /** Record an event into the observer's stream. */
  record(event: ObservedEvent): void {
    this.events.push(event);
  }

  /** Bulk record (used in tests & replay). */
  recordAll(events: ObservedEvent[]): void {
    for (const e of events) this.events.push(e);
  }

  /** Read-only view of recorded events. */
  getEvents(): readonly ObservedEvent[] {
    return this.events;
  }

  /** Run classification. Should be called once after the drill window closes. */
  classify(endedAt: number = Date.now()): DrillOutcome {
    return classifyEvents(this.scenario, this.events, this.startedAt, endedAt);
  }
}

/**
 * Pure classification function. Exposed separately so tests and the eval
 * suite can run it on synthetic event traces without instantiating Observer.
 */
export function classifyEvents(
  scenario: DrillScenario,
  events: ObservedEvent[],
  startedAt: number,
  endedAt: number,
): DrillOutcome {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  const injectEvents = sorted.filter(e => e.kind === 'inject');
  const orgEvents = sorted.filter(e => e.kind === 'org');

  const firstInject = injectEvents.length > 0 ? injectEvents[0].ts : null;
  const lastInject = injectEvents.length > 0 ? injectEvents[injectEvents.length - 1].ts : null;

  // Match symptoms against org events that occurred after first inject.
  const postInjectOrg = firstInject !== null
    ? orgEvents.filter(e => e.ts >= firstInject)
    : [];

  // No injects → either false positive (observer claims detection) or empty run.
  // Important: when there's no inject, scan ALL org events for detection-shaped
  // signatures. Otherwise the observer would silently miss the false-positive case.
  if (firstInject === null) {
    const noiseDetection = matchSymptoms(scenario.expected.detectionSymptoms, orgEvents);
    const noiseRecovery = matchSymptoms(scenario.expected.recoverySymptoms, orgEvents);
    return finalize(scenario, sorted, startedAt, endedAt,
      noiseDetection.matched ? 'false_positive' : 'undetected_recovered',
      null, noiseDetection, noiseRecovery,
      ['no inject events recorded']);
  }

  const detection = matchSymptoms(scenario.expected.detectionSymptoms, postInjectOrg);
  const recovery = matchSymptoms(scenario.expected.recoverySymptoms, postInjectOrg);

  // MTTR: time from first inject to first matched detection symptom.
  let mttrMs: number | null = null;
  if (detection.firstMatchTs !== null) {
    mttrMs = detection.firstMatchTs - firstInject;
  }

  // Detect human-rescue markers in events.
  const humanRescue = postInjectOrg.some(e =>
    /human|rescue|escalat|manual|intervention/i.test(e.message) ||
    (e.tags?.includes('human-rescue') ?? false),
  );

  let outcomeClass: OutcomeClass;
  const notes: string[] = [];

  if (detection.matched) {
    // Detection happened.
    const target = scenario.expected.targetMttrMs;
    if (target !== null && mttrMs !== null && mttrMs > target) {
      notes.push(`MTTR ${mttrMs}ms exceeded target ${target}ms`);
    }
    if (humanRescue) {
      outcomeClass = 'detected_human_rescue';
    } else {
      outcomeClass = 'detected_recovered';
    }
  } else {
    // No detection. Did the system self-heal?
    // Self-heal requires positive evidence: either an explicit recovery symptom,
    // or benign post-inject activity with NO further error/fail signals.
    // "Silence" alone is not recovery — it is undetected_failed (conservative bias).
    const orgAfterLastInject = lastInject !== null
      ? orgEvents.filter(e => e.ts > lastInject)
      : [];
    const hasErrorAfter = orgAfterLastInject.some(e => /error|fail|exception/i.test(e.message));
    const hasBenignActivityAfter = orgAfterLastInject.some(e => !/error|fail|exception/i.test(e.message));
    const selfHealed = recovery.matched || (hasBenignActivityAfter && !hasErrorAfter);

    if (selfHealed) {
      outcomeClass = 'undetected_recovered';
      notes.push('no detection symptom matched; system appears to have self-healed');
    } else {
      outcomeClass = 'undetected_failed';
      notes.push('no detection and no recovery — silent failure');
    }
  }

  const matchedExpectation = matchExpectation(scenario, outcomeClass, mttrMs);
  if (!matchedExpectation) notes.push('actual outcome differs from expected');

  return finalize(scenario, sorted, startedAt, endedAt, outcomeClass, mttrMs, detection, recovery, notes, matchedExpectation);
}

interface SymptomMatchResult {
  matched: boolean;
  firstMatchTs: number | null;
  matchedPatterns: string[];
}

/** Match expected symptoms against an event slice. ALL required must match. */
function matchSymptoms(expected: FailureSymptom[], events: ObservedEvent[]): SymptomMatchResult {
  if (expected.length === 0) return { matched: false, firstMatchTs: null, matchedPatterns: [] };

  const required = expected.filter(s => s.required);
  const matchedPatterns: string[] = [];
  let firstMatchTs: number | null = null;

  for (const sym of expected) {
    const re = compilePattern(sym.pattern);
    for (const e of events) {
      if (e.channel !== sym.channel) continue;
      if (!re.test(e.message)) continue;
      matchedPatterns.push(sym.pattern);
      if (firstMatchTs === null || e.ts < firstMatchTs) firstMatchTs = e.ts;
      break;
    }
  }

  // "matched" = all required matched OR (no required AND ≥1 optional matched).
  const requiredMet = required.every(r => matchedPatterns.includes(r.pattern));
  const optionalMet = matchedPatterns.length > 0;
  const matched = required.length > 0 ? requiredMet : optionalMet;

  return { matched, firstMatchTs: matched ? firstMatchTs : null, matchedPatterns };
}

/** Compile a symptom pattern. Treats it as substring unless it looks like regex. */
function compilePattern(p: string): RegExp {
  // Heuristic: starts with `/` or contains regex metachars → regex; otherwise substring.
  if (/^\/.+\/[gimsy]*$/.test(p)) {
    const m = p.match(/^\/(.+)\/([gimsy]*)$/);
    return new RegExp(m![1], m![2]);
  }
  // Substring match — escape regex metachars.
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

function matchExpectation(scenario: DrillScenario, actual: OutcomeClass, mttrMs: number | null): boolean {
  const expectedDetected = scenario.expected.detected;
  const expectedHumanFree = scenario.expected.recoveredWithoutHuman;

  const actualDetected = actual === 'detected_recovered' || actual === 'detected_human_rescue';
  const actualHumanFree = actual === 'detected_recovered' || actual === 'undetected_recovered';

  if (actualDetected !== expectedDetected) return false;
  if (expectedHumanFree && !actualHumanFree) return false;

  if (scenario.expected.targetMttrMs !== null && mttrMs !== null) {
    if (mttrMs > scenario.expected.targetMttrMs) return false;
  }
  return true;
}

function finalize(
  scenario: DrillScenario,
  events: ObservedEvent[],
  startedAt: number,
  endedAt: number,
  outcomeClass: OutcomeClass,
  mttrMs: number | null,
  detection: SymptomMatchResult,
  recovery: SymptomMatchResult,
  notes: string[],
  matchedExpectation?: boolean,
): DrillOutcome {
  return {
    scenarioId: scenario.id,
    outcomeClass,
    mttrMs,
    matchedExpectation: matchedExpectation ?? matchExpectation(scenario, outcomeClass, mttrMs),
    observedDetectionSymptoms: detection.matchedPatterns,
    observedRecoverySymptoms: recovery.matchedPatterns,
    notes,
    startedAt,
    endedAt,
  };
}
