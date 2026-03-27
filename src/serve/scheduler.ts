/** Scheduler: queue drain, auto-dispatch, heartbeat, polling, reconciliation, janitor, project pipeline. */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import { getConfig, resolveStatePath } from '../core/config.js';
import {
  getReadClient, getAgentClient, getIssue, updateIssueState,
  getIssuesByLabel, dismissAgentSession, listAgentSessions,
  globalDismissedSessions, getWorkflowStateId,
} from '../core/linear.js';
import {
  getActiveAttempts, getActiveAttempt, getIdleAttempt, getAttemptsByIssue, updateAttemptStatus,
} from '../core/db.js';
import { sessionExists, sendKeys, readFileOnRemote } from '../core/tmux.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';
import { canSpawnAgent } from '../core/router.js';
import {
  enqueue, dequeue, peekQueue, getQueueLength, getQueueItems,
  isInCooldown, completeQueueItem, cancelQueueItem, cancelQueued,
} from '../core/queue.js';
import { spawnCommand } from '../commands/spawn.js';
import { agentStartCommand } from '../commands/agent.js';
import { WORKFLOW_STATES } from '../types.js';

import { autoDispatchFailures } from './state.js';
import { hasQueuedIssue, isPermanentIssueError } from './helpers.js';
import { shouldSkipReview } from './monitor.js';
import { checkCircuitBreaker } from './circuit-breaker.js';
import { handleDispatch } from './dispatch.js';
import { canStartNewSession, monitorHibernatedSessions, tryWakeHibernatedSession } from './concurrency.js';

// Re-export for serve.ts
export { monitorHibernatedSessions, tryWakeHibernatedSession } from './concurrency.js';

// ─── Heartbeat: periodic unassigned issue checker ───

const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes
let lastHeartbeatAt = 0;

export async function heartbeatAssignUnowned(): Promise<void> {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = Date.now();

  const ts = new Date().toLocaleTimeString();

  try {
    const client = getReadClient();
    const config = getConfig();

    // Find issues with no assignee in Backlog/Todo/In Progress
    const states = await client.workflowStates({
      filter: { team: { id: { eq: config.linearTeamId } } }
    });
    const activeStateIds = states.nodes
      .filter(s => s.name === 'Todo')
      .map(s => s.id);

    if (activeStateIds.length === 0) return;

    const unassigned = await client.issues({
      filter: {
        state: { id: { in: activeStateIds } },
        team: { id: { eq: config.linearTeamId } },
        assignee: { null: true },
      },
      first: 10,
    });

    if (unassigned.nodes.length === 0) return;

    // Instead of mechanical routing, wake CTO to triage unassigned issues.
    // CTO reads titles/descriptions and makes intelligent assignment decisions.
    const issueList = unassigned.nodes
      .map(i => `- ${i.identifier}: ${i.title} (P${i.priority})`)
      .join('\n');

    const triageMsg = `Heartbeat: ${unassigned.nodes.length} unassigned issue(s) need triage. Read each title and assign to the RIGHT agent based on content, not just labels.\n\n${issueList}\n\nFor each: AGENT_ROLE=coo linear-tool dispatch <correct-role> <issue-key> "context". Research/analysis → research-lead. Code fixes → lead-engineer. Ops/infra → coo. Product/UX → cpo. Testing → cto.`;

    const tmuxName = 'aos-coo';
    if (sessionExists(tmuxName)) {
      // CTO is running — pipe triage request
      try {
        const { writeFileSync } = await import('fs');
        sendKeys(tmuxName, triageMsg);
        console.log(chalk.cyan(`[${ts}] Heartbeat: asked COO to triage ${unassigned.nodes.length} unassigned issue(s)`));
      } catch { /**/ }
    } else {
      // COO not running — start COO for triage
      try {
        await agentStartCommand('coo');
        console.log(chalk.cyan(`[${ts}] Heartbeat: started COO for triage of ${unassigned.nodes.length} issue(s)`));
        // Wait for boot, then send triage request
        setTimeout(async () => {
          try {
            sendKeys(tmuxName, triageMsg);
          } catch { /**/ }
        }, 30_000);
      } catch (err) {
        console.log(chalk.dim(`Heartbeat: failed to start COO: ${(err as Error).message}`));
      }
    }
  } catch (err) {
    console.log(chalk.dim(`Heartbeat: ${(err as Error).message}`));
  }
}

// ─── Auto-dispatch from backlog ───

