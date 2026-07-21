import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, existsSync } from 'fs';
import { dirname } from 'path';

const CMD_TIMEOUT = 30_000;

function runLocal(command: string, timeoutMs = CMD_TIMEOUT): string {
  try {
    return execSync(command, { encoding: 'utf-8', timeout: timeoutMs }).trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string; killed?: boolean };
    if (error.killed) {
      throw new Error(`Command timed out after ${timeoutMs}ms: ${command.substring(0, 80)}`);
    }
    throw new Error(`Command failed: ${error.stderr || error.message}`);
  }
}

export function createTmuxSession(
  sessionName: string,
  workDir: string,
  command: string
): void {
  mkdirSync(workDir, { recursive: true });

  // Write command to a script file to avoid shell escaping issues.
  const scriptPath = `/tmp/aos-tmux-${sessionName}.sh`;
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${command}\n`, 'utf-8');

  runLocal(`tmux new-session -d -s ${sessionName} -c ${workDir} bash ${scriptPath}`);
}

export function sessionExists(sessionName: string): boolean {
  try {
    runLocal(`tmux has-session -t ${sessionName} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName: string): void {
  runLocal(`tmux kill-session -t ${sessionName}`);
}

export function listAgentSessions(): string[] {
  try {
    const output = runLocal(`tmux list-sessions -F '#{session_name}' 2>/dev/null`);
    return output
      .split('\n')
      .filter((s) => s.startsWith('aos-'));
  } catch {
    return [];
  }
}

/** List tmux sessions that start with a given prefix (e.g. "aos-cto-") */
export function listSessionsByPrefix(prefix: string): string[] {
  return listAgentSessions().filter(s => s.startsWith(prefix));
}

export function capturePane(sessionName: string, lines = 50): string {
  try {
    return runLocal(
      `tmux capture-pane -t ${sessionName} -p -S -${lines}`
    );
  } catch {
    return '';
  }
}

/** Write content to a local file path (was SCP-based when running remotely) */
export function writeFileOnRemote(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/** Read a local file (was SSH cat when running remotely) */
export function readFileOnRemote(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Strip control characters that could manipulate the terminal or escape tmux.
 * Preserves newlines (\n), carriage returns (\r), and tabs (\t) which are
 * needed for normal message formatting. Strips all other C0 (0x00-0x1F)
 * and C1 (0x80-0x9F) control characters, including:
 *  - \x03 (Ctrl+C) — could kill the running process
 *  - \x04 (Ctrl+D) — could send EOF / close stdin
 *  - \x1B (ESC) — tmux escape sequences, terminal manipulation
 *  - \x1C (Ctrl+\) — SIGQUIT
 */
export function sanitizeForTmux(text: string): string {
  // Remove C0 control chars except \t (0x09), \n (0x0A), \r (0x0D)
  // Remove C1 control chars (0x80-0x9F)
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}

// RYA-1038: Settle delay between paste-buffer and Enter.
// Without this, Claude Code's TUI input handler can race with paste ingestion —
// Enter arrives before the pasted buffer is committed to internal state and the
// TUI eats it. Symptom: text visible in input box, no submission. Three lead-
// engineer sessions were lost for ~19h each on 2026-05-07 due to this race.
const SEND_KEYS_SETTLE_MS = 500;
const SEND_KEYS_VERIFY_MS = 600;

/**
 * Detect whether a Claude Code pane shows typed-but-not-submitted input.
 * Only the LAST `❯` line counts — the input box is always rendered at the
 * bottom of the pane, and SUBMITTED messages are echoed as `❯ <text>` in the
 * transcript above it (verified live on aos-cto-RYA-1243, 2026-06-12). An
 * anywhere-match would false-positive on that echo right after a successful
 * submit, which under the RYA-1251 retype fallback would double-send the
 * message. Empty last prompt (`❯ `) means input cleared / submission landed.
 */
export function paneHasUnsubmittedInput(paneOutput: string): boolean {
  const lines = paneOutput.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('❯')) return /\S/.test(lines[i].slice(1));
  }
  return false;
}

