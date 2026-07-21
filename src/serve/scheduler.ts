/** Scheduler: queue drain, auto-dispatch, heartbeat, polling, reconciliation, janitor, project pipeline. */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { randomUUID, createHash } from 'crypto';
import { getConfig, resolveStatePath, STATE_DIR } from '../core/config.js';
import {
  getReadClient, getAgentClient, getIssue, updateIssueState,
  getIssuesByLabel, dismissAgentSession, listAgentSessions,
  globalDismissedSessions, getWorkflowStateId, addLabelToIssue,
} from '../core/linear.js';
import {
  getActiveAttempts, getActiveAttempt, getIdleAttempt, getAttemptsByIssue, updateAttemptStatus,
} from '../core/db.js';
import { sessionExists, sendKeys, readFileOnRemote, listSessionsByPrefix, killSession } from '../core/tmux.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';
import { canSpawnAgent } from '../core/router.js';
import {
  enqueue, dequeue, peekQueue, getQueueLength, getQueueItems,
  isInCooldown, completeQueueItem, cancelQueueItem, cancelQueued,
  hasActiveQueueEntry,
} from '../core/queue.js';
import { spawnCommand } from '../commands/spawn.js';
import { agentStartCommand } from '../commands/agent.js';
import { WORKFLOW_STATES, AGENT_LABELS } from '../types.js';

import { autoDispatchFailures, persistentDedupCheck, persistentDedupRecord } from './state.js';
import { hasQueuedIssue, isPermanentIssueError } from './helpers.js';
import { shouldSkipReview, hasStickyInProgressIntent, parseStatusIntent } from './monitor.js';
import { isNoiseIssue, isTriageIssue } from './noise-filter.js';
import { checkCircuitBreaker } from './circuit-breaker.js';
import { isRolePaused } from './agent-guards.js';
import { handleDispatch } from './dispatch.js';
import { isBlocked, isDuplicateOfDone } from '../core/linear-relations.js';
import { canStartNewSession, monitorHibernatedSessions, tryWakeHibernatedSession, getMaxParallel, hasCapacity, getRoleRunningCount } from './concurrency.js';
import { classifyDomain, shouldAutoRoute } from '../core/smart-router.js';

// Re-export for serve.ts
export { monitorHibernatedSessions, tryWakeHibernatedSession } from './concurrency.js';

// ─── Heartbeat: periodic unassigned issue checker ───

const HEARTBEAT_INTERVAL_MS = 5 * 60_000; // 5 minutes
let lastHeartbeatAt = 0;

export async function heartbeatAssignUnowned(): Promise<void> {
  if (Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = Date.now();

  const ts = new Date().toLocaleTimeString();

  try {
    const client = getReadClient();
    const config = getConfig();

    // Find issues with no assignee in Todo
    const states = await client.workflowStates({
      filter: { team: { id: { eq: config.linearTeamId } } }
    });
    const activeStateIds = states.nodes
      .filter(s => s.name === 'Todo')
      .map(s => s.id);

    if (activeStateIds.length === 0) return;

    const unassigned = await client.issues({
      filter: {
        state: { id: { in: activeStateIds } },
        team: { id: { eq: config.linearTeamId } },
        assignee: { null: true },
      },
      first: 10,
    });

    if (unassigned.nodes.length === 0) return;

    // Smart routing: classify each issue by domain and dispatch directly
    // when confidence is high/medium. Only defer to COO for truly ambiguous issues.
    const ambiguousIssues: typeof unassigned.nodes = [];

    for (const issue of unassigned.nodes) {
      // A1.4: duplicate-dispatch guard — skip issues that are already in flight.
      // Linear shows them "unassigned" when the delegate write failed or lagged,
      // but a queue row / active attempt / recent dispatch means work is underway.
      if (hasActiveQueueEntry(issue.identifier)) {
        console.log(chalk.dim(`[${ts}] Heartbeat: ${issue.identifier} already queued — skipping`));
        continue;
      }
      if (getActiveAttempt(issue.identifier)) {
        console.log(chalk.dim(`[${ts}] Heartbeat: ${issue.identifier} has an active attempt — skipping`));
        continue;
      }
      if (persistentDedupCheck(`disp-any:${issue.identifier}`, 10 * 60_000)) {
        console.log(chalk.dim(`[${ts}] Heartbeat: ${issue.identifier} dispatched <10min ago — skipping`));
        continue;
      }
      if (persistentDedupCheck(`delegate-failed:${issue.identifier}`, 30 * 60_000)) {
        console.log(chalk.dim(`[${ts}] Heartbeat: ${issue.identifier} delegate write failed recently (assigned-pending) — skipping`));
        continue;
      }
      // [to decide] issues never auto-dispatch. Same reason as the guard in
      // autoDispatchFromBacklog (RYA-1036 slipped past 2026-05-06 because
      // this heartbeat path was missing the gate).
      if (/^\[to decide\]/i.test(issue.title)) {
        ambiguousIssues.push(issue);
        continue;
      }
      // Noise filter: proactive machinery never auto-dispatches via heartbeat
      if (isNoiseIssue(issue.title)) continue;

      const description = (issue as any).description || '';
      const result = classifyDomain(issue.title, description);

      if (shouldAutoRoute(result)) {
        // Direct dispatch — skip COO entirely
        try {
          console.log(chalk.cyan(`[${ts}] Smart route: ${issue.identifier} → ${result.role} (${result.confidence}, keywords: ${result.matchedKeywords.slice(0, 3).join(', ')})`));
          await handleDispatch({
            role: result.role,
            issueKey: issue.identifier,
            message: `Auto-routed by smart router (${result.confidence} confidence). Keywords: ${result.matchedKeywords.join(', ')}.`,
            from: 'smart-router',
          });
        } catch (err) {
          console.log(chalk.yellow(`[${ts}] Smart route failed for ${issue.identifier}: ${(err as Error).message}`));
          ambiguousIssues.push(issue);
        }
      } else {
        ambiguousIssues.push(issue);
      }
    }

    // Remaining ambiguous issues go to COO for human judgment (fallback)
    if (ambiguousIssues.length === 0) return;

    const issueList = ambiguousIssues
      .map(i => `- ${i.identifier}: ${i.title} (P${i.priority})`)
      .join('\n');

    const triageMsg = `Heartbeat: ${ambiguousIssues.length} ambiguous issue(s) need your triage (smart router couldn't classify with confidence).\n\n${issueList}\n\nFor each: AGENT_ROLE=coo linear-tool dispatch <correct-role> <issue-key> "context". Research/analysis → research-lead. Code fixes → lead-engineer. Ops/infra → coo. Product/UX → cpo. Architecture/review → cto.`;

    // RYA-1131: resolve the actual tmux session name rather than hardcoding
    // `aos-coo`. agentStartCommand('coo') with no issueKey actually spawns
    // `aos-coo-coo` (agent.ts line 305 passes `issueKey || role` to the
    // adapter, which builds `aos-${agentRole}-${issueKey}`). The heartbeat
    // also runs while real COO sessions are busy on issues (e.g.
    // `aos-coo-RYA-1129`). Either of those is a valid recipient for triage —
    // pipe into whichever COO session exists. If none exists, spawn and poll
    // for any `aos-coo*` session to appear; skip silently on timeout instead
    // of logging a 'can't find pane' error every cycle.
    const pickCooSession = (sessions: string[]): string | undefined =>
      sessions.find(s => s === 'aos-coo') || sessions[0];

    const existing = pickCooSession(listSessionsByPrefix('aos-coo'));
    if (existing) {
      try {
        sendKeys(existing, triageMsg);
        console.log(chalk.cyan(`[${ts}] Heartbeat: piped triage of ${ambiguousIssues.length} ambiguous issue(s) into ${existing}`));
      } catch (err) {
        console.log(chalk.dim(`Heartbeat: sendKeys to ${existing} failed: ${(err as Error).message}`));
      }
    } else {
      try {
        await agentStartCommand('coo');
        console.log(chalk.cyan(`[${ts}] Heartbeat: started COO for triage of ${ambiguousIssues.length} ambiguous issue(s)`));
        // Poll for the new COO session to appear (the adapter may name it
        // `aos-coo` or `aos-coo-coo`; either is fine). Up to 30s @ 2s ticks.
        void (async () => {
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const target = pickCooSession(listSessionsByPrefix('aos-coo'));
            if (target) {
              try {
                sendKeys(target, triageMsg);
                console.log(chalk.dim(`Heartbeat: piped triage into ${target}`));
              } catch (err) {
                console.log(chalk.dim(`Heartbeat: sendKeys to ${target} failed: ${(err as Error).message}`));
              }
              return;
            }
          }
          // Polled out — skip silently. Next heartbeat (5 min) will retry.
          console.log(chalk.dim(`Heartbeat: no COO session appeared within 30s — skipping triage delivery this cycle`));
        })();
      } catch (err) {
        console.log(chalk.dim(`Heartbeat: failed to start COO: ${(err as Error).message}`));
      }
    }
  } catch (err) {
    console.log(chalk.dim(`Heartbeat: ${(err as Error).message}`));
  }
}

