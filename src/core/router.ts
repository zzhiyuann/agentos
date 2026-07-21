import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';
import { getActiveSessions } from './db.js';
import { agentExists, loadAgentConfig } from './persona.js';
import { createLogger } from './logger.js';
import type { LinearIssueInfo } from '../types.js';

const log = createLogger('router');

export interface AgentDefinition {
  label: string;
  command: string;
  host: string;
  capabilities: string[];
  maxConcurrent: number;
}

export type AgentRegistry = Record<string, AgentDefinition>;

function getDefaultRegistry(): AgentRegistry {
  const host = getConfig().imacHost;
  return {
    cc: {
      label: 'agent:cc',
      command: 'claude --permission-mode auto',
      host,
      capabilities: ['code', 'review', 'docs', 'debug', 'refactor'],
      maxConcurrent: 4,
    },
    codex: {
      label: 'agent:codex',
      command: 'codex --dangerously-bypass-approvals-and-sandbox',
      host,
      capabilities: ['code', 'refactor', 'fix', 'implement'],
      maxConcurrent: 4,
    },
  };
}

function getRegistryPath(): string {
  return join(getConfig().stateDir, 'agents.json');
}

export function getAgentRegistry(): AgentRegistry {
  const path = getRegistryPath();
  const host = getConfig().imacHost;
  let registry: AgentRegistry;
  if (existsSync(path)) {
    registry = {
      ...getDefaultRegistry(),
      ...(JSON.parse(readFileSync(path, 'utf-8')) as AgentRegistry),
    };
  } else {
    registry = getDefaultRegistry();
    writeFileSync(path, JSON.stringify(registry, null, 2));
  }
  // Always override host from config (not cached file)
  for (const def of Object.values(registry)) {
    def.host = host;
  }
  return registry;
}

/**
 * Resolve agent ROLE for an issue (e.g., 'cto', 'lead-engineer').
 * Uses routing.json rules: label → project → default.
 */
export function resolveAgentRole(issue: LinearIssueInfo): string {
  const routingPath = join(getConfig().stateDir, 'routing.json');
  if (existsSync(routingPath)) {
    const { rules } = JSON.parse(readFileSync(routingPath, 'utf-8')) as { rules: { label?: string; project?: string; default?: string; agent: string }[] };

    // Label-based rules first
    for (const rule of rules) {
      if (rule.label && issue.labels.some(l => l.toLowerCase() === rule.label!.toLowerCase())) {
        return rule.agent;
      }
    }

    // Project-based rules
    for (const rule of rules) {
      if (rule.project && issue.project?.toLowerCase() === rule.project.toLowerCase()) {
        return rule.agent;
      }
    }

    // Default rule — { "default": "lead-engineer" } means agent = the default value
    const defaultRule = rules.find(r => r.default);
    if (defaultRule) return defaultRule.agent || defaultRule.default!;
  }

  return 'lead-engineer';
}

/**
 * Resolve adapter type for an issue.
 * First resolves role via routing, then maps role → baseModel.
 */
export function resolveAgentType(issue: LinearIssueInfo): string {
  // 1. Explicit adapter labels (agent:cc, agent:codex) take priority
  const registry = getAgentRegistry();
  for (const [agentType, def] of Object.entries(registry)) {
    if (issue.labels.includes(def.label)) {
      return agentType;
    }
  }

  // 2. Route via role → persona config → baseModel
  const role = resolveAgentRole(issue);
  if (agentExists(role)) {
    const config = loadAgentConfig(role);
    return config.baseModel || 'cc';
  }

  return 'cc';
}

export function getAgentDefinition(agentType: string): AgentDefinition {
  const registry = getAgentRegistry();
  const def = registry[agentType];
  if (!def) throw new Error(`Unknown agent type: ${agentType}. Available: ${Object.keys(registry).join(', ')}`);
  return def;
}

// RYA-1184: hard ceiling on concurrent sessions per model type. The Claude
// session limit is shared account-wide — exceeding it freezes every session on
// an interactive billing dialog. Registry maxConcurrent can only LOWER the cap
// (the live agents.json predates the incident and says 20 for cc); the ceiling
// itself is overridable via AOS_DISPATCH_CONCURRENCY.
const DEFAULT_DISPATCH_CAP = 3;

function dispatchCeiling(): number {
  const env = parseInt(process.env.AOS_DISPATCH_CONCURRENCY || '', 10);
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_DISPATCH_CAP;
}

export function getDispatchCap(agentType: string): number {
  return Math.min(getAgentDefinition(agentType).maxConcurrent, dispatchCeiling());
}

/** Attempts store the agent ROLE in agent_type (e.g. 'lead-engineer'), not the
 *  model type — map it back via the role's baseModel so sessions actually count
 *  against the model-type cap. Legacy rows holding a model type pass through. */
function modelTypeOf(agentTypeValue: string, registry: AgentRegistry): string {
  if (registry[agentTypeValue]) return agentTypeValue;
  try {
    if (agentExists(agentTypeValue)) {
      return loadAgentConfig(agentTypeValue).baseModel || 'cc';
    }
  } catch (err) {
    log.debug('modelTypeOf: agent config load failed, counting as cc', { agentTypeValue, error: (err as Error).message });
  }
  return 'cc';
}

export function canSpawnAgent(agentType: string): { allowed: boolean; reason?: string } {
  const registry = getAgentRegistry();
  if (!registry[agentType]) {
    throw new Error(`Unknown agent type: ${agentType}. Available: ${Object.keys(registry).join(', ')}`);
  }

  const running = getActiveSessions().filter(
    s => s.status === 'running' && modelTypeOf(s.agent_type, registry) === agentType
  );
  // Multiple attempt rows can share one tmux session; the session limit is
  // consumed per live session, so count unique tmux sessions (like
  // getRunningSessionCount in serve/concurrency.ts).
  const activeCount = new Set(running.map(s => s.tmux_session).filter(Boolean)).size;

  const cap = getDispatchCap(agentType);
  if (activeCount >= cap) {
    return {
      allowed: false,
      reason: `Max concurrent ${agentType} sessions reached (${activeCount}/${cap})`,
    };
  }

  return { allowed: true };
}
