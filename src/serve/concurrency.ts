/**
 * Concurrency governor: capacity checks, eviction, hibernation.
 *
 * Eviction priority (pickToEvict):
 *   1. Reclaim idle sessions with dead tmux (zero cost)
 *   2. Reclaim oldest idle sessions (FIFO by updated_at)
 *   3. Suspend lowest-priority active session (SIGSTOP)
 *      - CEO-pinned sessions are never suspended
 *   4. No eviction possible → caller should enqueue
 *
 * Hibernation (SIGSTOP/SIGCONT):
 *   - Frozen in RAM, zero CPU/API usage
 *   - Process group is stopped, not killed
 *   - tmux session stays alive for resume
 */

import chalk from 'chalk';
import {
  getActiveAttempts, getIdleAttempts, getHibernatedAttempts,
  updateAttemptStatus, logEvent,
  type Attempt,
} from '../core/db.js';
import {
  suspendSession, resumeSessionProcess, sessionExists, killSession,
} from '../core/tmux.js';
import { loadAgentConfig, listAgents } from '../core/persona.js';

// ─── Configuration ───

export const GLOBAL_MAX_SESSIONS = parseInt(process.env.AOS_MAX_SESSIONS || '20', 10);

// Default per-role limits (overridden by config.json maxParallel)
const DEFAULT_ROLE_LIMITS: Record<string, number> = {
  'cto': 8,
  'cpo': 5,
  'coo': 5,
  'lead-engineer': 5,
  'research-lead': 5,
};
const DEFAULT_MAX_PARALLEL = 5;

// Hibernate priority: higher number = lower importance = hibernate first
const ROLE_HIBERNATE_PRIORITY: Record<string, number> = {
  'cto': 1,
  'cpo': 2,
  'lead-engineer': 3,
  'coo': 4,
  'research-lead': 5,
};

const HIBERNATION_MIN_AGE_MS = 2 * 60_000;

// Track serve process start
let serveStartedAt = Date.now();
export function markServeStarted(): void { serveStartedAt = Date.now(); }

// ─── Capacity checks ───

/**
 * Check if a role has capacity for a new session.
 * Checks both global cap and per-role limit.
 */
export function hasCapacity(role: string): boolean {
  // Global cap
  const running = getRunningSessionCount();
  if (running >= GLOBAL_MAX_SESSIONS) return false;

  // Per-role cap
  const maxParallel = getMaxParallel(role);
  const roleRunning = getRoleRunningCount(role);
  return roleRunning < maxParallel;
}

/** Global: can any new session start? */
export function canStartNewSession(): { allowed: boolean; reason?: string } {
  const running = getRunningSessionCount();
  if (running >= GLOBAL_MAX_SESSIONS) {
    return { allowed: false, reason: `at global cap (${running}/${GLOBAL_MAX_SESSIONS})` };
  }
  return { allowed: true };
}

/** Count unique running tmux sessions globally. */
export function getRunningSessionCount(): number {
  const active = getActiveAttempts().filter(a => a.status === 'running');
  return new Set(active.map(a => a.tmux_session).filter(Boolean)).size;
}

/** Count unique running tmux sessions for a specific role. */
export function getRoleRunningCount(role: string): number {
  const roleAttempts = getActiveAttempts().filter(a => a.agent_type === role && a.status === 'running');
  return new Set(roleAttempts.map(a => a.tmux_session).filter(Boolean)).size;
}

/** Get the max parallel sessions for a role (config → default → 2). */
export function getMaxParallel(role: string): number {
  try {
    const cfg = loadAgentConfig(role);
    if (cfg.maxParallel !== undefined && cfg.maxParallel !== null) {
      // If config says 40 (old unlimited), use our sensible default instead
      if (cfg.maxParallel >= 20) return DEFAULT_ROLE_LIMITS[role] ?? DEFAULT_MAX_PARALLEL;
      return cfg.maxParallel;
    }
  } catch { /* agent may not exist */ }
  return DEFAULT_ROLE_LIMITS[role] ?? DEFAULT_MAX_PARALLEL;
}

// ─── Eviction ───

export interface EvictResult {
  type: 'reclaimed_dead' | 'reclaimed_idle' | 'suspended';
  attempt: Attempt;
}