const MAX_AUTO_DISPATCH_FAILURES = 2;
let lastAutoDispatchAt = 0;
const AUTO_DISPATCH_COOLDOWN_MS = 120_000; // 2 min between auto-dispatches

export async function autoDispatchFromBacklog(): Promise<void> {
  // Kill switch: disable auto-dispatch via env var
  if (process.env.AOS_NO_AUTO_DISPATCH === '1') return;

  // Cooldown: don't dispatch too frequently
  if (Date.now() - lastAutoDispatchAt < AUTO_DISPATCH_COOLDOWN_MS) return;

  // Global concurrency gate — prevents dispatch storm after restart
  const concurrencyCheck = canStartNewSession();
  if (!concurrencyCheck.allowed) {
    return;
  }

  // Check if any agents have capacity (running < maxParallel)
  const activeAttempts = getActiveAttempts();
  const availableRoles: string[] = [];

  for (const role of listAgents()) {
    if (!agentExists(role)) continue;
    const cfg = loadAgentConfig(role);
    const maxP = cfg.maxParallel ?? 2;
    const running = activeAttempts.filter(a => a.agent_type === role && a.status === 'running').length;
    if (running < maxP) {
      availableRoles.push(role);
    }
  }

  if (availableRoles.length === 0) return;

  // Fetch Backlog/Todo issues from Linear (cache for 5 min to avoid API spam)
  // Use a simple approach: check DB for recently created issues not yet completed
  // Actually, we need to ask Linear. But to avoid API spam, only check every 2 min (already cooldown-gated).
  try {
    const client = getReadClient();
    const config = getConfig();
    const backlogState = await client.workflowStates({ filter: { name: { eq: 'Backlog' }, team: { id: { eq: config.linearTeamId } } } });
    const todoState = await client.workflowStates({ filter: { name: { eq: 'Todo' }, team: { id: { eq: config.linearTeamId } } } });

    const stateIds = [
      ...backlogState.nodes.map(s => s.id),
      ...todoState.nodes.map(s => s.id),
    ];
    if (stateIds.length === 0) return;

    const issues = await client.issues({
      filter: { state: { id: { in: stateIds } }, team: { id: { eq: config.linearTeamId } } },
      first: 10,
    });

    // Sort by priority client-side (1=urgent, 4=low, 0=no priority)
    issues.nodes.sort((a, b) => {
      const pa = a.priority || 5;
      const pb = b.priority || 5;
      return pa - pb;
    });

    for (const issue of issues.nodes) {
      const issueKey = issue.identifier;

      // Skip issues that have failed auto-dispatch too many times
      if ((autoDispatchFailures.get(issueKey) || 0) >= MAX_AUTO_DISPATCH_FAILURES) continue;

      // Resolve target agent from assignee OR delegate.
      // Delegate = Linear's agent delegation field (preferred for agent work).
      // Assignee = traditional assignment (may be human or agent).
      let targetRole: string | null = null;

      // 1. Check delegate first (Linear agent delegation)
      const delegateId = (issue as any).delegateId as string | undefined;
      if (delegateId) {
        for (const role of listAgents()) {
          const cfg = loadAgentConfig(role);
          if (cfg.linearUserId === delegateId) {
            targetRole = role;
            break;
          }
        }
      }

      // 2. Fall back to assignee
      if (!targetRole) {
        const assignee = await issue.assignee;
        if (assignee) {
          for (const role of listAgents()) {
            const cfg = loadAgentConfig(role);
            if (cfg.linearUserId === assignee.id) {
              targetRole = role;
              break;
            }
          }
        }
      }

      // 3. No agent found — let heartbeat/COO handle
      if (!targetRole) continue;

      // Only dispatch if the target role is idle
      if (!availableRoles.includes(targetRole)) continue;

      // Guard: skip if a tmux session already exists for this role+issue
      // (agentStartCommand also checks, but catching it here avoids unnecessary getIssue calls)
      if (sessionExists(`aos-${targetRole}-${issueKey}`)) continue;

      // Guard: skip if there's already an idle session on this issue (any role)
      // The idle session can be reactivated — no need to spawn a new one
      const existingIdle = getIdleAttempt(issueKey);
      if (existingIdle) continue;

      // Circuit breaker: skip if this issue has exceeded its retry limit
      const cb = checkCircuitBreaker(issueKey, targetRole);
      if (!cb.allowed) {
        console.log(chalk.dim(`  Auto-dispatch circuit breaker: ${cb.reason}`));
        continue;
      }

      // Dispatch!
      const ts = new Date().toLocaleTimeString();
      console.log(chalk.cyan(`[${ts}] Auto-dispatch: ${issueKey} → ${targetRole} (idle agent, backlog issue)`));

      // Cancel any queued entries for this issue targeting a different agent
      // to prevent intrusion (e.g., lead-engineer queued but COO now dispatched)
      const canceled = cancelQueued(issueKey);
      if (canceled > 0) {
        console.log(chalk.dim(`  Canceled ${canceled} stale queue entry(ies) for ${issueKey}`));
      }

      try {
        await agentStartCommand(targetRole, issueKey);
        lastAutoDispatchAt = Date.now();
        return; // One at a time
      } catch (err) {
        const count = (autoDispatchFailures.get(issueKey) || 0) + 1;
        autoDispatchFailures.set(issueKey, count);
        console.log(chalk.yellow(`[${ts}] Auto-dispatch failed (${count}/${MAX_AUTO_DISPATCH_FAILURES}): ${(err as Error).message}`));
      }
    }
  } catch (err) {
    // Linear API error — skip this cycle
    console.log(chalk.dim(`Auto-dispatch: Linear query failed: ${(err as Error).message}`));
  }
}