// ─── CEO Office triage heartbeat: auto-dispatch when In Review queue grows ───
//
// RYA-1060: cooldown was previously in-memory (`let lastCeoTriageAt = 0`).
// Every node restart (the supervisor auto-restarts on any src/ change) reset
// it to 0 and the next monitor tick re-fired triage on the same In Review set.
// On 2026-05-10 this produced 4 dispatches in 95 minutes (07:00, 07:08, 07:38,
// 08:34) on the same 20 issues, each spawning a fresh ceo-office session.
//
// Fix: persist the SHA-1 of the sorted In Review issue keys to disk and skip
// when the queue contents are identical to the last fire. The 30-min interval
// is kept as a soft floor to bound retry frequency when the queue churns
// between fires (one issue closed, another opened) without ceo-office having
// actually completed the prior triage.
//
// RYA-1124: hash-equality alone wasn't enough. The hash flips whenever ANY
// issue moves in or out of In Review (e.g., a trivial fix auto-closes during
// the day, a new sub-issue gets dispatched). On 2026-05-13 and 2026-05-14
// we saw 5-7 triages per day on essentially the same actionable subset
// (~20 long-tail [to decide] items). The 30-min soft floor doesn't help —
// hash flips at hour intervals as items churn, and each flip clears the
// cooldown for the next tick. Add a SET-DIFFERENCE check on the persisted
// `lastQueueKeys`: if every current In Review key was also in the prior
// fire's set (i.e., the queue only shrank or held steady), skip — there's
// nothing genuinely new to triage. Items leaving In Review don't need
// CEO attention; only items appearing fresh do.

const CEO_TRIAGE_INTERVAL_MS = 30 * 60_000; // 30 minutes (soft floor)
const CEO_TRIAGE_THRESHOLD = 5; // Dispatch when In Review count exceeds this
const CEO_TRIAGE_FIRED_PATH = join(STATE_DIR, 'ceo-triage-fired.json');

// RYA-1070: in-memory iterator-level throttle. The monitor loop calls
// ceoOfficeTriageHeartbeat every 15s, but the body fetches the In Review
// queue from Linear before deciding to skip — which spammed ~5760 API
// queries/day and ~240 "queue unchanged" log lines/hour. Gate the whole
// body on this throttle so we only hit Linear once per 30-min window.
// This is a fast in-memory check; the persisted hash-stable cooldown still
// runs inside the body and protects across restarts.
let lastTriageCheckMs = 0;

interface CeoTriageFireRecord {
  lastFiredMs: number;
  lastFiredIso: string;
  lastQueueHash: string;
  lastQueueCount: number;
  // RYA-1124: full key list to detect "queue churned but no new items".
  // Optional for backward compat with pre-RYA-1124 records on disk.
  lastQueueKeys?: string[];
}

// Test-only reset hook for the in-memory throttle.
export function __resetTriageCheckCacheForTests(): void {
  lastTriageCheckMs = 0;
}

function readCeoTriageFire(): CeoTriageFireRecord | null {
  if (!existsSync(CEO_TRIAGE_FIRED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CEO_TRIAGE_FIRED_PATH, 'utf-8')) as CeoTriageFireRecord;
  } catch (err) {
    console.debug(`[ceo-triage] readCeoTriageFire failed: ${(err as Error).message}`);
    return null;
  }
}

function writeCeoTriageFire(r: CeoTriageFireRecord): void {
  try {
    writeFileSync(CEO_TRIAGE_FIRED_PATH, JSON.stringify(r, null, 2));
  } catch (err) {
    console.debug(`[ceo-triage] writeCeoTriageFire failed: ${(err as Error).message}`);
  }
}

function hashIssueKeys(keys: string[]): string {
  return createHash('sha1').update([...keys].sort().join(',')).digest('hex');
}

export async function ceoOfficeTriageHeartbeat(): Promise<void> {
  // Kill switch
  if (process.env.AOS_NO_CEO_TRIAGE === '1') return;

  // RYA-1070: iterator-level throttle. The monitor loop calls this every 15s
  // but a meaningful triage decision can only change every CEO_TRIAGE_INTERVAL_MS.
  // Skip the Linear fetch + hash compute until the window elapses. Fast path —
  // no logs, no API. The inner hash-stable / soft-floor checks remain as the
  // restart-safe correctness layer.
  if (Date.now() - lastTriageCheckMs < CEO_TRIAGE_INTERVAL_MS) return;
  lastTriageCheckMs = Date.now();

  const ts = new Date().toLocaleTimeString();

  try {
    // Check if ceo-office agent exists
    if (!agentExists('ceo-office')) return;

    // Check if ceo-office is already running
    const activeAttempts = getActiveAttempts();
    const ceoRunning = activeAttempts.filter(
      a => a.agent_type === 'ceo-office' && a.status === 'running'
    );
    if (ceoRunning.length > 0) {
      // Already working — skip
      return;
    }

    // Count In Review issues
    const client = getReadClient();
    const config = getConfig();
    const inReviewIssues = await client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        state: { name: { eq: WORKFLOW_STATES.IN_REVIEW } },
      },
      first: 100,
    });

    // RYA-1205: exclude prior triage issues from the count, the keyset, and
    // the prompt. A finished "Daily triage:*" issue that lands In Review
    // (reconciler default, fixed in RYA-1204) otherwise counts as a NEW item
    // in the set-difference check below — the triage process fed its own
    // trigger (4 dispatches in ~2.5h on 2026-06-10: RYA-1186/1190/1193/1202).
    const actionableNodes = inReviewIssues.nodes.filter(i => !isTriageIssue(i.title));

    const inReviewCount = actionableNodes.length;
    if (inReviewCount <= CEO_TRIAGE_THRESHOLD) {
      console.log(chalk.dim(`[${ts}] CEO triage: ${inReviewCount} In Review (threshold ${CEO_TRIAGE_THRESHOLD}), skipping`));
      return;
    }

    // RYA-1060: dedup by content (SHA-1 of sorted issue keys), persisted to
    // disk so it survives node restart. Primary check — if the In Review set
    // is identical to last fire, skip regardless of how long ago that was.
    const issueKeys = actionableNodes.map(i => i.identifier);
    const queueHash = hashIssueKeys(issueKeys);
    const last = readCeoTriageFire();
    if (last && last.lastQueueHash === queueHash) {
      console.log(chalk.dim(`[${ts}] CEO triage: skip — queue unchanged since last fire (${inReviewCount} issues, hash ${queueHash.slice(0, 8)})`));
      return;
    }
    // RYA-1124: hash differs, but check whether the difference is purely
    // items LEAVING the queue (auto-closed, moved to Backlog) vs items
    // ENTERING. If no current key is new relative to the prior fire's set,
    // ceo-office has nothing genuinely new to triage — skip. This kills the
    // 5-7-fires-per-day pattern observed 2026-05-13 / 2026-05-14, where the
    // actionable subset (~20 long-tail [to decide] items) stays constant
    // while trivial fixes close around it.
    if (last?.lastQueueKeys && last.lastQueueKeys.length > 0) {
      const knownKeys = new Set(last.lastQueueKeys);
      const newItems = issueKeys.filter(k => !knownKeys.has(k));
      if (newItems.length === 0) {
        const removed = last.lastQueueKeys.length - inReviewCount;
        const removedSuffix = removed > 0 ? `, ${removed} removed` : '';
        console.log(chalk.dim(`[${ts}] CEO triage: skip — queue churned but no new items since last fire (${inReviewCount} issues${removedSuffix})`));
        return;
      }
    }
    // Soft floor: even if the queue contents changed, don't refire within
    // the cooldown window. Prevents a tight loop when a single issue churns
    // (e.g., moved out then back to In Review) before triage actually lands.
    if (last && Date.now() - last.lastFiredMs < CEO_TRIAGE_INTERVAL_MS) {
      console.log(chalk.dim(`[${ts}] CEO triage: skip — within ${CEO_TRIAGE_INTERVAL_MS / 60_000}min cooldown (queue changed but soft floor)`));
      return;
    }
    // RYA-1205: hard cap — at most ONE auto-triage dispatch per UTC day,
    // regardless of how the queue churns (mirrors RYA-912's 1/role/day rule).
    // Every softer guard above has been routed around at least once (RYA-1060
    // restart reset, RYA-1124 keyset churn, RYA-1205 self-feeding). Manual
    // dispatch via linear-tool doesn't pass through this function and stays
    // unrestricted.
    const todayUtc = new Date(Date.now()).toISOString().slice(0, 10);
    if (last && new Date(last.lastFiredMs).toISOString().slice(0, 10) === todayUtc) {
      console.log(chalk.dim(`[${ts}] CEO triage: skip — daily cap (already fired ${todayUtc}, max 1 auto-triage/UTC day)`));
      return;
    }

    // Check capacity
    const ceoConfig = loadAgentConfig('ceo-office');
    const maxP = ceoConfig.maxParallel ?? 2;
    if (ceoRunning.length >= maxP) return;

    // Global concurrency gate
    const concurrency = canStartNewSession();
    if (!concurrency.allowed) return;

    // Build triage prompt with issue summary. RYA-1080: previously sliced to
    // first 20 by Linear's default updatedAt-desc order, which hid the long
    // tail of older items (P1s, strategic work) for 7+ days. Now show all
    // items, sorted by createdAt asc so the oldest items surface first —
    // those are most at risk of being forgotten.
    const sortedNodes = [...actionableNodes].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const issueList = sortedNodes
      .map(i => `- ${i.identifier}: ${i.title} (P${i.priority})`)
      .join('\n');

    const triagePrompt = `CEO Office triage: ${inReviewCount} issues are In Review and awaiting processing.\n\nReview each issue below. For trivial issues (fix, test, refactor, typo, chore), close as Done if HANDOFF.md shows success. For substantive issues, leave for CEO review. For incomplete work, comment and move back to In Progress.\n\n${issueList}`;

    // Create a triage issue for CEO Office to work on
    const agentClient = getAgentClient();
    const todoStateId = await getWorkflowStateId('Todo');
    const ceoLinearUserId = ceoConfig.linearUserId;

    // Persist the fire record BEFORE attempting createIssue/dispatch. If the
    // dispatch fails after this point (Linear down, capacity exhausted), the
    // hash is still recorded so subsequent ticks won't re-fire on the same
    // queue. Behaves identically to the original "set lastCeoTriageAt early"
    // pattern — we'd rather drop a triage cycle than risk a re-fire storm.
    writeCeoTriageFire({
      lastFiredMs: Date.now(),
      lastFiredIso: new Date().toISOString(),
      lastQueueHash: queueHash,
      lastQueueCount: inReviewCount,
      // RYA-1124: persist the full key list so the next tick can detect
      // "queue churned but no new items" via set difference.
      lastQueueKeys: issueKeys,
    });

    const result = await agentClient.createIssue({
      teamId: config.linearTeamId,
      title: `Daily triage: ${inReviewCount} issues In Review`,
      description: triagePrompt,
      priority: 3, // Medium
      stateId: todoStateId,
      ...(ceoLinearUserId ? { delegateId: ceoLinearUserId } : {}),
    });

    if (!result.success) {
      console.log(chalk.red(`[${ts}] CEO triage: failed to create triage issue`));
      return;
    }

    const issue = await result.issue;
    if (!issue) return;

    const issueKey = issue.identifier;

    // Dispatch CEO Office
    await handleDispatch({
      role: 'ceo-office',
      issueKey,
      message: triagePrompt,
      from: 'scheduler',
    });

    console.log(chalk.cyan(`[${ts}] CEO triage: dispatched ceo-office to ${issueKey} (${inReviewCount} In Review issues, hash ${queueHash.slice(0, 8)})`));
  } catch (err) {
    console.log(chalk.dim(`CEO triage: ${(err as Error).message}`));
  }
}

