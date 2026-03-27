import chalk from 'chalk';
import { getConfig, resolveStatePath } from '../core/config.js';
import {
  getIssuesByLabel, addComment, addLabelToIssue,
  hasAgentAccess, emitActivity, updateAgentPlan, createIssueDocument,
  dismissAgentSession, getAgentClient, generateHandoffSummary,
} from '../core/linear.js';
import { getActiveAttempts, updateAttemptStatus, logEvent, getActiveAttempt } from '../core/db.js';
import { readFileOnRemote, capturePane } from '../core/tmux.js';
import { getAdapter } from '../adapters/index.js';
import { spawnCommand } from './spawn.js';
import { WORKFLOW_STATES, AGENT_LABELS } from '../types.js';
import { validatePostSessionMemory, formatMemoryWarnings } from '../core/memory-validation.js';

/** Notify via configured group chat (Discord or Telegram) */
async function postToGroupChat(role: string, message: string): Promise<boolean> {
  try {
    const { loadDiscordConfig, postToDiscord } = await import('../core/discord.js');
    const dcConfig = loadDiscordConfig();
    if (dcConfig.webhookUrl) return await postToDiscord(role, message);
  } catch { /**/ }
  try {
    const { loadTelegramConfig, postToGroup } = await import('../core/telegram.js');
    const tgConfig = loadTelegramConfig();
    if (tgConfig.groupChatId) return await postToGroup(role, message);
  } catch { /**/ }
  return false;
}

let running = true;
const progressHashes = new Map<string, string>();

// Stall detection: track last time we saw output change per session
const lastOutputChange = new Map<string, { hash: string; at: number }>();
const STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes with no output change = stalled
const stalledNotified = new Set<string>(); // avoid repeat alerts

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

export async function watchCommand(): Promise<void> {
  const config = getConfig();

  console.log(chalk.bold('AgentOS Watcher v2'));
  console.log(chalk.dim(`Polling every ${config.pollIntervalMs / 1000}s`));
  console.log(chalk.dim('Press Ctrl+C to stop\n'));

  process.on('SIGINT', () => {
    running = false;
    console.log(chalk.dim('\nShutting down...'));
  });

  while (running) {
    try {
      await pollCycle();
    } catch (err: unknown) {
      console.log(chalk.red(`Poll error: ${(err as Error).message}`));
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, config.pollIntervalMs);
      if (!running) { clearTimeout(timer); resolve(); }
    });
  }
}

async function pollCycle(): Promise<void> {
  const ts = new Date().toLocaleTimeString();

  // 1. Auto-spawn: issues labeled agent:cc in Todo state
  const todoIssues = await getIssuesByLabel(AGENT_LABELS.CC, WORKFLOW_STATES.TODO);
  for (const issue of todoIssues) {
    if (!getActiveAttempt(issue.identifier)) {
      console.log(chalk.cyan(`[${ts}] Auto-spawning: ${issue.identifier} - ${issue.title}`));
      try {
        await spawnCommand(issue.identifier, { agent: 'cc' });
      } catch (err: unknown) {
        console.log(chalk.red(`  Failed: ${(err as Error).message}`));
      }
    }
  }

  // 2. Health check + lifecycle management
  const activeAttempts = getActiveAttempts();
  for (const attempt of activeAttempts) {
    if (!attempt.tmux_session) continue;

    const adapter = getAdapter(attempt.agent_type);
    const alive = adapter.isAlive(attempt.tmux_session);

    if (!alive) {
      console.log(chalk.yellow(`[${ts}] Session ended: ${attempt.issue_key} #${attempt.attempt_number}`));
      await handleSessionEnd(attempt);
      continue;
    }

    // 3. Stall detection — catch agents that are alive but not working
    await checkStall(attempt);

    // 4. Progress tracking
    if (attempt.workspace_path) {
      await checkProgress(attempt);
    }
  }

  const activeCount = activeAttempts.filter(a => a.status === 'running').length;
  if (activeCount > 0 || todoIssues.length > 0) {
    console.log(chalk.dim(`[${ts}] Active: ${activeCount} | Queued: ${todoIssues.length}`));
  }
}

async function checkStall(attempt: ReturnType<typeof getActiveAttempts>[0]): Promise<void> {
  if (!attempt.tmux_session) return;
  const key = `${attempt.issue_key}#${attempt.attempt_number}`;

  // Capture current terminal output
  const output = capturePane(attempt.tmux_session, 30);
  const hash = simpleHash(output || '');
  const now = Date.now();
  const last = lastOutputChange.get(key);

  if (!last || last.hash !== hash) {
    // Output changed — agent is active
    lastOutputChange.set(key, { hash, at: now });
    stalledNotified.delete(key);
    return;
  }

  // Output unchanged — check how long
  const stalledMs = now - last.at;
  if (stalledMs < STALL_THRESHOLD_MS || stalledNotified.has(key)) return;

  // Stalled! Kill session, notify, update status
  const stalledMin = Math.round(stalledMs / 60_000);
  const msg = `**Agent stalled** — ${attempt.issue_key} (${attempt.agent_type}) has had no output change for ${stalledMin} minutes. Killing session.`;
  console.log(chalk.red(`[STALL] ${attempt.issue_key} #${attempt.attempt_number} — no output for ${stalledMin}m, killing`));
  stalledNotified.add(key);

  // Kill the stalled session
  const adapter = getAdapter(attempt.agent_type);
  adapter.kill(attempt.tmux_session);
  updateAttemptStatus(attempt.id, 'failed', `Stalled: no output change for ${stalledMin} minutes`);
  logEvent(attempt.id, 'failed', { reason: 'stalled', stalledMinutes: stalledMin });

  // Dismiss Linear AgentSession
  if (hasAgentAccess() && attempt.agent_session_id) {
    await emitActivity(attempt.agent_session_id, { type: 'error', body: msg });
    try { await dismissAgentSession(attempt.agent_session_id, undefined, '–'); } catch { /**/ }
  }

  // Post to Linear issue
  await addComment(attempt.issue_id, msg);

  // Notify via group chat (Telegram/Discord)
  await postToGroupChat('system', `🚨 ${attempt.issue_key}: agent ${attempt.agent_type} stalled for ${stalledMin}m — auto-killed`);
}

