import { getActiveAttempts, getAllAttempts } from '../core/db.js';
import { getQueueItems } from '../core/queue.js';
import { getSystemConcurrencyStatus, getRoleRunningCount, getMaxParallel } from './concurrency.js';

export interface RoleSnapshot {
  role: string;
  running: number;
  max: number;
  queued: number;
  blocked: number;
  idle: number;
  hibernated: number;
  status: 'idle' | 'active' | 'queued' | 'blocked' | 'saturated';
  busyIssueKeys: string[];
  blockedIssueKeys: string[];
  queuedIssueKeys: string[];
}

export interface RoleControlSnapshot {
  summary: {
    running: number;
    queued: number;
    blocked: number;
    idle: number;
    hibernated: number;
    atCapacity: boolean;
    maxSessions: number;
  };
  roles: RoleSnapshot[];
}

export function buildRoleControlSnapshot(): RoleControlSnapshot {
  const attempts = getAllAttempts();
  const activeAttempts = getActiveAttempts();
  const queueItems = getQueueItems();
  const concurrency = getSystemConcurrencyStatus();
  const roleNames = new Set<string>([
    ...attempts.map(a => a.agent_type),
    ...queueItems.map(q => q.agent_role),
    ...Object.keys(concurrency.roleCapacity || {}),
  ]);

  const roles = Array.from(roleNames)
    .filter(Boolean)
    .sort()
    .map((role): RoleSnapshot => {
      const runningAttempts = activeAttempts.filter(a => a.agent_type === role && a.status === 'running');
      const blockedAttempts = attempts.filter(a => a.agent_type === role && a.status === 'blocked');
      const idleAttempts = attempts.filter(a => a.agent_type === role && a.status === 'idle');
      const hibernatedAttempts = attempts.filter(a => a.agent_type === role && a.status === 'hibernated');
      const queued = queueItems.filter(q => q.agent_role === role);
      const running = getRoleRunningCount(role);
      const max = getMaxParallel(role);

      let status: RoleSnapshot['status'] = 'idle';
      if (blockedAttempts.length > 0) status = 'blocked';
      else if (running >= max && max > 0) status = 'saturated';
      else if (queued.length > 0) status = 'queued';
      else if (running > 0) status = 'active';

      return {
        role,
        running,
        max,
        queued: queued.length,
        blocked: blockedAttempts.length,
        idle: idleAttempts.length,
        hibernated: hibernatedAttempts.length,
        status,
        busyIssueKeys: uniqueIssueKeys(runningAttempts.map(a => a.issue_key)),
        blockedIssueKeys: uniqueIssueKeys(blockedAttempts.map(a => a.issue_key)),
        queuedIssueKeys: uniqueIssueKeys(queued.map(q => q.issue_key)),
      };
    });

  return {
    summary: {
      running: concurrency.running,
      queued: queueItems.length,
      blocked: attempts.filter(a => a.status === 'blocked').length,
      idle: attempts.filter(a => a.status === 'idle').length,
      hibernated: attempts.filter(a => a.status === 'hibernated').length,
      atCapacity: concurrency.atCapacity,
      maxSessions: concurrency.maxSessions,
    },
    roles,
  };
}

export function formatRoleControlText(snapshot: RoleControlSnapshot): string {
  const lines: string[] = [];
  lines.push(`Company load: ${snapshot.summary.running}/${snapshot.summary.maxSessions} running · ${snapshot.summary.queued} queued · ${snapshot.summary.blocked} blocked`);

  for (const role of snapshot.roles) {
    const parts = [`${role.role} ${role.running}/${role.max}`];
    if (role.queued > 0) parts.push(`${role.queued} queued`);
    if (role.blocked > 0) parts.push(`${role.blocked} blocked`);
    if (role.hibernated > 0) parts.push(`${role.hibernated} hibernated`);
    const line = parts.join(' · ');

    const details: string[] = [];
    if (role.busyIssueKeys.length > 0) details.push(`busy: ${role.busyIssueKeys.join(', ')}`);
    if (role.queuedIssueKeys.length > 0) details.push(`queue: ${role.queuedIssueKeys.join(', ')}`);
    if (role.blockedIssueKeys.length > 0) details.push(`blocked: ${role.blockedIssueKeys.join(', ')}`);

    lines.push(details.length > 0 ? `${line} — ${details.join(' | ')}` : line);
  }

  return lines.join('\n');
}

function uniqueIssueKeys(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}
