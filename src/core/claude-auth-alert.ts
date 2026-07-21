/**
 * P0 alerting for Claude Code auth failures.
 *
 * Posts to Telegram group + Discord webhook. After N consecutive failures
 * (CLAUDE_AUTH_FAILURE_THRESHOLD) the alert escalates — louder prefix and
 * includes the "blackout" ticker so the message is impossible to miss.
 *
 * Also writes BLOCKED.md to the issue's state dir so the Linear comment
 * stream shows a clear reason the dispatch was refused.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { postSystemMessage } from './telegram.js';
import { postDiscordSystem } from './discord.js';
import { CLAUDE_AUTH_FAILURE_THRESHOLD } from './claude-auth.js';

export interface AuthAlertContext {
  issueKey: string;
  role: string;
  reason: string;
  consecutiveFailures: number;
  blockedMdPath?: string;
}

/**
 * Alert senders — injectable for tests.
 */
export interface AlertSinks {
  telegram: (message: string) => Promise<boolean>;
  discord: (message: string) => Promise<boolean>;
  writeBlocked: (path: string, content: string) => void;
}

export const defaultSinks: AlertSinks = {
  telegram: postSystemMessage,
  discord: postDiscordSystem,
  writeBlocked: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  },
};

function buildMessage(ctx: AuthAlertContext, escalated: boolean): string {
  const header = escalated
    ? `🚨🚨🚨 P0 CLAUDE CODE AUTH OUTAGE (${ctx.consecutiveFailures} consecutive failures) 🚨🚨🚨`
    : `🚨 P0: Claude Code auth failed — agent spawn blocked`;

  const lines = [
    header,
    '',
    `*Issue*: ${ctx.issueKey}`,
    `*Role*: ${ctx.role}`,
    `*Reason*: ${ctx.reason}`,
    '',
    escalated
      ? `Every dispatched agent is failing. This is the same failure mode that produced the 2026-04-15 → 2026-04-20 7-day outage. Stop the bleed now.`
      : `The agent could not be spawned — auth check blocked the dispatch. No silent failures, no cancelled issue.`,
    '',
    `*Runbook*: \`~/.aos/agents/coo/memory/runbooks.md\` → "Claude Code auth refresh"`,
    `*Quick fix*: SSH to iMac, run \`~/.claude/refresh-all-tokens.sh\`. If that fails, \`claude /login\`.`,
  ];

  return lines.join('\n');
}

/**
 * Fire a P0 alert for a Claude Code auth failure. Writes BLOCKED.md to the
 * per-issue state dir, posts to Telegram + Discord, and returns when the
 * alert has been attempted on all channels.
 *
 * Escalation: when `consecutiveFailures >= CLAUDE_AUTH_FAILURE_THRESHOLD`
 * the message uses a louder prefix that survives dedup.
 *
 * Result is whether at least one channel accepted the message — caller can
 * log this but should not fail the dispatch decision on it.
 */
export async function alertClaudeAuthFailure(
  ctx: AuthAlertContext,
  sinks: AlertSinks = defaultSinks
): Promise<{ telegramOk: boolean; discordOk: boolean; blockedWritten: boolean; escalated: boolean }> {
  const escalated = ctx.consecutiveFailures >= CLAUDE_AUTH_FAILURE_THRESHOLD;
  const message = buildMessage(ctx, escalated);

  let blockedWritten = false;
  if (ctx.blockedMdPath) {
    try {
      sinks.writeBlocked(
        ctx.blockedMdPath,
        `# BLOCKED — ${ctx.issueKey}\n\n` +
        `**Claude Code auth check failed before dispatch.** No agent was spawned.\n\n` +
        `## Reason\n${ctx.reason}\n\n` +
        `## Consecutive auth failures\n${ctx.consecutiveFailures} (threshold: ${CLAUDE_AUTH_FAILURE_THRESHOLD})\n\n` +
        `## Next step\n` +
        `Refresh Claude Code auth on the iMac server (\`~/.claude/refresh-all-tokens.sh\` or \`claude /login\`), ` +
        `then re-dispatch this issue.\n`
      );
      blockedWritten = true;
    } catch {
      blockedWritten = false;
    }
  }

  const [telegramOk, discordOk] = await Promise.all([
    sinks.telegram(message).catch(() => false),
    sinks.discord(message).catch(() => false),
  ]);

  return { telegramOk, discordOk, blockedWritten, escalated };
}
