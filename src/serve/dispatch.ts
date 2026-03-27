/** Dispatch handler: agent-to-agent direct dispatch and handoff. */

import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { getConfig } from '../core/config.js';
import {
  getIssue, addComment, emitActivity,
  dismissAgentSession, getAgentClient,
} from '../core/linear.js';
import { getActiveAttempt, updateAttemptStatus, logEvent } from '../core/db.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';
import { canSpawnAgent } from '../core/router.js';
import { enqueue } from '../core/queue.js';
import { agentStartCommand } from '../commands/agent.js';

import { dispatchDedup } from './state.js';
import { postToGroupChat, isPermanentIssueError } from './helpers.js';
import { checkCircuitBreaker } from './circuit-breaker.js';

export interface DispatchRequest {
  role: string;
  issueKey: string;
  message?: string;
  handoff?: boolean;
  from?: string;
}

export interface DispatchResponse {
  ok: boolean;
  action: 'started' | 'queued' | 'piped' | 'error';
  detail?: string;
}

export async function handleDispatch(req: DispatchRequest): Promise<DispatchResponse> {
  const { role, issueKey, message, handoff, from } = req;

  // Validate
  if (!role || !issueKey) {
    return { ok: false, action: 'error', detail: 'Missing role or issueKey' };
  }
  if (!agentExists(role)) {
    return { ok: false, action: 'error', detail: `Agent "${role}" not found. Available: ${listAgents().join(', ')}` };
  }
  if (!/^[A-Z]+-\d+$/.test(issueKey)) {
    return { ok: false, action: 'error', detail: `Invalid issue key format: ${issueKey}` };
  }

  // Dedup: same role+issue in last 60s
  const dedupKey = `${role}:${issueKey}`;
  const lastDispatched = dispatchDedup.get(dedupKey);
  if (lastDispatched && Date.now() - lastDispatched < 60_000) {
    return { ok: false, action: 'error', detail: `Already dispatched ${role} on ${issueKey} ${Math.round((Date.now() - lastDispatched) / 1000)}s ago` };
  }
  dispatchDedup.set(dedupKey, Date.now());

  // Clean old dedup entries
  if (dispatchDedup.size > 100) {
    const cutoff = Date.now() - 300_000;
    for (const [k, v] of dispatchDedup) {
      if (v < cutoff) dispatchDedup.delete(k);
    }
  }

  const ts = new Date().toLocaleTimeString();

  // If handoff: mark current attempt as completed
  if (handoff) {
    const currentAttempt = getActiveAttempt(issueKey);
    if (currentAttempt) {
      console.log(chalk.dim(`[${ts}] Handoff: ${currentAttempt.agent_type} → ${role} on ${issueKey}`));
      updateAttemptStatus(currentAttempt.id, 'completed', `Handed off to ${role}`);
      logEvent(currentAttempt.id, 'handoff', { to: role, message });

      // Dismiss Linear session if exists
      if (currentAttempt.agent_session_id) {
        const agentTok = getAgentLinearToken(currentAttempt.agent_type) || undefined;
        try {
          // A 'response' activity is terminal — it closes the session in Linear.
          // No separate dismissAgentSession needed (that would create duplicate noise).
          await emitActivity(currentAttempt.agent_session_id, {
            type: 'response',
            body: `Handing off to ${role}: ${message || 'continuation'}`,
          }, false, agentTok);
        } catch { /* best effort */ }
      }
    }
  }

  // Circuit breaker: check if this issue has exceeded its retry limit
  const cb = checkCircuitBreaker(issueKey, role);
  if (!cb.allowed) {
    return { ok: false, action: 'error', detail: `Circuit breaker: ${cb.reason}` };
  }

  // Check capacity
  const agentConfig = loadAgentConfig(role);
  const modelType = agentConfig.baseModel || 'cc';
  const { allowed, reason } = canSpawnAgent(modelType);

  if (!allowed) {
    // Enqueue
    console.log(chalk.yellow(`[${ts}] Dispatch queued: ${issueKey} → ${role} (${reason})`));
    enqueue({
      id: randomUUID(),
      issue_id: '', // Will be resolved when dequeued
      issue_key: issueKey,
      agent_role: role,
      follow_up_prompt: message,
    });
    return { ok: true, action: 'queued', detail: reason };
  }

  // Start the agent
  console.log(chalk.cyan(`[${ts}] Dispatch: ${issueKey} → ${role}`));
  try {
    await agentStartCommand(role, issueKey);

    // Post dispatch action as a visible comment for audit trail
    try {
      const dispatchIssue = await getIssue(issueKey);
      const fromLabel = from || 'system';
      const action = handoff ? 'Handoff' : 'Dispatch';
      const ctx = message ? `: ${message}` : '';
      const commentBody = `**${action}**: @${fromLabel} → @${role}${ctx}`;

      // Post comment using dispatching agent's token if available, otherwise AgentOS
      const fromToken = from ? getAgentLinearToken(from) : null;
      await addComment(dispatchIssue.id, commentBody, fromToken || undefined);

      // Update Linear assignee + delegate
      if (agentConfig.linearUserId) {
        const agentClient = getAgentClient();
        await agentClient.updateIssue(dispatchIssue.id, {
          assigneeId: agentConfig.linearUserId,
          delegateId: agentConfig.linearUserId,
        });
        console.log(chalk.dim(`  Set assignee+delegate on ${issueKey} → ${role}`));
      }

      await postToGroupChat(role, `Starting work on "${dispatchIssue.title}". Will update when done.`);
    } catch {
      await postToGroupChat(role, `Starting work on ${issueKey}.`).catch(() => {/**/});
    }
    return { ok: true, action: 'started', detail: `${role} started on ${issueKey}` };
  } catch (err) {
    // Permanent errors (issue deleted/not found): fail immediately, no retry
    if (isPermanentIssueError(err)) {
      console.log(chalk.red(`[${ts}] Dispatch failed (permanent): ${(err as Error).message}`));
      return { ok: false, action: 'error', detail: (err as Error).message };
    }

    // Transient errors: auto-retry with backoff (max 2 retries)
    const retryKey = `retry:${role}:${issueKey}`;
    const retryCount = (dispatchDedup.get(retryKey) || 0);
    if (retryCount < 2) {
      dispatchDedup.set(retryKey, retryCount + 1);
      const backoffMs = 15_000 * Math.pow(2, retryCount); // 15s, 30s
      console.log(chalk.yellow(`[${ts}] Dispatch failed, retry ${retryCount + 1}/2 in ${backoffMs / 1000}s: ${(err as Error).message}`));
      enqueue({
        id: randomUUID(),
        issue_id: '',
        issue_key: issueKey,
        agent_role: role,
        follow_up_prompt: message,
        delay_until: new Date(Date.now() + backoffMs).toISOString(),
      });
      return { ok: true, action: 'queued', detail: `Retry ${retryCount + 1}/2 in ${backoffMs / 1000}s (${(err as Error).message})` };
    }
    console.log(chalk.red(`[${ts}] Dispatch failed after retries: ${(err as Error).message}`));
    return { ok: false, action: 'error', detail: (err as Error).message };
  }
}
