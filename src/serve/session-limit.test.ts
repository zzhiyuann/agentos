import { describe, it, expect, beforeEach } from 'vitest';
import {
  isSessionLimitModal,
  parseSessionLimitResetMs,
  sessionLimitNextAction,
  recordSessionLimitHit,
  currentFleetHitKeys,
  buildFleetAlertMessage,
  fireSessionLimitFleetAlert,
  _resetSessionLimitFleetState,
  SessionLimitWaitState,
  SESSION_LIMIT_RESET_BUFFER_MS,
  SESSION_LIMIT_NUDGE_SPACING_MS,
  SESSION_LIMIT_MAX_NUDGES,
  SESSION_LIMIT_REDISMISS_MS,
  SESSION_LIMIT_FLEET_WINDOW_MS,
  SESSION_LIMIT_ALERT_COOLDOWN_MS,
} from './session-limit.js';

// Fixture modeled on the 2026-06-10 incident panes: Claude Code's
// /rate-limit-options modal as captured from a stalled session.
const MODAL_PANE = `
 Some earlier output from the agent's work...

 You've hit your session limit · resets 9:20pm

 ❯ 1. Stop and wait for limit to reset (9:20pm)
   2. Switch to usage-based billing for the rest of this session
   3. Switch to the Team plan

 Enter to confirm · Esc to cancel
`;

const MODAL_PANE_CURLY = MODAL_PANE.replace("You've", 'You’ve');

describe('isSessionLimitModal', () => {
  it('detects the modal fixture', () => {
    expect(isSessionLimitModal(MODAL_PANE)).toBe(true);
  });

  it('detects the modal with a curly apostrophe', () => {
    expect(isSessionLimitModal(MODAL_PANE_CURLY)).toBe(true);
  });

  it('detects a usage-limit variant of the header', () => {
    const pane = MODAL_PANE.replace('session limit', 'usage limit');
    expect(isSessionLimitModal(pane)).toBe(true);
  });

  it('does NOT match the inline rate-limit message (existing Case 3 path)', () => {
    const pane = `
 API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}
 Rate limited. Retrying in 30 seconds...
`;
    expect(isSessionLimitModal(pane)).toBe(false);
  });

  it('does NOT match header alone without the Stop-and-wait option', () => {
    const pane = `Discussion: what happens when you've hit your session limit in Claude Code?`;
    expect(isSessionLimitModal(pane)).toBe(false);
  });

  it('does NOT match an agent viewing this code via the Read tool', () => {
    const pane = `
   45→  const header = /You.{0,3}ve hit your (?:session|usage|weekly) limit/i.test(text);
   46→  const stopOption = /1\\.\\s*Stop and wait for limit to reset/i.test(text);
`;
    expect(isSessionLimitModal(pane)).toBe(false);
  });

  it('does NOT match grep results containing the modal strings', () => {
    const pane = `
src/serve/session-limit.ts:31: // "You've hit your session limit" header
src/serve/session-limit.ts:52: // "1. Stop and wait for limit to reset"
`;
    expect(isSessionLimitModal(pane)).toBe(false);
  });

  it('does NOT match the strings inside quoted literals', () => {
    const pane = `
 const a = "You've hit your session limit";
 const b = '1. Stop and wait for limit to reset';
`;
    expect(isSessionLimitModal(pane)).toBe(false);
  });
});

