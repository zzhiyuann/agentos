/** Session monitor: detect completion, quality gate, trust prompt, rate limit, batch completion. */

import chalk from 'chalk';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig, resolveStatePath, getIssueStateDir } from '../core/config.js';
import {
  hasAgentAccess, emitActivity, addComment, getIssue,
  updateIssueState, createIssueDocument, dismissAgentSession,
  generateHandoffSummary, getRecentCommentBodies, linkifyDeliverables,
  closeActiveSessionsForIssue, getAgentCommentCountSince,
} from '../core/linear.js';
import {
  Attempt, getActiveAttempts, getActiveAttempt, getIdleAttempts, getAttemptsByIssue,
  getRecentAttemptsByAgent, updateAttemptStatus, logEvent,
} from '../core/db.js';
import { readFileOnRemote, sessionExists, capturePane, killSession, sendKeys } from '../core/tmux.js';
import { agentExists, getAgentLinearToken, loadAgentConfig } from '../core/persona.js';
import { enqueue, setCooldown, cancelQueuedByRole } from '../core/queue.js';
import { WORKFLOW_STATES } from '../types.js';

import {
  reportedHandoffs, trustPromptHandled, followUpMeta, FOLLOW_UP_TTL_MS,
  progressNudgedAttempts,
} from './state.js';
import {
  postToGroupChat, handoffContentHash, isHandoffAlreadyPosted,
  countConsecutiveRateLimitFailures, getRateLimitBackoffMs,
  RATE_LIMIT_ESCALATION_MARKER, isPermanentIssueError,
} from './helpers.js';
import { checkCircuitBreaker, tripCircuitBreaker } from './circuit-breaker.js';
import { tryWakeHibernatedSession, monitorHibernatedSessions } from './concurrency.js';

/** Parse SQLite datetime (UTC without 'Z') into epoch ms. */
function parseUtcTimestamp(ts: string): number {
  return new Date(ts.endsWith('Z') ? ts : ts + 'Z').getTime();
}

// Content-hash dedup: prevent same HANDOFF.md from being posted multiple times
// for the same issue when session replacement creates new attempt IDs
const reportedHandoffHashes = new Set<string>();
const MAX_RATE_LIMIT_RETRIES = 3;

// Idle detection: track when sessions first appear at prompt
// We dismiss the Linear AgentSession (stop "Working") but keep tmux alive for context.
const idleTimers = new Map<string, number>();
const IDLE_DISMISS_MS = 300_000; // 5min idle at prompt → dismiss AgentSession (not kill)
const WARMUP_GRACE_MS = 120_000; // 2min grace period — new sessions need time to load CLAUDE.md, read context, and plan
const dismissedSessions = new Set<string>(); // attempt IDs already dismissed for idle

// Track batch completions — trigger COO review when a batch of work finishes
let lastActiveCount = 0;
let batchIdleStart = 0;
const BATCH_IDLE_THRESHOLD_MS = 60_000; // 60s of no active agents = batch complete

export async function checkBatchCompletion(): Promise<void> {
  const activeCount = getActiveAttempts().length;

  if (lastActiveCount > 0 && activeCount === 0) {
    // Transition from busy → idle
    if (batchIdleStart === 0) batchIdleStart = Date.now();

    if (Date.now() - batchIdleStart >= BATCH_IDLE_THRESHOLD_MS) {
      batchIdleStart = 0; // reset
      const ts = new Date().toLocaleTimeString();
      console.log(chalk.dim(`[${ts}] Batch complete — all agents idle. Triggering COO review.`));
      try {
        await postToGroupChat('system', '📊 All agents idle — batch complete. COO will review.');
      } catch { /**/ }
      // TODO: auto-dispatch COO for behavior review when pulse is fully wired
    }
  } else if (activeCount > 0) {
    batchIdleStart = 0; // reset if agents are working
  }

  lastActiveCount = activeCount;
}

/**
 * Determine if an issue should skip CEO review and go directly to Done.
 * Trivial issues (tests, fixes, hotfixes, QA, typos, lint, cleanup) don't need review
 * if the agent's HANDOFF.md indicates success.
 */
export function shouldSkipReview(issueTitle: string, handoff: string): boolean {
  const trivialPatterns = /\b(test|fix|hotfix|bug\s*fix|typo|lint|cleanup|clean-?up|rename|bump|patch|chore|refactor|nit)\b/i;
  if (!trivialPatterns.test(issueTitle)) return false;

  // Only auto-close if handoff indicates success (tests pass, verified, etc.)
  const successSignals = /\b(pass|passing|verified|confirmed|fixed|resolved|done|works|succeed|success|green|✅)\b/i;
  return successSignals.test(handoff);
}

/**
 * Check if an issue has an active handoff — another agent is already working on it.
 * When work is being handed off, the issue should stay In Progress, not go to In Review.
 */
export function hasActiveHandoff(issueKey: string, currentAttemptId: string): boolean {
  const allActive = getActiveAttempts();
  // If another attempt (different from the one completing) is active on the same issue, it's a handoff
  return allActive.some(a => a.issue_key === issueKey && a.id !== currentAttemptId);
}

/**
 * Detect whether an issue is a non-code deliverable (strategy, research doc, etc.)
 * These tasks produce documents/reports rather than code changes, so quality checks
 * should look for deliverable evidence instead of file diffs and test runs.
 */
