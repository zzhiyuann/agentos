/**
 * Discord bot — bidirectional communication between Discord and agents.
 * Starts alongside `aos serve` when botToken is configured in discord.json.
 */
import { Client, GatewayIntentBits, Message, Partials, TextChannel } from 'discord.js';
import chalk from 'chalk';
import { loadDiscordConfig } from '../core/discord.js';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { agentExists } from '../core/persona.js';
import { parseDiscordMentions } from '../core/discord.js';
import { agentStartCommand } from '../commands/agent.js';

let client: Client | null = null;

// Agent display names for Discord replies
const DISPLAY_NAMES: Record<string, string> = {
  'cto': 'CTO',
  'cpo': 'CPO',
  'coo': 'COO',
  'lead-engineer': 'Lead Engineer',
  'research-lead': 'Research Lead',
};

/**
 * Send a message to Discord as an agent.
 * If messageId is provided, replies in a thread.
 */
export async function sendDiscordReply(
  channelId: string,
  content: string,
  role?: string,
  messageId?: string,
): Promise<boolean> {
  if (!client?.isReady()) return false;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return false;

    const name = role ? (DISPLAY_NAMES[role] || role.toUpperCase()) : 'AgentOS';
    const prefixed = `**${name}**: ${content}`;

    if (messageId) {
      // Reply to specific message (creates a thread-like reply)
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
function buildAgentMessage(from: string, text: string, channelId: string, messageId: string, role: string): string {
  const replyCmd = `AGENT_ROLE=${role} linear-tool discord-reply ${channelId} ${messageId}`;
  return [
    `[Discord from ${from}]: ${text}`,
    ``,
    `To reply in Discord, run: ${replyCmd} "your reply"`,
    `Reply to acknowledge, then do the work if needed, then reply again with results.`,
  ].join('\n');
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

  client.on('ready', () => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.blue(`[${ts}] Discord bot connected as ${client!.user?.tag}`));
  });

  client.on('messageCreate', async (msg: Message) => {
    if (msg.author.bot) return;
    if (config.channelId && msg.channelId !== config.channelId) return;

    const text = msg.content;
    const from = msg.author.displayName || msg.author.username;
    const ts = new Date().toLocaleTimeString();

    const mentions = parseDiscordMentions(text);
    if (mentions.length === 0) return;

    console.log(chalk.blue(`[${ts}] Discord: ${from}: "${text.substring(0, 60)}" → ${mentions.join(', ')}`));

    for (const role of mentions) {
      if (!agentExists(role)) continue;

      const agentMsg = buildAgentMessage(from, text, msg.channelId, msg.id, role);
      const tmuxName = `aos-${role}`;

      if (sessionExists(tmuxName)) {
        try {
          sendKeys(tmuxName, agentMsg);
          try { await msg.react('✅'); } catch { /**/ }
        } catch (err) {
          console.log(chalk.red(`  Discord pipe failed: ${(err as Error).message}`));
          try { await msg.react('❌'); } catch { /**/ }
        }
      } else {
        // Agent not running — start it, then pipe after boot
        try {
          await msg.react('🚀');
          console.log(chalk.cyan(`  Starting ${role} for Discord conversation...`));
          await agentStartCommand(role);
          setTimeout(() => {
            if (sessionExists(`aos-${role}`)) {
              try { sendKeys(`aos-${role}`, agentMsg); } catch { /**/ }
            }
          }, 15_000);
        } catch (err) {
          console.log(chalk.red(`  Failed to start ${role}: ${(err as Error).message}`));
          try { await msg.react('❌'); } catch { /**/ }
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