async function handleSessionEnd(attempt: ReturnType<typeof getActiveAttempts>[0]): Promise<void> {
  const handoff = attempt.workspace_path ? readFileOnRemote(resolveStatePath(attempt.issue_key, attempt.workspace_path, 'HANDOFF.md')) : null;
  const blocked = attempt.workspace_path ? readFileOnRemote(resolveStatePath(attempt.issue_key, attempt.workspace_path, 'BLOCKED.md')) : null;

  if (handoff) {
    updateAttemptStatus(attempt.id, 'completed');
    logEvent(attempt.id, 'completed', { hasHandoff: true });

    // Post handoff as Issue Document (preferred) or comment (fallback)
    const docUrl = await createIssueDocument(attempt.issue_id, `Handoff: Attempt #${attempt.attempt_number}`, handoff);

    if (hasAgentAccess() && attempt.agent_session_id) {
      await emitActivity(attempt.agent_session_id, {
        type: 'response',
        body: `Task completed. ${docUrl ? `[View handoff](${docUrl})` : 'See HANDOFF.md in workspace.'}`,
      });
      await updateAgentPlan(attempt.agent_session_id, [
        { content: 'Analyze requirements', status: 'completed' },
        { content: 'Implement solution', status: 'completed' },
        { content: 'Write handoff', status: 'completed' },
      ]);
    } else {
      const summary = generateHandoffSummary(handoff);
      const docNote = docUrl ? `\n\n[View full handoff](${docUrl})` : '';
      await addComment(attempt.issue_id, `**Agent completed** (Attempt #${attempt.attempt_number})\n\n${summary}${docNote}`);
    }

    try {
      const agentClient = getAgentClient();
      const states = await agentClient.workflowStates({ filter: { name: { eq: WORKFLOW_STATES.IN_REVIEW } } });
      if (states.nodes.length > 0) {
        await agentClient.updateIssue(attempt.issue_id, { stateId: states.nodes[0].id });
      }
    } catch { /**/ }
    console.log(chalk.green(`  → Completed with handoff`));
  } else if (blocked) {
    updateAttemptStatus(attempt.id, 'blocked', blocked.substring(0, 500));
    logEvent(attempt.id, 'failed', { blocked: true });

    if (hasAgentAccess() && attempt.agent_session_id) {
      await emitActivity(attempt.agent_session_id, { type: 'elicitation', body: blocked });
    } else {
      await addComment(attempt.issue_id, `**Agent blocked** (Attempt #${attempt.attempt_number})\n\n${blocked}`);
      try { await addLabelToIssue(attempt.issue_id, AGENT_LABELS.BLOCKED); } catch { /**/ }
    }
    console.log(chalk.red(`  → Blocked`));
  } else {
    updateAttemptStatus(attempt.id, 'failed', 'Session ended without handoff');
    logEvent(attempt.id, 'failed', { reason: 'unexpected termination' });

    if (hasAgentAccess() && attempt.agent_session_id) {
      await emitActivity(attempt.agent_session_id, {
        type: 'error',
        body: 'Agent session ended unexpectedly — no HANDOFF.md or BLOCKED.md found.',
      });
    } else {
      await addComment(attempt.issue_id, '**Agent session ended unexpectedly** — no artifacts found.');
    }
    console.log(chalk.red(`  → Failed (no handoff)`));
  }

  // Post-session memory validation (warn, never block)
  try {
    const memResult = validatePostSessionMemory(attempt.agent_type, !!handoff);
    if (memResult.warnings.length > 0) {
      const warningText = formatMemoryWarnings(memResult);
      console.log(chalk.yellow(`  [MEMORY] ${attempt.issue_key}: ${memResult.warnings.length} warning(s)`));
      for (const w of memResult.warnings) {
        console.log(chalk.yellow(`    - ${w}`));
      }
      // Post as comment on the Linear issue so it's visible to reviewers
      await addComment(attempt.issue_id, warningText);
      logEvent(attempt.id, 'progress', { memoryValidation: memResult.warnings });
    }
  } catch (err: unknown) {
    // Memory validation must never crash session-end handling
    console.log(chalk.dim(`  [MEMORY] Validation skipped: ${(err as Error).message}`));
  }
}

async function checkProgress(attempt: ReturnType<typeof getActiveAttempts>[0]): Promise<void> {
  if (!attempt.workspace_path) return;
  const progress = readFileOnRemote(resolveStatePath(attempt.issue_key, attempt.workspace_path, 'PROGRESS.md'));
  if (!progress) return;

  const hash = simpleHash(progress);
  const lastHash = progressHashes.get(attempt.id);

  if (hash !== lastHash) {
    progressHashes.set(attempt.id, hash);
    if (lastHash !== undefined) {
      // Progress changed — report it
      if (hasAgentAccess() && attempt.agent_session_id) {
        await emitActivity(attempt.agent_session_id, { type: 'thought', body: progress }, true);
      } else {
        await addComment(attempt.issue_id, `**Progress** (Attempt #${attempt.attempt_number})\n\n${progress}`);
      }
    }
  }
}
