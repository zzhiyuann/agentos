/**
 * Linear issue operations: CRUD, comments, labels, documents, handoff summaries.
 * Split from linear.ts — see RYA-117 Finding 6, RYA-142.
 */

import { LinearClient, Issue, LinearDocument } from '@linear/sdk';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { getLinearApiKey } from './keychain.js';
import { getConfig } from './config.js';
import { getReadClient, getAgentClient, hasAgentAccess, getWorkflowStateId, graphql } from './linear-client.js';
import type { LinearIssueInfo } from '../types.js';

// --- Issue Operations (read client) ---

export async function getIssue(idOrKey: string): Promise<LinearIssueInfo> {
  const client = getReadClient();
  let issue: Issue;

  if (idOrKey.includes('-')) {
    const issues = await client.issues({
      filter: {
        team: { key: { eq: getConfig().linearTeamKey } },
        number: { eq: parseInt(idOrKey.split('-')[1]) },
      },
    });
    if (issues.nodes.length === 0) throw new Error(`Issue ${idOrKey} not found`);
    issue = issues.nodes[0];
  } else {
    issue = await client.issue(idOrKey);
  }

  const labels = await issue.labels();
  const state = await issue.state;
  const project = await issue.project;

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    priority: issue.priority,
    labels: labels.nodes.map((l) => l.name),
    state: state?.name ?? 'Unknown',
    url: issue.url,
    project: project?.name ?? undefined,
    delegateId: (issue as any).delegateId,
    assigneeId: (issue as any).assigneeId,
  };
}

export async function getIssuesByLabel(labelName: string, stateName?: string): Promise<LinearIssueInfo[]> {
  const client = getReadClient();
  const config = getConfig();

  const filter: Record<string, unknown> = {
    team: { key: { eq: config.linearTeamKey } },
    labels: { name: { eq: labelName } },
  };

  if (stateName) {
    filter.state = { name: { eq: stateName } };
  }

  const issues = await client.issues({ filter });
  const results: LinearIssueInfo[] = [];

  for (const issue of issues.nodes) {
    const labels = await issue.labels();
    const state = await issue.state;
    results.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      priority: issue.priority,
      labels: labels.nodes.map((l) => l.name),
      state: state?.name ?? 'Unknown',
      url: issue.url,
    });
  }

  return results;
}

// --- Comment Operations ---

/** Patterns that indicate agent/system comments (not real user questions) */
const AGENT_COMMENT_PATTERNS = [
  /^This thread is for an agent session/i,
  /^Done\.?$/,
  /^Session complete\.?$/,
  /^Session replaced/i,
  /^Dismissed/i,
  /^Stale session/i,
  /^Follow-up (answered|timed out)/i,
  /^Handing off to /i,
  /^No routing signal/i,
  /^–$/,
  /^\*\*Quality check warnings/,
  /^Handoff accepted/,
  /^# HANDOFF/,
  /^\*\*Agent failed after/,
  /^Agent session ended/,
  /^\*\*Automatic retries paused/,
];

/** Get the latest user comment on an issue.
 *  Returns { body, id, threadRootId } where:
 *  - body/id: the actual latest user comment (may be a reply)
 *  - threadRootId: the top-level comment ID to use as parentId for threading
 *    (same as id if the comment is top-level, or the root parent if it's a reply) */
export async function getLatestUserComment(issueId: string): Promise<{ body: string; id: string; threadRootId: string } | null> {
  const client = getReadClient();
  const issue = await client.issue(issueId);
  const comments = await issue.comments({ first: 10, orderBy: LinearDocument.PaginationOrderBy.UpdatedAt });
  for (const comment of comments.nodes) {
    const user = await comment.user;
    if (!user) continue;
    // Skip comments matching known agent/system patterns
    if (AGENT_COMMENT_PATTERNS.some(p => p.test(comment.body))) continue;
    // Skip bot users (agents are bots in Linear)
    if ((user as any).app) continue;
    // For threading: if this is a reply, walk up to the top-level root
    const parent = await comment.parent;
    const threadRootId = parent ? parent.id : comment.id;
    return { body: comment.body, id: comment.id, threadRootId };
  }
  return null;
}

/** Get recent comment bodies on an issue (for dedup checks) */
export async function getRecentCommentBodies(issueId: string, count = 5): Promise<string[]> {
  try {
    const client = getReadClient();
    const issue = await client.issue(issueId);
    const comments = await issue.comments({ first: count, orderBy: LinearDocument.PaginationOrderBy.UpdatedAt });
    return comments.nodes.map((c) => c.body);
  } catch {
    return [];
  }
}

