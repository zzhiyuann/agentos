/**
 * Planner: Automated issue decomposition into sub-issues with parallel dispatch.
 *
 * Flow: Parent issue → LLM plans sub-tasks → creates Linear sub-issues → dispatches agents in parallel
 *
 * Inspired by the "CEO Secretary" pattern: a planning LLM analyzes the goal,
 * decomposes it into assignable sub-tasks, and triggers parallel agent work.
 */

import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import {
  getIssue, addComment, getAgentClient, getWorkflowStateId,
  getReadClient,
} from '../core/linear.js';
import { listAgents, loadAgentConfig, agentExists } from '../core/persona.js';
import { handleDispatch } from './dispatch.js';

// ─── Types ───

export interface PlannedSubtask {
  title: string;
  description: string;
  assignee: string;   // Agent role name (e.g., 'lead-engineer', 'cto')
  priority?: number;   // 1-4, defaults to parent priority
}

export interface PlanResult {
  plan: string;          // Markdown plan comment
  subtasks: PlannedSubtask[];
  parentIssueKey: string;
}

export interface PlanAndDispatchResult {
  planResult: PlanResult;
  createdIssues: { key: string; title: string; assignee: string }[];
  dispatchResults: { key: string; role: string; action: string; detail?: string }[];
}

// ─── Agent Roster (for LLM planning context) ───

function buildAgentRoster(): string {
  const agents = listAgents();
  const roster: string[] = [];

  for (const role of agents) {
    if (!agentExists(role)) continue;
    const config = loadAgentConfig(role);
    roster.push(`- **${role}** (${config.baseModel || 'cc'}): Available for task assignment`);
  }

  return roster.join('\n');
}

// ─── LLM-Based Planning ───

/**
 * Use Claude CLI to decompose a parent issue into sub-tasks.
 * Returns structured plan with sub-task assignments.
 */