export function isNonCodeDeliverable(title: string, labels: string[]): boolean {
  // Title bracket tags: [Strategy], [Research], [Analysis], [Report], [Exploration]
  if (/\[(strategy|research|analysis|report|exploration|investigation)\]/i.test(title)) return true;

  // Labels indicating non-code work
  if (labels.some(l => /^(strategy|research|analysis|report|exploration|investigation)$/i.test(l))) return true;

  // Compound title keywords that clearly indicate document deliverables
  if (/\b(strategy|strategic\s+plan|research\s+report|market\s+analysis|business\s+plan|landscape\s+scan|competitive\s+analysis)\b/i.test(title)) return true;

  return false;
}

/** Validate handoff quality before accepting completion */
export async function validateHandoff(attempt: Attempt, handoff: string): Promise<{ passed: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  // Check 1: Memory written?
  // Check the agent's actual memory dir, not the workspace symlink
  // (symlink gets overwritten when another agent uses the same workspace)
  {
    const config = getConfig();
    const agentMemDir = `~/.aos/agents/${attempt.agent_type}/memory`;
    try {
      const memFiles = execSync(
        `find ${agentMemDir}/ -name '*.md' -mmin -120 2>/dev/null | head -1`,
        { encoding: 'utf-8', timeout: 10_000 }
      ).trim();
      if (!memFiles) {
        warnings.push('No memory files written this session');
      }
    } catch { /* dir may not exist */ }
  }

  // Fetch issue info once — used by both Check 2 and Check 3
  let issueTitle = '';
  let issueLabels: string[] = [];
  try {
    const issueInfo = await getIssue(attempt.issue_key);
    issueTitle = issueInfo.title;
    issueLabels = issueInfo.labels;
  } catch { /* issue fetch may fail — fall through to code-task checks */ }

  const nonCode = isNonCodeDeliverable(issueTitle, issueLabels);

  // Check 2: Evidence of work completion in HANDOFF.md?
  if (nonCode) {
    // Non-code deliverables: check for document/deliverable evidence
    const hasDeliverable = /deliverable|document|report|strategy|analysis|recommendations|findings|research|workspace|drafted|produced|written|complete/i.test(handoff);
    if (!hasDeliverable) {
      warnings.push('HANDOFF.md has no evidence of a deliverable document or analysis');
    }
  } else {
    // Code tasks: check for verification/file change evidence
    const hasVerification = /verif|test|confirm|check|pass|validated/i.test(handoff);
    const hasFilesChanged = /files? changed|modified|created|commit/i.test(handoff);
    if (!hasVerification && !hasFilesChanged) {
      warnings.push('HANDOFF.md has no evidence of verification or file changes');
    }
  }

  // Check 3: Audit/research tasks should create follow-up issues
  // (non-code deliverables like strategy docs are exempt — they produce documents, not issues)
  if (!nonCode) {
    const isAuditResearchTask = /audit|review|analysis|research|scan/i.test(issueTitle);
    if (isAuditResearchTask) {
      // Check if this agent created any other issues (tracked as attempts) in the last 30 minutes
      const recentAttempts = getRecentAttemptsByAgent(attempt.agent_type, 30, attempt.id);
      if (recentAttempts.length === 0) {
        warnings.push('Audit/research task completed without creating any follow-up issues');
      }
    }
  }

  // Check 4: Vague follow-up suggestions without corresponding sub-issues
  // Detect prose follow-ups that should be [to decide] sub-issues or dispatched work
  const followUpSection = handoff.match(/(?:follow[- ]?up|next steps?|what needs|recommendations?|remaining work)\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
  if (followUpSection) {
    const section = followUpSection[1];
    // Count prose items (lines starting with - or numbered) that don't reference issue keys
    const proseItems = section.split('\n')
      .filter(line => /^\s*[-*\d.]/.test(line))
      .filter(line => !/RYA-\d+/i.test(line))
      .filter(line => line.trim().length > 20); // skip very short lines
    if (proseItems.length >= 2) {
      warnings.push(`HANDOFF.md has ${proseItems.length} vague follow-up suggestions without sub-issue references — use [to decide] sub-issues or dispatch`);
    }
  }

  // Check 5: Progress comments posted during session?
  // Agent should have posted at least one substantive comment during work.
  {
    const agentConfig = loadAgentConfig(attempt.agent_type);
    const agentUserId = agentConfig.linearUserId;
    if (agentUserId) {
      const commentCount = await getAgentCommentCountSince(
        attempt.issue_id,
        agentUserId,
        attempt.created_at,
      );
      // commentCount === -1 means API error — don't warn
      if (commentCount === 0) {
        warnings.push('No progress comments posted during session — agent should post updates per the progress comment protocol');
      }
    }
  }

  return { passed: warnings.length === 0, warnings };
}

/** Monitor active sessions — detect completion via HANDOFF.md or session death */
export async function monitorSessions(): Promise<void> {
  // Also monitor idle sessions — detect reactivation or tmux death
  const idleAttempts = getIdleAttempts();
  for (const idle of idleAttempts) {
    if (!idle.tmux_session) continue;
    if (!sessionExists(idle.tmux_session)) {
      // tmux died while idle — mark as completed (not failed, since idle is a clean state)
      updateAttemptStatus(idle.id, 'completed', 'Session ended while idle');
      logEvent(idle.id, 'completed', { reason: 'idle_session_death' });
      const ts = new Date().toLocaleTimeString();
      console.log(chalk.dim(`[${ts}] Idle session ended: ${idle.issue_key} (${idle.agent_type})`));
      continue;
    }
    // Check if an idle session started working again (agent received piped input)
    try {
      const output = capturePane(idle.tmux_session, 10);
      const isActivelyWorking = /Flowing|Running \d+ agent|thinking|streaming|Searching|Fetching|Reading|Creating|Writing|Editing|Analyzing|thought for/i.test(output);
      if (isActivelyWorking) {
        updateAttemptStatus(idle.id, 'running');
        dismissedSessions.delete(idle.id);
        idleTimers.delete(`idle:${idle.id}`); // Reset idle timer so it can go idle again later
        logEvent(idle.id, 'reactivated', { reason: 'activity_detected' });
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.green(`[${ts}] Reactivated: ${idle.issue_key} (${idle.agent_type}) — activity detected in idle session`));
      }
    } catch { /* ignore */ }
  }

  const attempts = getActiveAttempts();
  if (attempts.length === 0) return;

  for (const attempt of attempts) {
    if (!attempt.tmux_session || !attempt.workspace_path) continue;

    const alive = sessionExists(attempt.tmux_session);
    // Read state files from per-issue state dir (RYA-246), with workspace fallback for in-flight sessions
    const handoffPath = resolveStatePath(attempt.issue_key, attempt.workspace_path, 'HANDOFF.md');
    const blockedPath = resolveStatePath(attempt.issue_key, attempt.workspace_path, 'BLOCKED.md');
    const handoff = readFileOnRemote(handoffPath);
    const blocked = readFileOnRemote(blockedPath);

    // Copy-on-read: if HANDOFF/BLOCKED was read from workspace (fallback), copy to state dir
    // for isolation. Prevents shared-workspace crosstalk on subsequent reads.
    if (handoff && handoffPath === join(attempt.workspace_path, 'HANDOFF.md')) {
      try {
        const stateDir = getIssueStateDir(attempt.issue_key);
        const stateCopy = join(stateDir, 'HANDOFF.md');
        writeFileSync(stateCopy, handoff);
      } catch { /* best-effort copy */ }
    }
    if (blocked && blockedPath === join(attempt.workspace_path, 'BLOCKED.md')) {
      try {
        const stateDir = getIssueStateDir(attempt.issue_key);
        const stateCopy = join(stateDir, 'BLOCKED.md');
        writeFileSync(stateCopy, blocked);
      } catch { /* best-effort copy */ }
    }

    const handoffKey = `${attempt.id}:handoff`;
    const ts = new Date().toLocaleTimeString();

    // Auto-approve trust prompts for sessions < 120s old (or until first successful detection)
    if (alive && attempt.tmux_session && !trustPromptHandled.has(attempt.tmux_session)) {
      const ageMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      if (ageMs < 120_000) {
        try {
          const paneOutput = capturePane(attempt.tmux_session, 10);
          if (/trust|Trust|Yes, I trust|trust this folder|Trust this workspace|Yes, continue|proceed|Press enter to confirm|Do you trust|security check/i.test(paneOutput || '')) {
            const { execSync: ex } = await import('child_process');
            const config = getConfig();
            ex(
              `tmux send-keys -t ${attempt.tmux_session} Enter 2>/dev/null`,
              { encoding: 'utf-8', timeout: 5_000 }
            );
            trustPromptHandled.add(attempt.tmux_session);
            console.log(chalk.dim(`[${ts}] Auto-approved trust prompt for ${attempt.issue_key}`));
          }
        } catch { /* ignore */ }
      }
    }

    // Case 1: HANDOFF.md appeared (CC finished, session may still be alive for observation)
    if (handoff && !reportedHandoffs.has(handoffKey)) {
      reportedHandoffs.add(handoffKey);

      // Content-hash dedup: skip if same HANDOFF content was already posted for this issue
      // This prevents duplicate posts when session replacement creates a new attempt
      const contentHash = handoffContentHash(handoff);
      const issueContentKey = `${attempt.issue_key}:${contentHash}`;
      if (reportedHandoffHashes.has(issueContentKey)) {
        console.log(chalk.dim(`[${ts}] Skipping duplicate HANDOFF for ${attempt.issue_key} #${attempt.attempt_number} (content already posted)`));
        updateAttemptStatus(attempt.id, 'completed');
        logEvent(attempt.id, 'completed', { hasHandoff: true, deduplicated: true });
        // Dismiss the Linear AgentSession so "Working" indicator clears
        if (attempt.agent_session_id) {
          const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
          try { await dismissAgentSession(attempt.agent_session_id, agentTok, '–'); } catch { /**/ }
        }
        continue;
      }

      // Secondary dedup: check if Linear already has this content as a comment
      const alreadyPosted = await isHandoffAlreadyPosted(attempt.issue_id, handoff);
      if (alreadyPosted) {
        console.log(chalk.dim(`[${ts}] Skipping duplicate HANDOFF for ${attempt.issue_key} #${attempt.attempt_number} (already in Linear comments)`));
        reportedHandoffHashes.add(issueContentKey);
        updateAttemptStatus(attempt.id, 'completed');
        logEvent(attempt.id, 'completed', { hasHandoff: true, deduplicated: true });
        // Dismiss the Linear AgentSession so "Working" indicator clears
        if (attempt.agent_session_id) {
          const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
          try { await dismissAgentSession(attempt.agent_session_id, agentTok, '–'); } catch { /**/ }
        }
        continue;
      }

      reportedHandoffHashes.add(issueContentKey);
      const isFollowUp = followUpMeta.has(attempt.id);
      console.log(chalk.green(`[${ts}] ${isFollowUp ? 'Follow-up answered' : 'Task completed'}: ${attempt.issue_key} #${attempt.attempt_number}`));

      // Use the agent's own token so state changes show their name
      const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;

      // For follow-ups: post HANDOFF.md content as a threaded reply under the user's comment
      if (isFollowUp) {
        const meta = followUpMeta.get(attempt.id)!;
        followUpMeta.delete(attempt.id);

        // Guard: don't post hollow responses — these aren't real answers
        const trimmed = handoff.trim()
          .replace(/^#.*\n*/gm, '')           // strip markdown headers
          .replace(/^---+\n*/gm, '')          // strip horizontal rules
          .replace(/^(Agent|Status|Date|Issue|Summary|Files Changed|Verification|Memory Updated|Remaining Issues):.*\n*/gim, '') // strip template labels
          .replace(/^\[.*?\]\s*\n*/gm, '')    // strip template placeholders like [1-3 sentences]
          .replace(/^[-•]\s*\n*/gm, '')       // strip empty bullets
          .trim();
        const isHollow =
          // Exact hollow phrases
          /^(done\.?|completed\.?|n\/a\.?|no further action\.?|task completed\.?|already (done|completed|addressed)\.?|no changes (needed|required)\.?|nothing to do\.?)$/i.test(trimmed) ||
          // Too short to be substantive (under 30 chars after stripping)
          trimmed.length < 30;
        if (isHollow) {
          console.log(chalk.yellow(`  Suppressed hollow follow-up reply ("${trimmed.substring(0, 50)}") on ${attempt.issue_key}`));
        } else {
          try {
            await addComment(attempt.issue_id, handoff, agentTok, meta.commentId);
            console.log(chalk.green(`  Posted threaded reply on ${attempt.issue_key}`));
          } catch (err) {
            console.log(chalk.yellow(`  Threaded reply failed, posting top-level: ${(err as Error).message}`));
            try { await addComment(attempt.issue_id, handoff, agentTok); } catch { /**/ }
          }
        }
      } else {
        // Normal task: system-level completion notification with HANDOFF.md summary
        try {
          let issueTitle = attempt.issue_key;
          try {
            const issueInfo = await getIssue(attempt.issue_key);
            issueTitle = issueInfo.title;
          } catch { /**/ }

          // Extract meaningful summary from HANDOFF.md for Discord
          let summary = '';
          const lines = handoff.split('\n').filter(l => {
            const t = l.trim();
            return t && !t.startsWith('#') && !t.startsWith('---') && !/^(Agent|Status|Date|Issue):/i.test(t);
          });
          const bullets = lines.filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'));
          if (bullets.length >= 2) {
            summary = bullets.slice(0, 3).map(b => b.trim()).join('\n');
          } else {
            summary = lines.slice(0, 3).join('\n');
          }
          summary = summary.substring(0, 400) || 'Task completed.';

          await postToGroupChat(
            attempt.agent_type,
            `✅ **${attempt.issue_key}** completed: "${issueTitle}"\n${summary}`
          );
        } catch { /**/ }

        // Create document FIRST so we can link it in the comment
        let handoffDocUrl: string | null = null;
        if (!isFollowUp) {
          handoffDocUrl = await createIssueDocument(attempt.issue_id, `Handoff #${attempt.attempt_number}`, handoff);
        }

        // Upload any deliverable files referenced in HANDOFF.md as linked documents
        let commentBody = handoff;
        if (!isFollowUp && attempt.workspace_path) {
          commentBody = await linkifyDeliverables(handoff, attempt.workspace_path, attempt.issue_id);
        }

        // Append handoff document link if available
        if (handoffDocUrl) {
          commentBody += `\n\n---\n📄 [View full handoff document](${handoffDocUrl})`;
        }

        // Post HANDOFF.md content as a comment on the issue so it's visible in the timeline
        try {
          await addComment(attempt.issue_id, commentBody, agentTok);
          console.log(chalk.green(`  Posted handoff comment on ${attempt.issue_key}`));
        } catch (err) {
          console.error(`  Failed to post handoff comment on ${attempt.issue_key}:`, (err as Error).message);
        }
      }

      // Quality gate: validate handoff before accepting (skip for follow-ups — just Q&A)
      if (!isFollowUp) {
        const validation = await validateHandoff(attempt, handoff);
        if (validation.warnings.length > 0) {
          const warningText = validation.warnings.map(w => `⚠️ ${w}`).join('\n');
          await addComment(attempt.issue_id, `**Quality check warnings:**\n${warningText}\n\nHandoff accepted with warnings.`);
          console.log(chalk.yellow(`  Quality warnings: ${validation.warnings.join(', ')}`));
        }
      }

      updateAttemptStatus(attempt.id, 'completed');
      logEvent(attempt.id, 'completed', { hasHandoff: true, isFollowUp });

      if (attempt.agent_session_id) {
        // Use dismissAgentSession for all paths — it posts a terminal 'response' activity
        // and tracks the session ID to prevent duplicate dismissals (via globalDismissedSessions).
        const summary = generateHandoffSummary(handoff);
        try {
          await dismissAgentSession(attempt.agent_session_id, agentTok, summary);
        } catch (err) {
          console.error(`[${ts}] Failed to dismiss session for ${attempt.issue_key}: ${(err as Error).message}`);
        }
      }
      // Close ALL remaining agent sessions for this issue (catches orphaned/duplicate sessions
      // that weren't tracked in the attempt record — prevents stuck "Working" indicators)
      if (agentTok) {
        closeActiveSessionsForIssue(attempt.issue_key, agentTok, 'Task completed').catch(() => {});
      }
      // Determine target status based on issue type and handoff state
      try {
        const currentIssue = await getIssue(attempt.issue_key);
        if (currentIssue.state !== 'Done') {
          if (hasActiveHandoff(attempt.issue_key, attempt.id)) {
            // Another agent is already working on this issue (handoff in progress)
            // Keep it In Progress — don't move to In Review
            console.log(chalk.dim(`[${ts}] Keeping ${attempt.issue_key} In Progress — handoff to another agent active`));
          } else if (shouldSkipReview(currentIssue.title, handoff)) {
            // Trivial issue (test, fix, etc.) with passing results — auto-close
            await updateIssueState(attempt.issue_id, WORKFLOW_STATES.DONE, agentTok);
            console.log(chalk.green(`[${ts}] Auto-closed ${attempt.issue_key} as Done (trivial issue, tests pass)`));
          } else {
            await updateIssueState(attempt.issue_id, WORKFLOW_STATES.IN_REVIEW, agentTok);
          }
        }
      } catch { /**/ }
      // A session completed — try waking a hibernated session for the freed slot
      tryWakeHibernatedSession();
      continue;
    }

    // Case 2: BLOCKED.md appeared (read from per-issue state dir — RYA-246)
    if (blocked && !reportedHandoffs.has(`${attempt.id}:blocked`)) {
      reportedHandoffs.add(`${attempt.id}:blocked`);
      console.log(chalk.red(`[${ts}] Agent blocked: ${attempt.issue_key}`));

      updateAttemptStatus(attempt.id, 'blocked', blocked.substring(0, 500));
      logEvent(attempt.id, 'failed', { blocked: true });

      const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
      if (attempt.agent_session_id) {
        await emitActivity(attempt.agent_session_id, { type: 'elicitation', body: blocked }, false, agentTok);
        await dismissAgentSession(attempt.agent_session_id, agentTok, '–');
      }
      continue;
    }

    // Case 3: Check for rate limiting in running sessions
    // Guard: skip during warmup — pane still shows issue description/prompt text
    // which may contain "rate limit" keywords as content, not as actual API errors.
    if (alive && attempt.tmux_session) {
      const rateLimitAgeMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      if (rateLimitAgeMs < WARMUP_GRACE_MS) {
        // Skip rate limit check — session is still loading
      } else try {
        // Only check the LAST 5 lines — real API errors appear at the bottom,
        // not in the initial prompt/issue description area higher up.
        const output = capturePane(attempt.tmux_session, 5);
        // Use specific patterns that require error context — plain keywords in
        // issue descriptions or code comments should NOT trigger this.
        const isRateLimited =
          /(?:error|failed|err(?:or)?)[:\s].*(?:rate.?limit|429|too many requests|usage.?limit)/i.test(output) ||
          /(?:rate.?limit|429|too many requests|usage.?limit).*(?:error|failed|retry|exceeded|reached)/i.test(output) ||
          /overloaded_error|APIStatusError.*429|RateLimitError|UsageLimitError/i.test(output);
        if (isRateLimited) {
          console.log(chalk.yellow(`[${ts}] Rate limited: ${attempt.issue_key}`));
          const { killSession } = await import('../core/tmux.js');
          killSession(attempt.tmux_session);
          updateAttemptStatus(attempt.id, 'failed', 'Rate limited');
          logEvent(attempt.id, 'failed', { reason: 'rate_limit' });

          // Dismiss Linear AgentSession to clear "Working" state
          if (attempt.agent_session_id) {
            try {
              const agentTok = attempt.agent_type ? getAgentLinearToken(attempt.agent_type) : null;
              await dismissAgentSession(attempt.agent_session_id, agentTok || undefined, '–');
            } catch { /* best effort */ }
          }

          const issueAttempts = getAttemptsByIssue(attempt.issue_key);
          const consecutiveFailures = countConsecutiveRateLimitFailures(issueAttempts, attempt.agent_type);

          if (consecutiveFailures >= MAX_RATE_LIMIT_RETRIES) {
            cancelQueuedByRole(attempt.issue_key, attempt.agent_type);
            try {
              await updateIssueState(attempt.issue_id, WORKFLOW_STATES.TODO);
            } catch { /**/ }

            const recentBodies = await getRecentCommentBodies(attempt.issue_id, 10);
            if (!recentBodies.some((body) => body.includes(RATE_LIMIT_ESCALATION_MARKER))) {
              await addComment(
                attempt.issue_id,
                `**Automatic retries paused**\n\n${RATE_LIMIT_ESCALATION_MARKER} ` +
                `${attempt.issue_key} hit provider rate limits ${consecutiveFailures} times in a row. ` +
                `The issue was moved back to Todo for manual intervention.`
              );
            }
            continue;
          }

          const backoffMs = getRateLimitBackoffMs(consecutiveFailures);
          enqueue({
            id: randomUUID(),
            issue_id: attempt.issue_id,
            issue_key: attempt.issue_key,
            agent_role: attempt.agent_type,
            agent_session_id: attempt.agent_session_id ?? undefined,
            delay_until: new Date(Date.now() + backoffMs).toISOString(),
          });
          setCooldown(backoffMs);
          continue;
        }
      } catch { /* ignore capture errors */ }
    }

    // Case 3.5: Session alive — detect idle prompt or errors.
    // Interactive session architecture: idle sessions transition to 'idle' status
    // (NOT 'completed') — they stay alive in tmux and can be reactivated when
    // new messages arrive. We dismiss the Linear AgentSession to clear "Working".
    if (alive && !handoff && !blocked && attempt.tmux_session) {
      // Warm-up grace period: new sessions need time to load CLAUDE.md, read context, and plan.
      // Skip idle detection entirely until the session has been alive for WARMUP_GRACE_MS.
      const sessionAgeMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      if (sessionAgeMs < WARMUP_GRACE_MS) continue;

      try {
        const output = capturePane(attempt.tmux_session, 10);
        const idleKey = `idle:${attempt.id}`;

        // Detect API errors in pane output — use specific patterns to avoid
        // false positives from issue descriptions containing error keywords
        const errorMatch = output.match(/API Error: (\d+).*?({.*?})/s)
          || output.match(/(?:error|failed)[:\s].*(rate.?limit|429|too many requests)/i)
          || output.match(/(overloaded_error|APIStatusError|RateLimitError)/i);

        // Detect active work signals (subagents, thinking, streaming)
        const isActivelyWorking = /Flowing|Running \d+ agent|thinking|streaming|Searching|Fetching|Reading|Creating|Doodling|Gusting|Crunching|Garnishing|Deciphering|Saut|Exploring|Writing|Editing|Analyzing|thought for/i.test(output);

        // Detect idle prompt (❯ with nothing after it) — but NOT if actively working
        const isIdlePrompt = !isActivelyWorking && /^[❯>]\s*$/m.test(output);

        // Detect permission/interactive prompts (stuck waiting for user input)
        const isStuckAtPrompt = !isActivelyWorking && /Do you want to|Yes, allow all|Esc to cancel|❯ \d+\./m.test(output);

        // Restart-resistant idle detection: if session age already exceeds
        // WARMUP + IDLE threshold, we can transition to idle immediately on
        // first detection instead of waiting for an in-memory timer.
        // This prevents auto-deploy restart storms from blocking idle cleanup.
        const alreadyMature = sessionAgeMs > (WARMUP_GRACE_MS + IDLE_DISMISS_MS);

        if (errorMatch && !dismissedSessions.has(attempt.id)) {
          // Error detected — dismiss AgentSession with error details, keep tmux alive
          dismissedSessions.add(attempt.id);
          const errorDetail = errorMatch[0].substring(0, 200);
          console.log(chalk.yellow(`[${ts}] Error in ${attempt.issue_key} (${attempt.agent_type}): ${errorDetail.substring(0, 80)}`));

          if (attempt.agent_session_id) {
            const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
            await emitActivity(attempt.agent_session_id, {
              type: 'error',
              body: `Agent encountered an error:\n${errorDetail}`,
            }, false, agentTok);
            await dismissAgentSession(attempt.agent_session_id, agentTok, '–');
          }
          // Mark attempt done but DON'T kill tmux — context preserved
          updateAttemptStatus(attempt.id, 'failed', `Error: ${errorDetail.substring(0, 100)}`);
          idleTimers.delete(idleKey);
        } else if (isIdlePrompt || isStuckAtPrompt) {
          // Agent at idle prompt or stuck at permission prompt — accumulate timer.
          // After IDLE_DISMISS_MS, dismiss Linear AgentSession to stop "Working" indicator,
          // but keep tmux alive so context is preserved for resume.
          //
          const idleStart = idleTimers.get(idleKey);
          if (alreadyMature && !dismissedSessions.has(attempt.id)) {
            // Session is old enough — transition to idle immediately
            dismissedSessions.add(attempt.id);
            const reason = isStuckAtPrompt ? 'Stuck at permission prompt' : 'Idle at prompt';
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason });
            console.log(chalk.dim(`[${ts}] ${reason}: ${attempt.issue_key} (${attempt.agent_type}) — session idle, awaiting reactivation`));
            idleTimers.delete(idleKey);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              const dismissMsg = isStuckAtPrompt
                ? 'Agent paused — waiting for permission prompt. Resume with a follow-up comment.'
                : 'Idle — send a comment to reactivate.';
              await dismissAgentSession(attempt.agent_session_id, agentTok, dismissMsg);
            }
          } else if (!idleStart) {
            idleTimers.set(idleKey, Date.now());
            if (isStuckAtPrompt) {
              console.log(chalk.dim(`[${ts}] Stuck at prompt: ${attempt.issue_key} (${attempt.agent_type}) — starting idle timer`));
            }
          } else if (Date.now() - idleStart > IDLE_DISMISS_MS && !dismissedSessions.has(attempt.id)) {
            dismissedSessions.add(attempt.id);
            const reason = isStuckAtPrompt ? 'Stuck at permission prompt' : 'Idle at prompt';
            // Transition to 'idle' — NOT 'completed'. Session stays alive for reactivation.
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason });
            console.log(chalk.dim(`[${ts}] ${reason}: ${attempt.issue_key} (${attempt.agent_type}) — session idle, awaiting reactivation`));
            idleTimers.delete(idleKey);
            // Dismiss Linear AgentSession to clear "Working" indicator
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              const dismissMsg = isStuckAtPrompt
                ? 'Agent paused — waiting for permission prompt. Resume with a follow-up comment.'
                : 'Idle — send a comment to reactivate.';
              await dismissAgentSession(attempt.agent_session_id, agentTok, dismissMsg);
            }
          }
        } else if (isActivelyWorking) {
          // Agent actively working — reset idle timer, clear dismissed flag if re-activated
          idleTimers.delete(idleKey);
          dismissedSessions.delete(attempt.id);
        } else {
          // Ambiguous state: not idle, not error, not actively working, not at a known prompt.
          // Don't reset idle timer — let it accumulate. After IDLE_DISMISS_MS, dismiss.
          // Same restart-resistant logic: if session is old enough, transition immediately.
          const idleStart = idleTimers.get(idleKey);
          if (alreadyMature && !dismissedSessions.has(attempt.id)) {
            dismissedSessions.add(attempt.id);
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason: 'no_activity' });
            console.log(chalk.dim(`[${ts}] No activity: ${attempt.issue_key} (${attempt.agent_type}) — session idle, awaiting reactivation`));
            idleTimers.delete(idleKey);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await dismissAgentSession(attempt.agent_session_id, agentTok, 'Idle — send a comment to reactivate.');
            }
          } else if (!idleStart) {
            idleTimers.set(idleKey, Date.now());
          } else if (Date.now() - idleStart > IDLE_DISMISS_MS && !dismissedSessions.has(attempt.id)) {
            dismissedSessions.add(attempt.id);
            updateAttemptStatus(attempt.id, 'idle');
            logEvent(attempt.id, 'idle', { reason: 'no_activity' });
            console.log(chalk.dim(`[${ts}] No activity: ${attempt.issue_key} (${attempt.agent_type}) — session idle, awaiting reactivation`));
            idleTimers.delete(idleKey);
            if (attempt.agent_session_id) {
              const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
              await dismissAgentSession(attempt.agent_session_id, agentTok, 'Idle — send a comment to reactivate.');
            }
          }
        }
      } catch { /* ignore capture errors */ }
    }

    // Case 3.6: Progress comment enforcement — recurring nudges for silent sessions.
    // First check at 10min, re-check every 15min. Injects nudge into agent's tmux pane.
    if (alive && !handoff && !blocked && !dismissedSessions.has(attempt.id)
        && !followUpMeta.has(attempt.id)) {
      const ageMs = Date.now() - parseUtcTimestamp(attempt.created_at);
      const PROGRESS_FIRST_NUDGE_MS = 10 * 60_000;  // 10 min: first check
      const PROGRESS_RENUDGE_MS = 15 * 60_000;       // 15 min: re-check interval

      if (ageMs > PROGRESS_FIRST_NUDGE_MS) {
        const nudgeState = progressNudgedAttempts.get(attempt.id);
        const timeSinceLastNudge = nudgeState ? Date.now() - nudgeState.lastNudgeTime : Infinity;
        const shouldCheck = !nudgeState || timeSinceLastNudge > PROGRESS_RENUDGE_MS;

        if (shouldCheck) {
          try {
            const agentConfig = loadAgentConfig(attempt.agent_type);
            const agentUserId = agentConfig.linearUserId;

            if (agentUserId) {
              // On re-checks, look for comments since last nudge (not session start).
              // This catches agents who post once early then go silent.
              const sinceIso = nudgeState
                ? new Date(nudgeState.lastNudgeTime).toISOString()
                : attempt.created_at;

              const commentCount = await getAgentCommentCountSince(
                attempt.issue_id,
                agentUserId,
                sinceIso,
              );

              // commentCount === -1 means API error — don't flag
              if (commentCount === 0) {
                const isFirstNudge = !nudgeState;
                const nudgeCount = (nudgeState?.nudgeCount ?? 0) + 1;
                progressNudgedAttempts.set(attempt.id, {
                  lastNudgeTime: Date.now(),
                  nudgeCount,
                });
                const ageMins = Math.round(ageMs / 60_000);

                console.log(chalk.yellow(
                  `[${ts}] Silent session: ${attempt.issue_key} (${attempt.agent_type}) — ${ageMins}min, ` +
                  `zero progress comments (nudge #${nudgeCount})`
                ));

                // Post to Linear on first nudge (CEO visibility).
                // Avoid spamming — subsequent nudges go to tmux only.
                if (isFirstNudge) {
                  const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
                  try {
                    await addComment(
                      attempt.issue_id,
                      `⚠️ **No progress comments** from \`${attempt.agent_type}\` after ${ageMins} minutes of work on ${attempt.issue_key}. ` +
                      `Agent should be posting updates per the progress comment protocol.`,
                      agentTok,
                    );
                  } catch { /* best effort */ }
                }

                // Inject nudge into agent's tmux pane so the agent actually sees it.
                // Only send when agent is at prompt to avoid disrupting active tool execution.
                try {
                  const paneOutput = capturePane(attempt.tmux_session, 10);
                  const isActivelyWorking = /Flowing|Running \d+ agent|thinking|streaming|Searching|Fetching|Reading|Creating|Doodling|Gusting|Crunching|Garnishing|Deciphering|Saut|Exploring|Writing|Editing|Analyzing|thought for/i.test(paneOutput);
                  const isAtPrompt = !isActivelyWorking && /^[❯>]\s*$/m.test(paneOutput);

                  if (isAtPrompt) {
                    sendKeys(
                      attempt.tmux_session,
                      `[SYSTEM] You have been working for ${ageMins} minutes with ZERO progress comments on ${attempt.issue_key}. ` +
                      `Post a progress update NOW: linear-tool comment ${attempt.issue_key} "your progress update here"`
                    );
                  }
                } catch { /* tmux errors are non-fatal */ }

                logEvent(attempt.id, 'progress_nudge', { ageMins, commentCount: 0, nudgeCount });
              } else if (commentCount > 0 && nudgeState) {
                // Agent posted a comment — clear nudge state so interval resets
                progressNudgedAttempts.delete(attempt.id);
              }
            }
          } catch { /* config load or API error — skip silently */ }
        }
      }
    }

    // Clean up tracking when session ends
    if (!alive && attempt.tmux_session) {
      trustPromptHandled.delete(attempt.tmux_session);
      idleTimers.delete(`idle:${attempt.id}`);
      dismissedSessions.delete(attempt.id);
      progressNudgedAttempts.delete(attempt.id); // Map.delete works the same
    }

    // Case 4: Session died without any artifacts — auto-retry with circuit breaker
    if (!alive && !handoff && !blocked) {
      updateAttemptStatus(attempt.id, 'failed', 'Session ended without handoff');
      logEvent(attempt.id, 'failed', { reason: 'no artifacts' });

      if (attempt.agent_session_id) {
        await emitActivity(attempt.agent_session_id, {
          type: 'error',
          body: 'Agent session ended without HANDOFF.md or BLOCKED.md.',
        });
        await dismissAgentSession(attempt.agent_session_id, undefined, '–');
      }

      // Verify issue still exists before retrying — deleted issues should not be re-enqueued
      let issueStillExists = true;
      try {
        await getIssue(attempt.issue_key);
      } catch (err) {
        if (isPermanentIssueError(err)) {
          issueStillExists = false;
          console.log(chalk.yellow(`[${ts}] Skipping retry for ${attempt.issue_key}: issue no longer exists in Linear`));
        }
      }

      if (!issueStillExists) continue;

      // Circuit breaker check (re-check after marking this attempt as failed)
      const cb = checkCircuitBreaker(attempt.issue_key, attempt.agent_type);
      if (cb.allowed) {
        const backoffMs = Math.max(cb.backoffMs, 30_000); // at least 30s
        console.log(chalk.yellow(`[${ts}] Auto-retry ${attempt.issue_key} in ${Math.round(backoffMs / 1000)}s (${cb.consecutiveFailures + 1} failures)`));

        enqueue({
          id: randomUUID(),
          issue_id: attempt.issue_id,
          issue_key: attempt.issue_key,
          agent_role: attempt.agent_type,
          agent_session_id: attempt.agent_session_id ?? undefined,
          delay_until: new Date(Date.now() + backoffMs).toISOString(),
        });
      } else {
        console.log(chalk.red(`[${ts}] Circuit breaker: ${cb.reason}`));
        await tripCircuitBreaker(attempt.issue_key, attempt.issue_id, attempt.agent_type, cb.consecutiveFailures);
      }
      // A session failed — try waking a hibernated session for the freed slot
      tryWakeHibernatedSession();
    }

    // Case 5: Follow-up session exceeded TTL — force-kill and dismiss
    if (alive && followUpMeta.has(attempt.id)) {
      const meta = followUpMeta.get(attempt.id)!;
      if (Date.now() - meta.createdAt > FOLLOW_UP_TTL_MS) {
        console.log(chalk.yellow(`[${ts}] Follow-up TTL exceeded for ${attempt.issue_key}, force-killing`));
        killSession(attempt.tmux_session);
        updateAttemptStatus(attempt.id, 'failed', 'Follow-up TTL exceeded');
        logEvent(attempt.id, 'failed', { reason: 'follow_up_ttl' });
        followUpMeta.delete(attempt.id);

        if (attempt.agent_session_id) {
          try {
            const agentTok = getAgentLinearToken(attempt.agent_type) || undefined;
            await dismissAgentSession(attempt.agent_session_id, agentTok, '–');
          } catch { /**/ }
        }
      }
    }
  }

  // Monitor hibernated sessions — detect if their tmux sessions died while frozen
  monitorHibernatedSessions();
}
