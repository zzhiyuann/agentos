/** Pure event classification and routing logic. No side effects, fully testable. */

import {
  buildAgentRoleRegex,
  normalizeAgentRole as _normalizeAgentRole,
} from '../core/persona.js';

export type EventClassification = 'agent-session' | 'comment-mention' | 'issue-created' | 'issue-updated' | 'log';

export interface RouteDecision {
  classification: EventClassification;
  action: 'spawn' | 'pipe' | 'conditional-spawn' | 'log' | 'skip';
  targetAgent: string | null;
  reason: string;
}

/**
 * Matches @mentions of any agent role. Derived from listAgents() at load time —
 * adding a new agent directory automatically updates routing.
 */
export const AGENT_ROLE_REGEX = buildAgentRoleRegex();

/** Re-export: normalizes role captures (e.g. "leadengineer" → "lead-engineer"). */
export const normalizeAgentRole = _normalizeAgentRole;

export function classifyEvent(
  linearEvent: string,
  payload: { action: string; type?: string },
): EventClassification {
  if (linearEvent === 'AppAgentSession' || linearEvent === 'AgentSessionEvent' || payload.type === 'AppAgentSession' || payload.action === 'created' && payload.type === 'AgentSession') {
    return 'agent-session';
  }
  if (linearEvent === 'Comment' && payload.action === 'create') {
    return 'comment-mention';
  }
  if (linearEvent === 'Issue' && payload.action === 'create') {
    return 'issue-created';
  }
  if (linearEvent === 'Issue' && payload.action === 'update') {
    return 'issue-updated';
  }
  return 'log';
}

export function routeEvent(
  linearEvent: string,
  payload: {
    action: string;
    type?: string;
    webhookId?: string;
    data?: {
      body?: string;
      labels?: { id: string; name: string }[];
      creatorId?: string;
    };
    agentSession?: {
      issue?: { labels?: string[] };
      comment?: { body: string };
    };
    agentActivity?: { signal?: string; body?: string };
  },
  opts?: {
    agentUserIds?: Set<string>;
    agentUserIdToRole?: Record<string, string>;
    webhookAgentMap?: Record<string, string>;
    runningAgents?: Set<string>;
  },
): RouteDecision {
  const classification = classifyEvent(linearEvent, payload);

  switch (classification) {
    case 'agent-session': {
      if (payload.action === 'created') {
        const issueLabels = payload.agentSession?.issue?.labels || [];
        const webhookAgent = opts?.webhookAgentMap?.[payload.webhookId || ''] || null;
        const hasLabels = issueLabels.length > 0;

        if (!webhookAgent && !hasLabels) {
          return { classification, action: 'skip', targetAgent: null, reason: 'No routing signal (no webhook mapping, no labels)' };
        }
        return { classification, action: 'spawn', targetAgent: webhookAgent || 'label-routed', reason: 'AgentSession created — spawn agent' };
      }
      if (payload.action === 'prompted') {
        const signal = payload.agentActivity?.signal;
        if (signal === 'stop') {
          return { classification, action: 'log', targetAgent: null, reason: 'Stop signal received' };
        }
        if (payload.agentActivity?.body) {
          return { classification, action: 'pipe', targetAgent: null, reason: 'Follow-up message — pipe to running session' };
        }
        return { classification, action: 'log', targetAgent: null, reason: 'Prompted with no body' };
      }
      return { classification, action: 'log', targetAgent: null, reason: `Unhandled AgentSession action: ${payload.action}` };
    }

    case 'comment-mention': {
      const body = payload.data?.body || '';
      const mentionMatch = body.match(AGENT_ROLE_REGEX);
      const targetRole = mentionMatch?.[1] ? normalizeAgentRole(mentionMatch[1].toLowerCase()) : null;

      if (targetRole) {
        const isRunning = opts?.runningAgents?.has(targetRole);
        if (isRunning) {
          return { classification, action: 'pipe', targetAgent: targetRole, reason: `@${targetRole} mentioned — pipe to running session` };
        }
        return { classification, action: 'conditional-spawn', targetAgent: targetRole, reason: `@${targetRole} mentioned — spawn if issue completed` };
      }
      return { classification, action: 'log', targetAgent: null, reason: 'Comment with no @mention — check parent thread' };
    }

    case 'issue-created': {
      const labels = payload.data?.labels || [];

      // Check for "Plan" label — triggers planner instead of direct agent routing
      if (labels.some(l => l.name.toLowerCase() === 'plan')) {
        return { classification, action: 'conditional-spawn', targetAgent: 'planner', reason: 'Issue has "Plan" label — trigger auto-decomposition' };
      }

      let targetAgent: string | null = null;
      for (const label of labels) {
        const match = label.name.match(/^agent:(.+)$/);
        if (match) {
          targetAgent = match[1];
          break;
        }
      }

      if (!targetAgent) {
        const creatorRole = payload.data?.creatorId ? opts?.agentUserIdToRole?.[payload.data.creatorId] : null;
        if (creatorRole) {
          return { classification, action: 'conditional-spawn', targetAgent: creatorRole, reason: `Agent-created issue defaulted to creator role ${creatorRole}` };
        }
        return { classification, action: 'log', targetAgent: null, reason: 'Issue created — no agent label, logged only' };
      }

      const isAgentCreated = payload.data?.creatorId && opts?.agentUserIds?.has(payload.data.creatorId);
      if (!isAgentCreated) {
        return { classification, action: 'log', targetAgent, reason: 'Issue has agent label but not agent-created — logged only' };
      }

      return { classification, action: 'conditional-spawn', targetAgent, reason: `Agent-created issue with label agent:${targetAgent}` };
    }

    default:
      return { classification, action: 'log', targetAgent: null, reason: `${linearEvent}:${payload.action} — no spawn triggered` };
  }
}
