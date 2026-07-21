/**
 * A2.1: HANDOFF.md quality gate.
 *
 * Evaluates an agent's handoff BEFORE the monitor's completion flow runs.
 * Three checks compose the gate:
 *   (a) post-session memory validation (memory-validation.ts)
 *   (b) verification mention — the handoff must mention testing/verifying/checking
 *   (c) prose follow-ups — "Next Steps"/"Remaining Issues" bullets must reference
 *       a tracked issue key (e.g. RYA-123), not free-floating prose suggestions
 *
 * Mode knob: AOS_QUALITY_GATE_MODE=off|warn|enforce (default 'warn', read at call time).
 *   off     — gate never fires
 *   warn    — failures are logged + posted as a Linear comment, completion proceeds
 *   enforce — first failing handoff per attempt is bounced back to the agent
 *             (HANDOFF.md deleted + tmux instruction to fix); second time proceeds
 *             with warn behavior so an attempt can never be wedged forever.
 */

import { createLogger } from '../core/logger.js';
import { validatePostSessionMemory, MemoryValidationResult } from '../core/memory-validation.js';
import type { Attempt } from '../core/db.js';

const log = createLogger('quality-gate');

export type QualityGateMode = 'off' | 'warn' | 'enforce';

/** Read the gate mode from the environment at call time (default: warn). */
export function qualityGateMode(): QualityGateMode {
  const raw = (process.env.AOS_QUALITY_GATE_MODE || 'warn').toLowerCase();
  if (raw === 'off' || raw === 'enforce') return raw;
  return 'warn';
}

export interface QualityGateResult {
  pass: boolean;
  failures: string[];
  /** True when at least one failure is a critical delivery error (e.g. wrong-prompt).
   *  Critical failures always bounce, regardless of AOS_QUALITY_GATE_MODE. */
  critical: boolean;
}

/** Issue key reference, e.g. RYA-123 (any team prefix). */
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Verification mention: test / verify / check (and word forms), case-insensitive. */
const VERIFICATION_RE = /\b(test\w*|verif\w*|check\w*)\b/i;

/**
 * No-task delivery failure: HANDOFF explicitly states the session received no
 * task, only a greeting, or was a test — a prompt delivery failure, not a
 * quality issue. Always-bounce regardless of AOS_QUALITY_GATE_MODE so the
 * monitor can immediately re-dispatch with the real task prompt.
 */
const NO_TASK_RE = /no\s+task\s+(was\s+)?(requested|received|assigned|given|provided)|no\s+(actual\s+|task\s+)?work\s+was\s+performed|no\s+actual\s+task|solely\s+a\s+greeting|only\s+a\s+greeting|greeting\s+exchange|trivial\s+(arithmetic\s+)?question|no\s+work\s+(was\s+)?(requested|assigned)/i;

/** Headings that mark a follow-up section subject to the issue-key rule. */
const FOLLOW_UP_HEADING_RE = /^\s*(?:#{1,6}\s*|\*\*)\s*(next\s+steps?|remaining\s+issues?|what\s+needs\s+follow[- ]?up|follow[- ]?ups?)\b/i;

/**
 * Find bullet lines inside "Next Steps" / "Remaining Issues" sections that do
 * NOT reference an issue key. These are prose suggestions the org protocol
 * forbids — every follow-up must be a tracked issue.
 *
 * Pure function (exported for unit tests).
 */
export function findProseFollowups(handoff: string): string[] {
  const offenders: string[] = [];
  const lines = handoff.split('\n');
  let inSection = false;

  for (const line of lines) {
    if (FOLLOW_UP_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }
    // Any other heading ends the follow-up section
    if (inSection && /^\s*#{1,6}\s+\S/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    // Bullet lines: -, *, +, or numbered
    const bulletMatch = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)/);
    if (!bulletMatch) continue;
    const bullet = bulletMatch[1];
    if (!ISSUE_KEY_RE.test(bullet)) {
      offenders.push(bullet);
    }
  }

  return offenders;
}

export type MemoryValidator = (role: string, sessionCompletedWork?: boolean) => MemoryValidationResult;

/**
 * Evaluate a handoff against the quality gate checks.
 *
 * @param attempt - the completing attempt (agent_type is the role to validate)
 * @param handoffContent - HANDOFF.md content
 * @param workspacePath - workspace the agent worked in (reserved for future checks)
 * @param validateMemory - injectable for tests (defaults to validatePostSessionMemory)
 */
export function evaluateHandoff(
  attempt: Pick<Attempt, 'agent_type'>,
  handoffContent: string,
  workspacePath: string | null,
  validateMemory: MemoryValidator = validatePostSessionMemory,
): QualityGateResult {
  void workspacePath; // reserved — checks today are role + handoff based
  const failures: string[] = [];

  // (a) Memory persistence protocol
  try {
    const mem = validateMemory(attempt.agent_type, true);
    for (const warning of mem.warnings) {
      failures.push(`Memory: ${warning}`);
    }
  } catch (err) {
    // Fail-open: a broken memory check must not block completions
    log.debug('Memory validation failed (skipping check)', { role: attempt.agent_type, error: (err as Error).message });
  }

  // (b) Verification mention
  if (!VERIFICATION_RE.test(handoffContent)) {
    failures.push('Verification: HANDOFF.md does not mention testing, verifying, or checking the work.');
  }

  // (c) Prose follow-ups without issue keys
  const prose = findProseFollowups(handoffContent);
  if (prose.length > 0) {
    const samples = prose.slice(0, 3).map(b => `"${b.substring(0, 80)}"`).join('; ');
    failures.push(
      `Follow-ups: ${prose.length} bullet(s) in Next Steps/Remaining Issues without an issue key (create + reference issues instead): ${samples}`,
    );
  }

  // (d) No-task delivery failure: HANDOFF claims the session received no task.
  // This is a prompt-delivery failure (stale buffer, wrong prompt, hibernation race)
  // — not the agent's fault but must always bounce so the monitor re-dispatches.
  let critical = false;
  if (NO_TASK_RE.test(handoffContent)) {
    failures.push('NoTask: HANDOFF indicates the session received no task (prompt delivery failure). Re-dispatching with the real task prompt.');
    critical = true;
  }

  return { pass: failures.length === 0, failures, critical };
}

export type QualityGateAction = 'proceed' | 'warn' | 'bounce';

/**
 * Pure decision helper for the monitor integration:
 *   - no failures or mode off → proceed silently
 *   - critical failure (e.g. no-task) → bounce regardless of mode, but only
 *     once per attempt (alreadyBounced still applies) so a false-positive
 *     NO_TASK_RE match on a legit HANDOFF can't delete-and-bounce forever
 *   - enforce + first failure for this attempt → bounce (reject handoff)
 *   - otherwise (warn mode, or enforce after one bounce) → warn and proceed
 */
export function qualityGateDecision(
  failures: string[],
  mode: QualityGateMode,
  alreadyBounced: boolean,
  critical = false,
): QualityGateAction {
  if (failures.length === 0 || mode === 'off') return 'proceed';
  // Critical failures (wrong-prompt delivery) bounce even in warn mode — the
  // agent cannot fix them by rewriting HANDOFF.md; the monitor re-delivers the
  // task. Capped by alreadyBounced to prevent an infinite delete-and-bounce
  // loop when the phrasing is a false positive.
  if (critical && !alreadyBounced) return 'bounce';
  if (mode === 'enforce' && !alreadyBounced) return 'bounce';
  return 'warn';
}

/** Format gate failures for a Linear comment / tmux instruction. */
export function formatGateFailures(failures: string[]): string {
  return failures.map(f => `- ${f}`).join('\n');
}
