/**
 * Types for the CEO Shadow decision corpus.
 *
 * One DecisionEvent per line of corpus.jsonl. Schema is stable across
 * fetch/classify changes — see ./README.md.
 *
 * RYA-845 — labeled CEO decision corpus for the Shadow predictor (RYA-765).
 */

export type DecisionCategory =
  | 'approve'
  | 'reject'
  | 'dispatch'
  | 'edit-priority'
  | 'status-change'
  | 'create'
  | 'comment'
  | 'no-action';

export type SourceType =
  | 'history'         // status/priority/assignment edit from issue history
  | 'comment'         // CEO authored a Linear comment
  | 'issue_creation'  // CEO opened an issue
  | 'to_decide_stall'; // negative example — CEO never acted on a `[to decide]`

export type AgentRole =
  | 'ceo'
  | 'ceo-office'
  | 'cto'
  | 'cpo'
  | 'coo'
  | 'lead-engineer'
  | 'research-lead'
  | 'qa-engineer'
  | 'engineer'
  | 'ops'
  | 'strategist'
  | 'linear-bot'
  | 'unknown';

export interface PriorComment {
  author_role: AgentRole;
  ts: string;
  body_excerpt: string;
}

export interface IssueContext {
  key: string;
  title: string;
  description_excerpt: string;
  creator_role: AgentRole;
  parent_key: string | null;
  labels: string[];
}

export interface DecisionContextAtTime {
  state: string;
  priority: number | null;
  assignee_role: AgentRole | null;
  n_prior_comments: number;
  prior_comments: PriorComment[];
  prior_proposal: string | null;
}

export interface DecisionPayload {
  actor: AgentRole;
  kind: DecisionCategory;
  from?: string | number | null;
  to?: string | number | null;
  comment_body?: string | null;
  reasoning_excerpt?: string | null;
  /** target role when `kind === 'dispatch'` (best-effort parse). */
  dispatch_target?: AgentRole | null;
}

export interface DecisionEventSource {
  linear_event_id: string;
  source_type: SourceType;
}

export interface DecisionEvent {
  /** Stable hash-based id for deduplication. */
  id: string;
  /** ISO-8601 timestamp of the decision. */
  ts: string;
  decision_type: string;
  category: DecisionCategory;
  is_ceo_decision: boolean;
  is_high_stakes: boolean;
  negative_example: boolean;
  issue: IssueContext;
  context_at_decision: DecisionContextAtTime;
  decision: DecisionPayload;
  tags: string[];
  source: DecisionEventSource;
}

/** Raw shape returned by the Linear GraphQL query — kept loose on purpose. */
export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  createdAt: string;
  updatedAt: string;
  creator: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  state: { name: string; type?: string } | null;
  parent: { identifier: string; title?: string } | null;
  labels: { nodes: { name: string }[] };
  history: { nodes: RawHistoryEntry[] };
  comments: { nodes: RawComment[] };
}

export interface RawHistoryEntry {
  id: string;
  createdAt: string;
  fromState: { name: string } | null;
  toState: { name: string } | null;
  fromPriority: number | null;
  toPriority: number | null;
  fromAssignee: { name: string } | null;
  toAssignee: { name: string } | null;
  fromTitle?: string | null;
  toTitle?: string | null;
  fromParent?: { identifier: string } | null;
  toParent?: { identifier: string } | null;
  actor: { id: string; name: string } | null;
}

export interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string } | null;
}
