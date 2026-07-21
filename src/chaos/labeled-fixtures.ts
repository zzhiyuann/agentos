/**
 * Labeled fixtures for the observer precision/recall eval.
 *
 * Each fixture is a (scenario, events, groundTruth) triple. The observer
 * runs on `events` and its `outcomeClass` is compared to `groundTruth`.
 *
 * Targets ≥80% precision and ≥80% recall per class (RYA-861 acceptance
 * criterion). 25 labeled fixtures across all five outcome classes ensures
 * the per-class denominator is large enough for the metric to be meaningful.
 */

import { DrillScenario, ObservedEvent, OutcomeClass, FailureMode } from './types.js';
import { generateDrill } from './generator.js';

/** Build a deterministic scenario for a fixture. */
function fixtureScenario(mode: FailureMode, seed: number): DrillScenario {
  return generateDrill(mode, { seed, now: new Date('2026-05-03T00:00:00Z') });
}

/** Construct fixture scenarios from the seed taxonomy synchronously. */
function buildModes(): Record<string, FailureMode> {
  // Inline minimal copies to avoid coupling fixtures to file I/O.
  return {
    'silent-failure-swallow': {
      id: 'silent-failure-swallow',
      title: 'Silent error swallow',
      description: 'Catch swallows error',
      surface: 'recovery',
      severity: 'critical',
      expectedRecovery: 'Error logged within 5s',
      symptoms: [
        { channel: 'logs', pattern: 'Error', required: true },
        { channel: 'linear-status', pattern: 'failed', required: false },
      ],
    },
    'rate-limit-cascade': {
      id: 'rate-limit-cascade',
      title: 'Rate-limit cascade',
      description: 'Linear API rate-limits',
      surface: 'rate-limit',
      severity: 'important',
      expectedRecovery: 'Backoff + circuit breaker',
      symptoms: [
        { channel: 'logs', pattern: '429', required: true },
        { channel: 'metrics', pattern: 'queue_depth', required: false },
      ],
    },
    'zombie-spawn-loop': {
      id: 'zombie-spawn-loop',
      title: 'Zombie spawn loop',
      description: 'Dead tmux but DB alive',
      surface: 'state',
      severity: 'critical',
      expectedRecovery: 'Monitor reconciles within 15s',
      symptoms: [
        { channel: 'session-state', pattern: 'dead', required: true },
        { channel: 'linear-status', pattern: 'failed', required: false },
      ],
    },
    'oauth-refresh-race': {
      id: 'oauth-refresh-race',
      title: 'OAuth refresh race',
      description: 'Token race',
      surface: 'auth',
      severity: 'critical',
      expectedRecovery: 'Per-role token paths',
      symptoms: [
        { channel: 'logs', pattern: '401', required: true },
        { channel: 'linear-status', pattern: 'blocked', required: false },
      ],
    },
    'handoff-context-drop': {
      id: 'handoff-context-drop',
      title: 'Handoff context drop',
      description: 'Lost context',
      surface: 'handoff',
      severity: 'important',
      expectedRecovery: 'Receiving agent reads HANDOFF.md',
      symptoms: [
        { channel: 'logs', pattern: 'no handoff', required: true },
        { channel: 'linear-comments', pattern: 'context', required: false },
      ],
    },
  };
}

const MODES = buildModes();

export interface LabeledFixture {
  id: string;
  scenario: DrillScenario;
  events: ObservedEvent[];
  groundTruth: OutcomeClass;
}

/** Helper: events relative to scenario start. */
function ev(
  scenario: DrillScenario,
  channel: ObservedEvent['channel'],
  kind: ObservedEvent['kind'],
  message: string,
  offsetMs: number,
): ObservedEvent {
  const start = new Date(scenario.generatedAt).getTime();
  return { ts: start + offsetMs, channel, kind, message };
}

/** Inject events for a scenario, evenly spread. */
function injects(scenario: DrillScenario): ObservedEvent[] {
  const out: ObservedEvent[] = [];
  const start = new Date(scenario.generatedAt).getTime();
  const spacing = scenario.injection.windowMs / scenario.injection.count;
  for (let i = 0; i < scenario.injection.count; i++) {
    out.push({
      ts: start + Math.round(spacing * i),
      channel: 'logs',
      kind: 'inject',
      message: `inject #${i + 1}`,
    });
  }
  return out;
}

