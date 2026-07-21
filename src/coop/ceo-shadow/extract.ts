/**
 * Convert cached raw Linear issues into a flat corpus.jsonl of decision
 * events, one per line. Schema documented in ./README.md.
 *
 * Decision sources:
 *   1. Issue creation by CEO         → category 'create'
 *   2. History entry actor=CEO       → 'status-change' | 'edit-priority' | 'comment' (assignment)
 *   3. Comment by CEO                → 'approve' | 'reject' | 'dispatch' | 'comment'
 *   4. Stalled `[to decide]` issues  → negative example, 'no-action'
 *
 * Tagging: events on RYA-640 / RYA-709 / RYA-722 / RYA-773 / RYA-740
 * subtrees are tagged as governance-failure exhaust per RYA-845.
 *
 * RYA-845.
 */

import { createHash } from 'crypto';

import type {
  AgentRole,
  DecisionCategory,
  DecisionEvent,
  IssueContext,
  PriorComment,
  RawComment,
  RawHistoryEntry,
  RawIssue,
  SourceType,
} from './types.js';
import { CEO_USER_ID, isCeoActor, roleFromId, roleFromName } from './users.js';
import { classifyCeoComment } from './classify.js';

const HIGH_STAKES_LABEL_PATTERNS = [
  /\[to decide\]/i,
  /\[proactive\]/i,
  /\[proposal\]/i,
  /budget/i,
  /security/i,
  /launch/i,
  /governance/i,
];

const GOVERNANCE_FAILURE_HUBS = new Set(['RYA-640', 'RYA-709', 'RYA-722', 'RYA-740', 'RYA-773']);

/** Stale-decision thresholds (days). */
const SILENT_DECLINE_TO_DECIDE_DAYS = 7;
const SILENT_DECLINE_PROACTIVE_DAYS = 14;

function excerpt(s: string | null | undefined, n = 1000): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function commentExcerpt(s: string, n = 300): string {
  return excerpt(s, n);
}

function makeId(parts: string[]): string {
  return 'evt_' + createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function buildIssueContext(issue: RawIssue): IssueContext {
  return {
    key: issue.identifier,
    title: issue.title,
    description_excerpt: excerpt(issue.description ?? '', 1200),
    creator_role: (issue.creator
      ? (isCeoActor(issue.creator) ? 'ceo' : (roleFromId(issue.creator.id) || roleFromName(issue.creator.name)))
      : 'unknown') as AgentRole,
    parent_key: issue.parent?.identifier ?? null,
    labels: issue.labels.nodes.map((l) => l.name),
  };
}

function isHighStakes(issue: RawIssue): boolean {
  if ((issue.priority ?? 4) <= 1) return true; // urgent or no-priority? P=1 urgent
  if (issue.priority === 1) return true;
  for (const l of issue.labels.nodes) {
    if (HIGH_STAKES_LABEL_PATTERNS.some((r) => r.test(l.name))) return true;
  }
  if (HIGH_STAKES_LABEL_PATTERNS.some((r) => r.test(issue.title))) return true;
  return false;
}

function tagsForIssue(issue: RawIssue): string[] {
  const out: string[] = [];
  let cursor: string | null | undefined = issue.parent?.identifier ?? null;
  if (cursor && GOVERNANCE_FAILURE_HUBS.has(cursor)) {
    out.push(`governance-failure:${cursor}`);
  }
  if (GOVERNANCE_FAILURE_HUBS.has(issue.identifier)) {
    out.push(`governance-hub:${issue.identifier}`);
  }
  if (/board[\s-]?vote/i.test(issue.title) || /board[\s-]?vote/i.test(issue.description ?? '')) {
    out.push('board-vote');
  }
  if (/\[to decide\]/i.test(issue.title)) out.push('to-decide');
  if (/\[proactive\]/i.test(issue.title)) out.push('proactive');
  if (/\[proposal\]/i.test(issue.title)) out.push('proposal');
  return out;
}

function priorComments(issue: RawIssue, beforeTs: string, max = 8): PriorComment[] {
  const subset = issue.comments.nodes
    .filter((c) => c.createdAt < beforeTs)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  // Keep last `max` to preserve recency.
  const tail = subset.slice(-max);
  return tail.map((c) => ({
    author_role: (isCeoActor(c.user) ? 'ceo' : (roleFromId(c.user?.id) || roleFromName(c.user?.name))) as AgentRole,
    ts: c.createdAt,
    body_excerpt: commentExcerpt(c.body),
  }));
}

function findPriorProposal(issue: RawIssue, beforeTs: string): string | null {
  // Heuristic: the most recent comment before `beforeTs` whose body contains
  // "proposal", "Proposed by", "Decision Asked", "VOTE:", or that opens with a
  // section header — these are the agent-side asks the CEO is responding to.
  const candidates = issue.comments.nodes
    .filter((c) => c.createdAt < beforeTs)
    .filter((c) => !isCeoActor(c.user))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const c of candidates) {
    const b = c.body;
    if (/proposal|Proposed\s*by|Decision\s*Asked|^\s*##\s|VOTE\s*:/i.test(b)) {
      return excerpt(b, 1500);
    }
  }
  // Fallback: first 1500 chars of issue description if body looks proposal-y.
  const desc = issue.description ?? '';
  if (/proposal|Decision\s*Asked|VOTE\s*:|TL;?DR|## /i.test(desc)) {
    return excerpt(desc, 1500);
  }
  return null;
}