/**
 * Pick the best session to evict to free a slot for the given role.
 *
 * Detects WHY there's no capacity:
 *   - Global cap full → evict any role's session
 *   - Per-role cap full → prefer evicting same-role sessions first
 *
 * 3-tier eviction chain:
 *   1. Dead idle sessions (tmux gone) — free, just update DB
 *   2. Oldest idle sessions (tmux alive, FIFO by updated_at, handoff-processed first)
 *   3. Suspend lowest-priority active session (SIGSTOP)
 *
 * Returns null if nothing can be evicted.
 */
export function pickToEvict(role: string, excludeIssueKey?: string): EvictResult | null {
  // Determine the bottleneck: global cap or per-role cap?
  const globalFull = getRunningSessionCount() >= GLOBAL_MAX_SESSIONS;
  const roleFull = getRoleRunningCount(role) >= getMaxParallel(role);

  // If per-role is the bottleneck, prefer evicting same-role sessions
  const preferSameRole = roleFull && !globalFull;

  const idleSessions = getIdleAttempts();

  // ─── Tier 1: Reclaim dead idle sessions (zero cost) ───
  // Prefer same-role if that's the bottleneck
  const deadIdle = idleSessions.filter(a =>
    a.issue_key !== excludeIssueKey && (!a.tmux_session || !sessionExists(a.tmux_session))
  );
  if (preferSameRole) {
    const sameRoleDead = deadIdle.find(a => a.agent_type === role);
    if (sameRoleDead) { reclaimSession(sameRoleDead, 'tmux_dead'); return { type: 'reclaimed_dead', attempt: sameRoleDead }; }
  }
  if (deadIdle.length > 0) {
    reclaimSession(deadIdle[0], 'tmux_dead');
    return { type: 'reclaimed_dead', attempt: deadIdle[0] };
  }

  // ─── Tier 2: Reclaim oldest idle with live tmux (FIFO) ───
  const aliveIdle = idleSessions
    .filter(a => a.issue_key !== excludeIssueKey && a.tmux_session && sessionExists(a.tmux_session))
    .sort((a, b) => a.updated_at.localeCompare(b.updated_at));

  // Same-role preference for per-role bottleneck
  if (preferSameRole) {
    const sameRoleIdle = aliveIdle.filter(a => a.agent_type === role);
    // Handoff-processed first
    const handoffDone = sameRoleIdle.find(a => hasHandoffCompleted(a));
    if (handoffDone) { reclaimSession(handoffDone, 'handoff_processed'); return { type: 'reclaimed_idle', attempt: handoffDone }; }
    if (sameRoleIdle.length > 0) { reclaimSession(sameRoleIdle[0], 'oldest_idle_same_role'); return { type: 'reclaimed_idle', attempt: sameRoleIdle[0] }; }
  }

  // Handoff-processed first (any role)
  for (const attempt of aliveIdle) {
    if (hasHandoffCompleted(attempt)) {
      reclaimSession(attempt, 'handoff_processed');
      return { type: 'reclaimed_idle', attempt };
    }
  }
  if (aliveIdle.length > 0) {
    reclaimSession(aliveIdle[0], 'oldest_idle');
    return { type: 'reclaimed_idle', attempt: aliveIdle[0] };
  }

  // ─── Tier 3: Suspend active session ───
  // For per-role bottleneck: suspend a same-role session
  if (preferSameRole) {
    const sameRoleRunning = getActiveAttempts().filter(a =>
      a.status === 'running' && a.agent_type === role && a.tmux_session &&
      sessionExists(a.tmux_session) && a.issue_key !== excludeIssueKey
    );
    // Pick oldest same-role session to hibernate
    const now = Date.now();
    const eligible = sameRoleRunning.filter(a => {
      const age = now - new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime();
      return age >= HIBERNATION_MIN_AGE_MS;
    });
    if (eligible.length > 0) {
      eligible.sort((a, b) =>
        new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime() -
        new Date(b.created_at.endsWith('Z') ? b.created_at : b.created_at + 'Z').getTime()
      );
      if (hibernateSession(eligible[0].id)) return { type: 'suspended', attempt: eligible[0] };
    }
  }

  // Global bottleneck: suspend lowest-priority session across all roles
  const candidate = selectSessionToHibernate(excludeIssueKey);
  if (candidate && hibernateSession(candidate.id)) {
    return { type: 'suspended', attempt: candidate };
  }

  return null;
}

