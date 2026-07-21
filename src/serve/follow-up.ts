/** Centralized follow-up spawn logic — shared by webhook.ts and comments.ts. */

import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { getConfig, resolveWorkspace } from '../core/config.js';
import { getAgentLinearToken, loadPersona, buildGroundingPrompt } from '../core/persona.js';
// emitActivity/hasAgentAccess removed — session ack handled by caller (RYA-286)
import { createAttempt } from '../core/db.js';
import { sessionExists, killSession } from '../core/tmux.js';
import { getAdapter } from '../adapters/index.js';

import { followUpMeta, claimSpawnSlot } from './state.js';
import { downloadCommentImages } from './helpers.js';

export interface SpawnFollowUpOptions {
  agentRole: string;
  issueKey: string;
  issueId: string;
  issueTitle: string;
  issueState: string;
  userMessage: string;
  /** Comment ID for threading the agent reply */
  commentId?: string;
  /** Webhook agent session ID — used to emit activity and attach to attempt */
  agentSessionId?: string;
  /** Pre-downloaded image paths (skip re-downloading if already done) */
  imagePaths?: string[];
  /** Project name for workspace resolution */
  project?: string;
  /** Discord channel ID — when follow-up is triggered from Discord */
  discordChannelId?: string;
  /** Discord message ID to reply to */
  discordMessageId?: string;
  /** Agent-to-agent mention: provide full issue context so the looped-in agent has complete picture */
  fromAgent?: string;
  /** Full issue description for context-rich follow-ups (e.g., agent-to-agent mentions) */
  issueDescription?: string;
}

export interface SpawnFollowUpResult {
  attemptId: string;
  workspacePath: string;
}

/**
 * Spawn an agent to answer a follow-up comment on an issue.
 *
 * Consolidates the spawn logic previously duplicated in webhook.ts and comments.ts.
 * Handles: persona loading, image downloading, prompt building, adapter spawn,
 * attempt creation, and follow-up meta tracking.
 */
