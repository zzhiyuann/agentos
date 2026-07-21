import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process so sendKeys/recoverPhantomInput tests can script pane
// captures and record the exact tmux commands issued. Pure-function tests
// below never touch execSync, so the mock is inert for them.
const execSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execSync }));

import {
  sanitizeForTmux, paneHasUnsubmittedInput,
  sendKeys, sendKeysLiteral, recoverPhantomInput, flattenForRetype,
} from './tmux.js';

describe('sanitizeForTmux', () => {
  it('preserves normal text', () => {
    expect(sanitizeForTmux('Hello world')).toBe('Hello world');
  });

  it('preserves newlines and tabs', () => {
    expect(sanitizeForTmux('line1\nline2\ttab')).toBe('line1\nline2\ttab');
  });

  it('preserves carriage returns', () => {
    expect(sanitizeForTmux('line1\r\nline2')).toBe('line1\r\nline2');
  });

  it('strips Ctrl+C (SIGINT)', () => {
    expect(sanitizeForTmux('before\x03after')).toBe('beforeafter');
  });

  it('strips Ctrl+D (EOF)', () => {
    expect(sanitizeForTmux('before\x04after')).toBe('beforeafter');
  });

  it('strips ESC (terminal escape sequences)', () => {
    expect(sanitizeForTmux('before\x1B[31mredafter')).toBe('before[31mredafter');
  });

  it('strips Ctrl+\\ (SIGQUIT)', () => {
    expect(sanitizeForTmux('before\x1Cafter')).toBe('beforeafter');
  });

  it('strips null bytes', () => {
    expect(sanitizeForTmux('before\x00after')).toBe('beforeafter');
  });

  it('strips Ctrl+Z (SIGTSTP)', () => {
    expect(sanitizeForTmux('before\x1Aafter')).toBe('beforeafter');
  });

  it('strips DEL character (0x7F)', () => {
    expect(sanitizeForTmux('before\x7Fafter')).toBe('beforeafter');
  });

  it('strips C1 control characters (0x80-0x9F)', () => {
    expect(sanitizeForTmux('before\x80\x8F\x9Fafter')).toBe('beforeafter');
  });

  it('strips vertical tab and form feed', () => {
    expect(sanitizeForTmux('before\x0B\x0Cafter')).toBe('beforeafter');
  });

  it('handles a realistic attack: Ctrl+C then shell command', () => {
    const malicious = '\x03rm -rf /\n';
    expect(sanitizeForTmux(malicious)).toBe('rm -rf /\n');
  });

  it('handles tmux escape sequence injection', () => {
    const malicious = '\x1Btmux send-keys -t other-session "pwned" Enter';
    expect(sanitizeForTmux(malicious)).toBe('tmux send-keys -t other-session "pwned" Enter');
  });

  it('preserves unicode and emoji', () => {
    expect(sanitizeForTmux('Hello 🌍 café')).toBe('Hello 🌍 café');
  });

  it('handles empty string', () => {
    expect(sanitizeForTmux('')).toBe('');
  });

  it('handles string with only control characters', () => {
    expect(sanitizeForTmux('\x00\x03\x04\x1B')).toBe('');
  });
});