// ─── CEO Office daily morning dispatch: retro, strategy, memory ───
//
// RYA-1060: same in-memory restart bug as ceoOfficeTriageHeartbeat. The 24h
// cooldown was reset on every node restart, so a restart inside the 8-10 AM
// window would fire the daily dispatch again. Fixed by persisting lastFiredMs
// to disk; a restart now reads the prior fire timestamp and respects the 24h
// gap.

const CEO_DAILY_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours
const CEO_DAILY_TARGET_HOUR = 9; // 9 AM local time
const CEO_DAILY_FIRED_PATH = join(STATE_DIR, 'ceo-daily-fired.json');

interface CeoDailyFireRecord {
  lastFiredMs: number;
  lastFiredIso: string;
}

function readCeoDailyFire(): CeoDailyFireRecord | null {
  if (!existsSync(CEO_DAILY_FIRED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CEO_DAILY_FIRED_PATH, 'utf-8')) as CeoDailyFireRecord;
  } catch (err) {
    console.debug(`[ceo-daily] readCeoDailyFire failed: ${(err as Error).message}`);
    return null;
  }
}

function writeCeoDailyFire(r: CeoDailyFireRecord): void {
  try {
    writeFileSync(CEO_DAILY_FIRED_PATH, JSON.stringify(r, null, 2));
  } catch (err) {
    console.debug(`[ceo-daily] writeCeoDailyFire failed: ${(err as Error).message}`);
  }
}

export async function ceoOfficeDailyDispatch(): Promise<void> {
  // Kill switch
  if (process.env.AOS_NO_CEO_DAILY === '1') return;

  // Only run once per 24h (persisted across node restarts)
  const lastFire = readCeoDailyFire();
  if (lastFire && Date.now() - lastFire.lastFiredMs < CEO_DAILY_INTERVAL_MS) return;

  // Only run near the target hour (8-10 AM window)
  const currentHour = new Date().getHours();
  if (currentHour < CEO_DAILY_TARGET_HOUR - 1 || currentHour > CEO_DAILY_TARGET_HOUR + 1) return;

  // Persist the fire timestamp BEFORE attempting work — same rationale as
  // ceoOfficeTriageHeartbeat: drop a daily cycle rather than risk a re-fire
  // storm if createIssue/dispatch fails partway through.
  writeCeoDailyFire({
    lastFiredMs: Date.now(),
    lastFiredIso: new Date().toISOString(),
  });

  const ts = new Date().toLocaleTimeString();

  try {
    if (!agentExists('ceo-office')) return;

    // Skip if ceo-office is already running
    const activeAttempts = getActiveAttempts();
    const ceoRunning = activeAttempts.filter(
      a => a.agent_type === 'ceo-office' && a.status === 'running'
    );
    if (ceoRunning.length > 0) return;

    // Check capacity
    const ceoConfig = loadAgentConfig('ceo-office');
    const maxP = ceoConfig.maxParallel ?? 2;
    if (ceoRunning.length >= maxP) return;

    // Global concurrency gate
    const concurrency = canStartNewSession();
    if (!concurrency.allowed) return;

    const today = new Date().toISOString().split('T')[0];
    const dailyPrompt = `Daily morning protocol (${today}). Execute your full daily cadence:\n\n` +
      `1. **Morning Triage**: Run \`linear-tool list-issues "In Review"\`. For each:\n` +
      `   - Trivial issues (fix, test, refactor, docs, chore) with successful HANDOFF → close as Done\n` +
      `   - Substantive/architectural/security → leave for CEO\n` +
      `   - Incomplete work → comment + move back to In Progress\n\n` +
      `2. **Daily Retrospective**: Review all issues worked on in the last 24 hours.\n` +
      `   - Write \`.agent-memory/daily-retro-${today}.md\` with: wins, failures, patterns\n` +
      `   - Synthesize cross-cutting learnings\n\n` +
      `3. **Agent Coordination**: Run \`linear-tool team-status\`. Redistribute work if any agent is overloaded or idle.\n\n` +
      `4. **Company Memory**: Update \`~/.aos/shared-memory/\` with learnings that benefit all agents.\n\n` +
      `5. **Discord Summary**: \`AGENT_ROLE=ceo-office linear-tool group "Daily triage ${today}: [summary]"\``;

    // Create daily triage issue
    const config = getConfig();
    const agentClient = getAgentClient();
    const todoStateId = await getWorkflowStateId('Todo');
    const ceoLinearUserId = ceoConfig.linearUserId;

    const result = await agentClient.createIssue({
      teamId: config.linearTeamId,
      title: `Daily CEO Office: morning triage & retro (${today})`,
      description: dailyPrompt,
      priority: 3,
      stateId: todoStateId,
      ...(ceoLinearUserId ? { delegateId: ceoLinearUserId } : {}),
    });

    if (!result.success) {
      console.log(chalk.red(`[${ts}] CEO daily: failed to create daily issue`));
      return;
    }

    const issue = await result.issue;
    if (!issue) return;

    const issueKey = issue.identifier;

    await handleDispatch({
      role: 'ceo-office',
      issueKey,
      message: dailyPrompt,
      from: 'scheduler',
    });

    console.log(chalk.green(`[${ts}] CEO daily: dispatched ceo-office to ${issueKey} (morning protocol)`));
  } catch (err) {
    console.log(chalk.dim(`CEO daily: ${(err as Error).message}`));
  }
}

// ─── Auto-dispatch from backlog ───

const MAX_AUTO_DISPATCH_FAILURES = 2;
// 2026-05-06: backstop against re-spawn loops where an agent "completes" but
// doesn't transition Linear state. Without this, autoDispatchFromBacklog will
// keep picking the same Todo issue every 15s after each completion.
const RECENT_COMPLETION_DEDUP_HOURS = 6;

