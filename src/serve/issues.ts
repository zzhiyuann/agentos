/** Handle Issue webhook events — auto-route issues created by agents, auto-strip [to decide] on status change. */

import chalk from 'chalk';
import { getIssue, getAgentClient, getReadClient } from '../core/linear.js';
import { agentExists, loadAgentConfig } from '../core/persona.js';
import { spawnCommand } from '../commands/spawn.js';
import { agentStartCommand } from '../commands/agent.js';
import { planAndDispatch } from './planner.js';

import { handledSessions, DEDUP_WINDOW_MS } from './state.js';
import { getAgentUserIds, getAgentRoleByUserId } from './helpers.js';

// --- Issue Update Handler (status changes) ---

export async function handleIssueUpdated(payload: {
  action: string;
  data?: {
    id?: string;
    identifier?: string;
    title?: string;
    stateId?: string;
  };
  updatedFrom?: {
    stateId?: string;
    [key: string]: unknown;
  };
}): Promise<void> {
  const data = payload.data;
  if (!data?.id || !data?.identifier) return;

  // Only care about status changes (stateId changed)
  if (!payload.updatedFrom?.stateId) return;

  // Only care about [to decide] issues
  const title = data.title || '';
  if (!/^\[to decide\]/i.test(title)) return;

  // Fetch the issue to check the new state name
  try {
    const issueInfo = await getIssue(data.identifier);
    if (issueInfo.state !== 'Todo') return;

    // Strip [to decide] from title
    const newTitle = title.replace(/^\[to decide\]\s*/i, '').trim();
    if (!newTitle) return; // safety: don't set empty title

    const client = getReadClient();
    await client.updateIssue(data.id, { title: newTitle });
    console.log(chalk.green(`  Auto-stripped [to decide] from ${data.identifier}: "${newTitle}"`));
  } catch (err) {
    console.log(chalk.red(`  Failed to strip [to decide] from ${data.identifier}: ${(err as Error).message}`));
  }
}

export async function handleIssueCreated(payload: {
  action: string;
  data?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string;
    creatorId?: string;
    labelIds?: string[];
  };
}): Promise<void> {
  const data = payload.data;
  if (!data?.identifier || !data?.id) {
    console.log(chalk.dim('  Issue event: no identifier/id, skipping'));
    return;
  }

  // Dedup: don't process the same issue twice
  const dedupKey = `issue-created:${data.identifier}`;
  const lastHandled = handledSessions.get(dedupKey);
  if (lastHandled && Date.now() - lastHandled < DEDUP_WINDOW_MS) {
    console.log(chalk.dim(`  Dedup: issue ${data.identifier} already handled`));
    return;
  }

  // Route both human-created and agent-created issues
  const agentIds = getAgentUserIds();
  const isAgentCreated = data.creatorId ? agentIds.has(data.creatorId) : false;

  handledSessions.set(dedupKey, Date.now());
  console.log(chalk.cyan(`  Issue: ${data.identifier} — ${data.title} (${isAgentCreated ? 'agent' : 'human'}-created)`));

  // Resolve label names from IDs
  let labelNames: string[] = [];
  if (data.labelIds?.length) {
    try {
      const client = getReadClient();
      const allLabels = await client.issueLabels({
        filter: { id: { in: data.labelIds } },
      });
      labelNames = allLabels.nodes.map(l => l.name);
    } catch { /* fallback: no label routing */ }
  }

  // Check for "Plan" label — auto-decompose into sub-issues
  if (labelNames.some(l => l.toLowerCase() === 'plan')) {
    console.log(chalk.cyan(`  Planning trigger: ${data.identifier} has "Plan" label`));
    handledSessions.set(dedupKey, Date.now());

    // Run planning asynchronously
    planAndDispatch(data.identifier).then(result => {
      console.log(chalk.green(`  Planning complete for ${data.identifier}: ${result.createdIssues.length} sub-issues created`));
    }).catch(err => {
      console.log(chalk.red(`  Planning failed for ${data.identifier}: ${(err as Error).message}`));
    });
    return;
  }

  // Check for agent-role labels like "agent:cto", "agent:lead-engineer"
  let targetAgent: string | null = null;
  for (const label of labelNames) {
    const match = label.match(/^agent:(.+)$/);
    if (match) {
      const candidate = match[1];
      if (agentExists(candidate)) {
        targetAgent = candidate;
        break;
      }
    }
  }

  if (!targetAgent) {
    targetAgent = getAgentRoleByUserId(data.creatorId);
    if (targetAgent) {
      console.log(chalk.cyan(`  Agent-created issue ${data.identifier}: defaulting to creator role ${targetAgent}`));
    } else {
      console.log(chalk.dim(`  Issue ${data.identifier}: no agent label — logged, not spawned`));
      return;
    }
  }

  console.log(chalk.cyan(`  Auto-routing ${data.identifier} → ${targetAgent}`));

  // Auto-assign + delegate the issue to the target agent in Linear
  const agentConfig = loadAgentConfig(targetAgent);
  if (agentConfig.linearUserId && data.id) {
    try {
      const agentClient = getAgentClient();
      await agentClient.updateIssue(data.id, {
        assigneeId: agentConfig.linearUserId,
        delegateId: agentConfig.linearUserId,
      });
      console.log(chalk.dim(`  Assigned+delegated ${data.identifier} to ${targetAgent}`));
    } catch { /* best effort */ }
  }

  try {
    if (agentExists(targetAgent)) {
      await agentStartCommand(targetAgent, data.identifier);
    } else {
      await spawnCommand(data.identifier, {});
    }
  } catch (err) {
    console.log(chalk.red(`  Auto-route spawn failed: ${(err as Error).message}`));
  }
}