function reconstructStateAt(issue: RawIssue, ts: string): { state: string; priority: number | null; assigneeRole: AgentRole | null } {
  // Walk history backward, reverting any change at or after `ts`. We want
  // state *just before* the decision was made, so the event AT `ts` itself
  // must be reverted (createdAt >= ts).
  let state = issue.state?.name ?? 'Unknown';
  let priority: number | null = issue.priority ?? null;
  let assigneeName: string | null = issue.assignee?.name ?? null;
  for (const h of issue.history.nodes) {
    if (h.createdAt < ts) continue;
    if (h.toState && h.fromState) state = h.fromState.name;
    if (h.toPriority != null && h.fromPriority != null) priority = h.fromPriority;
    if (h.toAssignee !== undefined || h.fromAssignee !== undefined) {
      assigneeName = h.fromAssignee?.name ?? null;
    }
  }
  const assigneeRole = assigneeName
    ? (roleFromName(assigneeName) as AgentRole)
    : null;
  return { state, priority, assigneeRole };
}

function classifyHistoryEntry(h: RawHistoryEntry): { kind: DecisionCategory; type: string } | null {
  if (h.fromState && h.toState && h.fromState.name !== h.toState.name) {
    return { kind: 'status-change', type: `status:${h.fromState.name}→${h.toState.name}` };
  }
  if (h.fromPriority != null && h.toPriority != null && h.fromPriority !== h.toPriority) {
    return { kind: 'edit-priority', type: `priority:${h.fromPriority}→${h.toPriority}` };
  }
  if ((h.fromAssignee?.name ?? null) !== (h.toAssignee?.name ?? null) && (h.fromAssignee || h.toAssignee)) {
    return { kind: 'comment', type: `assign:${h.fromAssignee?.name ?? '∅'}→${h.toAssignee?.name ?? '∅'}` };
  }
  return null;
}

