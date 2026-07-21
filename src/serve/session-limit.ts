/**
 * RYA-1243: /rate-limit-options modal detection + recovery.
 *
 * When Claude Code hits the plan's session limit it presents an interactive
 * modal ("You've hit your session limit" / "1. Stop and wait for limit to
 * reset"). The existing inline rate-limit recovery (Case 3) cannot get past
 * it: sendKeys pastes text into a select-list dialog that accepts no text,
 * so the nudge never submits and the session stalls until a human dismisses
 * the modal (12 sessions × 17h on 2026-06-10).
 *
 * Recovery (mirrors the manual fix that worked):
 *   1. Bare Enter selects option 1 "Stop and wait" — NEVER auto-select
 *      usage-based billing (option 2) or a plan switch (option 3).
 *   2. After the stated reset time passes, send a resume instruction.
 *   3. If >2 sessions hit the limit within 10 min, alert Telegram + Discord
 *      with the reset time so a human knows the fleet is paused.
 */
export const SESSION_LIMIT_RESET_BUFFER_MS = 60_000;       // wait 1 min past stated reset before nudging
export const SESSION_LIMIT_NUDGE_SPACING_MS = 120_000;     // 2 min between resume nudges
export const SESSION_LIMIT_MAX_NUDGES = 3;                 // then hand back to normal monitoring
export const SESSION_LIMIT_REDISMISS_MS = 60_000;          // re-send Enter if modal persists 1 min
export const SESSION_LIMIT_DEFAULT_WAIT_MS = 60 * 60_000;  // reset time unparseable → wait 1h
export const SESSION_LIMIT_FLEET_WINDOW_MS = 10 * 60_000;  // fleet alert window
export const SESSION_LIMIT_FLEET_THRESHOLD = 3;            // alert when >2 sessions in window
export const SESSION_LIMIT_ALERT_COOLDOWN_MS = 30 * 60_000; // one fleet alert per 30 min

/**
 * Detect the session-limit modal in pane output.
 *
 * Requires BOTH the header and the "Stop and wait" option so generic
 * rate-limit chatter can't match. Lines that look like an agent VIEWING
 * code or docs (Read tool `123→` prefixes, grep `file.ts:12:` prefixes,
 * quoted string literals) are filtered first — same false-positive class
 * as RYA-335.
 */