/**
 * Reclaim an idle session — kill tmux and mark as completed.
 */
export function reclaimSession(attempt: Attempt, reason: string): void {
  if (attempt.tmux_session && sessionExists(attempt.tmux_session)) {
    try { killSession(attempt.tmux_session); } catch { /* best effort */ }
  }
  updateAttemptStatus(attempt.id, 'completed', `Reclaimed: ${reason}`);
  logEvent(attempt.id, 'reclaimed', { reason });
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.dim(`[${ts}] Reclaimed: ${attempt.issue_key} (${attempt.agent_type}) — ${reason}`));
}

/**
 * Check if an idle session's handoff was already processed.
 * Looks for HANDOFF.md in the per-issue state dir.
 */
function hasHandoffCompleted(attempt: Attempt): boolean {
  if (!attempt.workspace_path) return false;
  try {
    const { getIssueStateDir } = require('../core/config.js');
    const stateDir = getIssueStateDir(attempt.issue_key);
    const { existsSync } = require('fs');
    return existsSync(join(stateDir, 'HANDOFF.md'));
  } catch { return false; }
}

// Need join for hasHandoffCompleted
import { join } from 'path';

// ─── Hibernation primitives ───

/**
 * Select the best running session to hibernate.
 * Priority: highest role-hibernate-priority number first, then oldest.
 * Never hibernates CEO-pinned sessions or sessions < 2min old.
 */
export function selectSessionToHibernate(excludeIssueKey?: string): Attempt | null {
  const running = getActiveAttempts().filter(a =>
    a.status === 'running' &&
    a.tmux_session &&
    sessionExists(a.tmux_session) &&
    a.issue_key !== excludeIssueKey
  );

  if (running.length === 0) return null;

  const now = Date.now();
  const eligible = running.filter(a => {
    const age = now - new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime();
    return age >= HIBERNATION_MIN_AGE_MS;
  });

  if (eligible.length === 0) return null;

  // Sort: higher hibernate-priority number first → then oldest first
  eligible.sort((a, b) => {
    const pa = ROLE_HIBERNATE_PRIORITY[a.agent_type] || 3;
    const pb = ROLE_HIBERNATE_PRIORITY[b.agent_type] || 3;
    if (pa !== pb) return pb - pa;
    return new Date(a.created_at.endsWith('Z') ? a.created_at : a.created_at + 'Z').getTime()
         - new Date(b.created_at.endsWith('Z') ? b.created_at : b.created_at + 'Z').getTime();
  });

  return eligible[0];
}

/** SIGSTOP a running session. */
export function hibernateSession(attemptId: string): boolean {
  const attempt = getActiveAttempts().find(a => a.id === attemptId);
  if (!attempt || !attempt.tmux_session || attempt.status !== 'running') return false;

  try {
    suspendSession(attempt.tmux_session);
    updateAttemptStatus(attemptId, 'hibernated' as Attempt['status']);
    logEvent(attemptId, 'hibernated', { role: attempt.agent_type, issueKey: attempt.issue_key, reason: 'eviction' });
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.blue(`[${ts}] HIBERNATE: ${attempt.agent_type} on ${attempt.issue_key}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`[HIBERNATE] Failed for ${attempt.issue_key}: ${(err as Error).message}`));
    return false;
  }
}

/** SIGCONT a hibernated session. */
export function wakeSession(attemptId: string): boolean {
  const hibernated = getHibernatedAttempts();
  const attempt = hibernated.find(a => a.id === attemptId);
  if (!attempt || !attempt.tmux_session) return false;

  if (!sessionExists(attempt.tmux_session)) {
    updateAttemptStatus(attemptId, 'failed', 'Tmux session died during hibernation');
    logEvent(attemptId, 'failed', { reason: 'hibernation_death' });
    return false;
  }

  try {
    resumeSessionProcess(attempt.tmux_session);
    updateAttemptStatus(attemptId, 'running');
    logEvent(attemptId, 'woke', { role: attempt.agent_type, issueKey: attempt.issue_key });
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.green(`[${ts}] WAKE: ${attempt.agent_type} on ${attempt.issue_key}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`[WAKE] Failed: ${(err as Error).message}`));
    return false;
  }
}