export function sendKeys(sessionName: string, text: string): void {
  // Sanitize user-facing text to prevent tmux/terminal escape injection
  const sanitized = sanitizeForTmux(text);
  // Use unique temp file (timestamp + random) to avoid races between concurrent calls
  const tmpFile = `/tmp/aos-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  writeFileSync(tmpFile, sanitized, 'utf-8');
  try {
    runLocal(`tmux load-buffer ${tmpFile}`);
    runLocal(`tmux paste-buffer -t ${sessionName}`);

    // Settle: let Claude Code's TUI commit the pasted content before Enter.
    runLocal(`sleep ${(SEND_KEYS_SETTLE_MS / 1000).toFixed(2)}`);
    runLocal(`tmux send-keys -t ${sessionName} Enter`);

    // Verify: if the pane still shows typed-but-not-submitted input after a second
    // settle window, retry Enter once. This catches the race where the first Enter
    // landed mid-render and was eaten.
    runLocal(`sleep ${(SEND_KEYS_VERIFY_MS / 1000).toFixed(2)}`);
    try {
      const post = runLocal(`tmux capture-pane -t ${sessionName} -p -S -10`);
      if (paneHasUnsubmittedInput(post)) {
        console.warn(`[tmux] sendKeys: input not submitted after Enter on ${sessionName} — retrying`);
        runLocal(`tmux send-keys -t ${sessionName} Enter`);

        // RYA-1251: re-verify after the retry. If the input STILL shows, the
        // paste was a phantom render — the TUI's real input buffer is empty
        // and no number of Enters can submit it. Fall back to literal retype.
        runLocal(`sleep ${(SEND_KEYS_VERIFY_MS / 1000).toFixed(2)}`);
        const post2 = runLocal(`tmux capture-pane -t ${sessionName} -p -S -10`);
        if (paneHasUnsubmittedInput(post2)) {
          console.warn(`[tmux] sendKeys: phantom paste on ${sessionName} — Enter cannot submit; falling back to literal retype (RYA-1251)`);
          const submitted = recoverPhantomInput(sessionName, sanitized);
          if (!submitted) {
            console.warn(`[tmux] sendKeys: literal retype did NOT submit on ${sessionName} — pane needs manual attention`);
          }
        }
      }
    } catch (err: unknown) {
      // Pane capture is best-effort; absence of verification doesn't block the send.
      console.debug(`[tmux] verify capture failed:`, (err as Error).message);
    }
  } finally {
    try { unlinkSync(tmpFile); } catch (err: unknown) {
      console.debug(`[tmux] temp file cleanup failed:`, (err as Error).message);
    }
  }
}

// RYA-1251: literal-retype recovery for phantom pastes.
// send-keys -l feeds the TUI's real input handler one keystroke at a time —
// the only delivery verified to work (3/3 on 2026-06-12) when a paste renders
// in the input box but never commits to the input buffer.
const RETYPE_CHUNK_CHARS = 256;

/**
 * Collapse text to a single line for literal retype: send-keys -l delivers
 * raw bytes, so an embedded newline acts as Enter and would submit a partial
 * message. Formatting degrades (newlines → spaces) but content survives —
 * acceptable for a recovery path whose alternative is a message lost forever.
 */
export function flattenForRetype(text: string): string {
  return sanitizeForTmux(text).replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * Type text into a pane as literal keystrokes (`tmux send-keys -l`), chunked
 * to stay under argv limits. Text must be single-line (see flattenForRetype).
 * Chunks split on code points so surrogate pairs (emoji) never tear.
 */
export function sendKeysLiteral(sessionName: string, text: string): void {
  const codePoints = Array.from(text);
  for (let i = 0; i < codePoints.length; i += RETYPE_CHUNK_CHARS) {
    const chunk = codePoints.slice(i, i + RETYPE_CHUNK_CHARS).join('');
    const quoted = `'${chunk.replace(/'/g, `'\\''`)}'`;
    runLocal(`tmux send-keys -t ${sessionName} -l -- ${quoted}`);
  }
}

/**
 * RYA-1251 phantom-paste recovery: text visible at the ❯ prompt that Enter
 * can never submit, because the render is stale and the real input buffer is
 * empty (verified 2026-06-12: typing one literal char makes the phantom
 * vanish). Recovery: clear the line (C-u — no-op on the empty phantom
 * buffer, and idempotent on a real one since we retype the same text),
 * re-type the message as literal keystrokes, then Enter.
 * Returns true when the pane no longer shows unsubmitted input.
 */
export function recoverPhantomInput(sessionName: string, text: string): boolean {
  const flat = flattenForRetype(text);
  if (!flat) return false;
  runLocal(`tmux send-keys -t ${sessionName} C-u`);
  runLocal(`sleep 0.20`);
  sendKeysLiteral(sessionName, flat);
  runLocal(`sleep ${(SEND_KEYS_SETTLE_MS / 1000).toFixed(2)}`);
  runLocal(`tmux send-keys -t ${sessionName} Enter`);
  runLocal(`sleep ${(SEND_KEYS_VERIFY_MS / 1000).toFixed(2)}`);
  try {
    const post = runLocal(`tmux capture-pane -t ${sessionName} -p -S -10`);
    return !paneHasUnsubmittedInput(post);
  } catch {
    return true; // capture is best-effort — don't make callers loop on a capture failure
  }
}