// RYA-1130: Per-issue log throttle for the recent-completion skip line. The
// monitor loop calls autoDispatchFromBacklog every 15s; a Todo issue with a
// recent-completion marker would log "Auto-dispatch skip (recent completion):
// RYA-XXXX" on every iteration. RYA-1111 produced 822 lines in 30 minutes
// (2026-05-14). Cache the latest-completion timestamp we've already logged
// per issue; emit only when it changes (i.e. a NEW completion arrives). Same
// class as RYA-1050 (Backlog-blocker spam) and RYA-1070 (CEO triage throttle).
const recentCompletionLogCache = new Map<string, number>();

// Test-only reset hook for the in-memory log cache.
export function __resetRecentCompletionLogCacheForTests(): void {
  recentCompletionLogCache.clear();
}

// Returns the timestamp (ms) of the most recent completed attempt within the
// window, or 0 if none. The timestamp also doubles as the de-dup key for the
// log throttle above — a new completion produces a fresh log line.
function latestRecentCompletionTs(issueKey: string, hours: number): number {
  const since = Date.now() - hours * 3600 * 1000;
  let latest = 0;
  for (const a of getAttemptsByIssue(issueKey)) {
    if (a.status !== 'completed') continue;
    const t = new Date(a.created_at.includes('Z') ? a.created_at : a.created_at + 'Z').getTime();
    if (t >= since && t > latest) latest = t;
  }
  return latest;
}

let lastAutoDispatchAt = 0;
const AUTO_DISPATCH_COOLDOWN_MS = 120_000; // 2 min between auto-dispatches

export async function autoDispatchFromBacklog(): Promise<void> {
  // Kill switch: disable auto-dispatch via env var
  if (process.env.AOS_NO_AUTO_DISPATCH === '1') return;

  // Cooldown: don't dispatch too frequently
  if (Date.now() - lastAutoDispatchAt < AUTO_DISPATCH_COOLDOWN_MS) return;

  // Global concurrency gate — prevents dispatch storm after restart
  const concurrencyCheck = canStartNewSession();
  if (!concurrencyCheck.allowed) {
    return;
  }

  // Check if any agents have capacity (running < maxParallel)
  // Use getMaxParallel() from concurrency.ts which clamps legacy values (≥20 → sensible defaults)
  // and getRoleRunningCount() which deduplicates by unique tmux session names.
  const availableRoles: string[] = [];

  for (const role of listAgents()) {
    if (!agentExists(role)) continue;
    if (isRolePaused(role)) continue; // A4.3: cost-velocity pause
    if (hasCapacity(role)) {
      availableRoles.push(role);
    }
  }

  if (availableRoles.length === 0) return;

  // RYA-1050: Iterate Todo only. Backlog issues are CEO's queue — not work-ready
  // by definition. Including them caused two failure modes: (1) per-cycle log
  // spam from the blocker check on chronically-blocked Backlog issues
  // (RYA-639/RYA-969 produced 260 lines in 16hrs), and (2) wasted Linear API
  // budget re-fetching blocker relations every cycle. Backlog → Todo is the
  // CEO's signal to start work; until that happens the dispatcher should not
  // touch the issue.
  try {
    const client = getReadClient();
    const config = getConfig();
    const todoState = await client.workflowStates({ filter: { name: { eq: 'Todo' }, team: { id: { eq: config.linearTeamId } } } });

    const stateIds = todoState.nodes.map(s => s.id);
    if (stateIds.length === 0) return;

    const issues = await client.issues({
      filter: { state: { id: { in: stateIds } }, team: { id: { eq: config.linearTeamId } } },
      first: 10,
    });

    // Sort by priority client-side (1=urgent, 4=low, 0=no priority)
    issues.nodes.sort((a, b) => {
      const pa = a.priority || 5;
      const pb = b.priority || 5;
      return pa - pb;
    });

    for (const issue of issues.nodes) {
      const issueKey = issue.identifier;

      // Skip proactive machinery (votes, ideas, exploration hubs). Only the
      // proactive heartbeat itself should dispatch these — the per-role weekly
      // cadence is the throttle. autoDispatchFromBacklog must not pick them up
      // after a serve restart, or the cleanup-then-restart cycle reanimates
      // every stale vote issue.
      if (isNoiseIssue(issue.title)) {
        const ts3 = new Date().toLocaleTimeString();
        console.log(chalk.dim(`[${ts3}] Auto-dispatch skip (noise): ${issueKey} — ${issue.title.slice(0, 60)}`));
        continue;
      }

      // [to decide] issues are explicit CEO-decision items — they wait for the
      // human to decide, not for an agent to auto-pick up. Cycling these via
      // smart-route generated 28 ceo-office spawns on RYA-970 in 4 hours
      // (2026-05-06 incident). The CEO is the only valid dispatcher.
      if (/^\[to decide\]/i.test(issue.title)) {
        const ts3 = new Date().toLocaleTimeString();
        console.log(chalk.dim(`[${ts3}] Auto-dispatch skip ([to decide]): ${issueKey} — ${issue.title.slice(0, 60)}`));
        continue;
      }

      // De-dup window: if any role completed this issue successfully in the
      // last RECENT_COMPLETION_DEDUP_HOURS, do NOT re-dispatch. This is the
      // backstop against the "agent finishes but doesn't change Linear state"
      // pattern that produced the 28-spawn loop on 2026-05-06. Failed attempts
      // are handled by the existing autoDispatchFailures counter.
      //
      // RYA-1130: skip semantics unchanged, but the log line is throttled —
      // emit at most once per (issueKey, latest-completion-timestamp) tuple
      // so the per-iteration spam (RYA-1111: 822 lines in 30 min) is gone.
      const recentCompletionTs = latestRecentCompletionTs(issueKey, RECENT_COMPLETION_DEDUP_HOURS);
      if (recentCompletionTs > 0) {
        if (recentCompletionLogCache.get(issueKey) !== recentCompletionTs) {
          const ts3 = new Date().toLocaleTimeString();
          console.log(chalk.dim(`[${ts3}] Auto-dispatch skip (recent completion): ${issueKey}`));
          recentCompletionLogCache.set(issueKey, recentCompletionTs);
        }
        continue;
      }

      // Skip issues that have failed auto-dispatch too many times
      if ((autoDispatchFailures.get(issueKey) || 0) >= MAX_AUTO_DISPATCH_FAILURES) continue;

      // Resolve target agent from assignee OR delegate.
      // Delegate = Linear's agent delegation field (preferred for agent work).
      // Assignee = traditional assignment (may be human or agent).
      let targetRole: string | null = null;

      // 1. Check delegate first (Linear agent delegation)
      const delegateId = (issue as any).delegateId as string | undefined;
      if (delegateId) {
        for (const role of listAgents()) {
          const cfg = loadAgentConfig(role);
          if (cfg.linearUserId === delegateId) {
            targetRole = role;
            break;
          }
        }
      }

      // 2. Fall back to assignee
      if (!targetRole) {
        const assignee = await issue.assignee;
        if (assignee) {
          for (const role of listAgents()) {
            const cfg = loadAgentConfig(role);
            if (cfg.linearUserId === assignee.id) {
              targetRole = role;
              break;
            }
          }
        }
      }

      // 3. Smart routing fallback: classify by title/description keywords
      if (!targetRole) {
        const description = (issue as any).description || '';
        const classification = classifyDomain(issue.title, description);
        if (shouldAutoRoute(classification)) {
          targetRole = classification.role;
          const ts2 = new Date().toLocaleTimeString();
          console.log(chalk.cyan(`[${ts2}] Auto-dispatch smart route: ${issueKey} → ${targetRole} (${classification.confidence})`));
        } else {
          continue; // Truly ambiguous — let heartbeat/COO handle
        }
      }

      // Only dispatch if the target role is idle
      if (!availableRoles.includes(targetRole)) continue;

      // Guard: skip if a tmux session already exists for this role+issue
      // (agentStartCommand also checks, but catching it here avoids unnecessary getIssue calls)
      if (sessionExists(`aos-${targetRole}-${issueKey}`)) continue;

      // Guard: skip if there's already an idle session on this issue (any role)
      // The idle session can be reactivated — no need to spawn a new one
      const existingIdle = getIdleAttempt(issueKey);
      if (existingIdle) continue;

      // Circuit breaker: skip if this issue has exceeded its retry limit
      const cb = checkCircuitBreaker(issueKey, targetRole);
      if (!cb.allowed) {
        console.log(chalk.dim(`  Auto-dispatch circuit breaker: ${cb.reason}`));
        continue;
      }

      // Dependency check: skip if this issue has unresolved blockers
      const blockCheck = await isBlocked(issueKey);
      if (blockCheck.blocked) {
        const blockerKeys = blockCheck.blockers.map(b => b.issueKey).join(', ');
        console.log(chalk.dim(`  Auto-dispatch blocked: ${issueKey} has unresolved blockers: ${blockerKeys}`));
        continue;
      }

      // Duplicate-of-Done check (RYA-1071): an issue Linear has already marked
      // as duplicate-of a completed issue has no real work to do. Spawning a
      // session would waste ~20h of tmux lifetime for zero work product (the
      // RYA-1067 incident on 2026-05-11). Count as an auto-dispatch failure so
      // the per-issue MAX_AUTO_DISPATCH_FAILURES gate stops the every-cycle
      // log spam after a few iterations.
      const dupCheck = await isDuplicateOfDone(issueKey);
      if (dupCheck) {
        const ts3 = new Date().toLocaleTimeString();
        console.log(chalk.dim(`[${ts3}] Skip dispatch: ${issueKey} is duplicate of ${dupCheck.canonicalKey} (${dupCheck.canonicalState})`));
        autoDispatchFailures.set(issueKey, (autoDispatchFailures.get(issueKey) || 0) + 1);
        continue;
      }

      // Dispatch!
      const ts = new Date().toLocaleTimeString();
      console.log(chalk.cyan(`[${ts}] Auto-dispatch: ${issueKey} → ${targetRole} (idle agent, backlog issue)`));

      // Cancel any queued entries for this issue targeting a different agent
      // to prevent intrusion (e.g., lead-engineer queued but COO now dispatched)
      const canceled = cancelQueued(issueKey);
      if (canceled > 0) {
        console.log(chalk.dim(`  Canceled ${canceled} stale queue entry(ies) for ${issueKey}`));
      }

      try {
        await agentStartCommand(targetRole, issueKey);
        lastAutoDispatchAt = Date.now();
        return; // One at a time
      } catch (err) {
        const count = (autoDispatchFailures.get(issueKey) || 0) + 1;
        autoDispatchFailures.set(issueKey, count);
        console.log(chalk.yellow(`[${ts}] Auto-dispatch failed (${count}/${MAX_AUTO_DISPATCH_FAILURES}): ${(err as Error).message}`));
      }
    }
  } catch (err) {
    // Linear API error — skip this cycle
    console.log(chalk.dim(`Auto-dispatch: Linear query failed: ${(err as Error).message}`));
  }
}