// ─── Queue drain ───

export async function drainQueue(): Promise<void> {
  if (isInCooldown()) return;

  const next = peekQueue();
  if (!next) return;

  // Check if the agent model has capacity
  const agentConfig = loadAgentConfig(next.agent_role);
  const modelType = agentConfig.baseModel || 'cc';
  const { allowed } = canSpawnAgent(modelType);
  if (!allowed) return;

  // Global concurrency gate
  const concurrency = canStartNewSession();
  if (!concurrency.allowed) return;

  const item = dequeue();
  if (!item) return;

  const ts = new Date().toLocaleTimeString();
  const remaining = getQueueLength();
  console.log(chalk.cyan(`[${ts}] Queue drain: ${item.issue_key} → ${item.agent_role} (${remaining} remaining)`));

  // Guard: if another agent is already active on this issue, cancel the queued item
  // to prevent "intrusion" (two different agents working the same issue concurrently).
  const existingAttempt = getActiveAttempt(item.issue_key);
  if (existingAttempt && existingAttempt.agent_type !== item.agent_role) {
    console.log(chalk.yellow(`  Queue skip: ${item.issue_key} already being worked by ${existingAttempt.agent_type} — canceling queued ${item.agent_role}`));
    cancelQueueItem(item.id);
    return;
  }

  // Guard: if there's an idle session on this issue, don't spawn — it can be reactivated
  const idleOnIssue = getIdleAttempt(item.issue_key);
  if (idleOnIssue) {
    console.log(chalk.dim(`  Queue skip: ${item.issue_key} has idle session (${idleOnIssue.agent_type}) — reactivate instead`));
    cancelQueueItem(item.id);
    return;
  }

  // Circuit breaker: skip if this issue has exceeded its retry limit
  const queueCb = checkCircuitBreaker(item.issue_key, item.agent_role);
  if (!queueCb.allowed) {
    console.log(chalk.yellow(`  Queue circuit breaker: ${queueCb.reason}`));
    cancelQueueItem(item.id);
    return;
  }

  try {
    if (agentExists(item.agent_role)) {
      await agentStartCommand(item.agent_role, item.issue_key);
    } else {
      await spawnCommand(item.issue_key, {
        agentSessionId: item.agent_session_id ?? undefined,
        followUpPrompt: item.follow_up_prompt ?? undefined,
      });
    }
    completeQueueItem(item.id);
  } catch (err) {
    console.log(chalk.red(`  Queue spawn failed: ${(err as Error).message}`));
    cancelQueueItem(item.id);

    // Permanent error (issue deleted/not found): cancel ALL queue entries for this issue
    // to prevent other roles or delayed retries from hitting the same dead issue
    if (isPermanentIssueError(err)) {
      const purged = cancelQueued(item.issue_key);
      if (purged > 0) {
        console.log(chalk.yellow(`  Purged ${purged} remaining queue entries for deleted issue ${item.issue_key}`));
      }
    }
  }
}

// ─── Polling fallback: pick up orphaned agent-labeled issues ───

let lastPollTime = 0;
const POLL_INTERVAL_MS = 60_000;

