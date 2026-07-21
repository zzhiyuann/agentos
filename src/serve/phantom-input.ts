/**
 * RYA-1251: Phantom unsubmitted input — detection state machine for messages
 * that render at the ❯ prompt but never submit.
 *
 * Two failure shapes, one symptom:
 *  1. Phantom paste: sendKeys' paste-buffer raced the TUI's commit window.
 *     The text is VISIBLE but the real input buffer is EMPTY — bare Enter can
 *     never submit it (verified 2026-06-12: typing a literal char makes the
 *     phantom vanish). Three sessions were stuck 20h–2d this way.
 *  2. A human-typed message whose Enter was eaten (the research-lead case was
 *     a CEO-typed message stuck ~40h, blocking the AskLess Path B pipeline).
 *
 * Recovery that works (3/3 empirically): clear the line, re-TYPE the text via
 * `tmux send-keys -l`, then Enter (core/tmux.ts recoverPhantomInput). The
 * monitor sweeps all aos-* panes each tick; any pane showing `❯ <text>`
 * unchanged and idle past the threshold gets the retype. sendKeys also runs
 * the same recovery inline when its own paste fails verification — this sweep
 * is the backstop for messages the monitor didn't deliver itself.
 */

export const PHANTOM_INPUT_IDLE_MS = 5 * 60_000;           // unchanged input for 5 min → stuck
export const PHANTOM_INPUT_RETRY_SPACING_MS = 5 * 60_000;  // between recovery attempts
export const PHANTOM_INPUT_MAX_RECOVERIES = 2;             // then give up (needs manual attention)

export interface PhantomInputState {
  firstSeenMs: number;      // when this exact text was first seen
  lastText: string;         // extracted input text — a change means someone is typing
  recoveryCount: number;
  lastRecoveryAtMs: number;
  gaveUp?: boolean;         // give-up already logged (log once, not per tick)
}

export type PhantomInputAction = 'wait' | 'recover' | 'give-up';

/**
 * Pure state machine: decide the monitor's next action for a pane showing
 * unchanged unsubmitted input. The caller resets state when the text changes
 * and executes recoveries, updating counters/timestamps.
 */
export function phantomInputNextAction(
  state: PhantomInputState,
  activelyWorking: boolean,
  nowMs: number,
): PhantomInputAction {
  // Agent mid-turn: typed-ahead input is legitimate queueing — don't touch it.
  if (activelyWorking) return 'wait';
  if (nowMs - state.firstSeenMs < PHANTOM_INPUT_IDLE_MS) return 'wait';
  if (state.recoveryCount >= PHANTOM_INPUT_MAX_RECOVERIES) return 'give-up';
  if (state.recoveryCount > 0 && nowMs - state.lastRecoveryAtMs < PHANTOM_INPUT_RETRY_SPACING_MS) return 'wait';
  return 'recover';
}

/**
 * Extract the unsubmitted input text from a pane capture.
 *
 * Finds the LAST `❯` line — the active input box sits at the bottom of the
 * pane; any earlier `❯` match is scrollback. An empty prompt (`❯ `) means
 * nothing is pending → null. Wrapped input continues on the lines below the
 * prompt until the input-box border / status line; continuation lines are
 * joined with spaces (the visual wrap loses the original break positions —
 * close enough for a recovery retype).
 */
export function extractUnsubmittedInput(paneOutput: string): string | null {
  const lines = paneOutput.split('\n');
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('❯')) { promptIdx = i; break; }
  }
  if (promptIdx === -1) return null;
  const first = lines[promptIdx].slice(1).trim();
  if (!first) return null; // empty prompt — nothing pending
  const parts = [first];
  for (let i = promptIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/\S/.test(line)) break;                  // blank line — input box ended
    if (/^\s*[─━│╭╮╰╯┃═]{2,}/.test(line)) break;  // input-box border
    if (/^\s*⏵/.test(line)) break;                // status line below the box
    parts.push(line.trim());
  }
  const text = parts.join(' ').trim();
  return text || null;
}
