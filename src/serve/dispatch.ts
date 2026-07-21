/** Dispatch handler: agent-to-agent direct dispatch and handoff. */

import { randomUUID } from 'crypto';
import { createLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import {
  getIssue, addComment, emitActivity,
  dismissAgentSession, getAgentClient,
} from '../core/linear.js';
import { getActiveAttempt, updateAttemptStatus, logEvent } from '../core/db.js';
import { agentExists, getAgentLinearToken, loadAgentConfig, listAgents } from '../core/persona.js';
import { canSpawnAgent } from '../core/router.js';
import { enqueue } from '../core/queue.js';
import { agentStartCommand } from '../commands/agent.js';
import { sessionExists, killSession } from '../core/tmux.js';

import { resolveEffortRule } from '../core/effort-rules.js';
import {
  dispatchDedup, checkAndRecordDedup, persistentDedupRecord,
  autoRoutedSpawns, AUTO_ROUTE_OVERRIDE_WINDOW_MS, releaseSpawnSlot,
} from './state.js';
import { postToGroupChat, isPermanentIssueError } from './helpers.js';
import { checkCircuitBreaker } from './circuit-breaker.js';
import { isDuplicateOfDone } from '../core/linear-relations.js';

const log = createLogger('dispatch');

export interface DispatchRequest {
  role: string;
  issueKey: string;
  message?: string;
  handoff?: boolean;
  from?: string;
  /** Bypass the recently-completed dedup check (for explicit user-initiated dispatch). */
  skipCompletionCheck?: boolean;
}

export interface DispatchResponse {
  ok: boolean;
  action: 'started' | 'queued' | 'piped' | 'skipped' | 'error';
  detail?: string;
}

/** Recognises titles that begin with the `[to decide]` marker so dispatch can refuse them.
 *  Trims leading whitespace and is case-insensitive. Only matches when the marker is the
 *  prefix — not when it occurs mid-title. */
export function isToDecidePrefix(title: string | undefined | null): boolean {
  if (!title) return false;
  return /^\s*\[to decide\]/i.test(title);
}

// 30s debounce: skip duplicate delegate writes for the same issue within one heartbeat window.
// Prevents rapid-fire updateIssue calls when the heartbeat processes multiple unassigned issues
// in quick succession (each dispatch calls ensureDelegate → updateIssue → Linear API).
const _delegateUpdateCache = new Map<string, number>();
const DELEGATE_DEBOUNCE_MS = 30_000;

/** Test-only: clear the delegate debounce cache between test cases. */
export function __resetEnsureDelegateCacheForTests(): void {
  _delegateUpdateCache.clear();
}

/** Set assignee + delegate for an issue using the role's own Linear token when available,
 *  falling back to the shared AgentOS client. No-op when the role has no `linearUserId`. */
export async function ensureDelegate(issueId: string, role: string): Promise<void> {
  const agentConfig = loadAgentConfig(role);
  if (!agentConfig?.linearUserId) return;

  // Debounce: skip if we've already updated this issue's delegate within 30s
  const lastMs = _delegateUpdateCache.get(issueId);
  if (lastMs !== undefined && Date.now() - lastMs < DELEGATE_DEBOUNCE_MS) return;
  _delegateUpdateCache.set(issueId, Date.now());

  // GC: prune stale entries so the map doesn't grow unbounded
  if (_delegateUpdateCache.size > 200) {
    const cutoff = Date.now() - DELEGATE_DEBOUNCE_MS;
    for (const [k, v] of _delegateUpdateCache) {
      if (v < cutoff) _delegateUpdateCache.delete(k);
    }
  }

  const roleToken = getAgentLinearToken(role);
  // Linear rejects setting both assigneeId and delegateId for app users in the same call
  // ("Cannot provide both delegateId and assigneeId as app users"). Use delegateId only —
  // it is the canonical app-user assignment field. (RYA-1053)
  const update = { delegateId: agentConfig.linearUserId };

  if (roleToken) {
    const { LinearClient } = await import('@linear/sdk');
    const roleClient = new LinearClient({ accessToken: roleToken });
    await roleClient.updateIssue(issueId, update);
  } else {
    const agentClient = getAgentClient();
    await agentClient.updateIssue(issueId, update);
  }
}

export async function handleDispatch(req: DispatchRequest): Promise<DispatchResponse> {
  const { role, issueKey, message, handoff, from } = req;

  // Validate
  if (!role || !issueKey) {
    return { ok: false, action: 'error', detail: 'Missing role or issueKey' };
  }
  if (!agentExists(role)) {
    return { ok: false, action: 'error', detail: `Agent "${role}" not found. Available: ${listAgents().join(', ')}` };
  }
  if (!/^[A-Z]+-\d+$/.test(issueKey)) {
    return { ok: false, action: 'error', detail: `Invalid issue key format: ${issueKey}` };
  }

  // Team guard: reject dispatches for issues outside our team to prevent cross-team contamination
  const config = getConfig();
  const issueTeamPrefix = issueKey.split('-')[0];
  if (config.linearTeamKey && issueTeamPrefix !== config.linearTeamKey) {
    log.warn('Dispatch blocked: cross-team', { issueKey, team: issueTeamPrefix, expected: config.linearTeamKey });
    return { ok: false, action: 'error', detail: `Cross-team dispatch blocked: ${issueKey} belongs to team ${issueTeamPrefix}, not ${config.linearTeamKey}` };
  }

  // Dedup: same role+issue in last 60s (A1.3: persists across serve restarts;
  // the `retry:`-prefixed counter entries in dispatchDedup stay memory-only)
  const dedupKey = `${role}:${issueKey}`;
  if (checkAndRecordDedup(dispatchDedup, dedupKey, `disp:${dedupKey}`, 60_000)) {
    return { ok: false, action: 'error', detail: `Already dispatched ${role} on ${issueKey} within the last 60s` };
  }
  // Role-agnostic marker for the heartbeat's duplicate-dispatch guard (A1.4)
  persistentDedupRecord(`disp-any:${issueKey}`);

  // Clean old dedup entries
  if (dispatchDedup.size > 100) {
    const cutoff = Date.now() - 300_000;
    for (const [k, v] of dispatchDedup) {
      if (v < cutoff) dispatchDedup.delete(k);
    }
  }

  // Pre-fetch issue so we can run guards (e.g. [to decide]) before spawning the agent.
  // Defensive default: if the fetch fails we still allow dispatch — guards run on the
  // post-spawn fetch path. Otherwise a transient Linear blip would block all dispatches.
  let prefetchedIssue: Awaited<ReturnType<typeof getIssue>> | null = null;
  try {
    prefetchedIssue = await getIssue(issueKey);
  } catch (err) {
    log.debug('Pre-dispatch issue fetch failed, proceeding without guards', { issueKey, error: (err as Error).message });
  }

  // [to decide] guard: refuse to dispatch issues that are still pending CEO decision
  if (prefetchedIssue && isToDecidePrefix(prefetchedIssue.title)) {
    log.warn('Dispatch blocked: [to decide] prefix', { issueKey, role, title: prefetchedIssue.title });
    return {
      ok: false,
      action: 'error',
      detail: `Cannot dispatch ${role} on ${issueKey}: title starts with [to decide] (awaiting CEO decision).`,
    };
  }

  // Duplicate-of-Done guard (RYA-1071): refuse to dispatch issues that Linear
  // has marked as duplicate-of a completed issue. The canonical issue's work
  // is already delivered — spawning here produces no work product. Skip the
  // check when we couldn't prefetch the issue: an undiagnosed duplicate is
  // better than blocking all dispatch on a transient Linear blip.
  if (prefetchedIssue) {
    const dupCheck = await isDuplicateOfDone(issueKey);
    if (dupCheck) {
      log.warn('Dispatch blocked: duplicate of Done issue', { issueKey, role, canonical: dupCheck.canonicalKey, canonicalState: dupCheck.canonicalState });
      return {
        ok: false,
        action: 'error',
        detail: `Skip dispatch: ${issueKey} is duplicate of ${dupCheck.canonicalKey} (${dupCheck.canonicalState}).`,
      };
    }
  }

  // RYA-1139: explicit dispatch is authoritative over creator-default auto-routing.
  // When an agent creates an issue, serve auto-routes it to the creator role within
  // seconds (issues.ts). If a dispatch then targets a DIFFERENT role inside the
  // override window, the auto-routed spawn must be superseded — otherwise the
  // per-issue spawn claim dedups the explicit spawn and the wrong role silently
  // keeps the work. Best-effort: if the auto-routed spawn is still mid-flight
  // (no tmux session / attempt yet), we only release the claim and let the
  // janitor clean up any stragglers.
  const autoRouted = autoRoutedSpawns.get(issueKey);
  if (autoRouted && autoRouted.role !== role && Date.now() - autoRouted.at < AUTO_ROUTE_OVERRIDE_WINDOW_MS) {
    log.info('Explicit dispatch supersedes auto-routed spawn', { issueKey, autoRoutedRole: autoRouted.role, role, from });
    const autoTmux = `aos-${autoRouted.role}-${issueKey}`;
    try {
      if (sessionExists(autoTmux)) killSession(autoTmux);
    } catch (err) {
      log.debug('Supersede: kill of auto-routed session failed', { issueKey, tmux: autoTmux, error: (err as Error).message });
    }
    const autoAttempt = getActiveAttempt(issueKey);
    if (autoAttempt && autoAttempt.agent_type === autoRouted.role && autoAttempt.status === 'running') {
      updateAttemptStatus(autoAttempt.id, 'completed', `Superseded by explicit dispatch to ${role}`);
      logEvent(autoAttempt.id, 'superseded', { by: role, from });
    }
    releaseSpawnSlot(issueKey);
    autoRoutedSpawns.delete(issueKey);
  }

  // If handoff: mark current attempt as completed
  if (handoff) {
    const currentAttempt = getActiveAttempt(issueKey);
    if (currentAttempt) {
      log.debug('Handoff transition', { from: currentAttempt.agent_type, to: role, issueKey });
      updateAttemptStatus(currentAttempt.id, 'completed', `Handed off to ${role}`);
      logEvent(currentAttempt.id, 'handoff', { to: role, message });

      // Dismiss Linear session if exists
      if (currentAttempt.agent_session_id) {
        const agentTok = getAgentLinearToken(currentAttempt.agent_type) || undefined;
        try {
          // A 'response' activity is terminal — it closes the session in Linear.
          // No separate dismissAgentSession needed (that would create duplicate noise).
          await emitActivity(currentAttempt.agent_session_id, {
            type: 'response',
            body: `Handing off to ${role}: ${message || 'continuation'}`,
          }, false, agentTok);
        } catch (err) { log.debug('Handoff emitActivity failed', { issueKey, error: (err as Error).message }); }
      }
    }
  }

  // Circuit breaker: check if this issue has exceeded its retry limit
  const cb = checkCircuitBreaker(issueKey, role);
  if (!cb.allowed) {
    return { ok: false, action: 'error', detail: `Circuit breaker: ${cb.reason}` };
  }
  // A1.1: recent failures → respect the computed exponential backoff instead of
  // hot-retrying. Enqueue with delay_until; drainQueue re-checks the breaker
  // when the delay elapses. Half-open probes (backoffMs=0) pass straight through.
  if (cb.backoffMs > 0 && !cb.halfOpen) {
    const retryAt = new Date(Date.now() + cb.backoffMs);
    enqueue({
      id: randomUUID(),
      issue_id: prefetchedIssue?.id ?? '',
      issue_key: issueKey,
      agent_role: role,
      follow_up_prompt: message,
      delay_until: retryAt.toISOString(),
    });
    log.warn('Dispatch delayed by failure backoff', { issueKey, role, backoffSec: Math.round(cb.backoffMs / 1000), failures: cb.consecutiveFailures });
    return { ok: true, action: 'queued', detail: `Delayed ${Math.round(cb.backoffMs / 1000)}s after ${cb.consecutiveFailures} recent failure(s)` };
  }

  // Check capacity
  const agentConfig = loadAgentConfig(role);
  const modelType = agentConfig.baseModel || 'cc';
  const { allowed, reason } = canSpawnAgent(modelType);

  // Set delegate up-front when we already have the issue UUID. Best-effort:
  // a failed delegate write must not block the dispatch (the agent can still work).
  // Tests expect this to fire BEFORE enqueue so the next heartbeat sees the
  // queued issue as already assigned to the agent.
  if (prefetchedIssue) {
    try {
      await ensureDelegate(prefetchedIssue.id, role);
    } catch (err) {
      // A1.4: warn (not debug) + persistent marker so the heartbeat treats the
      // issue as assigned-pending instead of unowned and doesn't re-triage it.
      log.warn('Pre-dispatch ensureDelegate failed (non-fatal)', { issueKey, role, error: (err as Error).message });
      persistentDedupRecord(`delegate-failed:${issueKey}`);
    }
  }

  if (!allowed) {
    // Enqueue
    log.warn('Dispatch queued — no capacity', { issueKey, role, reason });
    enqueue({
      id: randomUUID(),
      issue_id: '', // Will be resolved when dequeued
      issue_key: issueKey,
      agent_role: role,
      follow_up_prompt: message,
    });
    return { ok: true, action: 'queued', detail: reason };
  }

  // A4.4: effort-scaled dispatch — low-stakes issues (per ~/.aos/effort-rules.json)
  // run on a lighter Claude model. Best-effort: rule failures never block dispatch.
  let effortModel: string | null = null;
  if (prefetchedIssue) {
    try {
      effortModel = resolveEffortRule({
        labels: prefetchedIssue.labels,
        priority: prefetchedIssue.priority,
      }).model;
      if (effortModel) {
        log.info('Effort rule matched — using lighter model', { issueKey, role, model: effortModel, labels: prefetchedIssue.labels, priority: prefetchedIssue.priority });
      }
    } catch (err) {
      log.debug('Effort rule resolution failed (non-fatal)', { issueKey, error: (err as Error).message });
    }
  }

  // Start the agent
  log.info('Dispatch starting', { issueKey, role });
  try {
    const startOpts = {
      ...(req.skipCompletionCheck ? { skipCompletionCheck: true } : {}),
      ...(effortModel ? { claudeModel: effortModel } : {}),
    };
    const startResult = await agentStartCommand(role, issueKey, Object.keys(startOpts).length > 0 ? startOpts : undefined);

    // RYA-1139: report the real spawn outcome — 'started' when the spawn was
    // actually dedup'd or queued misled callers (the CLI printed "started" while
    // a different role kept the work).
    if (startResult === 'deduped') {
      const holder = getActiveAttempt(issueKey);
      const holderNote = holder && holder.status === 'running'
        ? `${holder.agent_type} already on ${issueKey}`
        : `a spawn for ${issueKey} was already claimed moments ago`;
      log.warn('Dispatch deduped — agent NOT started', { issueKey, role, holder: holder?.agent_type });
      return { ok: false, action: 'skipped', detail: `Dedup: skipped — ${holderNote}; ${role} was NOT started` };
    }
    if (startResult === 'queued') {
      return { ok: true, action: 'queued', detail: `${role} queued for ${issueKey} (at capacity)` };
    }
    if (startResult === 'error') {
      return { ok: false, action: 'error', detail: `Spawn failed for ${role} on ${issueKey} — see serve logs` };
    }

    // Post dispatch action as a visible comment for audit trail
    try {
      const dispatchIssue = prefetchedIssue ?? await getIssue(issueKey);
      const fromLabel = from || 'system';
      const action = handoff ? 'Handoff' : 'Dispatch';
      const ctx = message ? `: ${message}` : '';
      const commentBody = `**${action}**: @${fromLabel} → @${role}${ctx}`;

      // Post comment using dispatching agent's token if available, otherwise AgentOS
      const fromToken = from ? getAgentLinearToken(from) : null;
      await addComment(dispatchIssue.id, commentBody, fromToken || undefined);

      // Recovery path: if pre-dispatch fetch failed, we deferred the delegate set.
      // Now that the post-spawn fetch succeeded, retry the delegate write so the
      // issue still ends up assigned to the agent.
      if (!prefetchedIssue) {
        try {
          await ensureDelegate(dispatchIssue.id, role);
        } catch (err) {
          log.warn('Post-spawn ensureDelegate failed (non-fatal)', { issueKey, role, error: (err as Error).message });
          persistentDedupRecord(`delegate-failed:${issueKey}`);
        }
      }

      await postToGroupChat(role, `Starting work on "${dispatchIssue.title}". Will update when done.`);
    } catch {
      await postToGroupChat(role, `Starting work on ${issueKey}.`).catch(() => {/**/});
    }
    return {
      ok: true,
      action: 'started',
      detail: startResult === 'resumed'
        ? `${role} resumed existing session on ${issueKey}`
        : `${role} started on ${issueKey}`,
    };
  } catch (err) {
    // Permanent errors (issue deleted/not found): fail immediately, no retry
    if (isPermanentIssueError(err)) {
      log.error('Dispatch failed (permanent)', { issueKey, role, error: (err as Error).message });
      return { ok: false, action: 'error', detail: (err as Error).message };
    }

    // Transient errors: auto-retry with backoff (max 2 retries)
    const retryKey = `retry:${role}:${issueKey}`;
    const retryCount = (dispatchDedup.get(retryKey) || 0);
    if (retryCount < 2) {
      dispatchDedup.set(retryKey, retryCount + 1);
      const backoffMs = 15_000 * Math.pow(2, retryCount); // 15s, 30s
      log.warn('Dispatch failed, retrying', { issueKey, role, retry: retryCount + 1, backoffSec: backoffMs / 1000, error: (err as Error).message });
      enqueue({
        id: randomUUID(),
        issue_id: '',
        issue_key: issueKey,
        agent_role: role,
        follow_up_prompt: message,
        delay_until: new Date(Date.now() + backoffMs).toISOString(),
      });
      // ok=false signals the dispatcher hit an error; the enqueue is a recovery
      // side-effect, not a success path. Distinct from capacity-queued (ok=true)
      // so callers can log/alert on transient failures while still seeing action='queued'.
      return { ok: false, action: 'queued', detail: `Retry ${retryCount + 1}/2 in ${backoffMs / 1000}s (${(err as Error).message})` };
    }
    log.error('Dispatch failed after retries', { issueKey, role, error: (err as Error).message });
    return { ok: false, action: 'error', detail: (err as Error).message };
  }
}
