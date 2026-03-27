/**
 * Barrel re-export for backward compatibility.
 * Actual implementations split into:
 *   - linear-client.ts   (client mgmt, auth, GraphQL, workflow states)
 *   - linear-issues.ts   (issue CRUD, comments, labels, documents)
 *   - linear-sessions.ts (AgentSession operations)
 * See RYA-117 Finding 6, RYA-142.
 */

export {
  getReadClient,
  getAgentClient,
  refreshAgentClient,
  hasAgentAccess,
  getWorkflowStateId,
} from './linear-client.js';

export {
  getIssue,
  getIssuesByLabel,
  getLatestUserComment,
  getRecentCommentBodies,
  getCommentAuthor,
  getAgentCommentCountSince,
  addComment,
  updateIssueState,
  addLabelToIssue,
  removeLabelFromIssue,
  ensureLabelsExist,
  createIssueDocument,
  generateHandoffSummary,
  linkifyDeliverables,
} from './linear-issues.js';

export {
  closeActiveSessionsForIssue,
  createAgentSession,
  emitActivity,
  updateAgentPlan,
  globalDismissedSessions,
  dismissAgentSession,
  addExternalLink,
  listAgentSessions,
} from './linear-sessions.js';

export type { AgentSessionInfo } from './linear-sessions.js';

export {
  getIssueRelations,
  createRelation,
  removeRelation,
  formatRelationsForPrompt,
} from './linear-relations.js';

export type { IssueRelationInfo } from '../types.js';
