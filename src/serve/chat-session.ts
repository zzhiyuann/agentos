/**
 * B: Persistent per-role chat sessions — the Discord "front desk".
 *
 * Chat-level messages (no issue key) no longer auto-create Linear issues and
 * full task sessions. Each role gets one long-lived lightweight Claude Code
 * session (`aos-{role}-chat`) with a small grounding prompt: it replies
 * directly to conversation, and only when the CEO clearly asks for work does
 * it create + dispatch an issue itself via linear-tool.
 *
 * Sessions live outside the attempts/queue system (no HANDOFF, no quality
 * gates, no DoD hook) and are reaped after CHAT_IDLE_TTL_MS of inactivity.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import { execSync } from 'child_process';
import { createTmuxSession, sessionExists, killSession, sendKeys, listSessionsByPrefix, capturePane } from '../core/tmux.js';

export const CHAT_IDLE_TTL_MS = 30 * 60_000;

/** role → last message timestamp (for the idle reaper) */
export const chatLastActivity = new Map<string, number>();

export function chatSessionName(role: string): string {
  return `aos-${role}-chat`;
}

function getAnthropicKey(): string | null {
  const keyFile = join(getConfig().stateDir, '.anthropic-key');
  if (existsSync(keyFile)) {
    return readFileSync(keyFile, 'utf-8').trim();
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

const DEFAULT_FRONTDESK = `## 聊天前台守则（Discord chat mode）

你正以「聊天前台」模式与 CEO（Ryan）在 Discord 对话。这不是任务 session——没有 HANDOFF、没有记忆门禁、没有进度评论要求。

1. **直接、简短、说人话。** 像同事聊天一样回复，用 CEO 使用的语言（通常是中文）。不要公文腔，不要客套模板。
2. **禁止内部术语。** Discord 回复里绝不出现 linear-tool 命令、channel/message ID、followUpMeta、HANDOFF 等内部机制词汇。CEO 不需要知道管道怎么工作。
3. **回复方式：** 运行 \`AGENT_ROLE=<你的角色> linear-tool discord-reply <channel-id> <message-id> "回复内容"\`（每条消息会附带具体命令）。
4. **闲聊/问候/查询 → 直接回复。** 可以用 linear-tool team-status / list-issues / recall 查信息后回答，不要为此建 issue。
5. **明确的工程任务 → 升级处理。** 判定标准：CEO 明确要求做某事、改代码、产出调研。此时：
   a. \`AGENT_ROLE=<role> linear-tool create-issue "标题" "描述" <priority>\`
   b. \`AGENT_ROLE=<role> linear-tool dispatch <最合适的角色> <ISSUE-KEY> "上下文"\`
   c. 回复 CEO：「已派发 RYA-xxxx，<一句话说明谁在做什么>」
6. **拿不准是不是任务 → 先问一句确认。** 不要擅自开工单。
7. 你可以连续多轮对话——session 会保持存活，上下文连续。`;

/** Frontdesk rules: user-editable override at ~/.aos/agents/_shared/chat-frontdesk.md */
function loadFrontdeskRules(): string {
  const override = join(homedir(), '.aos', 'agents', '_shared', 'chat-frontdesk.md');
  try {
    if (existsSync(override)) return readFileSync(override, 'utf-8');
  } catch (err) {
    console.debug('[chat-session] frontdesk override read failed:', (err as Error).message);
  }
  return DEFAULT_FRONTDESK;
}

/** Small grounding: identity + frontdesk rules + a capped slice of the role's
 *  always-on memory. Deliberately NOT the full task grounding (cheap + fast). */
function buildChatGrounding(role: string): string {
  const parts: string[] = [];
  parts.push(`# 你是 YourOrg 的 ${role}（Discord 聊天前台）\n`);
  parts.push(`你的角色身份是 ${role}。环境变量 AGENT_ROLE=${role} 已设置。\n`);
  parts.push(loadFrontdeskRules());

  const sysMem = join(homedir(), '.aos', 'agents', role, 'system-memory.md');
  try {
    if (existsSync(sysMem)) {
      const content = readFileSync(sysMem, 'utf-8');
      parts.push(`\n## 你的核心记忆（节选）\n\n${content.substring(0, 4000)}`);
    }
  } catch (err) {
    console.debug('[chat-session] system-memory read failed:', (err as Error).message);
  }
  return parts.join('\n');
}

function chatWorkspace(role: string): string {
  const dir = join(homedir(), 'agent-workspaces', `${role}-chat`);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  return dir;
}

function spawnChatSession(role: string, firstMessage: string): void {
  const name = chatSessionName(role);
  const ws = chatWorkspace(role);
  const groundingFile = `.chat-grounding-${role}.md`;

  writeFileSync(join(ws, '.claude', groundingFile), buildChatGrounding(role));
  writeFileSync(
    join(ws, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: [], defaultMode: 'auto' }, trust: true }, null, 2),
  );

  const apiKey = getAnthropicKey();
  if (apiKey) {
    writeFileSync(join(ws, '.env.aos'), `ANTHROPIC_API_KEY=${apiKey}\n`);
  }

  const safePrompt = firstMessage.replace(/'/g, "'\\''");
  const parts = [
    `security unlock-keychain -p "$(cat ~/.aos/.keychain-pass 2>/dev/null)" ~/Library/Keychains/login.keychain-db 2>/dev/null`,
    apiKey ? `export $(cat ${ws}/.env.aos 2>/dev/null | xargs)` : '',
    `export AGENT_ROLE=${role}`,
    `claude --dangerously-skip-permissions --append-system-prompt-file .claude/${groundingFile} '${safePrompt}'`,
  ].filter(Boolean);

  createTmuxSession(name, ws, parts.join('; '));
  console.log(chalk.cyan(`[chat-session] Spawned ${name}`));

  // Same trust-prompt auto-accept as the task adapter — fresh chat workspaces
  // hit the folder-trust dialog on first spawn.
  for (const delayMs of [2000, 5000, 8000, 12000, 20000]) {
    setTimeout(() => {
      try {
        if (!sessionExists(name)) return;
        const output = capturePane(name, 10);
        if (/trust|Yes, I trust|trust this folder|Press enter to confirm|Do you trust|security check/i.test(output || '')) {
          execSync(`tmux send-keys -t ${name} Enter 2>/dev/null`, { encoding: 'utf-8', timeout: 5_000 });
        }
      } catch (err) { void err; /* session may not exist yet */ }
    }, delayMs);
  }
}

/** Deliver a Discord message to the role's chat session, spawning it if needed.
 *  First message rides in as the CLI prompt; later ones are piped via sendKeys. */
export function pipeToChatSession(role: string, message: string): void {
  const name = chatSessionName(role);
  if (sessionExists(name)) {
    sendKeys(name, message);
  } else {
    spawnChatSession(role, message);
  }
  chatLastActivity.set(role, Date.now());
}

/** Kill chat sessions idle past the TTL. Called from the monitor tick.
 *  Sessions found without an activity record (e.g. after a serve restart)
 *  start a fresh TTL window from discovery. */
export function reapIdleChatSessions(): void {
  const now = Date.now();
  for (const session of listSessionsByPrefix('aos-')) {
    if (!session.endsWith('-chat')) continue;
    const role = session.slice('aos-'.length, -'-chat'.length);
    const last = chatLastActivity.get(role);
    if (last === undefined) {
      chatLastActivity.set(role, now);
      continue;
    }
    if (now - last > CHAT_IDLE_TTL_MS) {
      try {
        killSession(session);
        chatLastActivity.delete(role);
        console.log(chalk.dim(`[chat-session] Reaped idle ${session} (${Math.round((now - last) / 60000)}min)`));
      } catch (err) {
        console.debug('[chat-session] reap failed:', (err as Error).message);
      }
    }
  }
}
