/**
 * Drill runner: end-to-end orchestration of a single chaos drill.
 *
 * Pipeline:
 *   load taxonomy → find failure mode → generate scenario →
 *   open sandbox bus → inject synthetic events → observe org response →
 *   classify outcome → produce DrillRun report.
 *
 * The runner has two modes:
 *   - replay: org events are supplied by the caller (used in evals)
 *   - live-sandbox: org events come from the production agent stack but
 *     filtered to TEST-* keys only (used by `aos chaos run`)
 *
 * Live-prod mode (untrue sandbox) is gated by assertLiveAuthorized.
 */

import { DrillRun, DrillScenario, ObservedEvent } from './types.js';
import { loadTaxonomy, findFailureMode } from './taxonomy.js';
import { generateDrill, GenerateOptions } from './generator.js';
import { Observer } from './observer.js';
import {
  SandboxBus, assertSandboxKey, assertLiveAuthorized, synthesizeInjectEvents,
} from './sandbox.js';

export interface RunOptions {
  /** Failure mode id from the taxonomy. */
  modeId: string;
  /** Optional pre-generated scenario id (replay). If absent, generates new. */
  scenarioOverride?: DrillScenario;
  /** Sandbox guard (default true). */
  sandbox?: boolean;
  /** Live confirmation. */
  confirmLive?: boolean;
  /** Generation options. */
  generate?: GenerateOptions;
  /**
   * Replay mode: caller supplies org events for classification.
   * If absent, runner generates a no-op event stream (useful for smoke tests).
   */
  replayOrgEvents?: ObservedEvent[];
  /** Override taxonomy path (for tests). */
  taxonomyPath?: string;
  /** Overall drill window (the runner uses this to bound the observer). */
  windowMs?: number;
  /** Timing source for tests. */
  now?: () => number;
}

export async function runDrill(opts: RunOptions): Promise<DrillRun> {
  const sandbox = opts.sandbox !== false;
  if (!sandbox) {
    assertLiveAuthorized(opts.confirmLive === true);
  }

  const taxonomy = loadTaxonomy(opts.taxonomyPath);
  const mode = findFailureMode(taxonomy, opts.modeId);

  const scenario = opts.scenarioOverride ?? generateDrill(mode, opts.generate);
  assertSandboxKey(scenario.targetIssueKey, sandbox);

  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const bus = new SandboxBus();
  const observer = new Observer(scenario, startedAt);
  bus.subscribe(e => observer.record(e));

  // Inject synthetic chaos events.
  for (const e of synthesizeInjectEvents(scenario, startedAt)) {
    bus.publish(e);
  }

  // Replay org response (in real live-sandbox this would come from log tailing).
  for (const e of opts.replayOrgEvents ?? []) {
    bus.publish(e);
  }

  const windowMs = opts.windowMs ?? scenario.injection.windowMs * 2;
  const endedAt = startedAt + windowMs;
  const outcome = observer.classify(endedAt);

  return {
    id: scenario.id,
    scenario,
    events: [...observer.getEvents()],
    outcome,
    sandbox,
  };
}

/** Format a DrillRun for human-readable CLI output. */
export function formatRunReport(run: DrillRun): string {
  const lines: string[] = [];
  lines.push(`# Drill Run ${run.id}`);
  lines.push(`Mode:    ${run.scenario.failureModeId}`);
  lines.push(`Target:  ${run.scenario.targetIssueKey}${run.sandbox ? ' (sandbox)' : ' (LIVE)'}`);
  lines.push(`Inject:  ${run.scenario.injection.count}× ${run.scenario.injection.type} over ${run.scenario.injection.windowMs}ms`);
  lines.push('');
  lines.push(`Outcome: ${run.outcome.outcomeClass}`);
  lines.push(`MTTR:    ${run.outcome.mttrMs === null ? 'undetected' : run.outcome.mttrMs + 'ms'}`);
  lines.push(`Match:   ${run.outcome.matchedExpectation ? 'as expected' : 'DEVIATION'}`);
  if (run.outcome.observedDetectionSymptoms.length > 0) {
    lines.push(`Detect:  ${run.outcome.observedDetectionSymptoms.join(', ')}`);
  }
  if (run.outcome.observedRecoverySymptoms.length > 0) {
    lines.push(`Recover: ${run.outcome.observedRecoverySymptoms.join(', ')}`);
  }
  if (run.outcome.notes.length > 0) {
    lines.push('Notes:');
    for (const n of run.outcome.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}
