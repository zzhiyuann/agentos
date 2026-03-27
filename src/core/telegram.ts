import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';
import { listAgents } from './persona.js';

interface TelegramConfig {
  groupChatId?: string;
  bots: Record<string, string>; // role → bot token
}

const CONFIG_PATH = join(getConfig().stateDir, 'telegram.json');

// Content dedup: skip identical messages within 30s window
const recentMessages = new Map<string, number>(); // content → timestamp
const CONTENT_DEDUP_WINDOW_MS = 30_000;
const MAX_TELEGRAM_LENGTH = 4000; // Telegram limit is 4096; leave room for suffix

/** Visible for testing */
export function _resetDedup(): void {
  recentMessages.clear();
}

/** Visible for testing */
export function _getRecentMessages(): Map<string, number> {
  return recentMessages;
}

function truncateMessage(message: string): string {
  if (message.length <= MAX_TELEGRAM_LENGTH) return message;
  return message.substring(0, MAX_TELEGRAM_LENGTH) + '\n...(truncated)';
}

function isDuplicate(content: string): boolean {
  const now = Date.now();
  const lastSent = recentMessages.get(content);
  if (lastSent && now - lastSent < CONTENT_DEDUP_WINDOW_MS) {
    return true;
  }
  recentMessages.set(content, now);
  // Clean old entries when map grows
  if (recentMessages.size > 50) {
    const cutoff = now - CONTENT_DEDUP_WINDOW_MS;
    for (const [k, v] of recentMessages) {
      if (v < cutoff) recentMessages.delete(k);
    }
  }
  return false;
}

export function loadTelegramConfig(): TelegramConfig {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return { bots: {} };
}

export function saveTelegramConfig(config: TelegramConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Post a message to the company group as a specific agent */
export async function postToGroup(role: string, message: string): Promise<boolean> {
  const config = loadTelegramConfig();
  if (!config.groupChatId) {
    console.log('Telegram group not configured. Set groupChatId in ~/.aos/telegram.json');
    return false;
  }

  const token = config.bots[role];
  if (!token) {
    // Fallback: use any available bot with role prefix
    const fallbackToken = Object.values(config.bots)[0];
    if (!fallbackToken) return false;
    return sendTelegramMessage(fallbackToken, config.groupChatId, `[${role.toUpperCase()}] ${message}`);
  }

  return sendTelegramMessage(token, config.groupChatId, message);
}

/** Post to group from system (uses first available bot) */
export async function postSystemMessage(message: string): Promise<boolean> {
  const config = loadTelegramConfig();
  if (!config.groupChatId) return false;
  const token = Object.values(config.bots)[0];
  if (!token) return false;
  return sendTelegramMessage(token, config.groupChatId, `🤖 ${message}`);
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<boolean> {
  const content = truncateMessage(text);

  // Dedup: skip if identical content was posted within 30s
  if (isDuplicate(content)) {
    return true; // silently succeed — message already sent
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: content, parse_mode: 'Markdown' }),
    });
    const data = await resp.json() as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

/** Parse @mentions from a Telegram group message.
 *  Role map derived from listAgents() so new roles are included automatically. */
export function parseMentions(text: string): string[] {
  const roleMap: Record<string, string> = {};
  for (const role of listAgents()) {
    roleMap[role] = role;
    if (role.includes('-')) {
      roleMap[role.replace(/-/g, '_')] = role; // lead_engineer → lead-engineer
    }
  }
  // Shorthand aliases (not derivable from dir names)
  roleMap['eng'] = 'lead-engineer';
  roleMap['research'] = 'research-lead';

  const mentions: string[] = [];
  const lower = text.toLowerCase();

  for (const [pattern, role] of Object.entries(roleMap)) {
    if (lower.includes(`@${pattern}`)) {
      if (!mentions.includes(role)) {
        mentions.push(role);
      }
    }
  }

  return mentions;
}
