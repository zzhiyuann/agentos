import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';
import { getActiveSessions } from './db.js';
import { agentExists, loadAgentConfig } from './persona.js';
import type { LinearIssueInfo } from '../types.js';

export interface AgentDefinition {
  label: string;
  command: string;
  host: string;
  capabilities: string[];
  maxConcurrent: number;
}

export type AgentRegistry = Record<string, AgentDefinition>;

function getDefaultRegistry(): AgentRegistry {
  const host = getConfig().execHost;
  return {
    cc: {
      label: 'agent:cc',
      command: 'claude --permission-mode auto',
      host,
      capabilities: ['code', 'review', 'docs', 'debug', 'refactor'],
      maxConcurrent: 4,
    },
  };
}

function getRegistryPath(): string {
  return join(getConfig().stateDir, 'agents.json');
}

export function getAgentRegistry(): AgentRegistry {
  const path = getRegistryPath();
  const host = getConfig().execHost;
  let registry: AgentRegistry;
  if (existsSync(path)) {
    registry = JSON.parse(readFileSync(path, 'utf-8'));
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

export function canSpawnAgent(agentType: string): { allowed: boolean; reason?: string } {
  const def = getAgentDefinition(agentType);
  const activeSessions = getActiveSessions();
  const activeCount = activeSessions.filter(s => s.agent_type === agentType && s.status === 'running').length;

  if (activeCount >= def.maxConcurrent) {
    return {
      allowed: false,
      reason: `Max concurrent ${agentType} sessions reached (${activeCount}/${def.maxConcurrent})`,
    };
  }

  return { allowed: true };
}