/** Patterns that indicate system boilerplate (not substantive progress comments) */
const SYSTEM_BOILERPLATE_PATTERNS = [
  ...AGENT_COMMENT_PATTERNS,
  /^\*\*Progress comment check/i,
  /^⚠️ No progress comments/i,
];

/**
 * Count substantive agent-authored comments on an issue since a given time.
 * Used by the monitor to detect silent sessions (>10min, zero comments).
 * Filters out system boilerplate like "Done.", "Session complete.", quality warnings, etc.
 */
export async function getAgentCommentCountSince(
  issueId: string,
  agentUserId: string,
  sinceIso: string,
): Promise<number> {
  try {
    const client = getReadClient();
    const issue = await client.issue(issueId);
    const comments = await issue.comments({
      first: 50,
      orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
    });

    const sinceMs = new Date(sinceIso).getTime();
    let count = 0;

    for (const comment of comments.nodes) {
      // Filter by time — only comments after the attempt started
      const createdAt = new Date(comment.createdAt).getTime();
      if (createdAt < sinceMs) continue;

      // Filter by author — must be the agent's Linear user
      const user = await comment.user;
      if (!user || user.id !== agentUserId) continue;

      // Filter out system boilerplate — these aren't real progress comments
      if (SYSTEM_BOILERPLATE_PATTERNS.some(p => p.test(comment.body))) continue;

      // Must be substantive (>30 chars after stripping whitespace)
      if (comment.body.trim().length < 30) continue;

      count++;
    }

    return count;
  } catch {
    return -1; // Return -1 on error so callers can distinguish "no comments" from "API error"
  }
}

/** Get the author (user ID) of a specific comment */
export async function getCommentAuthor(commentId: string): Promise<string | null> {
  try {
    const client = getReadClient();
    const comment = await client.comment({ id: commentId });
    const user = await comment.user;
    return user?.id || null;
  } catch {
    return null;
  }
}

// --- Write Operations ---

export async function addComment(issueId: string, body: string, agentToken?: string, parentId?: string): Promise<void> {
  // Use per-agent token if provided, otherwise fall back to AgentOS or personal
  const input: { issueId: string; body: string; parentId?: string } = { issueId, body };
  if (parentId) input.parentId = parentId;
  if (agentToken) {
    const client = new LinearClient({ accessToken: agentToken });
    await client.createComment(input);
  } else {
    const client = hasAgentAccess() ? getAgentClient() : getReadClient();
    await client.createComment(input);
  }
}

export async function updateIssueState(issueId: string, stateName: string, agentToken?: string): Promise<void> {
  const stateId = await getWorkflowStateId(stateName);
  if (agentToken) {
    const client = new LinearClient({ accessToken: agentToken });
    await client.updateIssue(issueId, { stateId });
  } else {
    const client = getReadClient();
    await client.updateIssue(issueId, { stateId });
  }
}

export async function addLabelToIssue(issueId: string, labelName: string): Promise<void> {
  const client = getReadClient();
  const labels = await client.issueLabels({ filter: { name: { eq: labelName } } });
  if (labels.nodes.length === 0) throw new Error(`Label "${labelName}" not found`);

  const issue = await client.issue(issueId);
  const existingLabels = await issue.labels();
  const labelIds = [...existingLabels.nodes.map((l) => l.id), labels.nodes[0].id];
  await client.updateIssue(issueId, { labelIds });
}

export async function removeLabelFromIssue(issueId: string, labelName: string): Promise<void> {
  const client = getReadClient();
  const issue = await client.issue(issueId);
  const existingLabels = await issue.labels();
  const labelIds = existingLabels.nodes.filter((l) => l.name !== labelName).map((l) => l.id);
  await client.updateIssue(issueId, { labelIds });
}

export async function ensureLabelsExist(): Promise<void> {
  const client = getReadClient();
  const config = getConfig();
  const existingLabels = await client.issueLabels();
  const existingNames = new Set(existingLabels.nodes.map((l) => l.name));

  const requiredLabels = [
    { name: 'agent:cc', color: '#6366f1', description: 'Assign to Claude Code agent' },
    { name: 'agent:codex', color: '#8b5cf6', description: 'Assign to Codex agent' },
    { name: 'agent:blocked', color: '#ef4444', description: 'Agent is blocked' },
    { name: 'agent:done', color: '#22c55e', description: 'Agent completed work' },
    { name: 'Plan', color: '#f59e0b', description: 'Auto-decompose into sub-issues via planner' },
  ];

  for (const label of requiredLabels) {
    if (!existingNames.has(label.name)) {
      await client.createIssueLabel({
        name: label.name,
        color: label.color,
        description: label.description,
        teamId: config.linearTeamId,
      });
    }
  }
}