export async function pollOrphanedIssues(): Promise<void> {
  if (Date.now() - lastPollTime < POLL_INTERVAL_MS) return;
  lastPollTime = Date.now();

  for (const role of listAgents()) {
    const labelName = `agent:${role}`;
    try {
      const issues = await getIssuesByLabel(labelName, WORKFLOW_STATES.TODO);
      for (const issue of issues) {
        if (getActiveAttempt(issue.identifier)) continue; // already being worked on
        if (sessionExists(`aos-${role}-${issue.identifier}`)) continue; // tmux session exists

        // Circuit breaker: skip if this issue has exceeded its retry limit
        const pollCb = checkCircuitBreaker(issue.identifier, role);
        if (!pollCb.allowed) continue;

        // Global concurrency gate
        const globalCheck = canStartNewSession();
        if (!globalCheck.allowed) continue;

        const agentConfig = loadAgentConfig(role);
        const modelType = agentConfig.baseModel || 'cc';
        const { allowed } = canSpawnAgent(modelType);

        const ts = new Date().toLocaleTimeString();
        if (allowed) {
          console.log(chalk.cyan(`[${ts}] Poll pickup: ${issue.identifier} → ${role}`));
          try {
            await agentStartCommand(role, issue.identifier);
          } catch (err) {
            console.log(chalk.red(`  Poll spawn failed: ${(err as Error).message}`));
          }
        } else if (!isInCooldown()) {
          console.log(chalk.yellow(`[${ts}] Poll queued: ${issue.identifier} → ${role}`));
          enqueue({
            id: randomUUID(),
            issue_id: issue.id,
            issue_key: issue.identifier,
            agent_role: role,
          });
        }
      }
    } catch {
      // Silently skip — Linear API might be unavailable
    }
  }
}

// ─── Reconcile In Progress issues ───

let lastReconcileTime = 0;
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export async function reconcileInProgressIssues(): Promise<void> {
  if (Date.now() - lastReconcileTime < RECONCILE_INTERVAL_MS) return;
  lastReconcileTime = Date.now();

  try {
    const client = getReadClient();
    const issues = await client.issues({
      first: 100,
      filter: {
        team: { key: { eq: getConfig().linearTeamKey } },
        state: { name: { eq: WORKFLOW_STATES.IN_PROGRESS } },
      },
    });

    for (const issue of issues.nodes) {
      if (getActiveAttempt(issue.identifier) || hasQueuedIssue(issue.identifier)) continue;

      const latestAttempt = getAttemptsByIssue(issue.identifier)[0];
      let targetState: string | null = null;

      if (latestAttempt?.status === 'completed') {
        // Check if this is a trivial issue that can auto-close as Done
        const handoff = latestAttempt.workspace_path
          ? readFileOnRemote(resolveStatePath(latestAttempt.issue_key, latestAttempt.workspace_path, 'HANDOFF.md')) : null;
        targetState = shouldSkipReview(issue.title, handoff || '')
          ? WORKFLOW_STATES.DONE
          : WORKFLOW_STATES.IN_REVIEW;
      } else if (!latestAttempt || latestAttempt.status === 'failed' || latestAttempt.status === 'blocked') {
        const comments = await issue.comments({ first: 1 });
        if (!latestAttempt || comments.nodes.length === 0 || latestAttempt.status === 'failed' || latestAttempt.status === 'blocked') {
          targetState = WORKFLOW_STATES.TODO;
        }
      }

      if (!targetState) continue;

      const ts = new Date().toLocaleTimeString();
      console.log(chalk.dim(`[${ts}] Reconcile: ${issue.identifier} In Progress → ${targetState}`));
      try {
        await updateIssueState(issue.id, targetState);
      } catch { /**/ }
    }
  } catch {
    // Best effort only
  }
}

// ─── Janitor: dismiss stale agent sessions ───

let lastJanitorTime = 0;
const SESSION_JANITOR_INTERVAL_MS = 5 * 60_000;

