import type { RunnerAdapter } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { agentExists, loadAgentConfig } from '../core/persona.js';

const adapters: Record<string, () => RunnerAdapter> = {
  cc: () => new ClaudeCodeAdapter(),
};

/**
 * Get adapter by type ('cc'/'codex') or role name ('cto'/'lead-engineer').
 * Role names are resolved to adapter type via persona config's baseModel.
 */
export function getAdapter(agentTypeOrRole: string): RunnerAdapter {
  // Direct adapter match
  const factory = adapters[agentTypeOrRole];
  if (factory) return factory();

  // Resolve role name → baseModel → adapter
  if (agentExists(agentTypeOrRole)) {
    const config = loadAgentConfig(agentTypeOrRole);
    const resolved = adapters[config.baseModel];
    if (resolved) return resolved();
  }

  throw new Error(`No adapter for "${agentTypeOrRole}". Available adapters: ${Object.keys(adapters).join(', ')}`);
}

export type { RunnerAdapter, SpawnOptions, SpawnResult } from './types.js';
