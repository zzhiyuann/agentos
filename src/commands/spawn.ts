import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { getConfig, resolveWorkspace } from '../core/config.js';
import {
  getIssue, addComment, updateIssueState,
  hasAgentAccess, createAgentSession, emitActivity,
  updateAgentPlan, addExternalLink, getAgentClient,
} from '../core/linear.js';
import { createAttempt, getActiveAttempt, updateAttemptStatus, logEvent } from '../core/db.js';
import { resolveAgentRole, resolveAgentType, getAgentDefinition, canSpawnAgent } from '../core/router.js';
import { getAdapter } from '../adapters/index.js';
import { agentExists, loadAgentConfig } from '../core/persona.js';
import { agentStartCommand } from './agent.js';
import { WORKFLOW_STATES } from '../types.js';

function buildSystemPrompt(issue: {
  identifier: string; title: string; description?: string;
  priority: number; labels: string[]; url: string;
}): string {
  return `You are working on Linear issue ${issue.identifier}: ${issue.title}
Priority: ${issue.priority} | Labels: ${issue.labels.join(', ')}
Linear URL: ${issue.url}

${issue.description || 'No description provided.'}

---
Instructions:
- Read CLAUDE.md in this directory for the full task specification.
- Work autonomously to complete the task.
- Write PROGRESS.md with status updates as you work.
- When done, write HANDOFF.md with: summary, files changed, testing notes, known issues.
- If blocked, write BLOCKED.md explaining what you need.`;
}

export async function spawnCommand(issueKeyOrId: string, options: { agent?: string; agentSessionId?: string; followUpPrompt?: string }): Promise<void> {
  const config = getConfig();

  // 1. Check for existing active attempt
  const issueKey = issueKeyOrId.toUpperCase();
  const existing = getActiveAttempt(issueKey);
  if (existing) {
    if (options.agentSessionId) {
      // Webhook-triggered: new Linear session created, close old attempt
      console.log(chalk.dim(`Closing previous attempt for ${issueKey}`));
      updateAttemptStatus(existing.id, 'completed', 'Superseded by new session');
    } else {
      // CLI-triggered: don't overwrite active session
      console.log(chalk.yellow(`Attempt already active for ${issueKey}: ${existing.tmux_session}`));
      console.log(`  Use: ${chalk.bold(`aos jump ${issueKey}`)}`);
      return;
    }
  }

  // 2. Fetch issue from Linear
  console.log(chalk.dim(`Fetching issue ${issueKeyOrId}...`));
  const issue = await getIssue(issueKeyOrId);
  console.log(chalk.bold(`${issue.identifier}: ${issue.title}`));

  // 3. Resolve agent role + type and check capacity
  const agentRole = resolveAgentRole(issue);
  const agentType = options.agent || (agentExists(agentRole) ? loadAgentConfig(agentRole).baseModel : resolveAgentType(issue));
  const { allowed, reason } = canSpawnAgent(agentType);
  if (!allowed) {
    console.log(chalk.red(`Cannot spawn: ${reason}`));
    return;
  }

  // If we have a persona for this role, use agent start (loads persona + memory)
  if (agentExists(agentRole) && !options.agent) {
    console.log(chalk.dim(`Routing to ${agentRole} [${agentType}] via persona system`));
    await agentStartCommand(agentRole, issue.identifier);
    return;
  }

  // 4. Set up workspace (resolve from project mapping if available)
  const workspacePath = resolveWorkspace(issue.identifier, issue.project);
  const systemPrompt = buildSystemPrompt(issue);
  const attemptId = randomUUID();

  // 5. Skip AgentSession — use comments instead (no "Did not respond" issues)
  const agentSessionId: string | null = options.agentSessionId ?? null;

  // 6. Spawn via adapter
  console.log(chalk.dim(`Spawning ${agentType} agent...`));
  const adapter = getAdapter(agentType);
  const result = await adapter.spawn({
    issueKey: issue.identifier,
    title: issue.title,
    description: issue.description,
    systemPrompt,
    initialPrompt: options.followUpPrompt || 'Read CLAUDE.md for your task assignment. Begin implementation.',
    workspacePath,
    attemptNumber: 1,
  });

  // 7. Record attempt
  createAttempt({
    id: attemptId,
    issue_id: issue.id,
    issue_key: issue.identifier,
    agent_type: agentType,
    host: config.execHost,
    agent_session_id: agentSessionId ?? undefined,
    tmux_session: result.tmuxSession,
    runner_session_id: result.runnerSessionId,
    workspace_path: workspacePath,
  });
  logEvent(attemptId, 'spawned', { agentType, agentSessionId });

  // 8. Post to Linear — use activity when agent session exists, minimal comment as fallback
  if (hasAgentAccess() && agentSessionId) {
    // Agent session is visible in Linear UI — no comment needed
  } else {
    await addComment(issue.id, `**Agent started** (\`${agentType}\`) — \`aos jump ${issue.identifier}\``);
  }

  // 9. Move issue to In Progress (use agent identity so it doesn't show as user)
  try {
    const agentClient = getAgentClient();
    const stateId = await agentClient.workflowStates({ filter: { name: { eq: WORKFLOW_STATES.IN_PROGRESS }, team: { id: { eq: config.linearTeamId } } } });
    if (stateId.nodes.length > 0) {
      await agentClient.updateIssue(issue.id, { stateId: stateId.nodes[0].id });
    }
  } catch (err) {
    console.warn(chalk.yellow(`[spawn] Failed to move ${issue.identifier} to In Progress: ${(err as Error).message}`));
  }

  console.log(chalk.green(`\n✓ Agent spawned for ${issue.identifier}`));
  console.log(`  Session:  ${result.tmuxSession}`);
  console.log(`  Attempt:  #1 (${agentType})`);
  console.log(`  Jump:     ${chalk.bold(`aos jump ${issue.identifier}`)}`);
  if (agentSessionId) {
    console.log(`  Linear:   AgentSession ${chalk.dim(agentSessionId)}`);
  }
}
