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

export function sendKeys(sessionName: string, text: string): void {
  // Use temp file + load-buffer to avoid shell escaping issues
  const tmpFile = `/tmp/aos-keys-${Date.now()}.txt`;
  writeFileSync(tmpFile, text, 'utf-8');
  try {
    runLocal(`tmux load-buffer ${tmpFile}`);
    runLocal(`tmux paste-buffer -t ${sessionName}`);
    runLocal(`tmux send-keys -t ${sessionName} Enter`);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* cleanup */ }
  }
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
 * Suspend (SIGSTOP) all processes in a tmux session.
 * Uses the pane's process group — stops the shell and all children (including Claude Code).
 * The tmux session stays alive, but all processes inside are frozen.
 */
export function suspendSession(sessionName: string): void {
  const pid = getSessionPid(sessionName);
  // Get the process group ID (may differ from PID)
  const pgid = runLocal(`ps -o pgid= -p ${pid}`).trim();
  // Send SIGSTOP to the entire process group
  runLocal(`kill -STOP -${pgid}`);
}

/**
 * Resume (SIGCONT) all processes in a previously suspended tmux session.
 * Claude Code continues execution from exactly where it was frozen.
 */
export function resumeSessionProcess(sessionName: string): void {
  const pid = getSessionPid(sessionName);
  const pgid = runLocal(`ps -o pgid= -p ${pid}`).trim();
  // Send SIGCONT to the entire process group
  runLocal(`kill -CONT -${pgid}`);
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
