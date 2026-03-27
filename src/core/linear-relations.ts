/**
 * Linear issue relation operations: blocking, duplicates, related issues.
 * Issue Relations support.
 *
 * Relation types in Linear:
 *   - blocks: issue A blocks issue B (B cannot proceed until A is done)
 *   - duplicate: issue A is a duplicate of issue B
 *   - related: generic relation between two issues
 *   - similar: treated as 'related' in our system
 *
 * Direction matters for 'blocks':
 *   - issue.relations() returns relations where THIS issue is the source
 *     (e.g., "this issue blocks X")
 *   - issue.inverseRelations() returns relations where THIS issue is the target
 *     (e.g., "this issue is blocked by Y")
 */

import { LinearClient } from '@linear/sdk';
import { getReadClient, getAgentClient, hasAgentAccess, graphql } from './linear-client.js';
import { getConfig } from './config.js';
import { getLinearApiKey } from './keychain.js';
import type { IssueRelationInfo } from '../types.js';

/**
 * Get all relations for an issue (both directions) using a single GraphQL query.
 * Returns a unified list with normalized types:
 *   - 'blocks': this issue blocks the related issue
 *   - 'blocked_by': this issue is blocked by the related issue
 *   - 'related': generic relation
 *   - 'duplicate': this issue is a duplicate of the related issue
 */
export async function getIssueRelations(issueKey: string): Promise<IssueRelationInfo[]> {
  const config = getConfig();
  const [teamKey, numStr] = issueKey.split('-');
  const num = parseInt(numStr, 10);

  // Single GraphQL query to fetch both forward and inverse relations
  const data = await graphql(getLinearApiKey(), `
    query($teamKey: String!, $num: Float!) {
      issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $num } }) {
        nodes {
          id
          relations {
            nodes {
              id
              type
              relatedIssue {
                identifier
                title
                state { name }
              }
            }
          }
          inverseRelations {
            nodes {
              id
              type
              issue {
                identifier
                title
                state { name }
              }
            }
          }
        }
      }
    }
  `, { teamKey, num });

  const issues = data.issues as { nodes: any[] };
  if (!issues?.nodes?.length) throw new Error(`Issue ${issueKey} not found`);

  const issue = issues.nodes[0];
  const results: IssueRelationInfo[] = [];

  // Forward relations: this issue → related issue
  for (const rel of issue.relations?.nodes ?? []) {
    const ri = rel.relatedIssue;
    if (!ri) continue;

    results.push({
      id: rel.id,
      type: normalizeRelationType(rel.type, 'forward'),
      issueKey: ri.identifier,
      issueTitle: ri.title,
      issueState: ri.state?.name,
    });
  }

  // Inverse relations: related issue → this issue
  for (const rel of issue.inverseRelations?.nodes ?? []) {
    const src = rel.issue;
    if (!src) continue;

    results.push({
      id: rel.id,
      type: normalizeRelationType(rel.type, 'inverse'),
      issueKey: src.identifier,
      issueTitle: src.title,
      issueState: src.state?.name,
    });
  }

  return results;
}

/**
 * Create a relation between two issues.
 * The Linear SDK accepts issue identifiers (e.g., 'ENG-123') directly.
 *
 * @param issueKey - The source issue (e.g., 'ENG-147')
 * @param relatedKey - The related issue (e.g., 'ENG-100')
 * @param type - 'blocks' | 'blocked_by' | 'related' | 'duplicate'
 * @param agentToken - Optional agent OAuth token for writes
 */
export async function createRelation(
  issueKey: string,
  relatedKey: string,
  type: 'blocks' | 'blocked_by' | 'related' | 'duplicate',
  agentToken?: string,
): Promise<void> {
  const client = agentToken
    ? new LinearClient({ accessToken: agentToken })
    : (hasAgentAccess() ? getAgentClient() : getReadClient());

  // For 'blocked_by', reverse the direction:
  // "A is blocked_by B" → create relation "B blocks A"
  let issueId: string;
  let relatedIssueId: string;
  let relationType: string;

  if (type === 'blocked_by') {
    issueId = relatedKey;
    relatedIssueId = issueKey;
    relationType = 'blocks';
  } else {
    issueId = issueKey;
    relatedIssueId = relatedKey;
    relationType = type;
  }

  await client.createIssueRelation({
    issueId,
    relatedIssueId,
    type: relationType as any,
  });
}

/**
 * Remove a relation between two issues.
 * Finds the matching relation and deletes it.
 */
export async function removeRelation(
  issueKey: string,
  relatedKey: string,
  type?: string,
): Promise<boolean> {
  const relations = await getIssueRelations(issueKey);
  const matching = relations.filter(r =>
    r.issueKey === relatedKey && (!type || r.type === type),
  );

  if (matching.length === 0) return false;

  const client = hasAgentAccess() ? getAgentClient() : getReadClient();
  for (const rel of matching) {
    await client.deleteIssueRelation(rel.id);
  }
  return true;
}

/**
 * Format relations for inclusion in an agent's task prompt.
 * Returns empty string if no relations exist.
 */
export function formatRelationsForPrompt(relations: IssueRelationInfo[]): string {
  if (relations.length === 0) return '';

  const blocked = relations.filter(r => r.type === 'blocked_by');
  const blocking = relations.filter(r => r.type === 'blocks');
  const related = relations.filter(r => r.type === 'related');
  const duplicates = relations.filter(r => r.type === 'duplicate');

  const parts: string[] = ['## Issue Relations'];

  if (blocked.length > 0) {
    parts.push('\n**BLOCKED BY:**');
    for (const r of blocked) {
      parts.push(`- ${r.issueKey}: ${r.issueTitle} [${r.issueState || 'Unknown'}]`);
    }
    parts.push('');
    parts.push('> This issue has unresolved blockers. Check if the blocking issues are resolved before starting work.');
    parts.push('> If a blocker is resolved, use `linear-tool unblock <this-issue> <blocking-issue>` to remove it.');
  }

  if (blocking.length > 0) {
    parts.push('\n**BLOCKING:**');
    for (const r of blocking) {
      parts.push(`- ${r.issueKey}: ${r.issueTitle} [${r.issueState || 'Unknown'}]`);
    }
    parts.push('');
    parts.push('> Other issues are waiting on this one. Prioritize accordingly.');
  }

  if (related.length > 0) {
    parts.push('\n**Related:**');
    for (const r of related) {
      parts.push(`- ${r.issueKey}: ${r.issueTitle}`);
    }
  }

  if (duplicates.length > 0) {
    parts.push('\n**Duplicates:**');
    for (const r of duplicates) {
      parts.push(`- ${r.issueKey}: ${r.issueTitle}`);
    }
  }

  return parts.join('\n');
}

// --- Internal helpers ---

function normalizeRelationType(
  rawType: string,
  direction: 'forward' | 'inverse',
): IssueRelationInfo['type'] {
  switch (rawType) {
    case 'blocks':
      return direction === 'forward' ? 'blocks' : 'blocked_by';
    case 'duplicate':
      return 'duplicate';
    case 'related':
    case 'similar':
      return 'related';
    default:
      return 'related';
  }
}
