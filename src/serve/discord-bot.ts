/**
 * Discord bot — bidirectional communication between Discord and agents.
 * Starts alongside `aos serve` when botToken is configured in discord.json.
 */
import { Client, GatewayIntentBits, Guild, Message, Partials, TextChannel } from 'discord.js';
import chalk from 'chalk';
import { loadDiscordConfig, saveDiscordConfig } from '../core/discord.js';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { agentExists, listAgents, loadAgentConfig } from '../core/persona.js';
import { parseDiscordMentions } from '../core/discord.js';
import { agentStartCommand } from '../commands/agent.js';
import { getActiveAttempts } from '../core/db.js';
import { getIssue } from '../core/linear.js';
import { spawnFollowUp } from './follow-up.js';
import { pipeToChatSession } from './chat-session.js';
import { getConfig } from '../core/config.js';
import { discordSourceContext } from './state.js';
import { classifyMessageRole, type RoleRouteDecision } from './role-router.js';

let client: Client | null = null;

// Agent display names for Discord replies
const DISPLAY_NAMES: Record<string, string> = {
  'cto': 'CTO',
  'cpo': 'CPO',
  'coo': 'COO',
  'lead-engineer': 'Lead Engineer',
  'research-lead': 'Research Lead',
};

// Reverse map: webhook display name → agent role (for auto-routing from quote author)
const DISPLAY_NAME_TO_ROLE: Record<string, string> = {};
for (const [role, name] of Object.entries(DISPLAY_NAMES)) {
  DISPLAY_NAME_TO_ROLE[name.toLowerCase()] = role;
}
// Also map the system name
DISPLAY_NAME_TO_ROLE['agentos'] = 'system';

/**
 * Send a message to Discord as an agent.
 * Prefers webhook (shows per-agent name + avatar) over bot client (shows generic "AgentOS").
 * If messageId is provided, quotes the original message for context.
 */
export async function sendDiscordReply(
  channelId: string,
  content: string,
  role?: string,
  messageId?: string,
): Promise<boolean> {
  const config = loadDiscordConfig();
  const name = role ? (DISPLAY_NAMES[role] || role.toUpperCase()) : 'AgentOS';

  // Prefer webhook — shows per-agent identity (name + avatar) instead of generic "AgentOS"
  if (config.webhookUrl) {
    let finalContent = content;

    // If replying to a specific message, quote it for context
    if (messageId && client?.isReady()) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel instanceof TextChannel) {
          const orig = await channel.messages.fetch(messageId);
          const origAuthor = orig.author.displayName || orig.author.username;
          const origText = orig.content.length > 200
            ? orig.content.substring(0, 200) + '...'
            : orig.content;
          finalContent = `> **${origAuthor}**: ${origText}\n${content}`;
        }
      } catch (err) {
        console.log(chalk.dim(`[discord] quote fetch failed: ${(err as Error).message}`));
      }
    }

    // Truncate to Discord limit
    if (finalContent.length > 1950) {
      finalContent = finalContent.substring(0, 1950) + '\n...(truncated)';
    }

    const avatarUrl = config.agentAvatars?.[role || 'system']
      || `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${role || 'system'}-agentos&size=128`;

    try {
      const resp = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: name,
          avatar_url: avatarUrl,
          content: finalContent,
        }),
      });
      if (resp.ok) return true;
    } catch (err) {
      console.log(chalk.dim(`[discord] webhook send failed, falling back to bot client: ${(err as Error).message}`));
    }
  }

  // Fallback: bot client (shows "AgentOS" but supports native reply threading)
  if (!client?.isReady()) return false;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return false;

    const prefixed = `**${name}**: ${content}`;

    if (messageId) {
      try {
        const origMessage = await channel.messages.fetch(messageId);
        await origMessage.reply(prefixed);
        return true;
      } catch {
        // Message not found — fall back to regular post
      }
    }

    await channel.send(prefixed);
    return true;
  } catch (err) {
    console.log(chalk.red(`Discord reply failed: ${(err as Error).message}`));
    return false;
  }
}

/** Build the message piped to the agent, including reply instructions */
function buildAgentMessage(from: string, text: string, channelId: string, messageId: string, role: string, quotedContext?: string): string {
  const replyCmd = `AGENT_ROLE=${role} linear-tool discord-reply ${channelId} ${messageId}`;
  const lines = [];
  if (quotedContext) {
    lines.push(`[Discord from ${from} (quoting: ${quotedContext})]: ${text}`);
  } else {
    lines.push(`[Discord from ${from}]: ${text}`);
  }
  lines.push('', `To reply in Discord, run: ${replyCmd} "your reply"`,
    `Reply to acknowledge, then do the work if needed, then reply again with results.`);
  return lines.join('\n');
}

