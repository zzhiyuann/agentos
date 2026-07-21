import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from './config.js';
import { listAgents } from './persona.js';

interface DiscordConfig {
  webhookUrl?: string;          // Channel webhook URL for posting
  botToken?: string;            // Bot token for receiving events (optional)
  guildId?: string;             // Server ID
  channelId?: string;           // Channel ID
  agentAvatars?: Record<string, string>; // role → avatar URL
  roleMapping?: Record<string, string>;  // Discord role ID → agent role name
}

// Lazy: suites that mock ../core/config.js without a STATE_DIR export would
// crash at module init if this were a top-level const (grader → discord chain).
function configPath(): string {
  return join(STATE_DIR, 'discord.json');
}

export function loadDiscordConfig(): DiscordConfig {
  if (existsSync(configPath())) {
    return JSON.parse(readFileSync(configPath(), 'utf-8'));
  }
  return {};
}

export function saveDiscordConfig(config: DiscordConfig): void {
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

// Avatars per role — bottts style (robot characters, each unique)
const DEFAULT_AVATARS: Record<string, string> = {
  'cto': 'https://api.dicebear.com/9.x/bottts-neutral/png?seed=cto-agentos&backgroundColor=6366f1&size=128',
  'cpo': 'https://api.dicebear.com/9.x/bottts-neutral/png?seed=cpo-agentos&backgroundColor=22c55e&size=128',
  'coo': 'https://api.dicebear.com/9.x/bottts-neutral/png?seed=coo-agentos&backgroundColor=f59e0b&size=128',
  'lead-engineer': 'https://api.dicebear.com/9.x/bottts-neutral/png?seed=eng-agentos&backgroundColor=3b82f6&size=128',
  'research-lead': 'https://api.dicebear.com/9.x/bottts-neutral/png?seed=research-agentos&backgroundColor=ec4899&size=128',
  'system': 'https://api.dicebear.com/9.x/bottts-neutral/png?seed=agentos-system&backgroundColor=64748b&size=128',
};

const DISPLAY_NAMES: Record<string, string> = {
  'cto': 'CTO',
  'cpo': 'CPO',
  'coo': 'COO',
  'lead-engineer': 'Lead Engineer',
  'research-lead': 'Research Lead',
  'system': 'AgentOS',
};

// Content dedup: skip identical messages within 30s window
const recentMessages = new Map<string, number>(); // content hash → timestamp
const CONTENT_DEDUP_WINDOW_MS = 30_000;
const MAX_DISCORD_LENGTH = 1950; // Discord limit is 2000; leave room for suffix

/** Visible for testing */
export function _resetDedup(): void {
  recentMessages.clear();
}

/** Visible for testing */
export function _getRecentMessages(): Map<string, number> {
  return recentMessages;
}

function truncateMessage(message: string): string {
  if (message.length <= MAX_DISCORD_LENGTH) return message;
  return message.substring(0, MAX_DISCORD_LENGTH) + '\n...(truncated)';
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

/** Post a message to Discord channel as a specific agent role */
export async function postToDiscord(role: string, message: string): Promise<boolean> {
  const config = loadDiscordConfig();
  if (!config.webhookUrl) {
    return false;
  }

  const content = truncateMessage(message);

  // Dedup: skip if identical content was posted within 30s
  if (isDuplicate(content)) {
    return true; // silently succeed — message already sent
  }

  const avatarUrl = config.agentAvatars?.[role] || DEFAULT_AVATARS[role] || DEFAULT_AVATARS['system'];
  const username = DISPLAY_NAMES[role] || role.toUpperCase();

  try {
    const resp = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        avatar_url: avatarUrl,
        content,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Post a system message (uses AgentOS identity) */
export async function postDiscordSystem(message: string): Promise<boolean> {
  return postToDiscord('system', `🤖 ${message}`);
}

/** Parse @mentions from Discord message text.
 *  Handles both plain-text @cto and Discord role mentions <@&ROLE_ID>.
 *  Role map derived from listAgents() so new roles are included automatically. */
export function parseDiscordMentions(text: string): string[] {
  const roleMap: Record<string, string> = {};
  for (const role of listAgents()) {
    roleMap[role] = role;
    if (role.includes('-')) {
      roleMap[role.replace(/-/g, ' ')] = role; // lead engineer → lead-engineer
    }
  }
  // Shorthand aliases (not derivable from dir names)
  roleMap['eng'] = 'lead-engineer';
  roleMap['engineer'] = 'lead-engineer';
  roleMap['research'] = 'research-lead';

  const mentions: string[] = [];
  const lower = text.toLowerCase();

  // 1. Parse Discord role mentions: <@&ROLE_ID>
  const config = loadDiscordConfig();
  if (config.roleMapping) {
    const roleMentionRegex = /<@&(\d+)>/g;
    let match;
    while ((match = roleMentionRegex.exec(text)) !== null) {
      const agentRole = config.roleMapping[match[1]];
      if (agentRole && !mentions.includes(agentRole)) {
        mentions.push(agentRole);
      }
    }
  }

  // 2. Parse plain-text @mentions (fallback / backward compat)
  for (const [pattern, role] of Object.entries(roleMap)) {
    if (lower.includes(`@${pattern}`)) {
      if (!mentions.includes(role)) {
        mentions.push(role);
      }
    }
  }

  return mentions;
}
