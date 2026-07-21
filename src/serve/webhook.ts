/** Webhook handler: processes Linear AgentSession events (created/prompted). */

import chalk from 'chalk';
import { getConfig, resolveWorkspace, resolveStatePath } from '../core/config.js';
import {
  emitActivity, getIssue,
  dismissAgentSession,
} from '../core/linear.js';
import { getActiveAttempts, getActiveAttempt, getIdleAttempt, getAttemptsByIssue, updateAttemptStatus, logEvent } from '../core/db.js';
import { readFileOnRemote, sessionExists, sendKeys } from '../core/tmux.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';
import { spawnCommand } from '../commands/spawn.js';
import { agentStartCommand } from '../commands/agent.js';

import { handledSessions, followUpMeta, activeFollowUpLock, DEDUP_WINDOW_MS, reactivatedAt, reactivationContext, checkAndRecordDedup, persistentDedupCheck, persistentDedupRecord } from './state.js';
import { resolveAgentForIssue, resolveAgentFromWebhook, hasExplicitRouting, getAgentUserIds, getAgentRoleByUserId, isAgentOrSystemComment, downloadCommentImages, wrapFollowUpMessage } from './helpers.js';
import { AGENT_ROLE_REGEX, normalizeAgentRole } from './classify.js';
import { spawnFollowUp } from './follow-up.js';
import { checkCircuitBreaker, tripCircuitBreaker } from './circuit-breaker.js';
import { resolveSession } from './session-manager.js';
import { isToDecidePrefix } from './dispatch.js';

export interface WebhookPayload {
  action: string;  // "created" | "prompted"
  type: string;
  agentSession?: {
    id: string;
    status: string;
    issue?: { id: string; identifier: string; title: string; description?: string; labels?: string[]; project?: string };
    comment?: { id: string; body: string };
  };
  agentActivity?: {
    body?: string;
    signal?: string;
  };
  promptContext?: string;
  guidance?: { body: string }[];
  organizationId?: string;
  webhookId?: string;
}