export async function planIssue(issueKey: string): Promise<PlanResult> {
  const issue = await getIssue(issueKey);
  const agentRoster = buildAgentRoster();

  const orgName = process.env.AOS_ORG_NAME || 'an AI-native company';
  const systemPrompt = `You are the CEO Secretary for ${orgName}. Your job is to decompose high-level goals into concrete, assignable sub-tasks for the agent team.

You MUST respond in this exact format — the orchestrator parses it programmatically:

<comment>
## Plan for: [issue title]

[2-4 sentence overview of the approach]

### Sub-tasks
[Numbered list of sub-tasks with assignee in parentheses]

### Dependencies
[Any ordering constraints or dependencies between sub-tasks]

### Success Criteria
[How to verify the overall goal is met]
</comment>
<subtasks>
[
  { "title": "Sub-task title", "description": "Detailed description with specific instructions", "assignee": "agent-role-name" },
  ...
]
</subtasks>

Rules:
- Each sub-task should be independently actionable by its assignee
- Use exact agent role names from the roster below
- Keep sub-tasks focused — one clear deliverable per sub-task
- Include enough context in each description that the agent can work autonomously
- For coding tasks, specify which files/modules to work on
- For review/audit tasks, specify what to review and success criteria
- Priority defaults to the parent issue priority unless overridden

Available agents:
${agentRoster}`;

  const userPrompt = `Decompose this issue into sub-tasks:

**${issue.identifier}: ${issue.title}**

${issue.description || '(No description provided)'}

Priority: ${issue.priority || 2}
Current status: ${issue.state}`;

  // Call Claude CLI in pipe mode for a quick planning call.
  // Use spawnSync to avoid shell escaping — pipe the prompt via stdin.
  let llmResponse: string;
  const { spawnSync } = await import('child_process');

  // Combine system prompt + user prompt into a single input for claude -p
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const result = spawnSync('claude', ['-p', '--output-format', 'text'], {
    input: fullPrompt,
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Planning LLM call failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'unknown error';
    throw new Error(`Planning LLM exited with code ${result.status}: ${stderr}`);
  }

  llmResponse = (result.stdout || '').trim();
  if (!llmResponse) {
    throw new Error('Planning LLM returned empty response');
  }

  // Parse the structured response
  const commentMatch = llmResponse.match(/<comment>([\s\S]*?)<\/comment>/);
  const subtasksMatch = llmResponse.match(/<subtasks>([\s\S]*?)<\/subtasks>/);

  const plan = commentMatch?.[1]?.trim() || llmResponse;

  let subtasks: PlannedSubtask[] = [];
  if (subtasksMatch) {
    try {
      const parsed = JSON.parse(subtasksMatch[1].trim());
      if (Array.isArray(parsed)) {
        subtasks = parsed
          .filter((t: Record<string, unknown>) => t.title && t.assignee)
          .map((t: Record<string, unknown>) => ({
            title: String(t.title),
            description: String(t.description || ''),
            assignee: resolveAgentRole(String(t.assignee)),
            priority: typeof t.priority === 'number' ? t.priority : (issue.priority || 2),
          }));
      }
    } catch (parseErr) {
      console.log(chalk.yellow(`  Plan parsing warning: subtasks JSON invalid — ${(parseErr as Error).message}`));
    }
  }

  return {
    plan,
    subtasks,
    parentIssueKey: issue.identifier,
  };
}

// ─── Agent Name Resolution (fuzzy matching) ───

/**
 * Resolve a potentially fuzzy agent name to an exact role.
 * "CTO" → "cto", "Lead Engineer" → "lead-engineer", "Engineer" → "lead-engineer"
 */
function resolveAgentRole(nameHint: string): string {
  const hint = nameHint.toLowerCase().replace(/\s+/g, '-');

  // Exact match first
  if (agentExists(hint)) return hint;

  // Fuzzy matching
  const agents = listAgents();
  for (const role of agents) {
    if (hint.includes(role) || role.includes(hint)) return role;
  }

  // Common aliases
  const aliases: Record<string, string> = {
    'engineer': 'lead-engineer',
    'dev': 'lead-engineer',
    'developer': 'lead-engineer',
    'qa': 'cto',
    'tester': 'cto',
    'product': 'cpo',
    'research': 'research-lead',
    'ops': 'coo',
    'operations': 'coo',
  };

  for (const [alias, role] of Object.entries(aliases)) {
    if (hint.includes(alias)) return role;
  }

  // Default fallback
  return 'lead-engineer';
}

// ─── Sub-Issue Creation ───

/**
 * Create a sub-issue in Linear under a parent issue.
 * Returns the new issue's key (e.g., "RYA-120").
 */
async function createSubIssue(
  parentIssueId: string,
  teamId: string,
  subtask: PlannedSubtask,
): Promise<{ key: string; id: string } | null> {
  try {
    const config = getConfig();
    const client = getAgentClient();
    const stateId = await getWorkflowStateId('Todo');

    // Resolve assignee to Linear user ID
    let assigneeId: string | undefined;
    if (agentExists(subtask.assignee)) {
      const agentConfig = loadAgentConfig(subtask.assignee);
      assigneeId = agentConfig.linearUserId || undefined;
    }

    const result = await client.createIssue({
      teamId,
      title: subtask.title,
      description: subtask.description,
      parentId: parentIssueId,
      priority: subtask.priority || 2,
      stateId,
      ...(assigneeId ? { assigneeId } : {}),
    });

    if (result.success) {
      const issue = await result.issue;
      if (issue) {
        // Also set delegate for webhook routing
        if (assigneeId) {
          try {
            await client.updateIssue(issue.id, { delegateId: assigneeId });
          } catch { /* best effort */ }
        }

        return { key: issue.identifier, id: issue.id };
      }
    }
    return null;
  } catch (err) {
    console.log(chalk.red(`  Failed to create sub-issue "${subtask.title}": ${(err as Error).message}`));
    return null;
  }
}

// ─── Plan + Create + Dispatch (Full Flow) ───

/**
 * Full planning flow:
 * 1. Decompose parent issue into sub-tasks (LLM)
 * 2. Post plan as comment on parent issue
 * 3. Create sub-issues in Linear with parent linkage
 * 4. Dispatch agents in parallel
 */
export async function planAndDispatch(issueKey: string): Promise<PlanAndDispatchResult> {
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.bold(`[${ts}] Planning: ${issueKey}`));

  // Step 1: Plan
  const planResult = await planIssue(issueKey);
  console.log(chalk.cyan(`  Plan generated: ${planResult.subtasks.length} sub-tasks`));

  // Step 2: Post plan as comment on parent issue
  const parentIssue = await getIssue(issueKey);
  try {
    await addComment(parentIssue.id, planResult.plan);
    console.log(chalk.dim(`  Plan posted as comment on ${issueKey}`));
  } catch (err) {
    console.log(chalk.yellow(`  Warning: failed to post plan comment: ${(err as Error).message}`));
  }

  if (planResult.subtasks.length === 0) {
    console.log(chalk.yellow(`  No sub-tasks generated — plan only`));
    return { planResult, createdIssues: [], dispatchResults: [] };
  }

  // Step 3: Create sub-issues
  const teamId = getConfig().linearTeamId;
  const createdIssues: { key: string; id: string; title: string; assignee: string }[] = [];

  for (const subtask of planResult.subtasks) {
    const result = await createSubIssue(parentIssue.id, teamId, subtask);
    if (result) {
      createdIssues.push({
        key: result.key,
        id: result.id,
        title: subtask.title,
        assignee: subtask.assignee,
      });
      console.log(chalk.dim(`  Created: ${result.key} → ${subtask.assignee}: ${subtask.title}`));
    }
  }

  // Step 4: Dispatch all agents in parallel
  const dispatchPromises = createdIssues.map(async (issue) => {
    try {
      const result = await handleDispatch({
        role: issue.assignee,
        issueKey: issue.key,
        message: `Sub-task of ${issueKey}. See parent issue for overall plan.`,
        from: 'planner',
      });
      return {
        key: issue.key,
        role: issue.assignee,
        action: result.action,
        detail: result.detail,
      };
    } catch (err) {
      return {
        key: issue.key,
        role: issue.assignee,
        action: 'error' as const,
        detail: (err as Error).message,
      };
    }
  });

  const dispatchResults = await Promise.all(dispatchPromises);

  // Log summary
  const started = dispatchResults.filter(r => r.action === 'started').length;
  const queued = dispatchResults.filter(r => r.action === 'queued').length;
  const errors = dispatchResults.filter(r => r.action === 'error').length;
  console.log(chalk.green(`  Dispatch complete: ${started} started, ${queued} queued, ${errors} errors`));

  // Post dispatch summary as comment
  const summaryLines = createdIssues.map((issue, i) => {
    const result = dispatchResults[i];
    const icon = result.action === 'started' ? '🟢' : result.action === 'queued' ? '🟡' : '🔴';
    return `${icon} **${issue.key}** → @${issue.assignee}: ${issue.title} (${result.action})`;
  });

  try {
    await addComment(parentIssue.id, [
      `## Dispatch Summary`,
      ``,
      `Created ${createdIssues.length} sub-issues, dispatched ${started + queued} agents:`,
      ``,
      ...summaryLines,
    ].join('\n'));
  } catch { /* best effort */ }

  return {
    planResult,
    createdIssues: createdIssues.map(i => ({ key: i.key, title: i.title, assignee: i.assignee })),
    dispatchResults,
  };
}

