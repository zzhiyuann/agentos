/**
 * Cross-agent context sharing: builds team context for agents working on related issues.
 * When an agent starts, it gets a summary of what sibling agents are doing/have done.
 * When an agent completes, its findings are broadcast to active sibling agents.
 *
 * "Sibling" = issues sharing the same parent issue in Linear.
 * "Related" = issues connected via Linear relations (related, blocking).
 *
 * See RYA-315.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { graphql } from './linear-client.js';
import { getLinearApiKey } from './keychain.js';
import { getIssueStateDir } from './config.js';
import { getActiveAttempts } from './db.js';
import { getIssueRelations } from './linear-relations.js';
import { generateHandoffSummary } from './linear-issues.js';
import { sendKeys, sessionExists } from './tmux.js';

/** Max characters for the entire team context section (~500 tokens) */
const MAX_CONTEXT_CHARS = 2000;

export interface SiblingIssue {
  issueKey: string;
  title: string;
  state: string;
}

/**
 * Query Linear for sibling issues — issues with the same parent as the given issue.
 * Returns empty array if the issue has no parent or on API error.
 */
export async function getSiblingIssues(issueKey: string): Promise<SiblingIssue[]> {
  try {
    const [teamKey, numStr] = issueKey.split('-');
    const num = parseInt(numStr, 10);

    const data = await graphql(getLinearApiKey(), `
      query($teamKey: String!, $num: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $num } }) {
          nodes {
            id
            parent {
              id
              identifier
              children {
                nodes {
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
    if (!issues?.nodes?.length) return [];

    const parent = issues.nodes[0].parent;
    if (!parent?.children?.nodes) return [];

    return parent.children.nodes
      .filter((c: any) => c.identifier !== issueKey) // exclude self
      .map((c: any) => ({
        issueKey: c.identifier,
        title: c.title,
        state: c.state?.name ?? 'Unknown',
      }));
  } catch (err) {
    console.debug(`[team-context] getSiblingIssues(${issueKey}) failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Build team context section for an agent's task prompt.
 * Shows: what sibling agents are working on, recently completed sibling work.
 * Returns empty string if no relevant context.
 */
export async function buildTeamContext(issueKey: string): Promise<string> {
  try {
    const activeAttempts = getActiveAttempts();
    const parts: string[] = ['## Team Context'];
    let totalLen = 0;

    // Query siblings (same parent issue)
    const siblings = await getSiblingIssues(issueKey);

    if (siblings.length > 0) {
      // Section 1: Active sibling work — what agents are currently doing
      const activeSiblings: Array<{ issueKey: string; title: string; role: string }> = [];
      for (const sib of siblings) {
        const attempt = activeAttempts.find(a => a.issue_key === sib.issueKey && a.status === 'running');
        if (attempt) {
          activeSiblings.push({
            issueKey: sib.issueKey,
            title: sib.title,
            role: attempt.agent_type,
          });
        }
      }

      if (activeSiblings.length > 0) {
        parts.push('\n**Active sibling work:**');
        for (const s of activeSiblings) {
          const line = `- ${s.issueKey}: ${s.title} (${s.role} working)`;
          if (totalLen + line.length > MAX_CONTEXT_CHARS) break;
          parts.push(line);
          totalLen += line.length;
        }
      }

      // Section 2: Recently completed sibling work — key findings
      const completedSiblings: Array<{ issueKey: string; title: string; summary: string }> = [];
      for (const sib of siblings) {
        if (sib.state !== 'Done' && sib.state !== 'In Review') continue;
        if (totalLen > MAX_CONTEXT_CHARS) break;

        // Try to read HANDOFF.md from the sibling's state dir
        const stateDir = getIssueStateDir(sib.issueKey);
        const handoffPath = join(stateDir, 'HANDOFF.md');
        if (!existsSync(handoffPath)) continue;

        try {
          const handoff = readFileSync(handoffPath, 'utf-8');
          const summary = generateHandoffSummary(handoff, 200);
          if (summary) {
            completedSiblings.push({
              issueKey: sib.issueKey,
              title: sib.title,
              summary,
            });
            totalLen += sib.issueKey.length + sib.title.length + summary.length + 20;
          }
        } catch (err: unknown) {
          console.debug(`[team-context] skip unreadable handoff ${sib.issueKey}:`, (err as Error).message);
        }
      }

      if (completedSiblings.length > 0) {
        parts.push('\n**Recently completed sibling work:**');
        for (const s of completedSiblings) {
          if (totalLen > MAX_CONTEXT_CHARS) break;
          parts.push(`- ${s.issueKey} (${s.title}): ${s.summary}`);
        }
      }
    }

    // Section 3: Related issues with active agents (from Linear relations, independent of siblings)
    try {
      const relations = await getIssueRelations(issueKey);
      const relatedKeys = relations
        .filter(r => r.type === 'related' || r.type === 'blocked_by' || r.type === 'blocks')
        .map(r => r.issueKey);

      const activeRelated: Array<{ issueKey: string; title: string; role: string }> = [];
      for (const key of relatedKeys) {
        const attempt = activeAttempts.find(a => a.issue_key === key && a.status === 'running');
        if (attempt) {
          const rel = relations.find(r => r.issueKey === key);
          activeRelated.push({
            issueKey: key,
            title: rel?.issueTitle ?? key,
            role: attempt.agent_type,
          });
        }
      }

      if (activeRelated.length > 0 && totalLen < MAX_CONTEXT_CHARS) {
        parts.push('\n**Active related work:**');
        for (const r of activeRelated) {
          const line = `- ${r.issueKey}: ${r.title} (${r.role} working)`;
          totalLen += line.length;
          if (totalLen > MAX_CONTEXT_CHARS) break;
          parts.push(line);
        }
      }
    } catch (err) {
      console.debug(`[team-context] relation lookup for ${issueKey} failed: ${(err as Error).message}`);
    }

    // Only return if we have actual content beyond the header
    if (parts.length <= 1) return '';

    parts.push('');
    parts.push('> Coordinate with active agents if your work overlaps. Check their HANDOFF.md for findings.');
    return parts.join('\n');
  } catch (err) {
    console.debug(`[team-context] buildTeamContext(${issueKey}) failed: ${(err as Error).message}`);
    return '';
  }
}

/**
 * Broadcast completion summary to active agents working on sibling issues.
 * Called when an agent completes its work (HANDOFF.md detected).
 * Sends a brief [TEAM] message into their tmux sessions.
 */
export async function broadcastCompletion(
  completedIssueKey: string,
  completedRole: string,
  summary: string,
): Promise<void> {
  try {
    const siblings = await getSiblingIssues(completedIssueKey);
    if (siblings.length === 0) return;

    const activeAttempts = getActiveAttempts();
    const truncatedSummary = summary.length > 300 ? summary.substring(0, 297) + '...' : summary;
    const message = `[TEAM] ${completedRole} completed ${completedIssueKey}: ${truncatedSummary}`;

    for (const sib of siblings) {
      const attempt = activeAttempts.find(a => a.issue_key === sib.issueKey && a.status === 'running');
      if (!attempt?.tmux_session) continue;
      if (!sessionExists(attempt.tmux_session)) continue;

      try {
        sendKeys(attempt.tmux_session, message);
      } catch (err: unknown) {
        console.debug(`[team-context] tmux sendKeys failed for ${sib.issueKey}:`, (err as Error).message);
      }
    }
  } catch (err: unknown) {
    console.debug(`[team-context] broadcastCompletion failed (best-effort):`, (err as Error).message);
  }
}