// ─── Queue drain ───

export async function drainQueue(): Promise<void> {
  const next = peekQueue();
  if (!next) return;

  // RYA-300: Check per-role cooldown instead of global — rate limit on one agent
  // no longer blocks all agents from being dequeued
  if (isInCooldown(next.agent_role)) return;

  // A4.3: cost-velocity pause — leave the item queued until the pause expires
  if (isRolePaused(next.agent_role)) return;

  // Check if the agent model has capacity
  const agentConfig = loadAgentConfig(next.agent_role);
  const modelType = agentConfig.baseModel || 'cc';
  const { allowed } = canSpawnAgent(modelType);
  if (!allowed) return;

  // Per-role capacity check (RYA-319: was missing — queue could drain past per-role limits)
  if (!hasCapacity(next.agent_role)) return;

  // Global concurrency gate
  const concurrency = canStartNewSession();
  if (!concurrency.allowed) return;

  const item = dequeue();
  if (!item) return;

  const ts = new Date().toLocaleTimeString();
  const remaining = getQueueLength();
  console.log(chalk.cyan(`[${ts}] Queue drain: ${item.issue_key} → ${item.agent_role} (${remaining} remaining)`));

  // Guard: if another agent is already active on this issue, cancel the queued item
  // to prevent "intrusion" (two different agents working the same issue concurrently).
  const existingAttempt = getActiveAttempt(item.issue_key);
  if (existingAttempt && existingAttempt.agent_type !== item.agent_role) {
    console.log(chalk.yellow(`  Queue skip: ${item.issue_key} already being worked by ${existingAttempt.agent_type} — canceling queued ${item.agent_role}`));
    cancelQueueItem(item.id);
    return;
  }

  // Guard: if there's an idle session on this issue, don't spawn — it can be reactivated
  const idleOnIssue = getIdleAttempt(item.issue_key);
  if (idleOnIssue) {
    console.log(chalk.dim(`  Queue skip: ${item.issue_key} has idle session (${idleOnIssue.agent_type}) — reactivate instead`));
    cancelQueueItem(item.id);
    return;
  }

  // Circuit breaker: skip if this issue has exceeded its retry limit
  const queueCb = checkCircuitBreaker(item.issue_key, item.agent_role);
  if (!queueCb.allowed) {
    console.log(chalk.yellow(`  Queue circuit breaker: ${queueCb.reason}`));
    cancelQueueItem(item.id);
    return;
  }

  // Terminal-state short-circuit (RYA-1155): if the Linear issue is already
  // Done or Canceled, there's no work to do. Without this gate, the blocker
  // check below re-enqueues the item every 5 min, producing endless log spam
  // when a Done issue has a stale [to decide] blocker relation (RYA-1148:
  // 336 lines in 24h). Purge ALL queued entries for the issue so other roles
  // queued for the same issue don't trigger the same loop on their turn.
  // Sibling of RYA-1050 (Backlog short-circuit in autoDispatchFromBacklog).
  try {
    const liveIssue = await getIssue(item.issue_key);
    const liveState = (liveIssue.state || '').toLowerCase();
    if (liveState === 'done' || liveState === 'canceled' || liveState === 'cancelled') {
      console.log(chalk.dim(`  Queue skip: ${item.issue_key} is ${liveIssue.state} — purging queue entries`));
      cancelQueueItem(item.id);
      const purged = cancelQueued(item.issue_key);
      if (purged > 0) {
        console.log(chalk.dim(`  Purged ${purged} additional queue entries for ${item.issue_key}`));
      }
      return;
    }
  } catch (err) {
    // Linear API error — fail open. The blocker check below has its own
    // fail-open behavior, and isPermanentIssueError handles deletion downstream.
    console.log(chalk.dim(`  Queue state check failed for ${item.issue_key}: ${(err as Error).message}`));
  }

  // Dependency check: skip if this issue has unresolved blockers
  const queueBlockCheck = await isBlocked(item.issue_key);
  if (queueBlockCheck.blocked) {
    const blockerKeys = queueBlockCheck.blockers.map(b => b.issueKey).join(', ');
    console.log(chalk.yellow(`  Queue blocked: ${item.issue_key} has unresolved blockers: ${blockerKeys}`));
    // Re-enqueue with delay so we check again later (don't cancel — the blocker may resolve)
    cancelQueueItem(item.id);
    enqueue({
      id: randomUUID(),
      issue_id: item.issue_id,
      issue_key: item.issue_key,
      agent_role: item.agent_role,
      follow_up_prompt: item.follow_up_prompt ?? undefined,
      delay_until: new Date(Date.now() + 5 * 60_000).toISOString(), // Re-check in 5 min
    });
    return;
  }

  try {
    if (agentExists(item.agent_role)) {
      await agentStartCommand(item.agent_role, item.issue_key, {
        followUpPrompt: item.follow_up_prompt ?? undefined,
      });
    } else {
      await spawnCommand(item.issue_key, {
        agentSessionId: item.agent_session_id ?? undefined,
        followUpPrompt: item.follow_up_prompt ?? undefined,
      });
    }
    completeQueueItem(item.id);
  } catch (err) {
    console.log(chalk.red(`  Queue spawn failed: ${(err as Error).message}`));
    cancelQueueItem(item.id);

    // Permanent error (issue deleted/not found): cancel ALL queue entries for this issue
    // to prevent other roles or delayed retries from hitting the same dead issue
    if (isPermanentIssueError(err)) {
      const purged = cancelQueued(item.issue_key);
      if (purged > 0) {
        console.log(chalk.yellow(`  Purged ${purged} remaining queue entries for deleted issue ${item.issue_key}`));
      }
    }
  }
}

// ─── Polling fallback: pick up orphaned agent-labeled issues ───

let lastPollTime = 0;
const POLL_INTERVAL_MS = 60_000;

export async function pollOrphanedIssues(): Promise<void> {
  if (Date.now() - lastPollTime < POLL_INTERVAL_MS) return;
  lastPollTime = Date.now();

  for (const role of listAgents()) {
    const labelName = `agent:${role}`;
    try {
      const issues = await getIssuesByLabel(labelName, WORKFLOW_STATES.TODO);
      for (const issue of issues) {
        if (getActiveAttempt(issue.identifier)) continue; // already being worked on
        if (sessionExists(`aos-${role}-${issue.identifier}`)) continue; // tmux session exists

        // Circuit breaker: skip if this issue has exceeded its retry limit
        const pollCb = checkCircuitBreaker(issue.identifier, role);
        if (!pollCb.allowed) continue;

        // Dependency check: skip if this issue has unresolved blockers
        const pollBlockCheck = await isBlocked(issue.identifier);
        if (pollBlockCheck.blocked) continue;

        // Global concurrency gate
        const globalCheck = canStartNewSession();
        if (!globalCheck.allowed) continue;

        const agentConfig = loadAgentConfig(role);
        const modelType = agentConfig.baseModel || 'cc';
        const { allowed } = canSpawnAgent(modelType);

        const ts = new Date().toLocaleTimeString();
        if (allowed) {
          console.log(chalk.cyan(`[${ts}] Poll pickup: ${issue.identifier} → ${role}`));
          try {
            await agentStartCommand(role, issue.identifier);
          } catch (err) {
            console.log(chalk.red(`  Poll spawn failed: ${(err as Error).message}`));
          }
        } else if (!isInCooldown(role)) {
          console.log(chalk.yellow(`[${ts}] Poll queued: ${issue.identifier} → ${role}`));
          enqueue({
            id: randomUUID(),
            issue_id: issue.id,
            issue_key: issue.identifier,
            agent_role: role,
          });
        }
      }
    } catch {
      // Silently skip — Linear API might be unavailable
    }
  }
}

