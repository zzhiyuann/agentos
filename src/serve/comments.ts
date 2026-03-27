/** Handle Comment webhook — route replies to the right agent. */

import chalk from 'chalk';
import { resolveWorkspace } from '../core/config.js';
import { getIssue } from '../core/linear.js';
import { getActiveAttempt, getIdleAttempt, getAttemptsByIssue, updateAttemptStatus, logEvent } from '../core/db.js';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { agentExists, loadAgentConfig, listAgents } from '../core/persona.js';

import { handledSessions, activeFollowUpLock, FOLLOW_UP_LOCK_TTL_MS } from './state.js';
import { getAgentUserIds, getAgentRoleByUserId, downloadCommentImages } from './helpers.js';
import { AGENT_ROLE_REGEX, normalizeAgentRole } from './classify.js';
import { spawnFollowUp } from './follow-up.js';
import { resolveSession } from './session-manager.js';

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

  // Skip comments from our own agents (prevent loops)
  const agentIds = getAgentUserIds();
  if (data.userId && agentIds.has(data.userId)) {
    console.log(chalk.dim(`  Skipping agent comment from ${data.userId}`));
    return;
  }

  // Skip "self:" prefix — admin note-to-self, no agent response
  if (/^\s*self:/i.test(commentBody)) {
    console.log(chalk.dim(`  Skipping self-addressed comment on ${data.issue?.identifier || data.issueId}`));
    return;
  }

  // Determine the target agent from @mention in the comment
  const mentionMatch = commentBody.match(AGENT_ROLE_REGEX);
  let targetRole = mentionMatch?.[1] ? normalizeAgentRole(mentionMatch[1].toLowerCase()) : null;

  // If no @mention but this is a reply to an agent's comment, route to that agent
  if (!targetRole && data.parentId) {
    console.log(chalk.dim(`  Resolving parent comment ${data.parentId} author...`));
    try {
      const { getCommentAuthor } = await import('../core/linear.js');
      const authorId = await getCommentAuthor(data.parentId);
      console.log(chalk.dim(`  Parent author: ${authorId || 'unknown'}`));
      if (authorId) {
        // Map Linear user ID back to agent role
        for (const role of listAgents()) {
          const config = loadAgentConfig(role);
          if (config.linearUserId === authorId) {
            targetRole = role;
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

  // If still no target, fall back to issue delegate/assignee
  if (!targetRole && (data.issue?.identifier || data.issueId)) {
    try {
      // Use identifier if available, otherwise issueId
      const issueInfo = await getIssue(data.issue?.identifier || data.issueId);
      // 1. Check delegate first (Linear agent delegation)
      if (issueInfo.delegateId) {
        for (const role of listAgents()) {
          const config = loadAgentConfig(role);
          if (config.linearUserId === issueInfo.delegateId) {
            targetRole = role;
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
          console.log(chalk.cyan(`  Last-agent-routed comment → ${targetRole} on ${issueInfo.identifier}`));
        }
      }
    } catch { /* skip */ }
  }

  if (!targetRole) {
    console.log(chalk.dim(`  No target agent for comment — skipping`));
    return;
  }

  // Defense-in-depth: prevent self-loops where agent's own comment routes back to itself
  // This catches cases where the primary userId check (above) fails for any reason
  const commenterRole = getAgentRoleByUserId(data.userId);
  if (commenterRole) {
    console.log(chalk.dim(`  Skipping agent comment from ${commenterRole} (${data.userId}) — defense-in-depth`));
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

  // Dedup: same comment in last 60s
  const dedupKey = `comment:${data.id}`;
  if (handledSessions.get(dedupKey)) return;
  handledSessions.set(dedupKey, Date.now());

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
    await spawnFollowUp({
      agentRole: targetRole,
      issueKey: issueIdentifier,
      issueId: data.issueId!,
      issueTitle: issueInfo?.title || '',
      issueState: issueInfo?.state || 'Todo',
      userMessage: processedComment,
      commentId: threadRootId,
      imagePaths,
      project: issueInfo?.project,
    });
  } catch (err) {
    console.log(chalk.red(`  Comment follow-up failed: ${(err as Error).message}`));
  }
}