describe('paneHasUnsubmittedInput', () => {
  it('detects typed-but-not-submitted prompt (RYA-1038)', () => {
    const stuck = [
      '  Per dispatch instructions, no HANDOFF.md written — waiting at the prompt.',
      '',
      '✻ Cogitated for 9m 20s',
      '',
      '────────────────────────────────────────',
      '❯ delete the archive',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(paneHasUnsubmittedInput(stuck)).toBe(true);
  });

  it('treats empty prompt as submitted (no content after ❯ )', () => {
    const clean = [
      '✻ Working on response...',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(paneHasUnsubmittedInput(clean)).toBe(false);
  });

  it('detects multi-word input', () => {
    expect(paneHasUnsubmittedInput('❯ verify lineage CLI works on a migrated file')).toBe(true);
  });

  it('does not match shell-style > prompts in agent output', () => {
    const agentOutput = '> npm install\n> echo done\nfinished';
    expect(paneHasUnsubmittedInput(agentOutput)).toBe(false);
  });

  it('handles empty pane output', () => {
    expect(paneHasUnsubmittedInput('')).toBe(false);
  });

  it('ignores submitted-message echoes above an empty input box (RYA-1251)', () => {
    // Claude Code echoes submitted messages as `❯ <text>` in the transcript.
    // Only the bottom-most ❯ (the actual input box) decides.
    const justSubmitted = [
      '❯ mark RYA-1243 in-review and end the session',
      '',
      '✻ Brewing…',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
    ].join('\n');
    expect(paneHasUnsubmittedInput(justSubmitted)).toBe(false);
  });

  it('still detects stuck input below a submitted-message echo', () => {
    const stuck = [
      '❯ an earlier submitted message',
      '  agent response...',
      '────────────────────────────────────────',
      '❯ this one never went through',
      '────────────────────────────────────────',
    ].join('\n');
    expect(paneHasUnsubmittedInput(stuck)).toBe(true);
  });
});

// ─── RYA-1251: phantom-paste fallback ────────────────────────────────────────

const PHANTOM_PANE = [
  '────────────────────────────────────────',
  '❯ hello world',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const CLEAN_PANE = [
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
].join('\n');

describe('sendKeys phantom-paste fallback (RYA-1251)', () => {
  let commands: string[];
  let paneQueue: string[];

  beforeEach(() => {
    commands = [];
    paneQueue = [];
    execSync.mockReset();
    execSync.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (cmd.includes('capture-pane')) {
        // Drain the scripted captures; the last one is sticky.
        return paneQueue.length > 1 ? paneQueue.shift()! : (paneQueue[0] ?? '');
      }
      return '';
    });
  });

  it('falls back to literal retype when input stays phantom after the Enter retry', () => {
    // verify #1: phantom → Enter retry; verify #2: still phantom → retype;
    // recovery verify: clean → submitted.
    paneQueue = [PHANTOM_PANE, PHANTOM_PANE, CLEAN_PANE];
    sendKeys('aos-test', 'hello world');

    const literal = commands.filter((c) => c.includes('send-keys') && c.includes(' -l '));
    expect(literal).toEqual([`tmux send-keys -t aos-test -l -- 'hello world'`]);
    // Recovery clears the (phantom) line before retyping.
    expect(commands.some((c) => c.includes('C-u'))).toBe(true);
    // Retype must come AFTER the clear, and a final Enter after the retype.
    const clearIdx = commands.findIndex((c) => c.includes('C-u'));
    const literalIdx = commands.findIndex((c) => c.includes(' -l '));
    const finalEnterIdx = commands.length - 1 - [...commands].reverse().findIndex((c) => c.endsWith('Enter'));
    expect(clearIdx).toBeLessThan(literalIdx);
    expect(literalIdx).toBeLessThan(finalEnterIdx);
  });

  it('does not retype when the first verify shows the input submitted', () => {
    paneQueue = [CLEAN_PANE];
    sendKeys('aos-test', 'hello world');

    expect(commands.some((c) => c.includes(' -l '))).toBe(false);
    expect(commands.filter((c) => c.endsWith('Enter')).length).toBe(1);
  });

  it('does not retype when the Enter retry succeeds', () => {
    paneQueue = [PHANTOM_PANE, CLEAN_PANE];
    sendKeys('aos-test', 'hello world');

    expect(commands.some((c) => c.includes(' -l '))).toBe(false);
    expect(commands.filter((c) => c.endsWith('Enter')).length).toBe(2);
  });
});

describe('recoverPhantomInput', () => {
  let commands: string[];

  beforeEach(() => {
    commands = [];
    execSync.mockReset();
    execSync.mockImplementation((cmd: string) => {
      commands.push(cmd);
      return cmd.includes('capture-pane') ? CLEAN_PANE : '';
    });
  });

  it('clears, retypes literally, submits, and reports success', () => {
    expect(recoverPhantomInput('aos-x', 'fix the bug')).toBe(true);
    const seq = commands.filter((c) => c.startsWith('tmux'));
    expect(seq[0]).toContain('C-u');
    expect(seq[1]).toBe(`tmux send-keys -t aos-x -l -- 'fix the bug'`);
    expect(seq[2]).toContain('Enter');
    expect(seq[3]).toContain('capture-pane');
  });

  it('reports failure when the pane still shows unsubmitted input', () => {
    execSync.mockImplementation((cmd: string) => {
      commands.push(cmd);
      return cmd.includes('capture-pane') ? PHANTOM_PANE : '';
    });
    expect(recoverPhantomInput('aos-x', 'fix the bug')).toBe(false);
  });

  it('flattens multi-line text so embedded newlines cannot submit early', () => {
    recoverPhantomInput('aos-x', 'line one\nline two');
    const literal = commands.find((c) => c.includes(' -l '));
    expect(literal).toBe(`tmux send-keys -t aos-x -l -- 'line one line two'`);
  });

  it('refuses empty text', () => {
    expect(recoverPhantomInput('aos-x', '  \n ')).toBe(false);
    expect(commands.filter((c) => c.startsWith('tmux')).length).toBe(0);
  });
});

describe('sendKeysLiteral', () => {
  let commands: string[];

  beforeEach(() => {
    commands = [];
    execSync.mockReset();
    execSync.mockImplementation((cmd: string) => { commands.push(cmd); return ''; });
  });

  it('shell-escapes single quotes', () => {
    sendKeysLiteral('aos-x', "don't panic");
    expect(commands).toEqual([`tmux send-keys -t aos-x -l -- 'don'\\''t panic'`]);
  });

  it('chunks long text without tearing surrogate pairs', () => {
    const text = '🌍'.repeat(300); // 300 code points = 600 UTF-16 units
    sendKeysLiteral('aos-x', text);
    expect(commands.length).toBe(2); // ceil(300 / 256)
    const sent = commands
      .map((c) => c.match(/-- '(.*)'$/)![1])
      .join('');
    expect(sent).toBe(text);
  });
});

describe('flattenForRetype', () => {
  it('collapses newlines to single spaces', () => {
    expect(flattenForRetype('a\nb\n\nc')).toBe('a b c');
  });

  it('strips control characters and trims', () => {
    expect(flattenForRetype('  \x03do it\x1B \n')).toBe('do it');
  });
});
