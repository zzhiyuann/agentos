/** Handoff parsing and structured action execution. */

import { createLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { getIssue, updateIssueState } from '../core/linear.js';
import { Attempt, getActiveAttempts, logEvent } from '../core/db.js';
import { agentExists, loadAgentConfig } from '../core/persona.js';
import { getQueueItems } from '../core/queue.js';
import { WORKFLOW_STATES } from '../types.js';
import { handleDispatch } from './dispatch.js';
import { TRANSIENT_LINEAR_ERROR_RE } from './proactive.js';

const log = createLogger('handoff-executor');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StatusIntent {
  status: 'done' | 'in-review' | 'in-progress' | 'todo' | 'no-change';
  reason?: string;
}

export interface DispatchAction {
  role: string;
  issue?: string;
  new_issue?: { title: string; description: string; priority?: number; parent?: string };
  context?: string;
}

/** Optional override: 'ceo' forces CEO review, 'cto' allows CTO peer-review (RYA-543) */
export type ReviewLevel = 'ceo' | 'cto';

export interface HandoffActions {
  statusIntent: StatusIntent | null;
  dispatches: DispatchAction[];
  delegate: string | null;
  parentStatus: string | null;
  reviewDispatch: string | null;
  reviewLevel: ReviewLevel | null;
}

const VALID_STATUS_INTENTS = ['done', 'in-review', 'in-progress', 'todo', 'no-change'];

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse YAML front matter from HANDOFF.md to extract agent's status intent.
 * Returns null if no front matter or no valid status_intent field found.
 */
export function parseStatusIntent(handoff: string): StatusIntent | null {
  const fmMatch = handoff.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;

  const fm = fmMatch[1];
  const statusMatch = fm.match(/^status_intent:\s*(.+)$/m);
  if (!statusMatch) return null;

  const rawStatus = statusMatch[1].trim().toLowerCase().replace(/['"]/g, '');
  if (!VALID_STATUS_INTENTS.includes(rawStatus)) return null;

  const reasonMatch = fm.match(/^reason:\s*['"]?(.+?)['"]?\s*$/m);

  return {
    status: rawStatus as StatusIntent['status'],
    reason: reasonMatch?.[1],
  };
}

/**
 * RYA-1116: Returns true if the agent's HANDOFF.md explicitly chose to keep
 * the issue In Progress (`status_intent: in-progress` or `no-change`).
 *
 * Auxiliary promotion pathways (scheduler reconciler, parent-issue tracker)
 * must NOT override this sticky intent — only a new HANDOFF.md write that
 * rewrites the intent should release the lock.
 */
export function hasStickyInProgressIntent(handoff: string | null | undefined): boolean {
  if (!handoff) return false;
  const intent = parseStatusIntent(handoff);
  if (!intent) return false;
  return intent.status === 'in-progress' || intent.status === 'no-change';
}

/** Parse dispatches YAML array from front matter (line-by-line state machine). */
export function parseDispatchesFromFrontMatter(fm: string): DispatchAction[] {
  const lines = fm.split('\n');
  const dispatchIdx = lines.findIndex(l => /^dispatches:\s*$/.test(l));
  if (dispatchIdx === -1) return [];

  const dispatches: DispatchAction[] = [];
  let current: DispatchAction | null = null;
  let inNewIssue = false;
  let newIssue: DispatchAction['new_issue'] = undefined;

  for (let i = dispatchIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) break;
    const trimmed = line.trimStart();

    if (trimmed.startsWith('- role:')) {
      if (current) dispatches.push(current);
      current = { role: trimmed.replace('- role:', '').trim().replace(/['"]/g, '') };
      inNewIssue = false;
      newIssue = undefined;
      continue;
    }
    if (!current) continue;

    if (inNewIssue) {
      if (trimmed.startsWith('title:')) {
        newIssue!.title = trimmed.replace('title:', '').trim().replace(/^['"]|['"]$/g, '');
      } else if (trimmed.startsWith('description:')) {
        newIssue!.description = trimmed.replace('description:', '').trim().replace(/^['"]|['"]$/g, '');
      } else if (trimmed.startsWith('priority:')) {
        newIssue!.priority = parseInt(trimmed.replace('priority:', '').trim()) || 2;
      } else if (trimmed.startsWith('parent:')) {
        newIssue!.parent = trimmed.replace('parent:', '').trim().replace(/['"]/g, '');
      } else {
        inNewIssue = false;
        current.new_issue = newIssue;
      }
    }

    if (!inNewIssue) {
      if (trimmed.startsWith('issue:')) {
        current.issue = trimmed.replace('issue:', '').trim().replace(/['"]/g, '');
      } else if (trimmed.startsWith('context:')) {
        current.context = trimmed.replace('context:', '').trim().replace(/^['"]|['"]$/g, '');
      } else if (trimmed.startsWith('new_issue:')) {
        inNewIssue = true;
        newIssue = { title: '', description: '', priority: 2 };
      }
    }
  }
  if (current) {
    if (inNewIssue && newIssue) current.new_issue = newIssue;
    dispatches.push(current);
  }
  return dispatches;
}

/**
 * Parse all structured actions from HANDOFF.md front matter.
 * Extends parseStatusIntent with dispatches, delegate, and parent_status.
 */
export function parseHandoffActions(handoff: string): HandoffActions {
  const result: HandoffActions = {
    statusIntent: parseStatusIntent(handoff),
    dispatches: [],
    delegate: null,
    parentStatus: null,
    reviewDispatch: null,
    reviewLevel: null,
  };

  const fmMatch = handoff.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return result;
  const fm = fmMatch[1];

  const delegateMatch = fm.match(/^delegate:\s*['"]?([a-z][\w-]*)['"]?\s*$/m);
  if (delegateMatch) result.delegate = delegateMatch[1].trim();

  const parentStatusMatch = fm.match(/^parent_status:\s*['"]?(.+?)['"]?\s*$/m);
  if (parentStatusMatch) {
    const val = parentStatusMatch[1].trim().toLowerCase();
    if (val !== 'null' && val !== 'none' && val !== '') {
      result.parentStatus = val;
    }
  }

  const reviewMatch = fm.match(/^review_dispatch:\s*['"]?([a-z][\w-]*)['"]?\s*$/m);
  if (reviewMatch) result.reviewDispatch = reviewMatch[1].trim();

  const levelMatch = fm.match(/^review_level:\s*['"]?(\w+)['"]?\s*$/m);
  if (levelMatch) {
    const level = levelMatch[1].trim().toLowerCase();
    if (level === 'ceo' || level === 'cto') result.reviewLevel = level as ReviewLevel;
  }

  result.dispatches = parseDispatchesFromFrontMatter(fm);

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if an issue has an active handoff — another agent is already working on it.
 * When work is being handed off, the issue should stay In Progress, not go to In Review.
 */
export function hasActiveHandoff(issueKey: string, currentAttemptId: string): boolean {
  const allActive = getActiveAttempts();
  if (allActive.some(a => a.issue_key === issueKey && a.id !== currentAttemptId)) return true;
  const queuedForIssue = getQueueItems().some(q => q.issue_key === issueKey);
  return queuedForIssue;
}

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Execute structured actions declared in HANDOFF.md front matter.
 * Each action is error-isolated — failures don't block other actions.
 */
export async function executeHandoffActions(
  actions: HandoffActions,
  attempt: Attempt,
  agentToken?: string,
): Promise<void> {
  const actionLog: string[] = [];

  // 1. Execute dispatches (parallel, fire-and-forget)
  if (actions.dispatches.length > 0) {
    const results = await Promise.allSettled(
      actions.dispatches.map(async (d) => {
        if (d.new_issue) {
          const created = await createSubIssueFromAction(d, attempt, agentToken);
          if (created) {
            const result = await handleDispatch({
              role: d.role,
              issueKey: created.key,
              message: d.context,
              from: attempt.agent_type,
            });
            actionLog.push(`Created ${created.key} → ${d.role} (${result.action})`);
          }
        } else if (d.issue) {
          const result = await handleDispatch({
            role: d.role,
            issueKey: d.issue,
            message: d.context,
            from: attempt.agent_type,
          });
          actionLog.push(`${d.issue} → ${d.role} (${result.action})`);
        }
      }),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn('Dispatch action failed', { reason: r.reason });
      }
    }
  }

  // 2. Set delegate on current issue
  if (actions.delegate) {
    try {
      if (!agentExists(actions.delegate)) throw new Error(`Agent "${actions.delegate}" not found`);
      const delegateConfig = loadAgentConfig(actions.delegate);
      if (!delegateConfig.linearUserId) throw new Error(`Agent "${actions.delegate}" has no linearUserId`);
      const { getAgentClient } = await import('../core/linear-client.js');
      const client = getAgentClient();
      await client.updateIssue(attempt.issue_id, {
        delegateId: delegateConfig.linearUserId,
      });
      actionLog.push(`Delegate → ${actions.delegate}`);
    } catch (err) {
      log.warn('Delegate action failed', { error: (err as Error).message });
    }
  }

  // 3. Propagate parent status
  if (actions.parentStatus) {
    try {
      const { getReadClient } = await import('../core/linear-client.js');
      const client = getReadClient();
      const issue = await client.issue(attempt.issue_id);
      const parent = await issue.parent;
      if (!parent) {
        log.debug('No parent found, skipping parent_status', { issueKey: attempt.issue_key });
      } else {
        const statusMap: Record<string, string> = {
          'done': WORKFLOW_STATES.DONE,
          'in-review': WORKFLOW_STATES.IN_REVIEW,
          'in-progress': WORKFLOW_STATES.IN_PROGRESS,
          'todo': WORKFLOW_STATES.TODO,
        };
        const targetState = statusMap[actions.parentStatus];
        if (targetState) {
          await updateIssueState(parent.id, targetState, agentToken);
          actionLog.push(`Parent ${parent.identifier} → ${targetState}`);
        }
      }
    } catch (err) {
      log.warn('Parent status action failed', { error: (err as Error).message });
    }
  }

  if (actionLog.length > 0) {
    log.info('Handoff actions executed', { issueKey: attempt.issue_key, actions: actionLog.join('; ') });
    logEvent(attempt.id, 'handoff_actions', { actions: actionLog });
  }
}

/** Create a Linear sub-issue from a dispatch action's new_issue spec. */
export async function createSubIssueFromAction(
  action: DispatchAction,
  attempt: Attempt,
  agentToken?: string,
): Promise<{ key: string; id: string } | null> {
  const ni = action.new_issue!;
  const config = getConfig();
  const { getAgentClient } = await import('../core/linear-client.js');
  const { getWorkflowStateId } = await import('../core/linear-client.js');
  const client = getAgentClient();
  const stateId = await getWorkflowStateId('Todo');

  let parentId: string | undefined;
  if (ni.parent) {
    try {
      const parentIssue = await getIssue(ni.parent);
      parentId = parentIssue.id;
    } catch (err) {
      const msg = (err as Error).message;
      log.error('Failed to resolve parent issue', { parent: ni.parent, error: msg });
      if (TRANSIENT_LINEAR_ERROR_RE.test(msg)) return null;
    }
  } else {
    parentId = attempt.issue_id;
  }

  let assigneeId: string | undefined;
  if (agentExists(action.role)) {
    const agentConfig = loadAgentConfig(action.role);
    assigneeId = agentConfig.linearUserId || undefined;
  }

  try {
    const result = await client.createIssue({
      teamId: config.linearTeamId,
      title: ni.title,
      description: ni.description || '',
      parentId,
      priority: ni.priority || 2,
      stateId,
      ...(assigneeId ? { assigneeId } : {}),
    });
    if (result.success) {
      const issue = await result.issue;
      if (issue) {
        if (assigneeId) {
          await client.updateIssue(issue.id, { assigneeId });
        }
        return { key: issue.identifier, id: issue.id };
      }
    }
  } catch (err) {
    log.warn('Sub-issue creation failed', { error: (err as Error).message });
  }
  return null;
}