/** B: chat-tier message — conversational instructions instead of task framing */
function buildChatMessage(from: string, text: string, channelId: string, messageId: string, role: string, quotedContext?: string): string {
  const replyCmd = `AGENT_ROLE=${role} linear-tool discord-reply ${channelId} ${messageId}`;
  const lines = [];
  if (quotedContext) {
    lines.push(`[Discord from ${from} (quoting: ${quotedContext})]: ${text}`);
  } else {
    lines.push(`[Discord from ${from}]: ${text}`);
  }
  lines.push('', `回复命令：${replyCmd} "你的回复"`,
    `按聊天前台守则处理：直接回复即可；只有明确的工程任务才 create-issue + dispatch 后告知。`);
  return lines.join('\n');
}

/** Extract issue key (e.g. RYA-19) from text */
function extractIssueKey(text: string): string | null {
  const match = text.match(/\b([A-Z]+-\d+)\b/);
  return match ? match[1] : null;
}

/**
 * Add a reaction to a Discord message. Used by the bot for claim feedback (👀/❓)
 * and by agents via `linear-tool discord-react` for status updates (🚧/✅).
 */
export async function addDiscordReaction(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<boolean> {
  if (!client?.isReady()) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return false;
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
    return true;
  } catch (err) {
    console.log(chalk.dim(`[discord] reaction ${emoji} failed: ${(err as Error).message}`));
    return false;
  }
}

/**
 * RYA-1299: instructions appended to auto-claimed messages so the claiming
 * agent knows it was routed by the classifier and how to signal status.
 */
function buildClaimNote(role: string, channelId: string, messageId: string, decision: RoleRouteDecision): string {
  const reactCmd = `AGENT_ROLE=${role} linear-tool discord-react ${channelId} ${messageId}`;
  const lines = [
    '',
    `[智能认领] 这条消息没有@任何人，系统判定你是最相关角色并已加👀认领${decision.confidence === 'low' ? '（置信度低：若明显不该由你处理，回复说明并用 linear-tool notify 转给正确角色）' : ''}。`,
    `状态反馈约定：需要较长处理时先运行 ${reactCmd} 🚧 ；处理完成后运行 ${reactCmd} ✅ 。纯聊天直接回复即可，无需🚧。`,
  ];
  return lines.join('\n');
}

