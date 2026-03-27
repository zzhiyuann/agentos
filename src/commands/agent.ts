import chalk from 'chalk';
import { randomUUID } from 'crypto';
import {
  listAgents, loadPersona, buildGroundingPrompt, buildTaskPrompt,
  agentExists, getAgentsDir, getAgentLinearToken, loadAgentConfig,
} from '../core/persona.js';
import { getConfig, resolveWorkspace } from '../core/config.js';
import { getIssue, updateIssueState, hasAgentAccess, createAgentSession, emitActivity, addComment, getIssueRelations, formatRelationsForPrompt } from '../core/linear.js';
import { sessionExists, killSession, writeFileOnRemote, sendKeys, listSessionsByPrefix } from '../core/tmux.js';
import { join } from 'path';
import { createAttempt, getActiveAttempt, getActiveAttempts, updateAttemptStatus, logEvent } from '../core/db.js';
import { getAdapter } from '../adapters/index.js';
import { WORKFLOW_STATES } from '../types.js';
import { claimSpawnSlot } from '../serve/state.js';
import { canStartNewSession, tryMakeRoom, getRunningSessionCount, GLOBAL_MAX_SESSIONS } from '../serve/concurrency.js';

const DEFAULT_MAX_PARALLEL = 8;

/**
 * aos agent list
 */
export async function agentListCommand(): Promise<void> {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log(chalk.dim('No agents configured.'));
    return;
  }

  console.log(chalk.bold('Agent Roster'));
  console.log('─'.repeat(65));

  const activeAttempts = getActiveAttempts();

  for (const role of agents) {
    if (!agentExists(role)) continue;
    const persona = loadPersona(role);
    const memoryCount = persona.memories.length;
    const model = persona.config.baseModel;
    const maxP = persona.config.maxParallel ?? 2;
    const roleAttempts = activeAttempts.filter(a => a.agent_type === role && a.status === 'running');
    const sessions = listSessionsByPrefix(`aos-${role}`);

    let status: string;
    if (roleAttempts.length === 0) {
      status = chalk.dim('idle');
    } else {
      const issues = roleAttempts.map(a => a.issue_key).join(', ');
      status = chalk.green(`${roleAttempts.length}/${maxP} (${issues})`);
    }

    console.log(
      `  ${chalk.bold(role.padEnd(18))} ${chalk.dim(model.padEnd(7))} ${status.padEnd(45)} ${chalk.dim(`${memoryCount} mem`)}`
    );
  }
}

/**
 * aos agent start <role> [issue-key] [--model cc|codex]
 */