// ─── Sub-Issue Queries ───

/**
 * Get all sub-issues of a parent issue.
 */
export async function getSubIssues(parentKey: string): Promise<{
  key: string;
  title: string;
  state: string;
  assignee?: string;
}[]> {
  const client = getReadClient();
  const parent = await getIssue(parentKey);

  const parentIssue = await client.issue(parent.id);
  const children = await parentIssue.children();

  const results: { key: string; title: string; state: string; assignee?: string }[] = [];
  for (const child of children.nodes) {
    const state = await child.state;
    const assignee = await child.assignee;
    results.push({
      key: child.identifier,
      title: child.title,
      state: state?.name || 'Unknown',
      assignee: assignee?.name,
    });
  }

  return results;
}

/**
 * Check if all sub-issues of a parent are completed.
 */
export async function areAllSubIssuesDone(parentKey: string): Promise<{
  allDone: boolean;
  total: number;
  done: number;
  remaining: { key: string; title: string; state: string }[];
}> {
  const subIssues = await getSubIssues(parentKey);
  const doneStates = ['Done', 'Canceled'];
  const done = subIssues.filter(s => doneStates.includes(s.state));
  const remaining = subIssues.filter(s => !doneStates.includes(s.state));

  return {
    allDone: remaining.length === 0 && subIssues.length > 0,
    total: subIssues.length,
    done: done.length,
    remaining,
  };
}