function eventsFromIssue(issue: RawIssue): DecisionEvent[] {
  const out: DecisionEvent[] = [];
  const ctx = buildIssueContext(issue);
  const hs = isHighStakes(issue);
  const tags = tagsForIssue(issue);

  // 1. Issue creation by CEO
  if (issue.creator && isCeoActor(issue.creator)) {
    out.push({
      id: makeId(['create', issue.id]),
      ts: issue.createdAt,
      decision_type: 'create',
      category: 'create',
      is_ceo_decision: true,
      is_high_stakes: hs,
      negative_example: false,
      issue: ctx,
      context_at_decision: {
        state: 'New',
        priority: issue.priority,
        assignee_role: issue.assignee ? (roleFromName(issue.assignee.name) as AgentRole) : null,
        n_prior_comments: 0,
        prior_comments: [],
        prior_proposal: null,
      },
      decision: {
        actor: 'ceo',
        kind: 'create',
        comment_body: excerpt(issue.description ?? '', 600) || null,
        reasoning_excerpt: null,
      },
      tags,
      source: { linear_event_id: issue.id, source_type: 'issue_creation' },
    });
  }

  // 2. CEO-actor history entries (status / priority / assignee changes)
  for (const h of issue.history.nodes) {
    if (!isCeoActor(h.actor)) continue;
    const cls = classifyHistoryEntry(h);
    if (!cls) continue;
    const before = reconstructStateAt(issue, h.createdAt);
    const priors = priorComments(issue, h.createdAt);
    const proposal = findPriorProposal(issue, h.createdAt);
    out.push({
      id: makeId(['hist', h.id]),
      ts: h.createdAt,
      decision_type: cls.type,
      category: cls.kind,
      is_ceo_decision: true,
      is_high_stakes: hs,
      negative_example: false,
      issue: ctx,
      context_at_decision: {
        state: before.state,
        priority: before.priority,
        assignee_role: before.assigneeRole,
        n_prior_comments: priors.length,
        prior_comments: priors,
        prior_proposal: proposal,
      },
      decision: {
        actor: 'ceo',
        kind: cls.kind,
        from: cls.kind === 'status-change' ? h.fromState?.name : cls.kind === 'edit-priority' ? h.fromPriority : h.fromAssignee?.name ?? null,
        to: cls.kind === 'status-change' ? h.toState?.name : cls.kind === 'edit-priority' ? h.toPriority : h.toAssignee?.name ?? null,
        comment_body: null,
        reasoning_excerpt: null,
      },
      tags,
      source: { linear_event_id: h.id, source_type: 'history' },
    });
  }

  // 3. CEO comments
  for (const c of issue.comments.nodes) {
    if (!isCeoActor(c.user)) continue;
    const cls = classifyCeoComment(c.body);
    const before = reconstructStateAt(issue, c.createdAt);
    const priors = priorComments(issue, c.createdAt);
    const proposal = findPriorProposal(issue, c.createdAt);
    out.push({
      id: makeId(['cmt', c.id]),
      ts: c.createdAt,
      decision_type: `comment:${cls.category}`,
      category: cls.category,
      is_ceo_decision: true,
      is_high_stakes: hs,
      negative_example: false,
      issue: ctx,
      context_at_decision: {
        state: before.state,
        priority: before.priority,
        assignee_role: before.assigneeRole,
        n_prior_comments: priors.length,
        prior_comments: priors,
        prior_proposal: proposal,
      },
      decision: {
        actor: 'ceo',
        kind: cls.category,
        comment_body: excerpt(c.body, 2000),
        reasoning_excerpt: cls.reasoning_excerpt ?? null,
        dispatch_target: cls.dispatch_target ?? null,
      },
      tags,
      source: { linear_event_id: c.id, source_type: 'comment' as SourceType },
    });
  }

  return out;
}

/**
 * Detect negative examples — proposals / `[to decide]` issues that the CEO
 * declined or let stall.
 *
 * Three heuristic flavours:
 *   1. `[to decide]` open ≥ 7d with zero CEO touch    → silent stall
 *   2. `[proactive]`/`[proposal]` open ≥ 14d with zero CEO touch
 *   3. `[proactive]`/`[proposal]`/`[to decide]` ended in Canceled with
 *      zero CEO comment beforehand → decline-by-omission (CEO didn't
 *      write the rejection rationale; they just let it die)
 */