/** Build a detection-shaped event whose message contains the required pattern. */
function detectionEvent(scenario: DrillScenario, mode: FailureMode, offsetMs: number): ObservedEvent {
  const required = mode.symptoms.find(s => s.required) ?? mode.symptoms[0];
  return ev(scenario, required.channel, 'org', `${required.pattern} observed by monitor`, offsetMs);
}

/** Build a recovery-shaped event matching an optional symptom (or required if none optional). */
function recoveryEvent(scenario: DrillScenario, mode: FailureMode, offsetMs: number): ObservedEvent | null {
  const optional = mode.symptoms.find(s => !s.required);
  if (!optional) return null;
  return ev(scenario, optional.channel, 'org', `${optional.pattern} normalized`, offsetMs);
}

export function buildFixtures(): LabeledFixture[] {
  const fixtures: LabeledFixture[] = [];

  // ── detected_recovered (5) ─────────────────────────────────────────────
  // Detection symptom present, no human-rescue marker, recovery seen.
  for (let i = 0; i < 5; i++) {
    const mode = i % 2 === 0 ? MODES['silent-failure-swallow'] : MODES['rate-limit-cascade'];
    const scenario = fixtureScenario(mode, 100 + i);
    const events: ObservedEvent[] = [
      ...injects(scenario),
      detectionEvent(scenario, mode, 3_000 + i * 500),
    ];
    const rec = recoveryEvent(scenario, mode, 25_000);
    if (rec) events.push(rec);
    fixtures.push({ id: `dr-${i}`, scenario, events, groundTruth: 'detected_recovered' });
  }

  // ── detected_human_rescue (5) ──────────────────────────────────────────
  for (let i = 0; i < 5; i++) {
    const mode = i % 2 === 0 ? MODES['zombie-spawn-loop'] : MODES['oauth-refresh-race'];
    const scenario = fixtureScenario(mode, 200 + i);
    const events: ObservedEvent[] = [
      ...injects(scenario),
      detectionEvent(scenario, mode, 3_000 + i * 500),
      ev(scenario, 'linear-comments', 'org', 'human intervention required to unblock', 30_000),
    ];
    fixtures.push({ id: `dh-${i}`, scenario, events, groundTruth: 'detected_human_rescue' });
  }

  // ── undetected_recovered (5) ───────────────────────────────────────────
  // No detection symptom; no error events for windowMs after last inject.
  for (let i = 0; i < 5; i++) {
    const mode = MODES['rate-limit-cascade'];
    const scenario = fixtureScenario(mode, 300 + i);
    const events: ObservedEvent[] = [
      ...injects(scenario),
      // System self-heals quietly: a benign info log, no detection symptom.
      ev(scenario, 'logs', 'org', 'queue drained successfully', scenario.injection.windowMs + 1_000),
    ];
    fixtures.push({ id: `ur-${i}`, scenario, events, groundTruth: 'undetected_recovered' });
  }

  // ── undetected_failed (5) ──────────────────────────────────────────────
  // No detection symptom; ongoing error events past windowMs — silent failure.
  for (let i = 0; i < 5; i++) {
    const mode = MODES['handoff-context-drop'];
    const scenario = fixtureScenario(mode, 400 + i);
    const events: ObservedEvent[] = [
      ...injects(scenario),
      // Error continues after window but doesn't match required symptom (substring "no handoff").
      ev(scenario, 'logs', 'org', 'silent error in pipeline', scenario.injection.windowMs + 5_000),
      ev(scenario, 'logs', 'org', 'silent error in pipeline (still failing)', scenario.injection.windowMs + 30_000),
    ];
    fixtures.push({ id: `uf-${i}`, scenario, events, groundTruth: 'undetected_failed' });
  }

  // ── false_positive (5) ─────────────────────────────────────────────────
  // No inject events at all — observer must NOT classify as detected.
  for (let i = 0; i < 5; i++) {
    const mode = MODES['silent-failure-swallow'];
    const scenario = fixtureScenario(mode, 500 + i);
    const events: ObservedEvent[] = [
      // Events that LOOK like detection symptoms but no inject preceded them.
      ev(scenario, 'logs', 'org', '[Error] unrelated background error', 1_000 + i * 200),
    ];
    fixtures.push({ id: `fp-${i}`, scenario, events, groundTruth: 'false_positive' });
  }

  return fixtures;
}