export async function janitorAgentSessions(): Promise<void> {
  if (Date.now() - lastJanitorTime < SESSION_JANITOR_INTERVAL_MS) return;
  lastJanitorTime = Date.now();

  const activeAttempts = getActiveAttempts();
  const activeIssues = new Set(activeAttempts.map((attempt) => attempt.issue_key));
  const queuedIssues = new Set(getQueueItems().map((item) => item.issue_key));
  const sessions = await listAgentSessions();

  // Also build a set of tracked session IDs so we can identify orphaned sessions
  const trackedSessionIds = new Set(
    activeAttempts.map(a => a.agent_session_id).filter(Boolean)
  );

  for (const session of sessions) {
    const issueKey = session.issue?.identifier;
    const issueState = session.issue?.state?.name;
    if (!issueKey || session.status === 'complete') continue;
    // Skip sessions already dismissed by any subsystem (monitor, webhook, watch, or previous janitor run)
    if (globalDismissedSessions.has(session.id)) continue;

    // For Done/In Review issues with no active work: always clean up
    // For In Progress issues: only clean up ORPHANED sessions (not tracked by any attempt)
    const hasActiveWork = activeIssues.has(issueKey) || queuedIssues.has(issueKey);
    if (hasActiveWork) {
      // Issue is being worked on — only dismiss sessions NOT tracked by any active attempt
      if (trackedSessionIds.has(session.id)) continue; // This session is tracked, leave it
      // Orphaned session on an active issue — dismiss it to prevent ghost "Working"
    } else {
      // No active work — only dismiss if issue is completed
      if (!['Done', 'In Review'].includes(issueState || '')) continue;
    }

    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}] Janitor dismiss: ${issueKey} session ${session.id.slice(0, 8)} (${session.status})`));
    // Try each agent's token — sessions are owned by per-agent OAuth apps
    let dismissed = false;
    for (const role of listAgents()) {
      const agentTok = getAgentLinearToken(role);
      if (!agentTok) continue;
      try {
        await dismissAgentSession(session.id, agentTok, '–');
        dismissed = true;
        break;
      } catch { /* wrong token, try next */ }
    }
    // Fallback: try default token (Keychain/refreshable) if per-agent tokens all failed
    if (!dismissed) {
      try {
        await dismissAgentSession(session.id, undefined, '–');
        dismissed = true;
      } catch { /* default token also failed */ }
    }
    if (!dismissed) {
      console.log(chalk.dim(`  Janitor: could not dismiss ${session.id.slice(0, 8)} (all tokens failed)`));
    }
  }

  // GC the global dismissed set when it grows large (sessions eventually expire from Linear)
  if (globalDismissedSessions.size > 200) {
    const activeSessionIds = new Set(sessions.map(s => s.id));
    for (const id of globalDismissedSessions) {
      if (!activeSessionIds.has(id)) globalDismissedSessions.delete(id);
    }
  }
}

// ─── Mailbox: check for agent-to-agent responses ───

export async function checkMailboxResponses(): Promise<void> {
  const mailboxDir = join(getConfig().stateDir, 'mailbox');
  if (!existsSync(mailboxDir)) return;

  for (const role of listAgents()) {
    const outbox = join(mailboxDir, role, 'outbox');
    if (!existsSync(outbox)) continue;

    const files = readdirSync(outbox).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(outbox, file), 'utf-8'));
        const response = data.response;
        if (!response) continue;

        // Find who asked (parse from the message ID: {timestamp}-{from})
        const msgId = file.replace('.json', '');
        const fromMatch = msgId.match(/-(\w+)$/);
        const fromRole = fromMatch?.[1];

        if (fromRole) {
          // Pipe the response into the asking agent's tmux
          const tmuxName = `aos-${fromRole}`;
          if (sessionExists(tmuxName)) {
            try {
              sendKeys(tmuxName, `[RESPONSE from ${role}]: ${response}`);
              const ts = new Date().toLocaleTimeString();
              console.log(chalk.blue(`[${ts}] Mailbox response: ${role} → ${fromRole}`));
            } catch { /**/ }
          }
        }

        // Clean up: remove the inbox message and outbox response
        const inbox = join(mailboxDir, role, 'inbox', file);
        try { unlinkSync(inbox); } catch { /**/ }
        try { unlinkSync(join(outbox, file)); } catch { /**/ }
      } catch { /**/ }
    }
  }
}

// ─── Project Pipeline: hourly idea-to-issue-to-dispatch cycle ───

const PIPELINE_INTERVAL_MS = 60 * 60_000; // 1 hour
let lastPipelineAt = 0;

const PIPELINE_DIR = join(process.env.HOME || '', '.aos', 'project-pipeline');
const IDEAS_FILE = join(PIPELINE_DIR, 'ideas', 'project-ideas.json');
const STATE_FILE = join(PIPELINE_DIR, 'pipeline-state.json');
const LOG_FILE = join(PIPELINE_DIR, 'pipeline-log.md');

interface PipelineIdea {
  id: string;
  title: string;
  description: string;
  category: string;
  leverages: string[];
  repoName: string;
  techStack: string;
  monetization: { model: string; free: string; paid: string; rationale: string };
  estimatedEffort: string;
  stages: { research: string; product: string; engineering: string; ship: string };
  impact: string;
  status: 'available' | 'in-progress' | 'shipped' | 'failed' | 'skipped';
}

interface PipelineState {
  lastRun: string | null;
  currentProject: string | null;
  currentIssueKey: string | null;
  shipped: Array<{ id: string; issueKey: string; repoUrl: string; shippedAt: string }>;
  failed: Array<{ id: string; issueKey: string; reason: string; failedAt: string }>;
  totalRuns: number;
}

function loadPipelineIdeas(): { version: string; ideas: PipelineIdea[] } | null {
  if (!existsSync(IDEAS_FILE)) return null;
  try { return JSON.parse(readFileSync(IDEAS_FILE, 'utf-8')); } catch { return null; }
}

function loadPipelineState(): PipelineState {
  if (!existsSync(STATE_FILE)) {
    return { lastRun: null, currentProject: null, currentIssueKey: null, shipped: [], failed: [], totalRuns: 0 };
  }
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch {
    return { lastRun: null, currentProject: null, currentIssueKey: null, shipped: [], failed: [], totalRuns: 0 };
  }
}

function selectNextIdea(ideas: PipelineIdea[]): PipelineIdea | null {
  const available = ideas.filter(i => i.status === 'available');
  if (available.length === 0) return null;

  const impactOrder = ['VERY HIGH', 'HIGH', 'MEDIUM-HIGH', 'MEDIUM'];
  for (const level of impactOrder) {
    const candidates = available.filter(i => i.impact.toUpperCase().startsWith(level));
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  return available[0];
}

function buildPipelineIssueDescription(idea: PipelineIdea): string {
  return `## Project Pipeline: ${idea.title}

