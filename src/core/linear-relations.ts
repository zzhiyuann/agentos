/**
 * Linear issue relation operations: blocking, duplicates, related issues.
 * New module for RYA-147: Issue Relations support.
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
 * The Linear SDK accepts issue identifiers (e.g., 'RYA-123') directly.
 *
 * @param issueKey - The source issue (e.g., 'RYA-147')
 * @param relatedKey - The related issue (e.g., 'RYA-100')
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

/**
 * Check if an issue has any unresolved blocked_by relations.
 * A blocker is "unresolved" if its state is NOT Done or Canceled.
 * Returns { blocked: true, blockers: [...] } if blocked, { blocked: false } otherwise.
 */
export async function isBlocked(issueKey: string): Promise<{
  blocked: boolean;
  blockers: Array<{ issueKey: string; issueTitle: string; issueState: string }>;
}> {
  try {
    const relations = await getIssueRelations(issueKey);
    const blockedBy = relations.filter(r => r.type === 'blocked_by');
    if (blockedBy.length === 0) return { blocked: false, blockers: [] };

    const unresolvedBlockers = blockedBy.filter(r => {
      const state = (r.issueState || '').toLowerCase();
      return state !== 'done' && state !== 'canceled' && state !== 'cancelled';
    });

    return {
      blocked: unresolvedBlockers.length > 0,
      blockers: unresolvedBlockers.map(r => ({
        issueKey: r.issueKey,
        issueTitle: r.issueTitle,
        issueState: r.issueState || 'Unknown',
      })),
    };
  } catch (err) {
    // If we can't fetch relations (API error), don't block dispatch — fail open
    console.warn(`[linear-relations] isBlocked(${issueKey}) API error: ${(err as Error).message}`);
    return { blocked: false, blockers: [] };
  }
}

/**
 * Check if an issue is a duplicate of another issue that is already Done.
 *
 * Direction matters: only FORWARD `duplicate` relations indicate that THIS issue
 * is the duplicate (and the related issue is the canonical). Inverse `duplicate`
 * relations would mean the OPPOSITE — the other issue is the duplicate of us —
 * so we must NOT inspect them here.
 *
 * Returns `{ canonicalKey, canonicalState }` when this issue is a forward
 * duplicate of an issue in Done state. Returns null otherwise. Fails open on
 * Linear API errors so transient blips never block dispatch.
 *
 * Used by auto-dispatch / dispatch paths to prevent spawning a session on an
 * issue that Linear has already marked as duplicate-of a completed issue
 * (RYA-1071: the canonical work is already delivered — no work for the agent).
 */
export async function isDuplicateOfDone(issueKey: string): Promise<{
  canonicalKey: string;
  canonicalState: string;
} | null> {
  try {
    const config = getConfig();
    const [teamKey, numStr] = issueKey.split('-');
    const num = parseInt(numStr, 10);

    // Forward-only query: we only care about relations where THIS issue is the
    // source of a 'duplicate' relation (i.e. THIS is the duplicate, related is
    // the canonical). Inverse relations would surface duplicates pointing AT us
    // — wrong direction for this check.
    const data = await graphql(getLinearApiKey(), `
      query($teamKey: String!, $num: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $num } }) {
          nodes {
            relations {
              nodes {
                type
                relatedIssue {
                  identifier
                  state { name }
                }
              }
            }
          }
        }
      }
    `, { teamKey, num });

    const issues = data.issues as { nodes: any[] };
    if (!issues?.nodes?.length) return null;

    for (const rel of issues.nodes[0].relations?.nodes ?? []) {
      if (rel.type !== 'duplicate') continue;
      const ri = rel.relatedIssue;
      if (!ri) continue;
      const state = (ri.state?.name || '').toLowerCase();
      // Treat Canceled as 'already terminal' too — the canonical isn't going to
      // be picked up either way, so spawning on the duplicate is still waste.
      if (state === 'done' || state === 'canceled' || state === 'cancelled') {
        return { canonicalKey: ri.identifier, canonicalState: ri.state?.name || 'Done' };
      }
    }
    return null;
  } catch (err) {
    console.warn(`[linear-relations] isDuplicateOfDone(${issueKey}) API error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Find issues that are blocked by the given issue key.
 * Used when an issue completes to check if dependents can now be unblocked.
 * Returns issue keys that have a "blocked_by" relation pointing to this issue.
 */
export async function getDependentIssues(issueKey: string): Promise<Array<{
  issueKey: string;
  issueTitle: string;
  issueState: string;
}>> {
  try {
    const relations = await getIssueRelations(issueKey);
    // "blocks" type means this issue blocks the related issue
    const blocking = relations.filter(r => r.type === 'blocks');
    return blocking.map(r => ({
      issueKey: r.issueKey,
      issueTitle: r.issueTitle,
      issueState: r.issueState || 'Unknown',
    }));
  } catch (err) {
    console.warn(`[linear-relations] getDependentIssues(${issueKey}) API error: ${(err as Error).message}`);
    return [];
  }
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