export async function agentStartCommand(role: string, issueKey?: string, options?: { model?: string; webhookSessionId?: string; useContinue?: boolean; skipCapacityCheck?: boolean }): Promise<'started' | 'resumed' | 'queued' | 'error'> {
  const config = getConfig();

  if (!agentExists(role)) {
    console.log(chalk.red(`Agent "${role}" not found. Available: ${listAgents().join(', ')}`));
    return 'error';
  }

  const persona = loadPersona(role);
  const baseModel = options?.model || persona.config.baseModel;
  const groundingPrompt = buildGroundingPrompt(persona);

  console.log(chalk.bold(`Starting ${role}`) + chalk.dim(` [${baseModel}]`));
  console.log(chalk.dim(`  Memories: ${persona.memories.length} files`));

  // Determine task and workspace
  let taskPrompt: string;
  let workspacePath: string;
  let issueId: string | undefined;
  let issueTitle: string | undefined;
  let agentSessionId: string | null = null;

  if (issueKey) {
    const issue = await getIssue(issueKey);
    workspacePath = resolveWorkspace(issue.identifier, issue.project);

    // Download any images in the issue description so agents can view them
    let processedDescription = issue.description;
    if (issue.description) {
      const { downloadCommentImages } = await import('../serve/helpers.js');
      const { text, imagePaths } = await downloadCommentImages(issue.description, workspacePath);
      if (imagePaths.length > 0) {
        processedDescription = text + `\n\n**Attached images** (use Read tool to view):\n${imagePaths.map(p => `- ${p}`).join('\n')}`;
        console.log(chalk.dim(`  Downloaded ${imagePaths.length} image(s) from issue description`));
      } else {
        processedDescription = text;
      }
    }

    // Fetch issue relations (blocking, related, etc.) and append to description
    try {
      const relations = await getIssueRelations(issue.identifier);
      if (relations.length > 0) {
        const relationsSection = formatRelationsForPrompt(relations);
        processedDescription = (processedDescription || '') + '\n\n' + relationsSection;
        console.log(chalk.dim(`  Relations: ${relations.length} (${relations.filter(r => r.type === 'blocked_by').length} blockers)`));
      }
    } catch (err) {
      console.log(chalk.dim(`  Relations fetch failed: ${(err as Error).message}`));
    }

    taskPrompt = buildTaskPrompt(role, issue.identifier, issue.title, processedDescription, workspacePath);
    issueId = issue.id;
    issueTitle = issue.title;

    console.log(chalk.dim(`  Task: ${issue.identifier} — ${issue.title}`));
  } else {
    taskPrompt = `You are resuming as ${role}. Your persona and memories are loaded. Awaiting instructions.`;
    workspacePath = `${config.workspaceBase}/${role}`;
  }

  // Parallel session support: each issue gets its own tmux session
  const tmuxName = issueKey ? `aos-${role}-${issueKey}` : `aos-${role}`;
  const maxParallel = persona.config.maxParallel ?? DEFAULT_MAX_PARALLEL;

  // If this exact role+issue already has a tmux session, check before resuming
  if (issueKey && sessionExists(tmuxName)) {
    // Check if there's already an active running attempt for this session.
    // If so, this is a DUPLICATE spawn (race between handlers) — don't re-prompt.
    // Sending the full task prompt into an actively working agent causes duplicate responses.
    const existingAttempt = issueId ? getActiveAttempts().find(
      a => a.tmux_session === tmuxName && a.status === 'running'
    ) : null;

    if (existingAttempt) {
      // Agent is already actively working — don't inject another prompt
      console.log(chalk.dim(`  Skip duplicate: ${role} already working on ${issueKey} (attempt ${existingAttempt.id.substring(0, 8)})`));
      return 'resumed';
    }

    // No active attempt — agent is at idle prompt, safe to re-engage
    console.log(chalk.cyan(`  Resuming ${role} on ${issueKey} (existing session)`));
    try {
      sendKeys(tmuxName, taskPrompt);
    } catch (err) {
      console.log(chalk.yellow(`  Resume failed: ${(err as Error).message} — will spawn new`));
      killSession(tmuxName);
      // Fall through to spawn below
    }
    if (issueId) {
      const attemptId = randomUUID();
      createAttempt({
        id: attemptId,
        issue_id: issueId,
        issue_key: issueKey,
        agent_type: role,
        host: config.execHost,
        tmux_session: tmuxName,
        workspace_path: workspacePath,
        agent_session_id: options?.webhookSessionId ?? undefined,
      });
      logEvent(attemptId, 'resumed', { role });
      const agentToken = getAgentLinearToken(role);
      try { await updateIssueState(issueId, WORKFLOW_STATES.IN_PROGRESS, agentToken || undefined); } catch { /**/ }
    }
    console.log(chalk.green(`\n✓ ${role} resumed on ${issueKey}`));
    console.log(`  Session:  ${tmuxName}`);
    return 'resumed';
  }

  // ─── Concurrency gate (skipped if session-manager already checked) ───
  if (issueKey && !options?.skipCapacityCheck) {
    const globalCheck = canStartNewSession();
    if (!globalCheck.allowed) {
      if (tryMakeRoom(issueKey)) {
        console.log(chalk.blue(`  Evicted a session to make room for ${issueKey}`));
      } else {
        const running = getRunningSessionCount();
        console.log(chalk.yellow(`  System at global cap (${running}/${GLOBAL_MAX_SESSIONS}) — queueing ${issueKey}`));
        const { enqueue } = await import('../core/queue.js');
        enqueue({ id: randomUUID(), issue_id: issueId || '', issue_key: issueKey, agent_role: role });
        return 'queued';
      }
    }

    const allRunning = getActiveAttempts().filter(a => a.agent_type === role && a.status === 'running');
    const uniqueSessions = new Set(allRunning.map(a => a.tmux_session).filter(Boolean));
    if (uniqueSessions.size >= maxParallel) {
      console.log(chalk.yellow(`  ${role} at capacity (${uniqueSessions.size}/${maxParallel}) — queueing ${issueKey}`));
      const { enqueue } = await import('../core/queue.js');
      enqueue({ id: randomUUID(), issue_id: issueId || '', issue_key: issueKey, agent_role: role });
      return 'queued';
    }
  }

  // NOTE: We no longer call closeActiveSessionsForIssue here.
  // It posted '–' as a visible comment on every spawn (type:'response' can't be ephemeral).
  // The janitor in scheduler.ts handles stale session cleanup instead.

  // Atomic spawn guard: prevents double-spawn from racing webhook + comment handlers.
  // Only applies to issue-specific spawns (not idle-mode sessions).
  if (issueKey && !claimSpawnSlot(issueKey)) {
    console.log(chalk.dim(`  Dedup: skipping duplicate spawn for ${role} on ${issueKey}`));
    return 'resumed'; // Return 'resumed' to signal the caller that work is already in progress
  }

  // No-issue session (idle mode): kill existing idle session if any
  if (!issueKey) {
    const oldSession = `aos-${role}`;
    if (sessionExists(oldSession)) {
      killSession(oldSession);
    }
  }

  // Symlink persona memory dir into workspace so agent can read/write memories
  // from its working directory (agents can't write to ~/.aos/ from workspace)
  const personaMemoryDir = join(getAgentsDir(), role, 'memory');
  try {
    const { mkdirSync, symlinkSync, lstatSync, unlinkSync: rmLink } = await import('fs');
    mkdirSync(personaMemoryDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    // Symlink memory dir
    try { lstatSync(`${workspacePath}/.agent-memory`); rmLink(`${workspacePath}/.agent-memory`); } catch { /**/ }
    symlinkSync(personaMemoryDir, `${workspacePath}/.agent-memory`);
    // Symlink MEMORY.md index
    const memoryIndex = join(getAgentsDir(), role, 'MEMORY.md');
    try { lstatSync(`${workspacePath}/.agent-memory-index.md`); rmLink(`${workspacePath}/.agent-memory-index.md`); } catch { /**/ }
    symlinkSync(memoryIndex, `${workspacePath}/.agent-memory-index.md`);
  } catch (err) {
    console.warn(chalk.yellow(`  Memory symlink failed: ${(err as Error).message}`));
  }

  // Spawn via adapter with grounding — if this fails, no AgentSession is created (no ghost)
  const adapter = getAdapter(baseModel);
  let result;
  try {
    result = await adapter.spawn({
      issueKey: issueKey || role,
      title: issueTitle || `Agent: ${role}`,
      description: undefined,
      systemPrompt: groundingPrompt,
      initialPrompt: taskPrompt,
      workspacePath,
      attemptNumber: 1,
      agentRole: role,
    });
  } catch (err) {
    console.log(chalk.red(`  Spawn failed: ${(err as Error).message}`));
    return 'error';
  }

  // Reuse webhook session if provided to prevent dual-session problem.
  // Only create a new session when no webhook session was passed (e.g., manual dispatch, auto-dispatch).
  if (issueId && issueKey) {
    const agentToken = getAgentLinearToken(role);
    if (options?.webhookSessionId) {
      agentSessionId = options.webhookSessionId;
    } else if (hasAgentAccess() && agentToken) {
      try {
        agentSessionId = await createAgentSession(issueId, undefined, agentToken);
      } catch { /* best effort — fall back to comment only */ }
    }
    if (agentSessionId) {
      try {
        await emitActivity(agentSessionId, {
          type: 'thought',
          body: `Starting work on ${issueKey}`,
        }, true, agentToken || undefined);
      } catch { /* best effort */ }
    }

    const attemptId = randomUUID();
    createAttempt({
      id: attemptId,
      issue_id: issueId,
      issue_key: issueKey,
      agent_type: role,
      host: config.execHost,
      agent_session_id: agentSessionId ?? undefined,
      tmux_session: result.tmuxSession || tmuxName,
      workspace_path: workspacePath,
    });
    logEvent(attemptId, 'spawned', { role, baseModel, memories: persona.memories.length });

    // Mark issue in progress
    try { await updateIssueState(issueId, WORKFLOW_STATES.IN_PROGRESS, agentToken || undefined); } catch { /**/ }
  }

  console.log(chalk.green(`\n✓ ${role} is online [${baseModel}]`));
  console.log(`  Session:  ${result.tmuxSession || tmuxName}`);
  console.log(`  Jump:     ${chalk.bold(`aos agent talk ${role} "your message"`)}`);
  return 'started';
}

/**
 * aos agent stop <role>
 */
export async function agentStopCommand(role: string): Promise<void> {
  const sessions = listSessionsByPrefix(`aos-${role}`);
  if (sessions.length === 0) {
    console.log(chalk.dim(`${role} is not running`));
    return;
  }

  for (const sess of sessions) {
    // Ask agent to save memory before stopping
    try {
      sendKeys(sess, 'Before exiting: update your memory files with anything important from this session.');
    } catch { /**/ }
  }
  console.log(chalk.dim(`Waiting for ${role} to save memory (${sessions.length} session(s))...`));
  await new Promise((r) => setTimeout(r, 15_000));

  for (const sess of sessions) {
    try { killSession(sess); } catch { /**/ }
    const active = getActiveAttempts().find(a => a.tmux_session === sess);
    if (active) {
      updateAttemptStatus(active.id, 'completed', 'Graceful stop');
    }
  }

  console.log(chalk.green(`✓ ${role} stopped (${sessions.length} session(s))`));
}

/**
 * aos agent talk <role> <message>
 */
export async function agentTalkCommand(role: string, message: string): Promise<void> {
  const sessions = listSessionsByPrefix(`aos-${role}`);
  if (sessions.length === 0) {
    console.log(chalk.red(`${role} is not running. Start: aos agent start ${role}`));
    return;
  }

  // Send to all active sessions for this role
  for (const sess of sessions) {
    try {
      sendKeys(sess, message);
      console.log(chalk.green(`✓ → ${sess}`));
    } catch (err) {
      console.log(chalk.red(`Failed (${sess}): ${(err as Error).message}`));
    }
  }
}

/**
 * aos agent memory <role>
 */
export async function agentMemoryCommand(role: string): Promise<void> {
  if (!agentExists(role)) {
    console.log(chalk.red(`Agent "${role}" not found`));
    return;
  }

  const persona = loadPersona(role);

  console.log(chalk.bold(`${role} — Memory`) + chalk.dim(` [${persona.config.baseModel}]`));
  console.log('─'.repeat(40));

  if (persona.memories.length === 0) {
    console.log(chalk.dim('No memories yet.'));
  } else {
    for (const mem of persona.memories) {
      const lines = mem.content.split('\n').filter((l) => l.trim()).length;
      console.log(`  ${chalk.cyan(mem.name.padEnd(25))} ${chalk.dim(`${lines} lines`)}`);
    }
  }

  console.log(chalk.dim(`\nConfig: ${JSON.stringify(persona.config)}`));
}
