import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { RunnerAdapter, SpawnOptions, SpawnResult } from './types.js';
import { createTmuxSession, sessionExists, killSession, capturePane, writeFileOnRemote } from '../core/tmux.js';
import { getIssueStateDir } from '../core/config.js';

const SHARED_DIRS = ['skills', 'plugins', 'rules', 'vendor_imports', 'memories'];
const SHARED_FILES = ['AGENTS.md', 'RTK.md', 'instructions.md'];
const COPIED_FILES = ['config.toml', 'auth.json', 'version.json', '.personality_migration'];

function shellEscape(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function removeIfExists(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      rmSync(path, { force: true });
    }
  } catch {
    // no-op
  }
}

function ensureSymlink(source: string, target: string): void {
  if (!existsSync(source)) return;

  try {
    if (lstatSync(target).isSymbolicLink()) {
      if (readlinkSync(target) === source) return;
      removeIfExists(target);
    } else {
      removeIfExists(target);
    }
  } catch {
    // target does not exist
  }

  symlinkSync(source, target);
}

function ensureCopy(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

export function buildCodexOverride(systemPrompt: string): string {
  return [
    '# AgentOS Session Override',
    '',
    'The following instructions are injected by AgentOS for this session.',
    'Treat them as mandatory operating instructions for the entire run.',
    '',
    systemPrompt.trim(),
    '',
  ].join('\n');
}

export function syncCodexHome(sourceCodexDir: string, targetCodexDir: string, systemPrompt: string): void {
  mkdirSync(targetCodexDir, { recursive: true });

  for (const file of COPIED_FILES) {
    ensureCopy(join(sourceCodexDir, file), join(targetCodexDir, file));
  }

  for (const file of SHARED_FILES) {
    ensureSymlink(join(sourceCodexDir, file), join(targetCodexDir, file));
  }

  for (const dir of SHARED_DIRS) {
    ensureSymlink(join(sourceCodexDir, dir), join(targetCodexDir, dir));
  }

  writeFileSync(join(targetCodexDir, 'AGENTS.override.md'), buildCodexOverride(systemPrompt), 'utf-8');
}

function writeHandoffTemplate(stateDir: string, issueKey: string): void {
  // RYA-902: trimmed template — Files Changed + Verification are auto-derived
  // by handoff-enrich.ts from `git diff` and the session transcript.
  writeFileOnRemote(
    join(stateDir, 'HANDOFF_TEMPLATE.md'),
    `---
status_intent: in-review  # done | in-review (default) | in-progress | todo | no-change
reason: ""
# review_dispatch: <agent-role>
# dispatches:
#   - role: <agent-role>
#     issue: <ISSUE-KEY>
#     context: "what to do"
# delegate: <agent-role>
# parent_status: null
---
# HANDOFF — ${issueKey}

## Summary
[1–3 sentences — intent, key decisions, outcome. Files Changed and Verification are auto-derived from git diff + session log; do not write them.]

## Memory Updated
[Which .agent-memory/ files you wrote/updated]

## Remaining Issues
[Anything not completed, edge cases — every follow-up must be a dispatched or [to decide] sub-issue, not prose]
`
  );
}

export class CodexAdapter implements RunnerAdapter {
  async spawn(opts: SpawnOptions): Promise<SpawnResult> {
    const tmuxName = opts.agentRole
      ? `aos-${opts.agentRole}-${opts.issueKey}`
      : `aos-${opts.issueKey}-${opts.attemptNumber}`;

    const stateDir = getIssueStateDir(opts.issueKey);
    for (const f of ['HANDOFF.md', 'BLOCKED.md', 'PROGRESS.md']) {
      try { unlinkSync(join(stateDir, f)); } catch { /* may not exist */ }
      try { unlinkSync(join(opts.workspacePath, f)); } catch { /* legacy fallback */ }
    }

    if (!opts.isFollowUp) {
      writeHandoffTemplate(stateDir, opts.issueKey);
    }

    const home = join(homedir(), '.codex-agents', tmuxName);
    const codexHome = join(home, '.codex');
    syncCodexHome(join(homedir(), '.codex'), codexHome, opts.systemPrompt);

    if (sessionExists(tmuxName)) {
      killSession(tmuxName);
    }

    const safePrompt = shellEscape(opts.initialPrompt);
    const safeHome = shellEscape(home);
    const safeCodexHome = shellEscape(codexHome);
    const safeWorkspace = shellEscape(opts.workspacePath);
    const agentRoleExport = opts.agentRole ? `export AGENT_ROLE='${shellEscape(opts.agentRole)}'` : '';

    const parts = [
      `security unlock-keychain -p "$(cat ~/.aos/.keychain-pass 2>/dev/null)" ~/Library/Keychains/login.keychain-db 2>/dev/null`,
      `export HOME='${safeHome}'`,
      `export CODEX_HOME='${safeCodexHome}'`,
      agentRoleExport,
      `codex --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C '${safeWorkspace}' '${safePrompt}'`,
    ].filter(Boolean);

    createTmuxSession(tmuxName, opts.workspacePath, parts.join('; '));
    return { tmuxSession: tmuxName, isolatedHome: home };
  }

  async resume(sessionId: string, _prompt?: string): Promise<void> {
    if (!sessionExists(sessionId)) {
      throw new Error(`tmux session ${sessionId} does not exist`);
    }
  }

  async fork(_sessionId: string, _prompt?: string): Promise<SpawnResult> {
    throw new Error('Fork not yet implemented for Codex');
  }

  isAlive(sessionId: string): boolean {
    return sessionExists(sessionId);
  }

  kill(sessionId: string): void {
    if (sessionExists(sessionId)) {
      killSession(sessionId);
    }
  }

  captureOutput(sessionId: string, lines = 50): string {
    return capturePane(sessionId, lines);
  }
}