// --- Documents ---

export async function createIssueDocument(issueId: string, title: string, content: string): Promise<string | null> {
  try {
    const data = await graphql(getLinearApiKey(), `
      mutation($input: DocumentCreateInput!) {
        documentCreate(input: $input) {
          success
          document { id url }
        }
      }
    `, { input: { issueId, title, content } });
    const result = data.documentCreate as { success: boolean; document: { id: string; url: string } } | undefined;
    return result?.document?.url ?? null;
  } catch (err) {
    console.error('Failed to create document:', (err as Error).message);
    return null;
  }
}

// --- Utilities ---

/** Extract a 2-3 sentence summary from HANDOFF.md content.
 *  Looks for ## Summary section first, then falls back to first substantial lines. */
export function generateHandoffSummary(handoff: string, maxLength = 300): string {
  // Try to find a ## Summary section
  const summaryMatch = handoff.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|\n---|\n\n\n|$)/i);
  if (summaryMatch) {
    const text = summaryMatch[1].trim().replace(/^[-*]\s*/gm, '');
    const sentences = text.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
    if (sentences.length > 0) return sentences.substring(0, maxLength);
  }

  // Fallback: take first 2-3 substantial lines (skip headings, rules, tables)
  const lines = handoff.split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('|') && !l.startsWith('- ['))
    .slice(0, 3);

  const summary = lines.join(' ').replace(/\s+/g, ' ').trim();
  return summary.substring(0, maxLength) || 'Task completed. See handoff document for details.';
}

/**
 * Scan comment text for deliverable file references and upload them as Linear Documents.
 * Replaces plain filenames with markdown links to the uploaded documents.
 *
 * Detects patterns like:
 * - `BRAND-PLAYBOOK.md` (bare filenames at line start or after bullet/number)
 * - `./BRAND-PLAYBOOK.md` (relative paths)
 * - `/path/to/BRAND-PLAYBOOK.md` (absolute paths)
 *
 * Skips HANDOFF.md (handled separately) and non-.md files.
 */
export async function linkifyDeliverables(
  text: string,
  workspacePath: string,
  issueId: string,
): Promise<string> {
  // Match filenames that look like deliverables: uppercase/kebab .md files
  // referenced standalone on a line (e.g., in bullet lists or numbered lists)
  // Pattern: captures the filename portion like BRAND-PLAYBOOK.md or launch-checklist.md
  const fileRefPattern = /(?:^|\s|[-*•]\s*|\d+\.\s*)((?:\.\/)?([A-Z][A-Z0-9_-]+\.md))\b/gm;
  const seen = new Set<string>();
  const replacements: { original: string; filename: string; url: string }[] = [];

  let match;
  while ((match = fileRefPattern.exec(text)) !== null) {
    const fullRef = match[1]; // e.g., ./BRAND-PLAYBOOK.md or BRAND-PLAYBOOK.md
    const filename = match[2]; // e.g., BRAND-PLAYBOOK.md

    // Skip HANDOFF.md (linked separately), BLOCKED.md, PROGRESS.md
    if (/^(HANDOFF|BLOCKED|PROGRESS)\.md$/i.test(filename)) continue;
    if (seen.has(filename)) continue;
    seen.add(filename);

    // Try to find the file in the workspace
    const candidates = [
      join(workspacePath, filename),
      join(workspacePath, fullRef),
    ];
    const filePath = candidates.find(p => existsSync(p));
    if (!filePath) continue;

    // Read and upload as a Linear Document
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (!content.trim()) continue;

      const title = filename.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
      const url = await createIssueDocument(issueId, title, content);
      if (url) {
        replacements.push({ original: filename, filename, url });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  // Apply replacements: turn bare filenames into markdown links
  let result = text;
  for (const { original, filename, url } of replacements) {
    // Replace standalone references (not already inside a markdown link)
    // Use a regex that avoids replacing inside existing [text](url) patterns
    const safePattern = new RegExp(
      `(?<!\\[)\\b${escapeRegex(original)}\\b(?!\\])(?!\\()`,
      'g'
    );
    result = result.replace(safePattern, `[📄 ${filename}](${url})`);
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