function negativeExamplesFromIssue(issue: RawIssue, asOf: Date, sinceTs: string): DecisionEvent[] {
  const isToDecide = /\[to decide\]/i.test(issue.title);
  const isProactive = /\[proactive\]/i.test(issue.title) || /\[proposal\]/i.test(issue.title);
  if (!isToDecide && !isProactive) return [];

  const stateName = issue.state?.name ?? '';
  const isOpen = ['Backlog', 'Todo', 'In Progress', 'In Review'].includes(stateName);
  const isCanceled = stateName === 'Canceled';

  // Skip if created before our window (we don't have full history).
  if (issue.createdAt < sinceTs) return [];

  const ceoComment = issue.comments.nodes.find((c) => isCeoActor(c.user));
  const ceoHistoryEntry = issue.history.nodes.find((h) => isCeoActor(h.actor));
  const ceoTouched = !!(ceoComment || ceoHistoryEntry);

  const created = new Date(issue.createdAt).getTime();
  const asOfMs = asOf.getTime();
  const ageDays = (asOfMs - created) / (24 * 3600 * 1000);

  const ctx = buildIssueContext(issue);
  const hs = isHighStakes(issue);
  const baseTags = tagsForIssue(issue);

  // Flavour 1 + 2: open + stalled + zero CEO touch.
  if (isOpen && !ceoTouched) {
    const threshold = isToDecide ? SILENT_DECLINE_TO_DECIDE_DAYS : SILENT_DECLINE_PROACTIVE_DAYS;
    if (ageDays < threshold) return [];
    const proposal = findPriorProposal(issue, asOf.toISOString());
    const priors = priorComments(issue, asOf.toISOString());
    return [{
      id: makeId(['noop-stall', issue.id]),
      ts: asOf.toISOString(),
      decision_type: isToDecide ? 'no-action:to-decide-stall' : 'no-action:proactive-stall',
      category: 'no-action',
      is_ceo_decision: false,
      is_high_stakes: hs,
      negative_example: true,
      issue: ctx,
      context_at_decision: {
        state: stateName,
        priority: issue.priority,
        assignee_role: issue.assignee ? (roleFromName(issue.assignee.name) as AgentRole) : null,
        n_prior_comments: priors.length,
        prior_comments: priors,
        prior_proposal: proposal,
      },
      decision: {
        actor: 'ceo',
        kind: 'no-action',
        comment_body: null,
        reasoning_excerpt: `${isToDecide ? '[to decide]' : '[proactive/proposal]'} open ${ageDays.toFixed(1)}d in ${stateName}, zero CEO touches`,
      },
      tags: [...baseTags, 'silent-decline', 'silent-stall'],
      source: { linear_event_id: issue.id, source_type: 'to_decide_stall' },
    }];
  }

  // Flavour 3: ended in Canceled with no CEO comment beforehand (CEO
  // didn't write a decline rationale — they let it die).
  if (isCanceled && !ceoComment) {
    // Find the cancel-event timestamp (last history entry that toState=Canceled).
    const cancelEvt = [...issue.history.nodes]
      .reverse()
      .find((h) => h.toState?.name === 'Canceled');
    const cancelTs = cancelEvt?.createdAt ?? issue.updatedAt;
    if (cancelTs < sinceTs) return [];
    const cancelActor = cancelEvt?.actor;
    // If the CEO themselves canceled it AND wrote no comment, that's a
    // legitimate decline-by-omission. If an agent canceled it, the CEO's
    // non-response is more interesting (they let an agent kill it).
    const proposal = findPriorProposal(issue, cancelTs);
    const priors = priorComments(issue, cancelTs);
    return [{
      id: makeId(['noop-decline', issue.id]),
      ts: cancelTs,
      decision_type: 'no-action:declined-by-omission',
      category: 'no-action',
      is_ceo_decision: false,
      is_high_stakes: hs,
      negative_example: true,
      issue: ctx,
      context_at_decision: {
        state: 'Canceled',
        priority: issue.priority,
        assignee_role: issue.assignee ? (roleFromName(issue.assignee.name) as AgentRole) : null,
        n_prior_comments: priors.length,
        prior_comments: priors,
        prior_proposal: proposal,
      },
      decision: {
        actor: 'ceo',
        kind: 'no-action',
        comment_body: null,
        reasoning_excerpt: `Canceled by ${cancelActor?.name ?? 'unknown'} after ${ageDays.toFixed(1)}d, CEO never commented`,
      },
      tags: [...baseTags, 'silent-decline', 'decline-by-omission'],
      source: { linear_event_id: cancelEvt?.id ?? issue.id, source_type: 'to_decide_stall' },
    }];
  }

  return [];
}

export interface ExtractOptions {
  asOf?: Date;
  sinceTs: string;
}

export function extractEventsFromIssues(issues: Iterable<RawIssue>, opts: ExtractOptions): DecisionEvent[] {
  const asOf = opts.asOf ?? new Date();
  const events: DecisionEvent[] = [];
  for (const issue of issues) {
    events.push(...eventsFromIssue(issue));
    events.push(...negativeExamplesFromIssue(issue, asOf, opts.sinceTs));
  }
  // Sort by ts ascending.
  events.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return events;
}

export { CEO_USER_ID };