// ─── Reconcile In Progress issues ───

let lastReconcileTime = 0;
const RECONCILE_INTERVAL_MS = 5 * 60_000;

export async function reconcileInProgressIssues(): Promise<void> {
  if (Date.now() - lastReconcileTime < RECONCILE_INTERVAL_MS) return;
  lastReconcileTime = Date.now();

  try {
    const client = getReadClient();
    const issues = await client.issues({
      first: 100,
      filter: {
        team: { id: { eq: getConfig().linearTeamId } },
        state: { name: { eq: WORKFLOW_STATES.IN_PROGRESS } },
      },
    });

    for (const issue of issues.nodes) {
      if (getActiveAttempt(issue.identifier) || hasQueuedIssue(issue.identifier)) continue;

      const latestAttempt = getAttemptsByIssue(issue.identifier)[0];
      let targetState: string | null = null;

      // Use per-agent token so changes are attributed to the agent, not the CEO
      const agentRole = latestAttempt?.agent_type;
      const reconcileToken = agentRole ? (getAgentLinearToken(agentRole) || undefined) : undefined;

      if (latestAttempt?.status === 'completed') {
        // Check if this is a trivial issue that can auto-close as Done
        const handoff = latestAttempt.workspace_path
          ? readFileOnRemote(resolveStatePath(latestAttempt.issue_key, latestAttempt.workspace_path, 'HANDOFF.md')) : null;
        // RYA-1116: If the agent's HANDOFF.md explicitly chose to stay
        // In Progress, the reconciler must not override that sticky intent.
        // Promotion only happens when the agent rewrites HANDOFF.md.
        if (hasStickyInProgressIntent(handoff)) continue;
        // RYA-1204: honor the agent's declared status_intent. The monitor's
        // completion sequence can be killed mid-flight (auto-deploy restart)
        // after the attempt is marked completed but before the status is
        // applied — the reconciler is the recovery path, so it must apply the
        // same mapping instead of blindly defaulting to In Review.
        const intent = handoff ? parseStatusIntent(handoff) : null;
        if (intent?.status === 'done') {
          targetState = WORKFLOW_STATES.DONE;
        } else if (intent?.status === 'in-review') {
          targetState = WORKFLOW_STATES.IN_REVIEW;
        } else if (intent?.status === 'todo') {
          targetState = WORKFLOW_STATES.TODO;
        } else {
          targetState = shouldSkipReview(issue.title, handoff || '')
            ? WORKFLOW_STATES.DONE
            : WORKFLOW_STATES.IN_REVIEW;
        }
      } else if (!latestAttempt || latestAttempt.status === 'failed' || latestAttempt.status === 'blocked') {
        // Check if the issue already has the agent:blocked label
        const issueLabels = await issue.labels();
        const hasBlockedLabel = issueLabels.nodes.some(l => l.name === AGENT_LABELS.BLOCKED);
        if (hasBlockedLabel) {
          // Already blocked — leave it alone, someone needs to remove the label to retry
          continue;
        }
        // No blocked label — mark as blocked (keep In Progress)
        try {
          await addLabelToIssue(issue.id, AGENT_LABELS.BLOCKED, reconcileToken);
        } catch (err) {
          console.log(chalk.dim(`Reconcile: failed to label ${issue.identifier} as blocked: ${(err as Error).message}`));
        }
      }

      if (!targetState) continue;

      const ts = new Date().toLocaleTimeString();
      console.log(chalk.dim(`[${ts}] Reconcile: ${issue.identifier} In Progress → ${targetState}`));
      try {
        await updateIssueState(issue.id, targetState, reconcileToken);
      } catch (err) {
        console.log(chalk.dim(`Reconcile: failed to transition ${issue.identifier} → ${targetState}: ${(err as Error).message}`));
      }
    }
  } catch (err) {
    console.log(chalk.dim(`Reconcile: ${(err as Error).message}`));
  }
}

// ─── Janitor: dismiss stale agent sessions ───

let lastJanitorTime = 0;
const SESSION_JANITOR_INTERVAL_MS = 5 * 60_000;

// Track sessions that repeatedly fail to dismiss (e.g. from foreign workspaces)
const janitorFailCounts = new Map<string, number>();
const JANITOR_MAX_FAILURES = 3; // Stop retrying after this many consecutive failures

