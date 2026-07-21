/** Reviewer auto-dispatch and tiered review classification. */

import { createLogger } from '../core/logger.js';
import { getIssue } from '../core/linear.js';
import { agentExists } from '../core/persona.js';
import { handleDispatch } from './dispatch.js';
import type { HandoffActions, ReviewLevel } from './handoff-executor.js';

export type { ReviewLevel };

const log = createLogger('review-dispatcher');

/**
 * Tiered review classification (RYA-543).
 * Determines whether an in-review issue needs CEO review or can be reviewed by CTO.
 *
 * Returns:
 *   'ceo'  — Level 2: external-facing, security, architecture, strategy, budget
 *   'cto'  — Level 1: internal code/infra changes, standard features
 *
 * Agents can force CEO review via `review_level: ceo` in HANDOFF.md front matter.
 */
export function classifyReviewLevel(
  issueTitle: string,
  handoff: string,
  builderRole: string,
): ReviewLevel {
  const fmMatch = handoff.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const levelMatch = fmMatch[1].match(/^review_level:\s*['"]?(\w+)['"]?\s*$/m);
    if (levelMatch) {
      const level = levelMatch[1].trim().toLowerCase();
      if (level === 'ceo') return 'ceo';
      if (level === 'cto') return 'cto';
    }
  }

  // C-suite agents' own work escalates to CEO (peer review, not self-review)
  if (builderRole === 'cto' || builderRole === 'cpo') return 'ceo';

  const ceoPatterns = /\b(security|auth\b|authentication|authorization|deploy\s*prod|production\s*deploy|architecture|strategic|strategy|budget|billing|cost\s*limit|external|public[- ]?facing|customer[- ]?facing|api[- ]?key|token\s*rotat|breaking\s*change|data\s*migrat|user\s*data|privacy|compliance|oss\s*release|open[- ]?source\s*release)\b/i;

  if (ceoPatterns.test(issueTitle)) return 'ceo';

  const reasonMatch = handoff.match(/^reason:\s*['"]?(.+?)['"]?\s*$/m);
  if (reasonMatch && ceoPatterns.test(reasonMatch[1])) return 'ceo';

  return 'cto';
}

/**
 * Detect the designated reviewer for an issue from its description.
 * Looks for patterns like "Reviewer: CTO", "Cross-review: CPO", "Review by: lead-engineer".
 * Returns the reviewer role (lowercase) or null.
 */
export function detectReviewerFromDescription(description: string | undefined): string | null {
  if (!description) return null;

  const reviewerPattern = /\b(?:reviewer|cross[- ]?review|review\s*by)\s*[:=]\s*([a-zA-Z][\w-]*)/i;
  const match = description.match(reviewerPattern);
  if (!match) return null;

  const role = match[1].trim().toLowerCase();
  const aliases: Record<string, string> = {
    'cto': 'cto',
    'cpo': 'cpo',
    'coo': 'coo',
    'lead-engineer': 'lead-engineer',
    'leadengineer': 'lead-engineer',
    'research-lead': 'research-lead',
    'researchlead': 'research-lead',
  };
  return aliases[role] || role;
}

/**
 * Auto-dispatch a reviewer when an issue moves to In Review.
 * Sources for reviewer (in priority order):
 *   1. review_dispatch from HANDOFF.md front matter
 *   2. Reviewer detected from issue description
 *   3. Tiered review classification (RYA-543): CTO for internal, CEO for external/security
 */
export async function autoDispatchReviewer(
  issueKey: string,
  issueId: string,
  issueTitle: string,
  builderRole: string,
  actions: HandoffActions,
  agentToken?: string,
  handoffContent?: string,
): Promise<void> {
  let reviewerRole = actions.reviewDispatch;

  if (!reviewerRole) {
    try {
      const issue = await getIssue(issueKey);
      reviewerRole = detectReviewerFromDescription(issue.description);
      issueTitle = issue.title || issueTitle;
    } catch {
      return;
    }
  }

  if (!reviewerRole && handoffContent) {
    const level = classifyReviewLevel(issueTitle, handoffContent, builderRole);
    if (level === 'cto') {
      reviewerRole = 'cto';
      log.info('Tiered review: CTO auto-assigned as reviewer (Level 1)', { issueKey, builderRole });
    } else {
      log.debug('Tiered review: CEO review required (Level 2)', { issueKey, builderRole });
      return;
    }
  }

  if (!reviewerRole) return;

  if (reviewerRole === builderRole) {
    log.debug('Skipping auto-review: reviewer same as builder', { issueKey, role: reviewerRole });
    return;
  }

  if (!agentExists(reviewerRole)) {
    log.debug('Skipping auto-review: reviewer agent not found', { issueKey, role: reviewerRole });
    return;
  }

  try {
    const result = await handleDispatch({
      role: reviewerRole,
      issueKey,
      message: `Auto-dispatched for review. ${builderRole} completed this issue. Review the HANDOFF.md, code changes, and deliverables. Post your review findings as comments and update status accordingly.`,
      from: 'monitor:auto-review',
    });
    log.info('Auto-dispatched reviewer', { issueKey, reviewer: reviewerRole, builder: builderRole, action: result.action });
  } catch (err) {
    log.warn('Auto-review dispatch failed', { issueKey, reviewer: reviewerRole, error: (err as Error).message });
  }
}