**Category**: ${idea.category}
**Tech Stack**: ${idea.techStack}
**Impact**: ${idea.impact}
**GitHub Repo**: \`${idea.repoName}\`
**Estimated Effort**: ${idea.estimatedEffort}

### Description
${idea.description}

### Leverages Existing Work
${idea.leverages.map(l => `- ${l}`).join('\n')}

### Monetization
- **Model**: ${idea.monetization.model}
- **Free tier**: ${idea.monetization.free}
- **Paid tier**: ${idea.monetization.paid}
- **Rationale**: ${idea.monetization.rationale}

### Pipeline Stages

**1. Research (Research Lead context)**
${idea.stages.research}

**2. Product (CPO context)**
${idea.stages.product}

**3. Engineering (Lead Engineer context)**
${idea.stages.engineering}

**4. Ship**
${idea.stages.ship}

---

### CTO Pipeline Protocol

Execute the full project pipeline for this project. You are leading a team of subagents through 5 stages:

**Stage 1 — Research (10 min)**
Spawn a research subagent to:
- Perform competitive landscape scan
- Identify technical feasibility
- Gather data/APIs needed
- Output: RESEARCH-BRIEF.md

**Stage 2 — Product Spec (10 min)**
Spawn a product subagent to:
- Define target audience and value proposition
- Specify MVP features (ruthlessly minimal)
- Write user-facing copy (tagline, README intro)
- Output: PRODUCT-SPEC.md

**Stage 3 — Engineering (25 min)**
Spawn 2-3 engineering subagents in parallel:
- Engineer A: Core library/tool implementation
- Engineer B: CLI/UI/dashboard
- Engineer C: Tests + README
- Output: Working code in workspace

**Stage 4 — QA Review (5 min)**
You (CTO) review:
- Code quality (staff engineer standard)
- Security (no OWASP issues)
- README quality and accuracy
- Tests pass

**Stage 5 — Ship to GitHub (10 min)**
- Create GitHub repo: \`gh repo create zzhiyuann/${idea.repoName} --public --description "..."\`
- Push code
- Enable GitHub Pages if applicable
- Post shipping summary to Linear

**Quality Gates:**
- Research must identify at least 2 competitors and our differentiation
- Product spec must have clear monetization angle
- Code must have at least 5 tests passing
- README must include: installation, usage, examples, contributing
- Repo must be public with MIT license

**Monetization Gate:**
- Every project must have a clear path to revenue
- Free tier must provide real value (not crippled)
- Paid tier must have a plausible $1K+ MRR path
`;
}

