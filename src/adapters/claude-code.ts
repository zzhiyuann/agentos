import { readFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import type { RunnerAdapter, SpawnOptions, SpawnResult } from './types.js';
import { isCaptureModeEnabled } from './types.js';
import {
  createTmuxSession, sessionExists, killSession,
  capturePane, writeFileOnRemote, sendKeys,
} from '../core/tmux.js';
import { getConfig, getIssueStateDir } from '../core/config.js';
import { getActiveAttempts } from '../core/db.js';

function getAnthropicKey(): string | null {
  const keyFile = join(getConfig().stateDir, '.anthropic-key');
  if (existsSync(keyFile)) {
    return readFileSync(keyFile, 'utf-8').trim();
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

export class ClaudeCodeAdapter implements RunnerAdapter {
  async spawn(opts: SpawnOptions): Promise<SpawnResult> {
    const tmuxName = opts.agentRole
      ? `aos-${opts.agentRole}-${opts.issueKey}`
      : `aos-${opts.issueKey}-${opts.attemptNumber}`;

    // Clean old state files from per-issue state dir (RYA-246).
    // State files live in ~/.aos/work/{issue-key}/, isolated from code workspace.
    // No shared-workspace guard needed — each issue has its own state dir.
    const stateDir = getIssueStateDir(opts.issueKey);
    for (const f of ['HANDOFF.md', 'BLOCKED.md', 'PROGRESS.md', '.dod-bounces', '.follow-up']) {
      const p = join(stateDir, f);
      try { unlinkSync(p); } catch { /* may not exist */ }
    }
    // A1.5: session markers for the DoD Stop hook — start timestamp (memory
    // freshness comparisons) and follow-up flag (gate exempts follow-ups).
    writeFileOnRemote(join(stateDir, '.session-started-at'), new Date().toISOString());
    if (opts.isFollowUp) {
      writeFileOnRemote(join(stateDir, '.follow-up'), '1');
    }
    // Also clean legacy workspace artifacts for backward compat transition
    for (const f of ['HANDOFF.md', 'BLOCKED.md', 'PROGRESS.md']) {
      const p = join(opts.workspacePath, f);
      try { unlinkSync(p); } catch { /* may not exist */ }
    }

    // Write agent grounding prompt to a per-session file (NOT .claude/CLAUDE.md).
    // CLAUDE.md is auto-loaded by Claude Code for ALL sessions including the human developer's.
    // Agent persona is passed via --system-prompt-file flag instead.
    // Per-session filename avoids overwrites when multiple agents share the same workspace.
    const groundingFile = `.agent-grounding-${tmuxName}.md`;
    const groundingPath = `${opts.workspacePath}/.claude/${groundingFile}`;
    writeFileOnRemote(groundingPath, opts.systemPrompt);

    // Pre-trust workspace + auto mode config + progress reporting hook
    writeFileOnRemote(
      `${opts.workspacePath}/.claude/settings.local.json`,
      JSON.stringify({
        permissions: {
          allow: [],
          defaultMode: 'auto',
        },
        autoMode: {
          environment: [
            `Organization: ${process.env.AOS_ORG_NAME || 'AgentOS-managed team'}. AI-native company with AI agent team members.`,
            `Source control: ${process.env.AOS_SOURCE_CONTROL || 'GitHub (configure AOS_SOURCE_CONTROL env var)'}`,
            'Agent orchestration: AgentOS at ~/.aos/ manages persistent AI agents',
            'Linear project management: agents interact via linear-tool CLI',
            'Infrastructure: Host server, tmux sessions',
            'Trusted tools: linear-tool, gh CLI, npm, node, tsx',
          ],
          allow: [
            'Git operations including commit and branch creation are allowed — agents commit freely',
            'Running tests and build commands is allowed',
            'Writing to agent memory files at .agent-memory/ and ~/.aos/ is allowed',
            'Using linear-tool for all Linear operations is allowed',
            'Installing npm dependencies from package.json is allowed',
          ],
        },
        trust: true,
        hooks: {
          Stop: [{
            matcher: '',
            hooks: [
              { type: 'command', command: `${getConfig().stateDir}/hooks/progress-report.sh`, timeout: 10000 },
              // A1.5: DoD gate — no-op unless the role is listed in ~/.aos/dod-gate-roles
              { type: 'command', command: `${getConfig().stateDir}/hooks/dod-gate.sh`, timeout: 10000 },
            ],
          }],
        },
      }, null, 2)
    );

    // Write structured HANDOFF template to per-issue state dir (RYA-246).
    // RYA-902: trimmed template — Files Changed + Verification are auto-derived
    // by handoff-enrich.ts from `git diff` and the session transcript, so the
    // agent only writes Summary + Memory Updated + Remaining Issues.
    // Skip for follow-ups — agent just needs to write its answer directly.
    if (!opts.isFollowUp) {
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
# HANDOFF — ${opts.issueKey}

## 给老板的话
[3 句以内的中文大白话，写给 CEO 看：干了什么、对他意味着什么、需要他做什么（没有就写「无需操作」）。禁止术语和 issue key。这段会直接显示在他手机的 CEO 门户上。]

## Summary
[1–3 sentences — intent, key decisions, outcome. Files Changed and Verification are auto-derived from git diff + session log; do not write them.]

## Memory Updated
[Which .agent-memory/ files you wrote/updated]

## Remaining Issues
[Anything not completed, edge cases — every follow-up must be a dispatched or [to decide] sub-issue, not prose]
`
      );
    }

    // Write API key to env file (not on command line — avoids ps aux exposure)
    const apiKey = getAnthropicKey();
    if (apiKey) {
      writeFileOnRemote(
        `${opts.workspacePath}/.env.aos`,
        `ANTHROPIC_API_KEY=${apiKey}\n`
      );
    }

    if (sessionExists(tmuxName)) {
      killSession(tmuxName);
    }

    // Build command:
    // 1. Unlock keychain from secure file (not inline password)
    // 2. Source API key from env file (not on command line)
    // 3. Launch Claude Code with auto mode — classifier reviews actions for safety (RYA-86)
    const safePrompt = opts.initialPrompt.replace(/'/g, "'\\''");
    const agentRoleExport = opts.agentRole ? `export AGENT_ROLE=${opts.agentRole}` : '';
    // A1.5: DoD Stop hook needs the per-issue state dir and issue key
    const stateDirExport = `export AOS_STATE_DIR='${stateDir}'; export AOS_ISSUE_KEY='${opts.issueKey}'`;
    // RYA-888 / RYA-945: when capture mode is on, route the Anthropic SDK's
    // request/response transcripts to ~/.claude/logs/ so RYA-844 can stitch
    // the rendered-context supplement onto the JSONL trace.
    const captureExport = isCaptureModeEnabled(opts) ? 'export ANTHROPIC_LOG=info' : '';
    // RYA-1258: always pass --model so claude never falls back to the org's built-in
    // default (which became inaccessible Jun 12-13 2026 and caused a 4-day outage).
    // Precedence: caller-specified model → AOS_FALLBACK_CLAUDE_MODEL env var → safe constant.
    const effectiveModel = opts.model ?? process.env.AOS_FALLBACK_CLAUDE_MODEL ?? 'claude-sonnet-4-6';
    const parts = [
      // Unlock keychain — read password from secured file instead of inline
      `security unlock-keychain -p "$(cat ~/.aos/.keychain-pass 2>/dev/null)" ~/Library/Keychains/login.keychain-db 2>/dev/null`,
      // Source API key from workspace env file
      apiKey ? `export $(cat ${opts.workspacePath}/.env.aos 2>/dev/null | xargs)` : '',
      // Set agent identity for linear-tool
      agentRoleExport,
      stateDirExport,
      // Capture-mode supplement (replay subsystem)
      captureExport,
      // Launch Claude Code with auto mode — classifier reviews actions instead of skipping all permissions
      `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-skip-permissions --model ${effectiveModel} --append-system-prompt-file .claude/${groundingFile} '${safePrompt}'`,
    ].filter(Boolean);
    const claudeCmd = parts.join('; ');

    createTmuxSession(tmuxName, opts.workspacePath, claudeCmd);

    // Smart trust prompt handler: check pane content before sending Enter
    for (const delayMs of [2000, 5000, 8000, 12000, 20000, 30000, 45000]) {
      setTimeout(() => {
        try {
          if (!sessionExists(tmuxName)) return;
          const output = capturePane(tmuxName, 10);
          if (/trust|Trust|Yes, I trust|trust this folder|Trust this workspace|Yes, continue|proceed|Press enter to confirm|Do you trust|security check/i.test(output || '')) {
            execSync(`tmux send-keys -t ${tmuxName} Enter 2>/dev/null`, { encoding: 'utf-8', timeout: 5_000 });
          }
        } catch { /* session may not exist yet */ }
      }, delayMs);
    }

    return { tmuxSession: tmuxName };
  }

  async resume(sessionId: string, _prompt?: string): Promise<void> {
    if (!sessionExists(sessionId)) {
      throw new Error(`tmux session ${sessionId} does not exist`);
    }
  }

  async fork(_sessionId: string, _prompt?: string): Promise<SpawnResult> {
    throw new Error('Fork not yet implemented for Claude Code');
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