export async function janitorAgentSessions(): Promise<void> {
  if (Date.now() - lastJanitorTime < SESSION_JANITOR_INTERVAL_MS) return;
  lastJanitorTime = Date.now();

  const teamKey = getConfig().linearTeamKey;
  const activeAttempts = getActiveAttempts();
  const activeIssues = new Set(activeAttempts.map((attempt) => attempt.issue_key));
  const queuedIssues = new Set(getQueueItems().map((item) => item.issue_key));
  const sessions = await listAgentSessions();

  // Also build a set of tracked session IDs so we can identify orphaned sessions
  const trackedSessionIds = new Set(
    activeAttempts.map(a => a.agent_session_id).filter(Boolean)
  );

  for (const session of sessions) {
    const issueKey = session.issue?.identifier;
    const issueState = session.issue?.state?.name;
    if (!issueKey || session.status === 'complete') continue;
    // Skip sessions already dismissed by any subsystem (monitor, webhook, watch, or previous janitor run)
    if (globalDismissedSessions.has(session.id)) continue;

    // Skip sessions from other teams/workspaces — we can't dismiss them
    if (teamKey && !issueKey.startsWith(teamKey + '-')) {
      // Silently skip — not our session to manage
      continue;
    }

    // Skip sessions that have repeatedly failed to dismiss (permanently broken)
    if ((janitorFailCounts.get(session.id) ?? 0) >= JANITOR_MAX_FAILURES) continue;

    // For Done/In Review issues with no active work: always clean up
    // For In Progress issues: only clean up ORPHANED sessions (not tracked by any attempt)
    const hasActiveWork = activeIssues.has(issueKey) || queuedIssues.has(issueKey);
    if (hasActiveWork) {
      // Issue is being worked on — only dismiss sessions NOT tracked by any active attempt
      if (trackedSessionIds.has(session.id)) continue; // This session is tracked, leave it
      // Orphaned session on an active issue — dismiss it to prevent ghost "Working"
    } else {
      // No active work — only dismiss if issue is completed
      if (!['Done', 'In Review'].includes(issueState || '')) continue;
    }

    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}] Janitor dismiss: ${issueKey} session ${session.id.slice(0, 8)} (${session.status})`));

    // RYA-1185: Kill zombie tmux sessions and reconcile attempt status BEFORE
    // posting the dismiss comment (kill first, comment second).
    const issueAttempts = getAttemptsByIssue(issueKey);
    for (const att of issueAttempts) {
      if (!att.tmux_session) continue;
      const tmuxAlive = sessionExists(att.tmux_session);
      if (att.status !== 'running' && att.status !== 'pending') {
        // Completed/failed attempt with a lingering tmux — kill the zombie process
        if (tmuxAlive) {
          try {
            killSession(att.tmux_session);
            console.log(chalk.dim(`  Janitor: killed zombie tmux ${att.tmux_session}`));
          } catch (killErr) {
            console.log(chalk.dim(`  Janitor: failed to kill zombie tmux ${att.tmux_session}: ${(killErr as Error).message}`));
          }
        }
      } else if (!tmuxAlive) {
        // Running attempt whose tmux is already dead — mark it completed so the
        // reconciler can transition the issue state out of In Progress.
        updateAttemptStatus(att.id, 'completed', 'Zombie cleanup by janitor');
        console.log(chalk.dim(`  Janitor: marked dead attempt ${att.id.slice(0, 8)} as completed`));
      }
    }

    const reason = `Stale session cleanup for ${issueKey}`;
    // Try each agent's token — sessions are owned by per-agent OAuth apps
    let dismissed = false;
    let lastDismissErr: Error | null = null;
    for (const role of listAgents()) {
      const agentTok = getAgentLinearToken(role);
      if (!agentTok) continue;
      try {
        await dismissAgentSession(session.id, agentTok, reason);
        dismissed = true;
        janitorFailCounts.delete(session.id); // Reset on success
        break;
      } catch (err) {
        // Wrong token, try next — track last error for diagnostics if all fail
        lastDismissErr = err as Error;
      }
    }
    // Fallback: try default token (Keychain/refreshable) if per-agent tokens all failed
    if (!dismissed) {
      try {
        await dismissAgentSession(session.id, undefined, reason);
        dismissed = true;
        janitorFailCounts.delete(session.id);
      } catch (err) {
        lastDismissErr = err as Error;
      }
    }
    if (!dismissed && lastDismissErr) {
      console.log(chalk.dim(`Janitor: all dismiss attempts failed for ${session.id.slice(0, 8)}: ${lastDismissErr.message}`));
    }
    if (!dismissed) {
      const fails = (janitorFailCounts.get(session.id) ?? 0) + 1;
      janitorFailCounts.set(session.id, fails);
      if (fails >= JANITOR_MAX_FAILURES) {
        console.log(chalk.dim(`  Janitor: giving up on ${session.id.slice(0, 8)} after ${fails} failures (foreign workspace or expired session)`));
      } else {
        console.log(chalk.dim(`  Janitor: could not dismiss ${session.id.slice(0, 8)} (attempt ${fails}/${JANITOR_MAX_FAILURES})`));
      }
    }
  }

  // GC the global dismissed set when it grows large (sessions eventually expire from Linear)
  if (globalDismissedSessions.size > 200) {
    const activeSessionIds = new Set(sessions.map(s => s.id));
    for (const id of globalDismissedSessions) {
      if (!activeSessionIds.has(id)) globalDismissedSessions.delete(id);
    }
  }

  // GC the janitor fail counts — remove entries for sessions no longer listed
  if (janitorFailCounts.size > 50) {
    const activeSessionIds = new Set(sessions.map(s => s.id));
    for (const id of janitorFailCounts.keys()) {
      if (!activeSessionIds.has(id)) janitorFailCounts.delete(id);
    }
  }
}

// ─── Mailbox: check for agent-to-agent responses ───

export async function checkMailboxResponses(): Promise<void> {
  const mailboxDir = join(getConfig().stateDir, 'mailbox');
  if (!existsSync(mailboxDir)) return;

  for (const role of listAgents()) {
    const outbox = join(mailboxDir, role, 'outbox');
    if (!existsSync(outbox)) continue;

    const files = readdirSync(outbox).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(outbox, file), 'utf-8'));
        const response = data.response;
        if (!response) continue;

        // Find who asked (parse from the message ID: {timestamp}-{from})
        const msgId = file.replace('.json', '');
        const fromMatch = msgId.match(/-(\w+)$/);
        const fromRole = fromMatch?.[1];

        if (fromRole) {
          // Pipe the response into the asking agent's tmux
          const tmuxName = `aos-${fromRole}`;
          if (sessionExists(tmuxName)) {
            try {
              sendKeys(tmuxName, `[RESPONSE from ${role}]: ${response}`);
              const ts = new Date().toLocaleTimeString();
              console.log(chalk.blue(`[${ts}] Mailbox response: ${role} → ${fromRole}`));
            } catch (err) {
              console.log(chalk.dim(`Mailbox: failed to deliver ${role}→${fromRole} response via ${tmuxName}: ${(err as Error).message}`));
            }
          }
        }

        // Clean up: remove the inbox message and outbox response
        const inbox = join(mailboxDir, role, 'inbox', file);
        try {
          unlinkSync(inbox);
        } catch (err) {
          // ENOENT is expected if inbox already cleaned up; log other failures
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.log(chalk.dim(`Mailbox: failed to remove inbox ${inbox}: ${(err as Error).message}`));
          }
        }
        try {
          unlinkSync(join(outbox, file));
        } catch (err) {
          console.log(chalk.dim(`Mailbox: failed to remove outbox ${file}: ${(err as Error).message}`));
        }
      } catch (err) {
        console.log(chalk.dim(`Mailbox: failed to process ${file} for ${role}: ${(err as Error).message}`));
      }
    }
  }
}

// ─── Project Pipeline: hourly idea-to-issue-to-dispatch cycle ───

const PIPELINE_INTERVAL_MS = 60 * 60_000; // 1 hour
let lastPipelineAt = 0;

const PIPELINE_DIR = join(process.env.HOME || '', '.aos', 'project-pipeline');
const IDEAS_FILE = join(PIPELINE_DIR, 'ideas', 'project-ideas.json');
const STATE_FILE = join(PIPELINE_DIR, 'pipeline-state.json');
const LOG_FILE = join(PIPELINE_DIR, 'pipeline-log.md');

interface PipelineIdea {
  id: string;
  title: string;
  description: string;
  category: string;
  leverages: string[];
  repoName: string;
  techStack: string;
  monetization: { model: string; free: string; paid: string; rationale: string };
  estimatedEffort: string;
  stages: { research: string; product: string; engineering: string; ship: string };
  impact: string;
  status: 'available' | 'in-progress' | 'shipped' | 'failed' | 'skipped';
}

interface PipelineState {
  lastRun: string | null;
  currentProject: string | null;
  currentIssueKey: string | null;
  shipped: Array<{ id: string; issueKey: string; repoUrl: string; shippedAt: string }>;
  failed: Array<{ id: string; issueKey: string; reason: string; failedAt: string }>;
  totalRuns: number;
}

function loadPipelineIdeas(): { version: string; ideas: PipelineIdea[] } | null {
  if (!existsSync(IDEAS_FILE)) return null;
  try { return JSON.parse(readFileSync(IDEAS_FILE, 'utf-8')); } catch { return null; }
}

function loadPipelineState(): PipelineState {
  if (!existsSync(STATE_FILE)) {
    return { lastRun: null, currentProject: null, currentIssueKey: null, shipped: [], failed: [], totalRuns: 0 };
  }
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch {
    return { lastRun: null, currentProject: null, currentIssueKey: null, shipped: [], failed: [], totalRuns: 0 };
  }
}

function selectNextIdea(ideas: PipelineIdea[]): PipelineIdea | null {
  const available = ideas.filter(i => i.status === 'available');
  if (available.length === 0) return null;

  const impactOrder = ['VERY HIGH', 'HIGH', 'MEDIUM-HIGH', 'MEDIUM'];
  for (const level of impactOrder) {
    const candidates = available.filter(i => i.impact.toUpperCase().startsWith(level));
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  return available[0];
}

function buildPipelineIssueDescription(idea: PipelineIdea): string {
  return `## Project Pipeline: ${idea.title}

**Category**: ${idea.category}
**Tech Stack**: ${idea.techStack}
**Impact**: ${idea.impact}
**GitHub Repo**: \`${idea.repoName}\`
**Estimated Effort**: ${idea.estimatedEffort}

### Description
${idea.description}

### Leverages Existing Work
${idea.leverages.map(l => `- ${l}`).join('\n')}

### Monetization
- **Model**: ${idea.monetization.model}
- **Free tier**: ${idea.monetization.free}
- **Paid tier**: ${idea.monetization.paid}
- **Rationale**: ${idea.monetization.rationale}

### Pipeline Stages

**1. Research (Research Lead context)**
${idea.stages.research}

**2. Product (CPO context)**
${idea.stages.product}

**3. Engineering (Lead Engineer context)**
${idea.stages.engineering}

**4. Ship**
${idea.stages.ship}

---

### CTO Pipeline Protocol

Execute the full project pipeline for this project. You are leading a team of subagents through 5 stages:

**Stage 1 — Research (10 min)**
Spawn a research subagent to:
- Perform competitive landscape scan
- Identify technical feasibility
- Gather data/APIs needed
- Output: RESEARCH-BRIEF.md

**Stage 2 — Product Spec (10 min)**
Spawn a product subagent to:
- Define target audience and value proposition
- Specify MVP features (ruthlessly minimal)
- Write user-facing copy (tagline, README intro)
- Output: PRODUCT-SPEC.md

**Stage 3 — Engineering (25 min)**
Spawn 2-3 engineering subagents in parallel:
- Engineer A: Core library/tool implementation
- Engineer B: CLI/UI/dashboard
- Engineer C: Tests + README
- Output: Working code in workspace

**Stage 4 — QA Review (5 min)**
You (CTO) review:
- Code quality (staff engineer standard)
- Security (no OWASP issues)
- README quality and accuracy
- Tests pass

**Stage 5 — Ship to GitHub (10 min)**
- Create GitHub repo: \`gh repo create \${sourceControl}/${idea.repoName} --public --description "..."\`
- Push code
- Enable GitHub Pages if applicable
- Post shipping summary to Linear

**Quality Gates:**
- Research must identify at least 2 competitors and our differentiation
- Product spec must have clear monetization angle
- Code must have at least 5 tests passing
- README must include: installation, usage, examples, contributing
- Repo must be public with MIT license

**Monetization Gate:**
- Every project must have a clear path to revenue
- Free tier must provide real value (not crippled)
- Paid tier must have a plausible $1K+ MRR path
`;
}

