import { describe, it, expect } from 'vitest';
import {
  extractUnsubmittedInput, phantomInputNextAction, PhantomInputState,
  PHANTOM_INPUT_IDLE_MS, PHANTOM_INPUT_RETRY_SPACING_MS, PHANTOM_INPUT_MAX_RECOVERIES,
} from './phantom-input.js';

describe('extractUnsubmittedInput', () => {
  it('extracts single-line phantom input (RYA-1251 incident shape)', () => {
    const pane = [
      '  Per dispatch instructions, no HANDOFF.md written — waiting at the prompt.',
      '',
      '✻ Cogitated for 9m 20s',
      '',
      '────────────────────────────────────────',
      '❯ mark RYA-1243 in-review and end the session',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(extractUnsubmittedInput(pane)).toBe('mark RYA-1243 in-review and end the session');
  });

  it('returns null for an empty prompt', () => {
    const pane = [
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
    ].join('\n');
    expect(extractUnsubmittedInput(pane)).toBeNull();
  });

  it('returns null when there is no prompt at all', () => {
    expect(extractUnsubmittedInput('some agent output\nmore output')).toBeNull();
    expect(extractUnsubmittedInput('')).toBeNull();
  });

  it('uses the LAST prompt — scrollback ❯ lines above an empty box do not count', () => {
    const pane = [
      '❯ an earlier message still visible in scrollback',
      '  agent response...',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
    ].join('\n');
    expect(extractUnsubmittedInput(pane)).toBeNull();
  });

  it('joins wrapped continuation lines until the box border', () => {
    const pane = [
      '────────────────────────────────────────',
      '❯ please check the tailscale config on the server and report',
      'back whether the research box is reachable',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(extractUnsubmittedInput(pane)).toBe(
      'please check the tailscale config on the server and report back whether the research box is reachable',
    );
  });

  it('stops continuation at a status line', () => {
    const pane = [
      '❯ clean up the .bak files too',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(extractUnsubmittedInput(pane)).toBe('clean up the .bak files too');
  });

  it('stops continuation at a blank line', () => {
    const pane = [
      '❯ do the thing',
      '',
      'unrelated trailing text',
    ].join('\n');
    expect(extractUnsubmittedInput(pane)).toBe('do the thing');
  });
});

describe('phantomInputNextAction', () => {
  const base = (over: Partial<PhantomInputState> = {}): PhantomInputState => ({
    firstSeenMs: 0, lastText: 'msg', recoveryCount: 0, lastRecoveryAtMs: 0, ...over,
  });

  it('waits while the input is younger than the idle threshold', () => {
    expect(phantomInputNextAction(base(), false, PHANTOM_INPUT_IDLE_MS - 1)).toBe('wait');
  });

  it('recovers once the idle threshold passes', () => {
    expect(phantomInputNextAction(base(), false, PHANTOM_INPUT_IDLE_MS + 1)).toBe('recover');
  });

  it('never recovers while the agent is actively working (typed-ahead input)', () => {
    expect(phantomInputNextAction(base(), true, PHANTOM_INPUT_IDLE_MS * 10)).toBe('wait');
  });

  it('spaces out recovery attempts', () => {
    const state = base({ recoveryCount: 1, lastRecoveryAtMs: PHANTOM_INPUT_IDLE_MS });
    const tooSoon = PHANTOM_INPUT_IDLE_MS + PHANTOM_INPUT_RETRY_SPACING_MS - 1;
    expect(phantomInputNextAction(state, false, tooSoon)).toBe('wait');
    expect(phantomInputNextAction(state, false, tooSoon + 2)).toBe('recover');
  });

  it('gives up after the max recovery attempts', () => {
    const state = base({ recoveryCount: PHANTOM_INPUT_MAX_RECOVERIES, lastRecoveryAtMs: PHANTOM_INPUT_IDLE_MS });
    expect(phantomInputNextAction(state, false, PHANTOM_INPUT_IDLE_MS * 100)).toBe('give-up');
  });
});
