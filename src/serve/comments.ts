/** Handle Comment webhook — route replies to the right agent. */

import chalk from 'chalk';
import { resolveWorkspace } from '../core/config.js';
import { getIssue, addComment } from '../core/linear.js';
import { getActiveAttempt, getIdleAttempt, getAttemptsByIssue, updateAttemptStatus, logEvent } from '../core/db.js';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';

import { handledSessions, activeFollowUpLock, FOLLOW_UP_LOCK_TTL_MS, checkAndRecordDedup } from './state.js';
import { getAgentUserIds, getAgentRoleByUserId, downloadCommentImages } from './helpers.js';
import { AGENT_ROLE_REGEX, normalizeAgentRole } from './classify.js';
import { spawnFollowUp } from './follow-up.js';
import { resolveSession } from './session-manager.js';

type RouteSource = 'mention' | 'parent-reply' | 'delegate' | 'assignee' | 'last-agent';

export async function handleCommentCreated(payload: {
  data?: {
    id?: string;
    body?: string;
    issueId?: string;
    issue?: { id: string; identifier: string; title: string };
    parentId?: string;
    userId?: string;
  };
}): Promise<void> {
  const data = payload.data;
  if (!data?.body || !data?.issueId) return;

  const commentBody = data.body;
  const commentTs = new Date().toLocaleTimeString();
  console.log(chalk.dim(`[${commentTs}] Comment payload: parentId=${data.parentId || 'none'}, userId=${data.userId || 'none'}, issue=${data.issue?.identifier || data.issueId}, body="${commentBody.substring(0, 80)}"`));

  // ─── Agent-to-agent @mention handling ───
  // Allow agent comments that @mention a DIFFERENT agent (inter-agent discussion).
  // Block agent comments that don't @mention anyone or @mention themselves (prevent loops).
  const agentIds = getAgentUserIds();
  const isFromAgent = !!(data.userId && agentIds.has(data.userId));
  if (isFromAgent) {
    const commenterAgentRole = getAgentRoleByUserId(data.userId);
    const mentionedRole = commentBody.match(AGENT_ROLE_REGEX)?.[1]
      ? normalizeAgentRole(commentBody.match(AGENT_ROLE_REGEX)![1].toLowerCase())
      : null;

    if (!mentionedRole || mentionedRole === commenterAgentRole) {
      // No @mention or self-mention — skip to prevent loops
      console.log(chalk.dim(`  Skipping agent comment from ${commenterAgentRole || data.userId} (no cross-agent @mention)`));
      return;
    }

    // Agent-to-agent @mention: allow through — will be routed to the mentioned agent
    console.log(chalk.cyan(`  Agent-to-agent: ${commenterAgentRole} → @${mentionedRole} on ${data.issue?.identifier || data.issueId}`));
  }

  // Skip "self:" prefix or @Zhiyuan Wang mentions — CEO note-to-self, no agent response
  if (/^\s*self:/i.test(commentBody) || /@Zhiyuan\s*Wang/i.test(commentBody)) {
    console.log(chalk.dim(`  Skipping self-addressed comment on ${data.issue?.identifier || data.issueId}`));
    return;
  }

  // ─── Route comment to the right agent ───
  // Priority: @mention > parent-reply > delegate > assignee > last-agent
  // Rule: delegate has OBLIGATION to respond to comments on their issue,
  //       UNLESS the comment @mentions a different agent.

  const mentionMatch = commentBody.match(AGENT_ROLE_REGEX);
  let targetRole = mentionMatch?.[1] ? normalizeAgentRole(mentionMatch[1].toLowerCase()) : null;
  let routeSource: RouteSource | null = targetRole ? 'mention' : null;

  // If no @mention but this is a reply to an agent's comment, route to that agent
  if (!targetRole && data.parentId) {
    console.log(chalk.dim(`  Resolving parent comment ${data.parentId} author...`));
    try {
      const { getCommentAuthor } = await import('../core/linear.js');
      const authorId = await getCommentAuthor(data.parentId);
      console.log(chalk.dim(`  Parent author: ${authorId || 'unknown'}`));
      if (authorId) {
        for (const role of listAgents()) {
          const config = loadAgentConfig(role);
          if (config.linearUserId === authorId) {
            targetRole = role;
            routeSource = 'parent-reply';
            console.log(chalk.cyan(`  Resolved parent reply → ${role}`));
            break;
          }
        }
        if (!targetRole) {
          console.log(chalk.dim(`  Parent author ${authorId} is not an agent`));
        }
      }
    } catch (err) {
      console.log(chalk.dim(`  Failed to resolve parent: ${(err as Error).message}`));
    }
  }

  // If still no target, fall back to issue delegate/assignee/last-agent
  if (!targetRole && (data.issue?.identifier || data.issueId)) {
    try {
      const issueInfo = await getIssue(data.issue?.identifier || data.issueId);
      // 1. Check delegate first — delegate has obligation to respond
      if (issueInfo.delegateId) {
        for (const role of listAgents()) {
          const config = loadAgentConfig(role);
          if (config.linearUserId === issueInfo.delegateId) {
            targetRole = role;
            routeSource = 'delegate';
            console.log(chalk.cyan(`  Delegate-routed comment → ${role} on ${issueInfo.identifier}`));
            break;
          }
        }
      }
      // 2. Fall back to assignee
      if (!targetRole && issueInfo.assigneeId) {
        for (const role of listAgents()) {
          const config = loadAgentConfig(role);
          if (config.linearUserId === issueInfo.assigneeId) {
            targetRole = role;
            routeSource = 'assignee';
            console.log(chalk.cyan(`  Assignee-routed comment → ${role} on ${issueInfo.identifier}`));
            break;
          }
        }
      }
      // 3. Fall back to last agent that worked on this issue
      if (!targetRole) {
        const attempts = getAttemptsByIssue(issueInfo.identifier);
        const lastAgent = attempts.find(a => a.agent_type && agentExists(a.agent_type));
        if (lastAgent?.agent_type) {
          targetRole = lastAgent.agent_type;
          routeSource = 'last-agent';
          console.log(chalk.cyan(`  Last-agent-routed comment → ${targetRole} on ${issueInfo.identifier}`));
        }
      }
    } catch (err) {
      console.log(chalk.yellow(`  Failed to resolve delegate/assignee for ${data.issue?.identifier || data.issueId}: ${(err as Error).message}`));
    }
  }

  if (!targetRole) {
    console.log(chalk.dim(`  No target agent for comment — skipping`));
    return;
  }

  // Defense-in-depth: prevent self-loops where agent's own comment routes back to itself.
  // For agent-to-agent @mentions (isFromAgent=true), we already validated the target is different
  // in the early check above — so only block if the resolved target matches the commenter.
  const commenterRole = getAgentRoleByUserId(data.userId);
  if (commenterRole && commenterRole === targetRole) {
    console.log(chalk.dim(`  Skipping self-loop: ${commenterRole} comment would route back to itself — defense-in-depth`));
    return;
  }

  // Resolve issue identifier
  let issueIdentifier = data.issue?.identifier;
  if (!issueIdentifier) {
    try {
      const issueInfo = await getIssue(data.issueId);
      issueIdentifier = issueInfo.identifier;
    } catch { return; }
  }

  // Dedup: same comment — in-memory entry lives until the 5-min GC sweep, so the
  // persistent window matches that effective retention (A1.3: survives restarts).
  const dedupKey = `comment:${data.id}`;
  if (checkAndRecordDedup(handledSessions, dedupKey, `wh:${dedupKey}`, 5 * 60_000)) return;

  const ts = new Date().toLocaleTimeString();
  console.log(chalk.cyan(`[${ts}] Comment → ${targetRole} on ${issueIdentifier}: "${commentBody.substring(0, 60)}"`));

  // Download any images in the comment so agents can view them
  const workDir = resolveWorkspace(issueIdentifier);
  const { text: processedComment, imagePaths } = await downloadCommentImages(commentBody, workDir);
  if (imagePaths.length > 0) {
    console.log(chalk.dim(`  Downloaded ${imagePaths.length} image(s) to ${workDir}/.comment-images/`));
  }

  // ─── Use resolveSession for unified session lifecycle ───
  // resolveSession handles: pipe → reactivate → resume → spawn → evict → queue
  const issueInfo = await getIssue(issueIdentifier).catch(() => null);

  const resolution = resolveSession({
    role: targetRole,
    issueKey: issueIdentifier,
    issueId: data.issueId || issueInfo?.id || '',
    prompt: processedComment,
    commentId: data.id,
  });

  if (resolution.action === 'piped' || resolution.action === 'reactivated' || resolution.action === 'resumed') {
    // Session handled — message delivered
    return;
  }

  if (resolution.action === 'rejected' || resolution.action === 'queued') {
    console.log(chalk.dim(`  Comment on ${issueIdentifier}: ${resolution.action}`));
    return;
  }

  // resolution.action === 'spawn' — need to spawn a follow-up
  // Defer to webhook handler if it's already handling this
  const lockTime = activeFollowUpLock.get(issueIdentifier);
  if (lockTime && Date.now() - lockTime < FOLLOW_UP_LOCK_TTL_MS) {
    console.log(chalk.dim(`  Deferring to webhook handler for ${issueIdentifier} follow-up`));
    return;
  }

  const threadRootId = data.parentId || data.id;

  try {
    // For agent-to-agent mentions, pass the commenter role and full issue description
    // so the looped-in agent has complete context on first entry.
    const fromAgentRole = isFromAgent ? getAgentRoleByUserId(data.userId) : undefined;

    const result = await spawnFollowUp({
      agentRole: targetRole,
      issueKey: issueIdentifier,
      issueId: data.issueId!,
      issueTitle: issueInfo?.title || '',
      issueState: issueInfo?.state || 'Todo',
      userMessage: processedComment,
      commentId: threadRootId,
      imagePaths,
      project: issueInfo?.project,
      fromAgent: fromAgentRole || undefined,
      issueDescription: isFromAgent ? (issueInfo?.description || undefined) : undefined,
    });

    // When delegate/assignee routing triggers a new follow-up (no @mention = no
    // Linear "Working" indicator), post an immediate acknowledgment so the user
    // has visible confirmation that the agent received the comment.
    if (result && routeSource && routeSource !== 'mention') {
      const agentToken = getAgentLinearToken(targetRole) || undefined;
      const issueId = data.issueId || issueInfo?.id;
      if (issueId) {
        addComment(issueId, `Received. ${targetRole} is working on your question.`, agentToken, threadRootId).catch(() => {});
      }
    }
  } catch (err) {
    console.log(chalk.red(`  Comment follow-up failed: ${(err as Error).message}`));
  }
}
