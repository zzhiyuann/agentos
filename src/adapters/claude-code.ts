import { readFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import type { RunnerAdapter, SpawnOptions, SpawnResult } from './types.js';
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
    for (const f of ['HANDOFF.md', 'BLOCKED.md', 'PROGRESS.md']) {
      const p = join(stateDir, f);
      try { unlinkSync(p); } catch { /* may not exist */ }
    }
    // Also clean legacy workspace artifacts for backward compat transition
    for (const f of ['HANDOFF.md', 'BLOCKED.md', 'PROGRESS.md']) {
      const p = join(opts.workspacePath, f);
      try { unlinkSync(p); } catch { /* may not exist */ }
    }

    // Write full persona + memories to workspace CLAUDE.md
    writeFileOnRemote(`${opts.workspacePath}/.claude/CLAUDE.md`, opts.systemPrompt);

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
            hooks: [{ type: 'command', command: `${getConfig().stateDir}/hooks/progress-report.sh`, timeout: 10000 }],
          }],
        },
      }, null, 2)
    );

    // Write structured HANDOFF template to per-issue state dir (RYA-246)
    // Skip for follow-ups — agent just needs to write its answer directly
    if (!opts.isFollowUp) {
      writeFileOnRemote(
        join(stateDir, 'HANDOFF_TEMPLATE.md'),
        `# HANDOFF — ${opts.issueKey}

## Summary
[1-3 sentences: what was done]

## Files Changed
[List every file you created or modified, with brief description]

## Verification
[How you verified this works — commands run, tests passed, behavior confirmed]

## Memory Updated
[Which .agent-memory/ files you wrote/updated]

## Remaining Issues
[Anything not completed, edge cases, known limitations]
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
    const parts = [
      // Unlock keychain — read password from secured file instead of inline
      `security unlock-keychain -p "$(cat ~/.aos/.keychain-pass 2>/dev/null)" ~/Library/Keychains/login.keychain-db 2>/dev/null`,
      // Source API key from workspace env file
      apiKey ? `export $(cat ${opts.workspacePath}/.env.aos 2>/dev/null | xargs)` : '',
      // Set agent identity for linear-tool
      agentRoleExport,
      // Launch Claude Code with auto mode — classifier reviews actions instead of skipping all permissions
      `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --dangerously-skip-permissions '${safePrompt}'`,
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