describe('parseSessionLimitResetMs', () => {
  // Fixed "now": 2026-06-10 20:30 local
  const now = new Date(2026, 5, 10, 20, 30, 0, 0).getTime();

  it('parses "resets 9:20pm" later today', () => {
    const ms = parseSessionLimitResetMs('limit · resets 9:20pm', now);
    expect(ms).toBe(new Date(2026, 5, 10, 21, 20, 0, 0).getTime());
  });

  it('parses "resets at 9pm" without minutes', () => {
    const ms = parseSessionLimitResetMs('resets at 9pm', now);
    expect(ms).toBe(new Date(2026, 5, 10, 21, 0, 0, 0).getTime());
  });

  it('parses am times across midnight as tomorrow-relative clock time', () => {
    // 2:30am parsed at 8:30pm → 2:30am is 18h in the past → tomorrow
    const ms = parseSessionLimitResetMs('resets 2:30am', now);
    expect(ms).toBe(new Date(2026, 5, 11, 2, 30, 0, 0).getTime());
  });

  it('treats a time ≤6h in the past as already reset (not tomorrow)', () => {
    // Modal still visible at 9:25pm stating "resets 9:20pm" — reset just happened
    const at2125 = new Date(2026, 5, 10, 21, 25, 0, 0).getTime();
    const ms = parseSessionLimitResetMs('resets 9:20pm', at2125);
    expect(ms).toBe(new Date(2026, 5, 10, 21, 20, 0, 0).getTime());
    expect(ms!).toBeLessThan(at2125);
  });

  it('handles 12am and 12pm correctly', () => {
    const noon = parseSessionLimitResetMs('resets 12pm', new Date(2026, 5, 10, 9, 0).getTime());
    expect(new Date(noon!).getHours()).toBe(12);
    const midnight = parseSessionLimitResetMs('resets 12:00am', new Date(2026, 5, 10, 20, 0).getTime());
    expect(new Date(midnight!).getHours()).toBe(0);
  });

  it('returns null when no reset time is present', () => {
    expect(parseSessionLimitResetMs('You have hit your session limit', now)).toBeNull();
  });

  it('parses the full modal fixture', () => {
    const ms = parseSessionLimitResetMs(MODAL_PANE, now);
    expect(ms).toBe(new Date(2026, 5, 10, 21, 20, 0, 0).getTime());
  });
});

describe('sessionLimitNextAction', () => {
  const t0 = 1_000_000_000_000;
  const freshState = (over: Partial<SessionLimitWaitState> = {}): SessionLimitWaitState => ({
    firstSeenMs: t0,
    resetAtMs: t0 + 50 * 60_000, // resets in 50 min
    lastEnterAtMs: 0,
    nudgeCount: 0,
    lastNudgeAtMs: 0,
    ...over,
  });

  it('dismisses the modal on first sighting', () => {
    expect(sessionLimitNextAction(freshState(), true, false, t0)).toBe('dismiss-modal');
  });

  it('rate-limits Enter re-sends while the modal persists', () => {
    const s = freshState({ lastEnterAtMs: t0 });
    expect(sessionLimitNextAction(s, true, false, t0 + 10_000)).toBe('wait');
    expect(sessionLimitNextAction(s, true, false, t0 + SESSION_LIMIT_REDISMISS_MS)).toBe('dismiss-modal');
  });

  it('waits quietly until the reset time passes', () => {
    const s = freshState({ lastEnterAtMs: t0 });
    expect(sessionLimitNextAction(s, false, false, t0 + 10 * 60_000)).toBe('wait');
  });

  it('sends the resume nudge after reset + buffer', () => {
    const s = freshState({ lastEnterAtMs: t0 });
    const afterReset = s.resetAtMs + SESSION_LIMIT_RESET_BUFFER_MS;
    expect(sessionLimitNextAction(s, false, false, afterReset)).toBe('send-resume-nudge');
  });

  it('spaces resume nudges and gives up after the cap', () => {
    const s = freshState({ lastEnterAtMs: t0 });
    let now = s.resetAtMs + SESSION_LIMIT_RESET_BUFFER_MS;
    for (let i = 0; i < SESSION_LIMIT_MAX_NUDGES; i++) {
      expect(sessionLimitNextAction(s, false, false, now)).toBe('send-resume-nudge');
      s.lastNudgeAtMs = now;
      s.nudgeCount++;
      // Too soon → wait
      expect(sessionLimitNextAction(s, false, false, now + 5_000)).toBe('wait');
      now += SESSION_LIMIT_NUDGE_SPACING_MS;
    }
    expect(sessionLimitNextAction(s, false, false, now)).toBe('give-up');
  });

  it('reports recovery when active work is detected', () => {
    const s = freshState({ lastEnterAtMs: t0, nudgeCount: 1, lastNudgeAtMs: t0 + 51 * 60_000 });
    expect(sessionLimitNextAction(s, false, true, t0 + 52 * 60_000)).toBe('recovered');
  });

  it('modal re-appearing takes precedence over recovery/nudging', () => {
    const s = freshState({ lastEnterAtMs: 0 });
    expect(sessionLimitNextAction(s, true, true, s.resetAtMs + 10 * 60_000)).toBe('dismiss-modal');
  });
});