/** Create a new Linear issue from a Discord message */
async function createIssueFromDiscord(
  role: string,
  messageText: string,
  from: string,
): Promise<{ key: string; id: string } | null> {
  try {
    const { getAgentClient, getWorkflowStateId } = await import('../core/linear-client.js');
    const config = getConfig();
    const client = getAgentClient();
    const stateId = await getWorkflowStateId('Todo');

    // Generate a concise title from the message (first 60 chars, cleaned up)
    // Strip Discord raw mentions: <@&ROLE_ID>, <@USER_ID>, <@!USER_ID>, <#CHANNEL_ID>, plus plain @word
    const cleaned = messageText
      .replace(/<@[&!]?\d+>/g, '')
      .replace(/<#\d+>/g, '')
      .replace(/@\w+/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const title = cleaned.length > 60 ? cleaned.substring(0, 57) + '...' : cleaned;

    // Resolve assignee from role
    let assigneeId: string | undefined;
    if (agentExists(role)) {
      const agentConfig = loadAgentConfig(role);
      assigneeId = agentConfig.linearUserId || undefined;
    }

    const result = await client.createIssue({
      teamId: config.linearTeamId,
      title: title || `Discord message from ${from}`,
      description: `> Discord from **${from}**:\n> ${messageText}\n\n_Auto-created from Discord message._`,
      priority: 3,
      stateId,
      ...(assigneeId ? { assigneeId } : {}),
    });

    if (result.success) {
      const issue = await result.issue;
      if (issue) {
        if (assigneeId) {
          await client.updateIssue(issue.id, { delegateId: assigneeId });
        }
        return { key: issue.identifier, id: issue.id };
      }
    }
  } catch (err) {
    console.log(chalk.red(`  Issue creation from Discord failed: ${(err as Error).message}`));
  }
  return null;
}

/** Fetch quoted message content, resolve agent role and issue key */
async function resolveQuotedMessage(msg: Message): Promise<{ quotedText: string; quotedRole: string | null; issueKey: string | null }> {
  if (!msg.reference?.messageId) return { quotedText: '', quotedRole: null, issueKey: null };
  try {
    const channel = msg.channel as TextChannel;
    const quoted = await channel.messages.fetch(msg.reference.messageId);
    const authorName = quoted.author.username;
    // Webhook messages use the display name as username
    const role = DISPLAY_NAME_TO_ROLE[authorName.toLowerCase()] || null;
    // Extract issue key from quoted message
    const issueKey = extractIssueKey(quoted.content);
    // Truncate quoted content to avoid overwhelming the agent
    const content = quoted.content.length > 500
      ? quoted.content.substring(0, 500) + '...(truncated)'
      : quoted.content;
    return { quotedText: content, quotedRole: role, issueKey };
  } catch {
    return { quotedText: '', quotedRole: null, issueKey: null };
  }
}

/** Role colors for Discord (matching avatar color scheme) */
const ROLE_COLORS: Record<string, number> = {
  'cto': 0x6366f1,       // Indigo
  'cpo': 0x22c55e,       // Green
  'coo': 0xf59e0b,       // Amber
  'lead-engineer': 0x3b82f6, // Blue
  'research-lead': 0xec4899, // Pink
  'ceo-office': 0x64748b,    // Slate
};

/**
 * Sync agent roles to Discord server as mentionable roles.
 * Creates missing roles, updates existing ones, saves mapping to discord.json.
 */
async function syncAgentRoles(guild: Guild): Promise<void> {
  const agents = listAgents();
  const config = loadDiscordConfig();
  const roleMapping: Record<string, string> = { ...(config.roleMapping || {}) };

  // Build reverse map: agentRole → discordRoleId (from existing mapping)
  const agentToDiscordId = new Map<string, string>();
  for (const [discordId, agentRole] of Object.entries(roleMapping)) {
    agentToDiscordId.set(agentRole, discordId);
  }

  // Fetch all guild roles (don't rely on cache alone)
  await guild.roles.fetch();

  let created = 0;
  let synced = 0;

  for (const agentRole of agents) {
    const displayName = DISPLAY_NAMES[agentRole]
      || agentRole.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Check if we already have a valid mapping
    const existingId = agentToDiscordId.get(agentRole);
    if (existingId && guild.roles.cache.has(existingId)) {
      // Role exists — ensure it's mentionable
      const existing = guild.roles.cache.get(existingId)!;
      if (!existing.mentionable) {
        try { await existing.setMentionable(true); } catch (err) { void err; }
      }
      synced++;
      continue;
    }

    // Clean up stale mapping
    if (existingId) {
      delete roleMapping[existingId];
    }

    // Check if a role with this display name already exists on the server
    const byName = guild.roles.cache.find(r => r.name === displayName);
    if (byName) {
      roleMapping[byName.id] = agentRole;
      if (!byName.mentionable) {
        try { await byName.setMentionable(true); } catch (err) { void err; }
      }
      synced++;
      continue;
    }

    // Create the role
    try {
      const newRole = await guild.roles.create({
        name: displayName,
        color: ROLE_COLORS[agentRole] || 0x94a3b8,
        mentionable: true,
        reason: 'AgentOS: mentionable agent role for @mention routing',
      });
      roleMapping[newRole.id] = agentRole;
      created++;
      console.log(chalk.green(`  Created Discord role: @${displayName}`));
    } catch (err) {
      console.log(chalk.yellow(`  Failed to create role @${displayName}: ${(err as Error).message}`));
    }
  }

  // Save updated mapping
  saveDiscordConfig({ ...config, roleMapping });

  if (created > 0 || synced > 0) {
    console.log(chalk.blue(`  Discord roles: ${created} created, ${synced} existing`));
  }
}

/** Find the running tmux session for a specific issue key and role */
function findIssueSession(role: string, issueKey: string): string | null {
  // Try issue-specific session first: aos-{role}-{issueKey}
  const issueSession = `aos-${role}-${issueKey}`;
  if (sessionExists(issueSession)) return issueSession;
  // Check DB for any running attempt on this issue by this role
  const attempts = getActiveAttempts().filter(
    a => a.issue_key === issueKey && a.agent_type === role && a.status === 'running' && a.tmux_session
  );
  for (const a of attempts) {
    if (a.tmux_session && sessionExists(a.tmux_session)) return a.tmux_session;
  }
  return null;
}

export async function startDiscordBot(): Promise<boolean> {
  const config = loadDiscordConfig();
  if (!config.botToken) return false;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message],
  });

  client.on('ready', async () => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.blue(`[${ts}] Discord bot connected as ${client!.user?.tag}`));

    // Sync agent roles → mentionable Discord roles
    if (config.guildId) {
      try {
        const guild = await client!.guilds.fetch(config.guildId);
        await syncAgentRoles(guild);
      } catch (err) {
        console.log(chalk.yellow(`  Discord role sync failed: ${(err as Error).message}`));
        console.log(chalk.yellow(`  Ensure bot has ManageRoles permission in the Discord server`));
      }
    }
  });

  client.on('messageCreate', async (msg: Message) => {
    if (msg.author.bot) return;
    if (config.channelId && msg.channelId !== config.channelId) return;

    const text = msg.content;
    const from = msg.author.displayName || msg.author.username;
    const ts = new Date().toLocaleTimeString();

    // Resolve quoted message (if replying to someone)
    const { quotedText, quotedRole, issueKey: quotedIssueKey } = await resolveQuotedMessage(msg);

    // Also extract issue key from the main message text (not just quoted)
    const textIssueKey = extractIssueKey(text);
    const issueKey = textIssueKey || quotedIssueKey;

    // Get explicit @mentions from text
    let mentions = parseDiscordMentions(text);

    // Auto-route: if no @mention but replying to an agent's message, route to that agent
    if (mentions.length === 0 && quotedRole && quotedRole !== 'system') {
      mentions = [quotedRole];
    }

    const quotedContext = quotedText
      ? `${quotedRole ? DISPLAY_NAMES[quotedRole] || quotedRole : 'unknown'}: "${quotedText}"`
      : undefined;

    // RYA-1299/RYA-1304: LLM smart claim — no @mention and no quoted-agent route.
    // classifyMessageRole always returns a best-guess role (never null except when
    // no agents are registered). ❓ react and silent drop are intentionally removed.
    let autoClaim: RoleRouteDecision | null = null;
    if (mentions.length === 0) {
      if (text.trim().length < 2) return; // bare emoji / one-char — not routable
      autoClaim = await classifyMessageRole(text, { quotedContext });
      if (!autoClaim?.role || !agentExists(autoClaim.role)) {
        // Only hit when no agents are registered (system misconfiguration). Alert visibly.
        const errMsg = '⚠️ 路由失败：系统中没有可用的 agent，无法处理此消息。请检查 agent 配置。';
        console.log(chalk.red(`[${ts}] Discord: no agents registered — message from ${from} cannot be routed`));
        try { await sendDiscordReply(msg.channelId, errMsg, undefined, msg.id); } catch (err) { void err; }
        return;
      }
      mentions = [autoClaim.role];
      try { await msg.react('👀'); } catch (err) {
        console.log(chalk.dim(`[discord] 👀 react failed: ${(err as Error).message}`));
      }
      console.log(chalk.cyan(`[${ts}] Discord smart claim → ${autoClaim.role} (${autoClaim.confidence}/${autoClaim.complexity}${autoClaim.reason ? `: ${autoClaim.reason}` : ''})`));
    }

    console.log(chalk.blue(`[${ts}] Discord: ${from}: "${text.substring(0, 60)}" → ${mentions.join(', ')}${issueKey ? ` (issue ${issueKey})` : ''}${quotedRole ? ` (quoted ${quotedRole})` : ''}`));

    for (const role of mentions) {
      if (!agentExists(role)) continue;

      // B: chat tier — messages without an issue key are conversation, not work.
      // They go to the role's persistent chat session (spawned on demand); the
      // chat agent itself escalates to create-issue + dispatch when the CEO
      // clearly asks for work. No more auto-created issues for "在吗".
      if (!issueKey) {
        try {
          const chatMsg = buildChatMessage(from, text, msg.channelId, msg.id, role, quotedContext)
            + (autoClaim ? buildClaimNote(role, msg.channelId, msg.id, autoClaim) : '');
          pipeToChatSession(role, chatMsg);
          try { await msg.react('💬'); } catch (err) { void err; }
          console.log(chalk.green(`  Chat tier → aos-${role}-chat`));
        } catch (err) {
          console.log(chalk.red(`  Chat session failed for ${role}: ${(err as Error).message}`));
          try { await msg.react('❌'); } catch (reactErr) { void reactErr; }
        }
        continue;
      }

      const agentMsg = buildAgentMessage(from, text, msg.channelId, msg.id, role, quotedContext)
        + (autoClaim ? buildClaimNote(role, msg.channelId, msg.id, autoClaim) : '');

      // Try issue-specific session first, fall back to generic role session
      const issueSession = issueKey ? findIssueSession(role, issueKey) : null;
      const genericSession = `aos-${role}`;
      const targetSession = issueSession || (sessionExists(genericSession) ? genericSession : null);

      if (targetSession) {
        try {
          sendKeys(targetSession, agentMsg);
          try { await msg.react('✅'); } catch (err) { void err; }
          if (issueSession) {
            console.log(chalk.green(`  Routed to issue session: ${issueSession}`));
          }
        } catch (err) {
          console.log(chalk.red(`  Discord pipe failed: ${(err as Error).message}`));
          try { await msg.react('❌'); } catch (reactErr) { void reactErr; }
        }
      } else {
        // Agent not running — check issue status to decide spawn mode
        try {
          await msg.react('🚀');

          // If we have an issue key, check its Linear status
          let issueState: string | undefined;
          let issueTitle: string | undefined;
          let issueId: string | undefined;
          if (issueKey) {
            try {
              const issue = await getIssue(issueKey);
              issueState = issue.state;
              issueTitle = issue.title;
              issueId = issue.id;
            } catch (err) {
              console.log(chalk.dim(`[discord] issue fetch failed for ${issueKey}: ${(err as Error).message}`));
            }
          }

          const isCompleted = issueState && ['Done', 'In Review'].includes(issueState);

          if (isCompleted && issueKey && issueId) {
            // Issue is done/reviewed — use conversation mode (no status change, no attempt)
            console.log(chalk.cyan(`  Follow-up on ${issueKey} (${issueState}) — conversation mode`));
            const fullMsg = quotedContext
              ? `[Quoting: ${quotedContext}]\n\n${text}`
              : text;
            await spawnFollowUp({
              agentRole: role,
              issueKey,
              issueId,
              issueTitle: issueTitle || issueKey,
              issueState: issueState!,
              userMessage: fullMsg,
              discordChannelId: msg.channelId,
              discordMessageId: msg.id,
            });
          } else {
            // Active issue or no issue — full task dispatch
            let dispatchKey = issueKey;

            // No issue key found — create a new issue from the Discord message
            if (!dispatchKey) {
              console.log(chalk.cyan(`  No issue key — creating issue from Discord message for ${role}...`));
              const created = await createIssueFromDiscord(role, text, from);
              if (created) {
                dispatchKey = created.key;
                console.log(chalk.green(`  Created ${created.key} from Discord message`));
              } else {
                console.log(chalk.yellow(`  Issue creation failed — starting bare session for ${role}`));
              }
            }

            console.log(chalk.cyan(`  Starting ${role}${dispatchKey ? ` on ${dispatchKey}` : ''} for Discord conversation...`));
            // Store Discord context so monitor can reply to the original message on completion
            if (dispatchKey) {
              discordSourceContext.set(dispatchKey, {
                channelId: msg.channelId,
                messageId: msg.id,
                createdAt: Date.now(),
              });
            }
            await agentStartCommand(role, dispatchKey || undefined);
          }

          const dispatchKeyForSession = issueKey;
          const expectedSession = dispatchKeyForSession ? `aos-${role}-${dispatchKeyForSession}` : genericSession;
          setTimeout(() => {
            // Try all possible session names (issue-specific, role-generic, or newly created issue)
            const possibleSessions = [expectedSession, `aos-${role}`];
            // Also check for sessions matching any issue key we created
            const allSessions = getActiveAttempts()
              .filter(a => a.agent_type === role && a.status === 'running' && a.tmux_session)
              .map(a => a.tmux_session!);
            for (const s of [...new Set([...possibleSessions, ...allSessions])]) {
              if (sessionExists(s)) {
                try { sendKeys(s, agentMsg); } catch (err) { void err; }
                break;
              }
            }
          }, 15_000);
        } catch (err) {
          console.log(chalk.red(`  Failed to start ${role}: ${(err as Error).message}`));
          try { await msg.react('❌'); } catch (reactErr) { void reactErr; }
        }
      }
    }
  });

  try {
    await client.login(config.botToken);
    return true;
  } catch (err) {
    console.log(chalk.red(`Discord bot login failed: ${(err as Error).message}`));
    client = null;
    return false;
  }
}

export function stopDiscordBot(): void {
  if (client) {
    client.destroy();
    client = null;
  }
}