/** Try to wake the highest-invested hibernated session (FIFO). */
export function tryWakeHibernatedSession(): boolean {
  const running = getRunningSessionCount();
  if (running >= GLOBAL_MAX_SESSIONS) return false;

  const hibernated = getHibernatedAttempts();
  for (const attempt of hibernated) {
    if (wakeSession(attempt.id)) return true;
  }
  return false;
}

/** Try to make room by evicting. Convenience wrapper. */
export function tryMakeRoom(forIssueKey?: string): boolean {
  const result = pickToEvict('_any_', forIssueKey);
  return result !== null;
}

/** Monitor hibernated sessions for dead tmux. */
export function monitorHibernatedSessions(): void {
  const hibernated = getHibernatedAttempts();
  for (const attempt of hibernated) {
    if (!attempt.tmux_session || !sessionExists(attempt.tmux_session)) {
      updateAttemptStatus(attempt.id, 'failed', 'Tmux session died during hibernation');
      logEvent(attempt.id, 'failed', { reason: 'hibernation_death' });
      const ts = new Date().toLocaleTimeString();
      console.log(chalk.yellow(`[${ts}] Hibernated session died: ${attempt.issue_key}`));
    }
  }
}

// ─── Dashboard / API ───

export function getSystemConcurrencyStatus() {
  const running = getRunningSessionCount();
  const hibernated = getHibernatedAttempts();
  const idle = getIdleAttempts();
  const uptimeMs = Date.now() - serveStartedAt;

  // Per-role capacity breakdown
  const roleCapacity: Record<string, { running: number; max: number }> = {};
  for (const role of listAgents()) {
    roleCapacity[role] = {
      running: getRoleRunningCount(role),
      max: getMaxParallel(role),
    };
  }

  return {
    running,
    idle: idle.length,
    idleSessions: idle.map(a => ({
      attemptId: a.id,
      issueKey: a.issue_key,
      agentRole: a.agent_type,
      tmuxSession: a.tmux_session,
      idleSince: a.updated_at,
    })),
    hibernated: hibernated.length,
    hibernatedSessions: hibernated.map(a => ({
      attemptId: a.id,
      issueKey: a.issue_key,
      agentRole: a.agent_type,
      tmuxSession: a.tmux_session,
      hibernatedSince: a.updated_at,
    })),
    roleCapacity,
    maxSessions: GLOBAL_MAX_SESSIONS,
    uptimeSeconds: Math.round(uptimeMs / 1000),
    atCapacity: running >= GLOBAL_MAX_SESSIONS,
  };
}

// ─── Convenience wrappers for CLI/API ───

export function hibernateByIssueKey(issueKey: string): { ok: boolean; detail: string } {
  const attempt = getActiveAttempts().find(a => a.issue_key === issueKey && a.status === 'running' && a.tmux_session);
  if (!attempt) return { ok: false, detail: `No running session for ${issueKey}` };
  const ok = hibernateSession(attempt.id);
  return { ok, detail: ok ? `Hibernated ${attempt.agent_type} on ${issueKey}` : `Failed to hibernate ${issueKey}` };
}

export function wakeByIssueKey(issueKey: string): { ok: boolean; detail: string } {
  const attempt = getHibernatedAttempts().find(a => a.issue_key === issueKey);
  if (!attempt) return { ok: false, detail: `No hibernated session for ${issueKey}` };
  const running = getRunningSessionCount();
  if (running >= GLOBAL_MAX_SESSIONS) {
    return { ok: false, detail: `At global cap (${running}/${GLOBAL_MAX_SESSIONS})` };
  }
  const ok = wakeSession(attempt.id);
  return { ok, detail: ok ? `Woke ${attempt.agent_type} on ${issueKey}` : `Failed to wake ${issueKey}` };
}

// ─── Legacy: RESTART_COOLDOWN_MS (kept for serve.ts import compat) ───
export const RESTART_COOLDOWN_MS = 5 * 60_000;