export async function projectPipelineHeartbeat(): Promise<void> {
  // Kill switch
  if (process.env.AOS_NO_PIPELINE === '1') return;

  // Hourly cooldown
  if (Date.now() - lastPipelineAt < PIPELINE_INTERVAL_MS) return;
  lastPipelineAt = Date.now();

  const ts = new Date().toLocaleTimeString();

  // Check if ideas file exists
  const bank = loadPipelineIdeas();
  if (!bank) {
    console.log(chalk.dim(`[${ts}] Pipeline: no ideas file at ${IDEAS_FILE}`));
    return;
  }

  // Check if there's already a project in progress
  const state = loadPipelineState();
  if (state.currentProject) {
    console.log(chalk.dim(`[${ts}] Pipeline: project in progress (${state.currentProject} / ${state.currentIssueKey}), skipping`));
    return;
  }

  // Select next idea
  const idea = selectNextIdea(bank.ideas);
  if (!idea) {
    console.log(chalk.dim(`[${ts}] Pipeline: no available ideas remaining`));
    return;
  }

  // Check CTO has capacity
  const ctoConfig = loadAgentConfig('cto');
  const maxP = ctoConfig.maxParallel ?? 2;
  const ctoRunning = getActiveAttempts().filter(a => a.agent_type === 'cto' && a.status === 'running').length;
  if (ctoRunning >= maxP) {
    console.log(chalk.dim(`[${ts}] Pipeline: CTO at capacity (${ctoRunning}/${maxP}), deferring`));
    return;
  }

  try {
    // Create Linear issue via SDK
    const config = getConfig();
    const client = getAgentClient();
    const stateId = await getWorkflowStateId('Todo');

    const ctoLinearUserId = ctoConfig.linearUserId;

    const result = await client.createIssue({
      teamId: config.linearTeamId,
      title: `Ship: ${idea.title}`,
      description: buildPipelineIssueDescription(idea),
      priority: 2, // High
      stateId,
      ...(ctoLinearUserId ? { assigneeId: ctoLinearUserId, delegateId: ctoLinearUserId } : {}),
    });

    if (!result.success) {
      console.log(chalk.red(`[${ts}] Pipeline: failed to create issue for ${idea.id}`));
      return;
    }

    const issue = await result.issue;
    if (!issue) {
      console.log(chalk.red(`[${ts}] Pipeline: issue creation returned no issue for ${idea.id}`));
      return;
    }

    const issueKey = issue.identifier;
    console.log(chalk.cyan(`[${ts}] Pipeline: created ${issueKey} for "${idea.title}"`));

    // Update idea status
    idea.status = 'in-progress';
    writeFileSync(IDEAS_FILE, JSON.stringify({ version: bank.version, lastUpdated: new Date().toISOString().split('T')[0], ideas: bank.ideas }, null, 2));

    // Update pipeline state
    state.currentProject = idea.id;
    state.currentIssueKey = issueKey;
    state.lastRun = new Date().toISOString();
    state.totalRuns++;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    // Append to pipeline log
    const logEntry = `\n## ${new Date().toISOString()}\n**Triggered**: ${idea.title}\n- Issue: ${issueKey}\n- Impact: ${idea.impact}\n- Category: ${idea.category}\n- Repo: ${idea.repoName}\n`;
    if (existsSync(LOG_FILE)) {
      writeFileSync(LOG_FILE, readFileSync(LOG_FILE, 'utf-8') + logEntry);
    } else {
      writeFileSync(LOG_FILE, `# Project Pipeline Log\n${logEntry}`);
    }

    // Dispatch CTO via company dispatch system
    const dispatchContext = `Project pipeline triggered for "${idea.title}". Execute the full 5-stage pipeline protocol in the issue description. Ship to github.com/zzhiyuann/${idea.repoName}. Estimated effort: ${idea.estimatedEffort}.`;

    await handleDispatch({
      role: 'cto',
      issueKey,
      message: dispatchContext,
      from: 'pipeline',
    });

    console.log(chalk.green(`[${ts}] Pipeline: dispatched CTO to ${issueKey} (${idea.id})`));
  } catch (err) {
    console.log(chalk.red(`[${ts}] Pipeline error: ${(err as Error).message}`));
  }
}