/**
 * Send a bare Enter keystroke — no paste, no settle/verify loop.
 * For interactive select-list dialogs (trust prompt, /rate-limit-options
 * modal) where sendKeys' paste-buffer path cannot submit: the dialog accepts
 * no text, so pasted content sits unsubmitted forever (RYA-1243).
 */
export function sendEnterKey(sessionName: string): void {
  runLocal(`tmux send-keys -t ${sessionName} Enter`);
}

/**
 * Get the PID of the shell process running in a tmux session's pane.
 */
export function getSessionPid(sessionName: string): number {
  const output = runLocal(`tmux list-panes -t ${sessionName} -F '#{pane_pid}'`);
  const pid = parseInt(output.split('\n')[0], 10);
  if (isNaN(pid)) throw new Error(`Could not get PID for tmux session ${sessionName}`);
  return pid;
}

/**
 * List all descendant PIDs of a root process (BFS: parents before children).
 * Excludes the root itself.
 */
export function listDescendantPids(rootPid: number): number[] {
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    let children: number[] = [];
    try {
      // pgrep exits 1 on no match — mask so runLocal doesn't throw
      children = runLocal(`pgrep -P ${pid} || true`)
        .split('\n')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n));
    } catch (err: unknown) {
      console.debug(`[tmux] pgrep -P ${pid} failed:`, (err as Error).message);
    }
    for (const c of children) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * Suspend (SIGSTOP) the processes inside a tmux session.
 *
 * RYA-1312: this MUST NOT stop the pane leader or signal by process group.
 * When the pane leader stops, the tmux server sees its child stopped and
 * immediately sends SIGCONT to the pane's process group (tmux
 * server_child_stopped), so a group-wide `kill -STOP -pgid` is silently
 * undone within milliseconds. Verified live 2026-07-20: the "hibernated"
 * RYA-1309 session kept working through its entire hibernation window.
 * Instead, SIGSTOP each descendant of the pane shell individually (parents
 * first, so a frozen Claude can't spawn new children mid-enumeration). The
 * pane shell itself keeps blocking in waitpid — tmux never notices.
 */
export function suspendSession(sessionName: string): void {
  const panePid = getSessionPid(sessionName);
  const descendants = listDescendantPids(panePid);
  if (descendants.length === 0) {
    throw new Error(`No descendant processes to suspend in ${sessionName} (agent process gone?)`);
  }
  let stopped = 0;
  for (const pid of descendants) {
    try { runLocal(`kill -STOP ${pid}`); stopped++; } catch (err: unknown) {
      console.debug(`[tmux] STOP ${pid} failed (raced exit?):`, (err as Error).message);
    }
  }
  if (stopped === 0) {
    throw new Error(`Failed to suspend any process in ${sessionName}`);
  }
}

/**
 * Resume (SIGCONT) all processes in a previously suspended tmux session.
 * Claude Code continues execution from exactly where it was frozen.
 */
export function resumeSessionProcess(sessionName: string): void {
  const panePid = getSessionPid(sessionName);
  const descendants = listDescendantPids(panePid);
  // Children before parents so nothing observes a still-frozen child; belt-and-
  // braces also CONT the pane group in case an older serve stopped it group-wide.
  for (const pid of descendants.reverse()) {
    try { runLocal(`kill -CONT ${pid}`); } catch (err: unknown) {
      console.debug(`[tmux] CONT ${pid} failed (raced exit?):`, (err as Error).message);
    }
  }
  try {
    const pgid = runLocal(`ps -o pgid= -p ${panePid}`).trim();
    if (pgid) runLocal(`kill -CONT -${pgid} || true`);
  } catch (err: unknown) {
    console.debug(`[tmux] group CONT for ${sessionName} failed:`, (err as Error).message);
  }
}

export function openGhosttySession(sessionName: string): void {
  const scriptPath = `/tmp/aos-jump-${sessionName}.sh`;
  const script = [
    '#!/bin/bash',
    `tmux attach -t ${sessionName}`,
  ].join('\n');

  writeFileSync(scriptPath, script, 'utf-8');
  execSync(`chmod +x ${scriptPath}`, { encoding: 'utf-8' });
  execSync(`open -na "Ghostty" --args -e ${scriptPath}`, { encoding: 'utf-8' });
}