export async function spawnFollowUp(opts: SpawnFollowUpOptions): Promise<SpawnFollowUpResult | null> {
  const {
    agentRole, issueKey, issueId, issueTitle, issueState,
    userMessage, commentId, agentSessionId, project,
    discordChannelId, discordMessageId, fromAgent, issueDescription,
  } = opts;

  // Atomic spawn guard: prevents double-spawn from racing webhook + comment handlers.
  // Must be called synchronously (no await above) to be atomic in single-threaded Node.js.
  if (!claimSpawnSlot(issueKey)) {
    console.log(chalk.dim(`  Dedup: skipping duplicate follow-up spawn for ${agentRole} on ${issueKey}`));
    return null;
  }

  const persona = loadPersona(agentRole);
  const groundingPrompt = buildGroundingPrompt(persona, 'conversation');
  const workspacePath = resolveWorkspace(issueKey, project);
  const adapter = getAdapter(persona.config.baseModel || 'cc');

  // Download images if not already provided by the caller
  let processedMsg = userMessage;
  let imagePaths = opts.imagePaths ?? [];
  if (imagePaths.length === 0) {
    const result = await downloadCommentImages(userMessage, workspacePath);
    processedMsg = result.text;
    imagePaths = result.imagePaths;
    if (imagePaths.length > 0) {
      console.log(chalk.dim(`  Downloaded ${imagePaths.length} image(s) for follow-up on ${issueKey}`));
    }
  }

  const imageNote = imagePaths.length > 0
    ? `\n\nThe comment includes ${imagePaths.length} image(s). Use the Read tool to view them:\n${imagePaths.map(p => `- ${p}`).join('\n')}`
    : '';

  const statusNote = ['Done', 'In Review'].includes(issueState)
    ? ' — already completed, do NOT re-do the task'
    : '';

  const isFromDiscord = !!(discordChannelId && discordMessageId);
  const isAgentMention = !!fromAgent;

  // Agent-to-agent mentions get full issue context so the looped-in agent can participate
  // meaningfully in the discussion without needing to re-read the entire issue.
  const issueContextBlock = isAgentMention && issueDescription
    ? [
        ``,
        `## Issue Context (${issueKey}: ${issueTitle})`,
        `Status: ${issueState}`,
        ``,
        issueDescription,
        ``,
        `---`,
        ``,
      ].join('\n')
    : '';

  const followUpPrompt = isAgentMention
    ? [
        `You are ${agentRole}. @${fromAgent} has looped you into a discussion on ${issueKey} (${issueTitle}).`,
        ``,
        issueContextBlock,
        `## Message from @${fromAgent}:`,
        `> ${processedMsg}${imageNote}`,
        ``,
        `## Your Role in This Discussion`,
        `You've been brought in for your expertise. Read the issue context above, then contribute your perspective.`,
        ``,
        `Rules:`,
        `- Post your response as a Linear comment: \`linear-tool comment ${issueKey} "your response"\``,
        commentId ? `- Or reply in-thread: \`linear-tool reply ${issueKey} ${commentId} "your response"\`` : '',
        `- To bring another agent into the discussion, @mention them in your comment (e.g., @lead-engineer)`,
        `- Be substantive — share your expertise, flag risks, propose alternatives`,
        `- You may read codebase files if needed to give a thorough answer`,
        `- OVERRIDE your completion checklist — do NOT write memory files, create issues, or write HANDOFF.md`,
        `- Then stop and wait at the prompt — your session stays alive for follow-up discussion`,
      ].filter(Boolean).join('\n')
    : [
        `You are ${agentRole}. A user left a follow-up ${isFromDiscord ? 'message on Discord' : 'comment'} on ${issueKey} (${issueTitle}).`,
        `Status: ${issueState}${statusNote}`,
        ``,
        `Their ${isFromDiscord ? 'message' : 'comment'}:`,
        `> ${processedMsg}${imageNote}`,
        ``,
        `## IMPORTANT — This is a CONVERSATION, not a task`,
        `Your ONLY job is to **answer their question or respond to their comment** substantively.`,
        ``,
        `Rules:`,
        `- OVERRIDE your completion checklist — do NOT write memory files or create issues`,
        `- Do NOT write HANDOFF.md — this is a conversation, not a task completion`,
        `- Read any codebase files you need to give a thorough answer`,
        `- Post your answer as a Linear comment: \`linear-tool comment ${issueKey} "your answer"\``,
        commentId ? `- Or reply in-thread: \`linear-tool reply ${issueKey} ${commentId} "your answer"\`` : '',
        isFromDiscord ? `- ALSO reply in Discord: \`linear-tool discord-reply ${discordChannelId} ${discordMessageId} "your answer"\`` : '',
        `- Do NOT just write "Done" or "Task completed" — actually answer what they asked`,
        `- Do NOT re-do or re-execute the original task`,
        `- Then stop and wait at the prompt — your session stays alive for future messages`,
      ].filter(Boolean).join('\n');

  // Kill stale tmux sessions if they exist (RYA-300: check both naming conventions)
  const tmuxNameIdle = `aos-${agentRole}`;
  const tmuxNameIssue = `aos-${agentRole}-${issueKey}`;
  if (sessionExists(tmuxNameIdle)) {
    killSession(tmuxNameIdle);
  }
  if (sessionExists(tmuxNameIssue)) {
    killSession(tmuxNameIssue);
  }

  await adapter.spawn({
    issueKey,
    title: issueTitle,
    systemPrompt: groundingPrompt,
    initialPrompt: followUpPrompt,
    workspacePath,
    attemptNumber: 1,
    agentRole,
    isFollowUp: true,
  });

  // Session acknowledgment is handled by the caller (webhook.ts) via dismissAgentSession (RYA-286).
  // No need to emit a thought activity — the session is dismissed immediately with an ack message.

  // Record attempt for monitor tracking
  const attemptId = randomUUID();
  createAttempt({
    id: attemptId,
    issue_id: issueId,
    issue_key: issueKey,
    agent_type: agentRole,
    host: getConfig().imacHost,
    agent_session_id: agentSessionId,
    tmux_session: `aos-${agentRole}-${issueKey}`,
    workspace_path: workspacePath,
  });

  // Track follow-up metadata so the monitor can:
  // - Post as a threaded reply on Linear (when commentId is present)
  // - Reply in Discord (when Discord context is present)
  if (commentId || isFromDiscord) {
    followUpMeta.set(attemptId, {
      createdAt: Date.now(),
      commentId,
      discordChannelId,
      discordMessageId,
    });
  }

  console.log(chalk.green(`  ${agentRole} spawned for follow-up on ${issueKey}`));
  return { attemptId, workspacePath };
}
