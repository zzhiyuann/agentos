export interface AosConfig {
  linearTeamId: string;
  linearTeamKey: string;
  execHost: string;
  execUser: string;
  workspaceBase: string;
  dbPath: string;
  pollIntervalMs: number;
  stateDir: string;
  tunnelUrl: string;
}

export interface Session {
  id: string;
  issue_id: string;
  issue_key: string;
  tmux_session: string;
  agent_type: string;
  host: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  workspace_path: string;
  created_at: string;
  updated_at: string;
  cost_usd: number;
  error_log: string | null;
}

export interface SessionEvent {
  id: number;
  session_id: string;
  event_type: 'spawned' | 'progress' | 'completed' | 'failed' | 'cost_update' | 'killed';
  payload: string | null;
  created_at: string;
}

export interface LinearIssueInfo {
  id: string;
  identifier: string;
  title: string;
  description: string | undefined;
  priority: number;
  labels: string[];
  state: string;
  url: string;
  project?: string;
  delegateId?: string;
  assigneeId?: string;
}

export interface IssueRelationInfo {
  id: string;
  type: 'blocks' | 'blocked_by' | 'related' | 'duplicate';
  issueKey: string;
  issueTitle: string;
  issueState?: string;
}

export const WORKFLOW_STATES = {
  BACKLOG: 'Backlog',
  TODO: 'Todo',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
  CANCELED: 'Canceled',
} as const;

export const AGENT_LABELS = {
  CC: 'agent:cc',
  CODEX: 'agent:codex',
  BLOCKED: 'agent:blocked',
} as const;