export async function projectPipelineHeartbeat(): Promise<void> {
  // Kill switch
  if (process.env.AOS_NO_PIPELINE === '1') return;

  // Hourly cooldown
  if (Date.now() - lastPipelineAt < PIPELINE_INTERVAL_MS) return;
  lastPipelineAt = Date.now();

  const ts = new Date().toLocaleTimeString();

  // Check if ideas file exists
  const bank = loadPipelineIdeas();
  if (!bank) {
    console.log(chalk.dim(`[${ts}] Pipeline: no ideas file at ${IDEAS_FILE}`));
    return;
  }

  // Check if there's already a project in progress
  const state = loadPipelineState();
  if (state.currentProject) {
    console.log(chalk.dim(`[${ts}] Pipeline: project in progress (${state.currentProject} / ${state.currentIssueKey}), skipping`));
    return;
  }

  // Select next idea
  const idea = selectNextIdea(bank.ideas);
  if (!idea) {
    console.log(chalk.dim(`[${ts}] Pipeline: no available ideas remaining`));
    return;
  }

  // Check CTO has capacity
  const ctoConfig = loadAgentConfig('cto');
  const maxP = ctoConfig.maxParallel ?? 2;
  const ctoRunning = getActiveAttempts().filter(a => a.agent_type === 'cto' && a.status === 'running').length;
  if (ctoRunning >= maxP) {
    console.log(chalk.dim(`[${ts}] Pipeline: CTO at capacity (${ctoRunning}/${maxP}), deferring`));
    return;
  }

  try {
    // Create Linear issue via SDK
    const config = getConfig();
    const client = getAgentClient();
    const stateId = await getWorkflowStateId('Todo');

    const ctoLinearUserId = ctoConfig.linearUserId;

    const result = await client.createIssue({
      teamId: config.linearTeamId,
      title: `Ship: ${idea.title}`,
      description: buildPipelineIssueDescription(idea),
      priority: 2, // High
      stateId,
      ...(ctoLinearUserId ? { delegateId: ctoLinearUserId } : {}),
    });

    if (!result.success) {
      console.log(chalk.red(`[${ts}] Pipeline: failed to create issue for ${idea.id}`));
      return;
    }

    const issue = await result.issue;
    if (!issue) {
      console.log(chalk.red(`[${ts}] Pipeline: issue creation returned no issue for ${idea.id}`));
      return;
    }

    const issueKey = issue.identifier;
    console.log(chalk.cyan(`[${ts}] Pipeline: created ${issueKey} for "${idea.title}"`));

    // Update idea status
    idea.status = 'in-progress';
    writeFileSync(IDEAS_FILE, JSON.stringify({ version: bank.version, lastUpdated: new Date().toISOString().split('T')[0], ideas: bank.ideas }, null, 2));

    // Update pipeline state
    state.currentProject = idea.id;
    state.currentIssueKey = issueKey;
    state.lastRun = new Date().toISOString();
    state.totalRuns++;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    // Append to pipeline log
    const logEntry = `\n## ${new Date().toISOString()}\n**Triggered**: ${idea.title}\n- Issue: ${issueKey}\n- Impact: ${idea.impact}\n- Category: ${idea.category}\n- Repo: ${idea.repoName}\n`;
    if (existsSync(LOG_FILE)) {
      writeFileSync(LOG_FILE, readFileSync(LOG_FILE, 'utf-8') + logEntry);
    } else {
      writeFileSync(LOG_FILE, `# Project Pipeline Log\n${logEntry}`);
    }

    // Dispatch CTO via company dispatch system
    const sourceControl = process.env.AOS_SOURCE_CONTROL || 'github.com/your-org';
    const dispatchContext = `Project pipeline triggered for "${idea.title}". Execute the full 5-stage pipeline protocol in the issue description. Ship to ${sourceControl}/${idea.repoName}. Estimated effort: ${idea.estimatedEffort}.`;

    await handleDispatch({
      role: 'cto',
      issueKey,
      message: dispatchContext,
      from: 'pipeline',
    });

    console.log(chalk.green(`[${ts}] Pipeline: dispatched CTO to ${issueKey} (${idea.id})`));
  } catch (err) {
    console.log(chalk.red(`[${ts}] Pipeline error: ${(err as Error).message}`));
  }
}

// ─── Weekly Agent P&L digest (RYA-898) ───
//
// Posts a Discord digest of last week's task-vs-meta token spend. Fires once
// per week, gated to a UTC weekday + hour so it lands consistently. Internal
// dedup stamp at ~/.aos/pnl-fired.json prevents double-fire if the monitor
// restarts within the target hour. Override via AOS_PNL_WEEKDAY / AOS_PNL_HOUR_UTC,
// or disable via AOS_NO_PNL_DIGEST=1.

const PNL_FIRED_PATH = join(STATE_DIR, 'pnl-fired.json');
const PNL_TARGET_WEEKDAY = (() => {
  const v = parseInt(process.env.AOS_PNL_WEEKDAY ?? '1', 10);
  return Number.isFinite(v) && v >= 0 && v <= 6 ? v : 1; // Monday default
})();
const PNL_TARGET_HOUR_UTC = (() => {
  const v = parseInt(process.env.AOS_PNL_HOUR_UTC ?? '14', 10);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? v : 14; // 14:00 UTC default
})();
const PNL_DEDUP_MS = 6 * 24 * 60 * 60 * 1000;

interface PnLFireRecord {
  lastFiredMs: number;
  lastFiredIso: string;
  posted: boolean;
  error?: string;
}

function readPnLFire(): PnLFireRecord | null {
  if (!existsSync(PNL_FIRED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PNL_FIRED_PATH, 'utf-8')) as PnLFireRecord;
  } catch (err) {
    console.debug(`[pnl] readPnLFire failed: ${(err as Error).message}`);
    return null;
  }
}

function writePnLFire(r: PnLFireRecord): void {
  try {
    writeFileSync(PNL_FIRED_PATH, JSON.stringify(r, null, 2));
  } catch (err) {
    console.debug(`[pnl] writePnLFire failed: ${(err as Error).message}`);
  }
}

/** A4.1: cost attribution backfill — every 10 min, idempotent upserts.
 *  Walks ~/.claude/projects JSONL transcripts since (now - 40min), writes
 *  attempt_attributions, then rolls totals up into attempts.cost_usd — the
 *  field `aos status` and the dashboard already render but nothing wrote.
 *  Throttle persists across serve restarts (dedup_keys). */
export async function costAttributionHeartbeat(): Promise<void> {
  if (process.env.AOS_NO_COST_BACKFILL === '1') return;
  if (persistentDedupCheck('cost-backfill:tick', 10 * 60_000)) return;
  persistentDedupRecord('cost-backfill:tick');

  const ts = new Date().toLocaleTimeString();
  try {
    const { backfillWindow } = await import('../analytics/cost-attribution.js');
    const { rollupAttemptCosts } = await import('../core/db.js');
    const sinceMs = Date.now() - 40 * 60_000; // 10min cadence + 30min overlap
    const result = backfillWindow({ sinceMs });
    const rolled = rollupAttemptCosts(new Date(sinceMs).toISOString());
    if (result.rowsWritten > 0 || rolled > 0) {
      console.log(chalk.dim(`[${ts}] Cost backfill: ${result.rowsWritten} attribution row(s), ${rolled} attempt cost(s) rolled up, ${result.unattributedSessions} unattributed`));
    }
  } catch (err) {
    console.log(chalk.yellow(`[${ts}] Cost backfill error: ${(err as Error).message}`));
  }
}

export async function weeklyPnLDigestHeartbeat(): Promise<void> {
  if (process.env.AOS_NO_PNL_DIGEST === '1') return;

  const now = new Date();
  if (now.getUTCDay() !== PNL_TARGET_WEEKDAY) return;
  if (now.getUTCHours() !== PNL_TARGET_HOUR_UTC) return;

  const last = readPnLFire();
  if (last && Date.now() - last.lastFiredMs < PNL_DEDUP_MS) return;

  const ts = now.toLocaleTimeString();
  console.log(chalk.cyan(`[${ts}] Weekly P&L digest: firing...`));

  try {
    const { runWeeklyPnL } = await import('../analytics/weekly-pnl.js');
    const result = await runWeeklyPnL({});
    writePnLFire({
      lastFiredMs: Date.now(),
      lastFiredIso: new Date().toISOString(),
      posted: result.posted,
      error: result.postError,
    });
    if (result.posted) {
      console.log(chalk.green(`[${ts}] Weekly P&L digest: posted (${result.data.sessionCount} sessions)`));
    } else {
      console.log(chalk.yellow(`[${ts}] Weekly P&L digest: not posted — ${result.postError ?? 'unknown'}`));
    }
  } catch (err) {
    console.log(chalk.red(`[${ts}] Weekly P&L digest error: ${(err as Error).message}`));
    writePnLFire({
      lastFiredMs: Date.now(),
      lastFiredIso: new Date().toISOString(),
      posted: false,
      error: (err as Error).message,
    });
  }
}