export async function handleWebhook(payload: WebhookPayload): Promise<void> {
  const { action, agentSession } = payload;

  if (!agentSession?.issue) {
    console.log(chalk.dim('  No issue in payload, skipping'));
    return;
  }

  const issue = agentSession.issue;
  const sessionId = agentSession.id;

  // Dedup check: ignore if we've handled this session recently.
  // A1.3: backed by the dedup_keys table so webhook replays after a serve
  // restart (auto-deploy) don't double-spawn.
  if (checkAndRecordDedup(handledSessions, sessionId, `wh:${sessionId}`, DEDUP_WINDOW_MS)) {
    console.log(chalk.dim(`  Dedup: ${issue.identifier} session ${sessionId.substring(0, 8)} (handled recently)`));
    return;
  }

  // Also rate-limit per issue: max 1 spawn per issue per 60s
  const issueKey = `issue:${issue.identifier}`;
  const lastIssueHandled = handledSessions.get(issueKey);
  if (action === 'created' && ((lastIssueHandled && Date.now() - lastIssueHandled < DEDUP_WINDOW_MS) || persistentDedupCheck(`wh:${issueKey}`, DEDUP_WINDOW_MS))) {
    const agoSec = lastIssueHandled ? `${Math.round((Date.now() - lastIssueHandled) / 1000)}s ago` : 'recently (persisted dedup)';
    console.log(chalk.dim(`  Rate limit: ${issue.identifier} spawned ${agoSec}`));
    // Dismiss the orphaned session so Linear doesn't show "Did not respond" or stuck "Working"
    // RYA-312: Use descriptive body
    if (sessionId) {
      dismissAgentSession(sessionId, undefined, `Rate limited — ${issue.identifier} already being processed.`).catch(() => {});
    }
    return;
  }
  if (action === 'created') {
    handledSessions.set(issueKey, Date.now());
    persistentDedupRecord(`wh:${issueKey}`);
  }

  // Clean old dedup entries regularly
  if (handledSessions.size > 50) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
    for (const [k, v] of handledSessions) {
      if (v < cutoff) handledSessions.delete(k);
    }
  }

  if (action === 'created') {
    // Guard: check issue status — if completed, treat as follow-up
    try {
      // Claim ownership BEFORE async call to prevent handleCommentCreated from racing
      activeFollowUpLock.set(issue.identifier, Date.now());

      const issueInfo = await getIssue(issue.identifier);

      if (!['In Review', 'Done'].includes(issueInfo.state)) {
        // Not a completed issue — release the follow-up lock
        activeFollowUpLock.delete(issue.identifier);
      }

      if (['In Review', 'Done'].includes(issueInfo.state)) {
        // Completed issue — this is a follow-up question, NOT a new task

        let userMsg = '';
        let commentId = '';

        // Strategy: use getLatestUserComment (filters out agent/system noise)
        // but validate against webhook comment to catch race conditions
        const webhookBody = agentSession.comment?.body || '';
        const webhookId = agentSession.comment?.id || '';

        // Guard: skip if the triggering comment is from one of our own agents (prevent self-loops)
        // This catches the case where agent X posts a comment → Linear creates AgentSession → webhook fires
        if (isAgentOrSystemComment(webhookBody)) {
          console.log(chalk.dim(`  Skipping follow-up: agent/system comment on ${issue.identifier}`));
          if (sessionId) {
            dismissAgentSession(sessionId, undefined, `Agent comment on ${issue.identifier} — no action needed.`).catch(() => {});
          }
          return;
        }

        const isWebhookReal = webhookBody && !isAgentOrSystemComment(webhookBody);

        try {
          const { getLatestUserComment } = await import('../core/linear.js');
          const latest = await getLatestUserComment(issue.id);
          if (latest) {
            userMsg = latest.body;
            commentId = latest.threadRootId;
          }
        } catch (err) {
          // Non-fatal: falls back to webhookBody below. Log for ops visibility.
          console.log(chalk.dim(`  getLatestUserComment failed on ${issue.identifier}: ${(err as Error).message} — using webhook body fallback`));
        }

        // If getLatestUserComment returned garbage but webhook has a real comment, prefer webhook
        if ((!userMsg || /^Done\.?$/i.test(userMsg)) && isWebhookReal) {
          userMsg = webhookBody;
          commentId = webhookId;
        }

        // Skip "self:" prefix or @Zhiyuan Wang — CEO note-to-self, no agent response
        if (/^\s*self:/i.test(userMsg) || /^\s*self:/i.test(webhookBody) || /@Zhiyuan\s*Wang/i.test(userMsg) || /@Zhiyuan\s*Wang/i.test(webhookBody)) {
          console.log(chalk.dim(`  Skipping self-addressed follow-up on ${issue.identifier}`));
          if (sessionId) {
            dismissAgentSession(sessionId, undefined, `Self-addressed note on ${issue.identifier} — no agent action.`).catch(() => {});
          }
          return;
        }

        // Skip system-generated or empty — but dismiss the webhook session to clear "Working"
        if (!userMsg || isAgentOrSystemComment(userMsg)) {
          console.log(chalk.dim(`  Skipping follow-up: system/noise comment on ${issue.identifier}`));
          if (sessionId) {
            const mentionMatch2 = webhookBody.match(AGENT_ROLE_REGEX);
            const dismissRole = mentionMatch2?.[1] ? normalizeAgentRole(mentionMatch2[1].toLowerCase()) : undefined;
            const dismissToken = dismissRole ? getAgentLinearToken(dismissRole) : null;
            dismissAgentSession(sessionId, dismissToken || undefined, `System comment on ${issue.identifier} — no action needed.`).catch(() => {});
          }
          return;
        }
        console.log(chalk.cyan(`  Follow-up on ${issueInfo.state} issue ${issue.identifier}: "${userMsg.substring(0, 80)}"`));
        const previousAttempts = getAttemptsByIssue(issue.identifier);
        const lastAgent = previousAttempts.find(a => a.status === 'completed' && a.agent_type && agentExists(a.agent_type));
        const mentionMatch = userMsg.match(AGENT_ROLE_REGEX);
        let agentRole: string | undefined = mentionMatch?.[1] ? normalizeAgentRole(mentionMatch[1].toLowerCase()) : undefined;

        // If no @mention, try delegate/assignee
        if (!agentRole && issueInfo.delegateId) {
          for (const role of listAgents()) {
            const cfg = loadAgentConfig(role);
            if (cfg.linearUserId === issueInfo.delegateId) {
              agentRole = role;
              console.log(chalk.cyan(`  Delegate-routed follow-up → ${role} on ${issue.identifier}`));
              break;
            }
          }
        }
        if (!agentRole && issueInfo.assigneeId) {
          for (const role of listAgents()) {
            const cfg = loadAgentConfig(role);
            if (cfg.linearUserId === issueInfo.assigneeId) {
              agentRole = role;
              console.log(chalk.cyan(`  Assignee-routed follow-up → ${role} on ${issue.identifier}`));
              break;
            }
          }
        }
        // Last resort: last agent that completed work on this issue
        if (!agentRole) agentRole = lastAgent?.agent_type;

        if (agentRole) {
          // Check if handleCommentCreated already spawned for this issue (race: it ran first)
          const existingAttempt = getActiveAttempt(issue.identifier);
          if (existingAttempt && !existingAttempt.agent_session_id) {
            console.log(chalk.cyan(`  Attaching session ${sessionId?.substring(0, 8)} to comment-spawned attempt for ${issue.identifier}`));
            if (sessionId) {
              const { updateAttemptAgentSession } = await import('../core/db.js');
              updateAttemptAgentSession(existingAttempt.id, sessionId);
            }
            if (commentId && !followUpMeta.has(existingAttempt.id)) {
              followUpMeta.set(existingAttempt.id, { commentId, createdAt: Date.now() });
            }
            return;
          }

          // Check for idle session — reactivate instead of spawning new
          // Only reactivate if the idle session belongs to the same agent role
          const idleAttempt = getIdleAttempt(issue.identifier);
          if (idleAttempt?.tmux_session && sessionExists(idleAttempt.tmux_session)
              && idleAttempt.agent_type === agentRole) {
            console.log(chalk.green(`  Reactivating idle session ${idleAttempt.tmux_session} for ${issue.identifier}`));
            try {
              sendKeys(idleAttempt.tmux_session, userMsg);
              updateAttemptStatus(idleAttempt.id, 'running');
              reactivatedAt.set(idleAttempt.id, Date.now()); // Fresh warmup grace period
              reactivationContext.set(idleAttempt.id, userMsg); // Preserve for rate-limit re-enqueue
              logEvent(idleAttempt.id, 'reactivated', { reason: 'follow_up_webhook', commentId });
              // Attach the new AgentSession ID if available
              if (sessionId) {
                const { updateAttemptAgentSession } = await import('../core/db.js');
                updateAttemptAgentSession(idleAttempt.id, sessionId);
                // Immediately acknowledge so Linear doesn't show "Did not respond" (RYA-286)
                const agentTok = getAgentLinearToken(agentRole!) || undefined;
                dismissAgentSession(sessionId, agentTok, `Follow-up received. ${agentRole} is processing it.`).catch(() => {});
              }
            } catch (err) {
              console.log(chalk.dim(`  Reactivation failed: ${(err as Error).message}`));
            }
            return;
          }

          console.log(chalk.cyan(`  Spawning ${agentRole} for follow-up (NOT re-executing task)`));
          try {
            await spawnFollowUp({
              agentRole,
              issueKey: issue.identifier,
              issueId: issue.id,
              issueTitle: issue.title,
              issueState: issueInfo.state,
              userMessage: userMsg,
              commentId,
              agentSessionId: sessionId,
              project: issueInfo.project,
            });
            // Immediately acknowledge so Linear doesn't show "Did not respond" (RYA-286)
            if (sessionId) {
              const agentTok = getAgentLinearToken(agentRole) || undefined;
              dismissAgentSession(sessionId, agentTok, `Follow-up received. ${agentRole} is working on it.`).catch(() => {});
            }
          } catch (err) {
            console.log(chalk.red(`  Follow-up spawn failed: ${(err as Error).message}`));
          }
        }
        return;
      }
    } catch {
      // RYA-300: Clean up lock on error — prevents 30s dead zone where
      // handleCommentCreated defers to us but we've already fallen through.
      activeFollowUpLock.delete(issue.identifier);
    }

    // [to decide] issues are explicit CEO-decision items — never start a task session.
    // The scheduler, dispatch, and Issue-create paths already refuse them (RYA-635,
    // RYA-1234); without the same guard here, an AgentSession created on a [to decide]
    // issue spawned its creator anyway (RYA-1237/RYA-1238, 2026-06-10). Follow-up
    // handling on completed issues (above) is intentionally not guarded.
    if (isToDecidePrefix(issue.title)) {
      console.log(chalk.yellow(`  AgentSession skip ([to decide]): ${issue.identifier} — awaits CEO decision`));
      if (sessionId) {
        dismissAgentSession(sessionId, undefined, `${issue.identifier} is a [to decide] item — awaiting CEO decision; no agent session started.`).catch(() => {});
      }
      return;
    }

    // ─── Resolve agent role (routing) ───
    const webhookAgent = resolveAgentFromWebhook(payload.webhookId);
    let fullIssueInfo: Awaited<ReturnType<typeof getIssue>> | null = null;
    try {
      fullIssueInfo = await getIssue(issue.identifier);
    } catch (err) {
      // Non-fatal: downstream routing uses empty labels/project defaults and still resolves a target agent.
      console.log(chalk.dim(`  getIssue failed on ${issue.identifier}: ${(err as Error).message} — falling back to label/webhook routing only`));
    }

    const issueLabels = fullIssueInfo?.labels ?? [];
    const issueProject = fullIssueInfo?.project;
    const labelAgent = resolveAgentForIssue({ identifier: issue.identifier, labels: issueLabels, title: issue.title, project: issueProject });

    let targetAgent = webhookAgent || labelAgent;
    const isDefaultFallback = !webhookAgent && !hasExplicitRouting({ labels: issueLabels, project: issueProject });

    // Check delegate/assignee/description for routing signal
    let delegateFound = false;
    if (isDefaultFallback && fullIssueInfo?.delegateId) {
      for (const role of listAgents()) {
        const cfg = loadAgentConfig(role);
        if (cfg.linearUserId === fullIssueInfo.delegateId) { targetAgent = role; delegateFound = true; break; }
      }
    }
    if (isDefaultFallback && !delegateFound && fullIssueInfo?.assigneeId) {
      for (const role of listAgents()) {
        const cfg = loadAgentConfig(role);
        if (cfg.linearUserId === fullIssueInfo.assigneeId) { targetAgent = role; delegateFound = true; break; }
      }
    }
    if (isDefaultFallback && !delegateFound && fullIssueInfo?.description) {
      const descMention = fullIssueInfo.description.match(AGENT_ROLE_REGEX);
      if (descMention) {
        const mentioned = normalizeAgentRole(descMention[1]);
        if (agentExists(mentioned)) { targetAgent = mentioned; delegateFound = true; }
      }
    }

    // ─── Use resolveSession for the unified session lifecycle ───
    // Build the prompt from webhook comment or default system nudge
    let spawnPrompt = agentSession.comment?.body || '';
    if (!spawnPrompt || isAgentOrSystemComment(spawnPrompt)) {
      spawnPrompt = `[SYSTEM] New activity on ${issue.identifier}: ${issue.title}`;
    }

    const resolution = resolveSession({
      role: targetAgent,
      issueKey: issue.identifier,
      issueId: issue.id,
      prompt: spawnPrompt,
      webhookSessionId: sessionId,
      commentId: agentSession.comment?.id,
    });

    // Handle resolution result
    if (resolution.action === 'piped' || resolution.action === 'reactivated' || resolution.action === 'resumed') {
      // Immediately acknowledge so Linear doesn't show "Did not respond" (RYA-286).
      // resolveSession already attached the new sessionId to the attempt.
      // Results are posted as comments when the agent finishes.
      // RYA-312: Use descriptive body instead of '–' → 'Session complete.'
      if (sessionId) {
        const agentTok = getAgentLinearToken(targetAgent) || undefined;
        dismissAgentSession(sessionId, agentTok, `${targetAgent} ${resolution.action}. Working in background — results posted as comments.`).catch(() => {});
      }
      return;
    }

    if (resolution.action === 'rejected') {
      // Circuit breaker or other rejection
      if (sessionId) {
        const agentTok = getAgentLinearToken(targetAgent) || undefined;
        dismissAgentSession(sessionId, agentTok, resolution.reason).catch(() => {});
      }
      try {
        const cbIssue = fullIssueInfo || await getIssue(issue.identifier);
        await tripCircuitBreaker(issue.identifier, cbIssue.id, targetAgent, 0);
      } catch (err) {
        console.log(chalk.dim(`[webhook] Failed to trip circuit breaker for ${issue.identifier}/${targetAgent}: ${(err as Error).message}`));
      }
      return;
    }

    if (resolution.action === 'queued') {
      if (sessionId) {
        const agentTok = getAgentLinearToken(targetAgent) || undefined;
        dismissAgentSession(sessionId, agentTok, `${targetAgent} at capacity — issue queued.`).catch(() => {});
      }
      return;
    }

    // resolution.action === 'spawn' — need to actually start the agent
    if (isDefaultFallback && !delegateFound) {
      console.log(chalk.dim(`  Skipping ${issue.identifier}: no routing signal. Use @agent-role or /dispatch.`));
      if (sessionId) {
        dismissAgentSession(sessionId, undefined, `No routing signal for ${issue.identifier}.`).catch(() => {});
      }
      return;
    }

    console.log(chalk.cyan(`  Spawning: ${issue.identifier} → ${targetAgent}`));
    // RYA-302: Removed routing thought — startup confirmation is now a plain comment from agentStartCommand

    try {
      let result: string | undefined;
      if (agentExists(targetAgent)) {
        result = await agentStartCommand(targetAgent, issue.identifier, {
          webhookSessionId: sessionId,
          useContinue: resolution.useContinue,
          skipCapacityCheck: true,  // session-manager already checked
        });
      } else {
        await spawnCommand(issue.identifier, { agentSessionId: sessionId });
      }

      // Always dismiss session immediately (RYA-286: prevents "Did not respond" timeout).
      // RYA-302: Startup confirmation is now a plain comment from agentStartCommand, not a session activity.
      // RYA-312: Use descriptive body instead of '–' → 'Session complete.' which confuses the timeline.
      if (sessionId) {
        const agentTok = getAgentLinearToken(targetAgent) || undefined;
        dismissAgentSession(sessionId, agentTok, `${targetAgent} connected. Working in background — results posted as comments.`).catch(() => {});
      }
    } catch (err) {
      console.log(chalk.red(`  Spawn failed: ${(err as Error).message}`));
      if (sessionId) { dismissAgentSession(sessionId, undefined, `Spawn failed: ${(err as Error).message}`).catch(() => {}); }
    }

  } else if (action === 'prompted') {
    // Follow-up message or signal from user
    const activity = payload.agentActivity;

    if (activity?.signal === 'stop') {
      console.log(chalk.yellow(`  Stop signal for ${issue.identifier}`));
      // Dismiss session immediately so Linear doesn't show "Did not respond" (RYA-320)
      if (sessionId) {
        dismissAgentSession(sessionId, undefined, `Agent stopped on ${issue.identifier}.`).catch(() => {});
      }
      const { killCommand } = await import('../commands/kill.js');
      await killCommand(issue.identifier, {});
      return;
    }

    if (activity?.body) {
      const userMsg = activity.body;

      // Skip "self:" prefix or @Zhiyuan Wang — CEO note-to-self, no agent response
      if (/^\s*self:/i.test(userMsg) || /@Zhiyuan\s*Wang/i.test(userMsg)) {
        console.log(chalk.dim(`  Skipping self-addressed prompted message on ${issue.identifier}`));
        if (sessionId) {
          dismissAgentSession(sessionId, undefined, `Self-addressed note on ${issue.identifier} — no agent action.`).catch(() => {});
        }
        return;
      }

      console.log(chalk.blue(`  Follow-up for ${issue.identifier}: ${userMsg.substring(0, 80)}`));

      // Immediately acknowledge so Linear doesn't show "Did not respond" (RYA-286)
      if (sessionId) {
        dismissAgentSession(sessionId, undefined, `Message received. Processing follow-up on ${issue.identifier}.`).catch(() => {});
      }

      // Download any images in the user's message so agents can view them
      const promptedWorkDir = resolveWorkspace(issue.identifier);
      const { text: processedUserMsg, imagePaths: promptedImgPaths } = await downloadCommentImages(userMsg, promptedWorkDir);
      if (promptedImgPaths.length > 0) {
        console.log(chalk.dim(`  Downloaded ${promptedImgPaths.length} image(s) for prompted follow-up on ${issue.identifier}`));
      }
      const promptedImageHint = promptedImgPaths.length > 0
        ? `\n(${promptedImgPaths.length} image(s) attached — use Read tool to view: ${promptedImgPaths.join(', ')})`
        : '';

      // Check if there's a running CC session we can pipe into
      const active = getActiveAttempts().find(a => a.issue_key === issue.identifier);
      if (active?.tmux_session && sessionExists(active.tmux_session)) {
        // Session still running — pipe the message into tmux
        // RYA-331: Wrap with follow-up instructions so agent posts a visible Linear comment
        console.log(chalk.dim(`  Piping into running session ${active.tmux_session}`));
        try {
          const wrappedMsg = wrapFollowUpMessage(issue.identifier, processedUserMsg + promptedImageHint);
          sendKeys(active.tmux_session, wrappedMsg);
          // Track follow-up meta so monitor can post as comment (fallback)
          followUpMeta.set(active.id, { createdAt: Date.now() });
        } catch (err) {
          console.log(chalk.red(`  Failed to pipe: ${(err as Error).message}`));
        }
      } else {
        // No running session — restart the original agent with persona grounding
        console.log(chalk.dim(`  No active session, restarting agent for follow-up`));

        // Find which agent previously worked on this issue
        const previousAttempts = getAttemptsByIssue(issue.identifier);
        const lastAgent = previousAttempts.find(a => a.agent_type && agentExists(a.agent_type));
        const agentRole = lastAgent?.agent_type;

        if (agentRole) {
          // Restart with full persona (CLAUDE.md + memories + identity)
          console.log(chalk.dim(`  Restarting ${agentRole} on ${issue.identifier} for follow-up`));
          try {
            await agentStartCommand(agentRole, issue.identifier);

            // Wait briefly for CC to boot, then pipe the follow-up message
            // Poll for session readiness instead of fixed 10s delay (RYA-300)
            // agentStartCommand creates tmux as "aos-{role}-{issueKey}", not "aos-{role}"
            const tmuxName = `aos-${agentRole}-${issue.identifier}`;
            // RYA-331: Wrap with follow-up instructions so agent posts a visible Linear comment
            const wrappedFollowUp = wrapFollowUpMessage(issue.identifier, processedUserMsg + promptedImageHint);
            const pollForSession = async () => {
              for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 2000));
                if (sessionExists(tmuxName)) {
                  try {
                    sendKeys(tmuxName, wrappedFollowUp);
                    console.log(chalk.dim(`  Piped follow-up into ${tmuxName}`));
                    // Track follow-up meta for any active attempt on this issue
                    const attemptForMeta = getActiveAttempts().find(a => a.tmux_session === tmuxName);
                    if (attemptForMeta) {
                      followUpMeta.set(attemptForMeta.id, { createdAt: Date.now() });
                    }
                    return;
                  } catch (err) {
                    console.log(chalk.red(`  Failed to pipe follow-up: ${(err as Error).message}`));
                  }
                }
              }
              console.log(chalk.red(`  Follow-up: tmux session ${tmuxName} not found after 30s boot wait`));
            };
            pollForSession().catch(() => {});
          } catch (err) {
            console.log(chalk.red(`  Agent restart failed: ${(err as Error).message}`));
            if (sessionId) {
              await emitActivity(sessionId, {
                type: 'error',
                body: `Failed to restart ${agentRole}: ${(err as Error).message}`,
              });
            }
          }
        } else {
          // Fallback: no previous agent found, use generic spawn
          console.log(chalk.dim(`  No previous agent found, spawning generic session`));
          const config = getConfig();
          const prevHandoff = readFileOnRemote(resolveStatePath(issue.identifier, `${config.workspaceBase}/${issue.identifier}`, 'HANDOFF.md'));
          const contextPrefix = prevHandoff
            ? `Previous work summary:\n${prevHandoff}\n\n---\nNew request from user: `
            : 'User request: ';
          try {
            const imgNote = promptedImgPaths.length > 0
              ? `\n\nThe message includes ${promptedImgPaths.length} image(s). Use the Read tool to view them:\n${promptedImgPaths.map(p => `- ${p}`).join('\n')}`
              : '';
            await spawnCommand(issue.identifier, {
              agentSessionId: sessionId,
              followUpPrompt: `${contextPrefix}${processedUserMsg}${imgNote}`,
            });
          } catch (err) {
            console.log(chalk.red(`  Spawn failed: ${(err as Error).message}`));
            if (sessionId) {
              await emitActivity(sessionId, {
                type: 'error',
                body: `Failed to process follow-up: ${(err as Error).message}`,
              });
            }
          }
        }
      }
    }
  }
}