describe('fleet alert', () => {
  const t0 = 1_000_000_000_000;
  const reset = t0 + 50 * 60_000;

  beforeEach(() => _resetSessionLimitFleetState());

  it('does not alert for 1-2 sessions', () => {
    expect(recordSessionLimitHit('RYA-1', reset, t0).shouldAlert).toBe(false);
    expect(recordSessionLimitHit('RYA-2', reset, t0 + 1000).shouldAlert).toBe(false);
  });

  it('alerts when a 3rd session hits the limit within 10 min', () => {
    recordSessionLimitHit('RYA-1', reset, t0);
    recordSessionLimitHit('RYA-2', reset, t0 + 60_000);
    const r = recordSessionLimitHit('RYA-3', reset + 60_000, t0 + 120_000);
    expect(r.shouldAlert).toBe(true);
    expect(r.count).toBe(3);
    expect(r.latestResetAtMs).toBe(reset + 60_000);
    expect(currentFleetHitKeys(t0 + 120_000)).toEqual(['RYA-1', 'RYA-2', 'RYA-3']);
  });

  it('dedupes repeat detections of the same issue', () => {
    recordSessionLimitHit('RYA-1', reset, t0);
    recordSessionLimitHit('RYA-1', reset, t0 + 1000);
    const r = recordSessionLimitHit('RYA-1', reset, t0 + 2000);
    expect(r.count).toBe(1);
    expect(r.shouldAlert).toBe(false);
  });

  it('suppresses repeat alerts within the cooldown, re-alerts after', () => {
    recordSessionLimitHit('RYA-1', reset, t0);
    recordSessionLimitHit('RYA-2', reset, t0);
    expect(recordSessionLimitHit('RYA-3', reset, t0).shouldAlert).toBe(true);
    // 4th session shortly after → no second alert
    expect(recordSessionLimitHit('RYA-4', reset, t0 + 60_000).shouldAlert).toBe(false);
    // After cooldown, a fresh burst alerts again
    const later = t0 + SESSION_LIMIT_ALERT_COOLDOWN_MS + SESSION_LIMIT_FLEET_WINDOW_MS + 1000;
    recordSessionLimitHit('RYA-5', reset, later);
    recordSessionLimitHit('RYA-6', reset, later);
    expect(recordSessionLimitHit('RYA-7', reset, later).shouldAlert).toBe(true);
  });

  it('expires hits outside the 10-min window', () => {
    recordSessionLimitHit('RYA-1', reset, t0);
    recordSessionLimitHit('RYA-2', reset, t0);
    const r = recordSessionLimitHit('RYA-3', reset, t0 + SESSION_LIMIT_FLEET_WINDOW_MS + 60_000);
    expect(r.count).toBe(1);
    expect(r.shouldAlert).toBe(false);
  });

  it('builds an alert message with count, sessions, and reset time', () => {
    const msg = buildFleetAlertMessage(12, new Date(2026, 5, 10, 21, 20).getTime(), ['RYA-634', 'RYA-1227']);
    expect(msg).toContain('12 agent sessions paused');
    expect(msg).toContain('RYA-634, RYA-1227');
    expect(msg).toContain('9:20');
    expect(msg).toContain('Stop and wait');
  });

  it('fires on both channels via injectable sinks and never throws', async () => {
    const sent: string[] = [];
    const result = await fireSessionLimitFleetAlert(3, reset, ['RYA-1'], {
      telegram: async (m) => { sent.push(`tg:${m.slice(0, 20)}`); return true; },
      discord: async () => { throw new Error('webhook down'); },
    });
    expect(result.telegramOk).toBe(true);
    expect(result.discordOk).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