export function isSessionLimitModal(paneOutput: string): boolean {
  const lines = paneOutput.split('\n').filter((line) => {
    if (/^\s*\d+→/.test(line)) return false;                        // Read tool output
    if (/^\s*[\w/.-]+\.(ts|js|py|rs|go|md|txt):\d+/.test(line)) return false; // grep results
    if (/['"`].*(?:session limit|Stop and wait).*['"`]/i.test(line)) return false; // string literals
    return true;
  });
  const text = lines.join('\n');
  // Apostrophe in the TUI may be straight or curly.
  const header = /You.{0,3}ve hit your (?:session|usage|weekly) limit/i.test(text);
  const stopOption = /1\.\s*Stop and wait for limit to reset/i.test(text);
  return header && stopOption;
}

/**
 * Parse the stated reset time ("resets 9:20pm", "resets at 9pm") into epoch
 * ms, resolved against the server's local clock.
 *
 * Disambiguation when the stated time-of-day is in the past: session limits
 * reset within ≤5h windows, so a time ≤6h in the past means the reset
 * already happened (return that past instant — caller may nudge right away);
 * further back means it refers to tomorrow.
 */
export function parseSessionLimitResetMs(paneOutput: string, nowMs: number): number | null {
  const m = paneOutput.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const candidate = new Date(nowMs);
  candidate.setHours(hour, minute, 0, 0);
  let resetMs = candidate.getTime();
  if (resetMs < nowMs - 6 * 60 * 60_000) resetMs += 24 * 60 * 60_000; // >6h past → tomorrow
  return resetMs;
}

/** Per-attempt wait state, owned by the monitor's sessionLimitWaitMap. */
export interface SessionLimitWaitState {
  firstSeenMs: number;
  resetAtMs: number;
  lastEnterAtMs: number;
  nudgeCount: number;
  lastNudgeAtMs: number;
}

export type SessionLimitAction =
  | 'dismiss-modal'   // send bare Enter to select option 1
  | 'wait'            // limit not reset yet — suppress loop/idle failure paths
  | 'send-resume-nudge' // reset time passed — send the resume instruction
  | 'recovered'       // active work detected — clear state
  | 'give-up';        // nudges exhausted — clear state, normal monitoring resumes

/**
 * Pure state machine: decide the monitor's next action for an attempt that
 * is (or was) stuck at the session-limit modal. The caller executes the
 * action and updates the state's timestamps/counters.
 */
export function sessionLimitNextAction(
  state: SessionLimitWaitState,
  modalVisible: boolean,
  activelyWorking: boolean,
  nowMs: number,
): SessionLimitAction {
  if (modalVisible) {
    // Modal (still) up — re-send Enter, rate-limited so we don't spam keys.
    return nowMs - state.lastEnterAtMs >= SESSION_LIMIT_REDISMISS_MS ? 'dismiss-modal' : 'wait';
  }
  if (activelyWorking) return 'recovered';
  if (nowMs < state.resetAtMs + SESSION_LIMIT_RESET_BUFFER_MS) return 'wait';
  // Give the most recent nudge a full spacing window to land before acting again.
  if (state.nudgeCount > 0 && nowMs - state.lastNudgeAtMs < SESSION_LIMIT_NUDGE_SPACING_MS) return 'wait';
  if (state.nudgeCount >= SESSION_LIMIT_MAX_NUDGES) return 'give-up';
  return 'send-resume-nudge';
}

/** Resume instruction — replicates the manual recovery that worked on 2026-06-11. */
export const SESSION_LIMIT_RESUME_MESSAGE =
  '[SYSTEM] You were paused at a Claude session-limit dialog; the limit has now reset. ' +
  'Resume your original task from where you left off. If you had already finished, ' +
  'write HANDOFF.md per your instructions.';

// ─── Fleet alert (>2 sessions limited within 10 min) ────────────────────────

interface FleetHit { issueKey: string; atMs: number; resetAtMs: number }
let fleetHits: FleetHit[] = [];
let lastFleetAlertAtMs = 0;

/** Test hook. */
export function _resetSessionLimitFleetState(): void {
  fleetHits = [];
  lastFleetAlertAtMs = 0;
}

/**
 * Record that an attempt hit the session limit. Returns whether a fleet
 * alert should fire now (threshold reached within the window, and no alert
 * fired in the cooldown period). Hits are deduped per issue key.
 */
export function recordSessionLimitHit(
  issueKey: string,
  resetAtMs: number,
  nowMs: number,
): { shouldAlert: boolean; count: number; latestResetAtMs: number } {
  fleetHits = fleetHits.filter((h) => nowMs - h.atMs <= SESSION_LIMIT_FLEET_WINDOW_MS);
  const existing = fleetHits.find((h) => h.issueKey === issueKey);
  if (existing) {
    existing.atMs = nowMs;
    existing.resetAtMs = resetAtMs;
  } else {
    fleetHits.push({ issueKey, atMs: nowMs, resetAtMs });
  }
  const count = fleetHits.length;
  const latestResetAtMs = Math.max(...fleetHits.map((h) => h.resetAtMs));
  const shouldAlert =
    count >= SESSION_LIMIT_FLEET_THRESHOLD &&
    nowMs - lastFleetAlertAtMs >= SESSION_LIMIT_ALERT_COOLDOWN_MS;
  if (shouldAlert) lastFleetAlertAtMs = nowMs;
  return { shouldAlert, count, latestResetAtMs };
}

/** Alert senders — injectable for tests (same pattern as claude-auth-alert). */
export interface FleetAlertSinks {
  telegram: (message: string) => Promise<boolean>;
  discord: (message: string) => Promise<boolean>;
}

// Lazy imports: telegram/discord read STATE_DIR from config.js at module load,
// which breaks test files that partially mock config.js (they'd fail to even
// LOAD monitor.ts through this chain). Same pattern as monitor.ts's inline
// `await import(...)` calls.
export const defaultFleetAlertSinks: FleetAlertSinks = {
  telegram: async (m) => (await import('../core/telegram.js')).postSystemMessage(m),
  discord: async (m) => (await import('../core/discord.js')).postDiscordSystem(m),
};

export function buildFleetAlertMessage(count: number, latestResetAtMs: number, issueKeys: string[]): string {
  const resetStr = new Date(latestResetAtMs).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });
  return [
    `🚨 Claude session limit: ${count} agent sessions paused in the last 10 min`,
    '',
    `*Sessions*: ${issueKeys.join(', ')}`,
    `*Limit resets*: ~${resetStr} (server local time)`,
    '',
    'The monitor selected "Stop and wait" on each session and will auto-resume ' +
    'them after the reset. No action needed unless they fail to resume — ' +
    'check `serve` logs for "session limit" entries.',
  ].join('\n');
}

/** Current in-window issue keys (for the alert body). */
export function currentFleetHitKeys(nowMs: number): string[] {
  return fleetHits
    .filter((h) => nowMs - h.atMs <= SESSION_LIMIT_FLEET_WINDOW_MS)
    .map((h) => h.issueKey);
}

/**
 * Fire the fleet alert on Telegram + Discord. Best-effort: returns per-channel
 * success, never throws.
 */
export async function fireSessionLimitFleetAlert(
  count: number,
  latestResetAtMs: number,
  issueKeys: string[],
  sinks: FleetAlertSinks = defaultFleetAlertSinks,
): Promise<{ telegramOk: boolean; discordOk: boolean }> {
  const message = buildFleetAlertMessage(count, latestResetAtMs, issueKeys);
  const [telegramOk, discordOk] = await Promise.all([
    sinks.telegram(message).catch(() => false),
    sinks.discord(message).catch(() => false),
  ]);
  return { telegramOk, discordOk };
}
