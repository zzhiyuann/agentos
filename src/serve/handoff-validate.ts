/**
 * A2.2: Validation layer for structured HANDOFF.md front-matter actions.
 *
 * Agents declare side-effects (dispatches, delegate, status intent) in YAML
 * front matter that the monitor executes with real Linear credentials. The
 * front matter is agent-generated free text — garbled YAML, hallucinated
 * roles, cross-team issue keys, or oversized payloads must be dropped before
 * executeHandoffActions runs. Rejected actions are dropped individually
 * (valid ones proceed) and reported once via a Linear comment by the caller.
 */

import { getConfig } from '../core/config.js';
import type { HandoffActions, DispatchAction } from './monitor.js';

/** Hard caps on agent-declared actions. */
export const MAX_DISPATCHES = 5;
export const MAX_NEW_ISSUE_TITLE_LEN = 200;
export const MAX_CONTEXT_LEN = 2000;

const STATUS_INTENT_WHITELIST = new Set(['done', 'in-review', 'in-progress', 'todo', 'no-change']);
const ISSUE_KEY_FORMAT_RE = /^[A-Z]+-\d+$/;

export interface RejectedAction {
  /** Short human-readable description of the rejected action. */
  action: string;
  reason: string;
}

export interface HandoffValidationResult {
  /** Sanitized copy of the actions — only validated entries remain. */
  valid: HandoffActions;
  rejected: RejectedAction[];
}

function describeDispatch(d: DispatchAction, index: number): string {
  const target = d.issue ?? (d.new_issue ? `new_issue "${(d.new_issue.title || '').substring(0, 60)}"` : '(no target)');
  return `dispatch[${index}] role=${d.role || '(none)'} → ${target}`;
}

/**
 * Validate parsed handoff actions against the agent roster and team config.
 *
 * Checks:
 *  - status_intent ∈ whitelist (defensive — the parser already constrains this)
 *  - delegate role exists (param-injected role list)
 *  - at most MAX_DISPATCHES dispatches; extras rejected
 *  - per dispatch: role exists; issue key matches /^[A-Z]+-\d+$/ AND carries the
 *    configured team prefix; new-issue title 1–200 chars; context ≤ 2000 chars
 *
 * @param actions - output of parseHandoffActions (agent-controlled)
 * @param knownRoles - the agent roster (e.g. listAgents())
 */
export function validateHandoffActions(
  actions: HandoffActions,
  knownRoles: string[],
): HandoffValidationResult {
  const rejected: RejectedAction[] = [];

  let teamKey = '';
  try {
    teamKey = getConfig().linearTeamKey || '';
  } catch {
    // No config (e.g. unit tests without env) — skip the team-prefix check
  }

  // status_intent — parser whitelists already; re-check defensively
  let statusIntent = actions.statusIntent;
  if (statusIntent && !STATUS_INTENT_WHITELIST.has(statusIntent.status)) {
    rejected.push({ action: `status_intent: ${statusIntent.status}`, reason: 'status_intent not in whitelist' });
    statusIntent = null;
  }

  // delegate — must be a known role
  let delegate = actions.delegate;
  if (delegate && !knownRoles.includes(delegate)) {
    rejected.push({ action: `delegate: ${delegate}`, reason: `unknown role "${delegate}"` });
    delegate = null;
  }

  // dispatches
  const validDispatches: DispatchAction[] = [];
  for (let i = 0; i < actions.dispatches.length; i++) {
    const d = actions.dispatches[i];
    const label = describeDispatch(d, i);

    if (i >= MAX_DISPATCHES) {
      rejected.push({ action: label, reason: `dispatch limit exceeded (max ${MAX_DISPATCHES})` });
      continue;
    }
    if (!d.role || !knownRoles.includes(d.role)) {
      rejected.push({ action: label, reason: `unknown role "${d.role || ''}"` });
      continue;
    }
    if (!d.issue && !d.new_issue) {
      rejected.push({ action: label, reason: 'dispatch has neither issue nor new_issue' });
      continue;
    }
    if (d.issue) {
      if (!ISSUE_KEY_FORMAT_RE.test(d.issue)) {
        rejected.push({ action: label, reason: `invalid issue key format "${d.issue}"` });
        continue;
      }
      if (teamKey && d.issue.split('-')[0] !== teamKey) {
        rejected.push({ action: label, reason: `issue key "${d.issue}" is outside team ${teamKey}` });
        continue;
      }
    }
    if (d.new_issue) {
      const title = (d.new_issue.title || '').trim();
      if (title.length < 1 || title.length > MAX_NEW_ISSUE_TITLE_LEN) {
        rejected.push({ action: label, reason: `new-issue title must be 1-${MAX_NEW_ISSUE_TITLE_LEN} chars (got ${title.length})` });
        continue;
      }
    }
    if (d.context && d.context.length > MAX_CONTEXT_LEN) {
      rejected.push({ action: label, reason: `context exceeds ${MAX_CONTEXT_LEN} chars (got ${d.context.length})` });
      continue;
    }
    validDispatches.push(d);
  }

  return {
    valid: {
      ...actions,
      statusIntent,
      delegate,
      dispatches: validDispatches,
    },
    rejected,
  };
}

/** Format rejected actions for a single Linear comment. */
export function formatRejectedActions(rejected: RejectedAction[]): string {
  return rejected.map(r => `- ${r.action} — ${r.reason}`).join('\n');
}
