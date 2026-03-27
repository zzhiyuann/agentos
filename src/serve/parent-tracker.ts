/**
 * Parent Issue Tracker: Monitors parent issues and auto-transitions
 * when all sub-issues are completed.
 *
 * Runs as part of the monitor loop. Checks issues that have sub-issues
 * and updates parent status based on child completion.
 */

import chalk from 'chalk';
import { getIssue, addComment, updateIssueState } from '../core/linear.js';
import { areAllSubIssuesDone, getSubIssues } from './planner.js';

// Track which parent issues we've already checked recently (avoid API spam)
const recentChecks = new Map<string, number>();
const CHECK_INTERVAL_MS = 5 * 60_000; // Check each parent at most every 5 minutes

// Track which parents we've already closed (avoid double-close)
const closedParents = new Set<string>();

/**
 * Check if a parent issue should be auto-transitioned based on sub-issue completion.
 * Called from the monitor loop for issues that have sub-issues.
 */
export async function checkParentCompletion(parentKey: string): Promise<void> {
  // Skip if already closed
  if (closedParents.has(parentKey)) return;

  // Rate limit checks
  const lastCheck = recentChecks.get(parentKey);
  if (lastCheck && Date.now() - lastCheck < CHECK_INTERVAL_MS) return;
  recentChecks.set(parentKey, Date.now());

  try {
    const parentIssue = await getIssue(parentKey);

    // Only check parents that are In Progress
    if (parentIssue.state !== 'In Progress') return;

    const status = await areAllSubIssuesDone(parentKey);

    if (status.allDone && status.total > 0) {
      // All sub-issues done — move parent to In Review
      console.log(chalk.green(`  Parent ${parentKey}: all ${status.total} sub-issues done — moving to In Review`));

      try {
        await updateIssueState(parentIssue.id, 'In Review');
      } catch (err) {
        console.log(chalk.red(`  Failed to update parent state: ${(err as Error).message}`));
        return;
      }

      // Post completion comment
      try {
        await addComment(parentIssue.id, [
          `## All Sub-Issues Completed`,
          ``,
          `All ${status.total} sub-issues are now done. Moving parent to **In Review** for CEO review.`,
          ``,
          `| Sub-Issue | Status |`,
          `|-----------|--------|`,
          ...status.remaining.length === 0
            ? (await getSubIssues(parentKey)).map(s => `| ${s.key}: ${s.title} | ${s.state} |`)
            : [],
        ].join('\n'));
      } catch { /* best effort */ }

      closedParents.add(parentKey);
    } else if (status.total > 0 && status.done > 0) {
      // Partial completion — log for visibility
      const pct = Math.round((status.done / status.total) * 100);
      console.log(chalk.dim(`  Parent ${parentKey}: ${status.done}/${status.total} sub-issues done (${pct}%)`));
    }
  } catch (err) {
    console.log(chalk.dim(`  Parent check failed for ${parentKey}: ${(err as Error).message}`));
  }
}

/**
 * Scan for parent issues that need completion checking.
 * Called from the monitor loop.
 */
export async function scanParentIssues(): Promise<void> {
  try {
    const { getReadClient } = await import('../core/linear.js');
    const { getConfig } = await import('../core/config.js');
    const client = getReadClient();
    const config = getConfig();

    // Find In Progress issues that have children (sub-issues)
    const issues = await client.issues({
      filter: {
        team: { key: { eq: config.linearTeamKey } },
        state: { name: { eq: 'In Progress' } },
        children: { length: { gt: 0 } },
      },
      first: 20,
    });

    for (const issue of issues.nodes) {
      await checkParentCompletion(issue.identifier);
    }
  } catch (err) {
    // Silently skip if the filter doesn't work (Linear API may not support children filter)
    // In that case, parent tracking happens via explicit calls only
    console.log(chalk.dim(`  Parent scan: ${(err as Error).message}`));
  }
}

// Clean up stale entries periodically
export function cleanupParentTracker(): void {
  const cutoff = Date.now() - CHECK_INTERVAL_MS * 3;
  for (const [key, ts] of recentChecks) {
    if (ts < cutoff) recentChecks.delete(key);
  }
}
