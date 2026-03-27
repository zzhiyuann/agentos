/**
 * Swarm Trigger — Automatically initialize and start an autoresearch swarm
 * when a Linear issue receives the "Swarm" label.
 *
 * Flow:
 *   1. LLM reads issue description, extracts swarm config
 *   2. Validates required fields (metric, eval command)
 *   3. Initializes swarm via coordinator
 *   4. Spawns 2 researcher agents
 *   5. Posts progress to the parent Linear issue
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

import { getConfig, resolveWorkspace } from '../core/config.js';
import { getIssue, addComment } from '../core/linear.js';
import { loadPersona, buildGroundingPrompt, agentExists } from '../core/persona.js';
import { getAdapter } from '../adapters/index.js';
import { sessionExists } from '../core/tmux.js';
import {
  initSwarm,
  recordBaseline,
  seedFrontier,
  buildResearcherGrounding,
  type SwarmInitOptions,
} from '../core/swarm-coordinator.js';
import { SwarmStateManager } from '../core/swarm-state.js';
import { registerSwarm } from './swarm-monitor.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of researcher agents per swarm (safety cap) */
const MAX_AGENTS = 2;

/** Maximum time budget in minutes (safety cap: 4 hours) */
const MAX_BUDGET_MINUTES = 240;

/** Default experiments per agent if not specified */
const DEFAULT_MAX_EXPERIMENTS = 20;

/** Default budget in minutes if not specified */
const DEFAULT_BUDGET_MINUTES = 120;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SwarmConfig {
  metric: string;
  higherIsBetter: boolean;
  evalCommand: string;
  targetFiles: string[];
  directions: { focus: string; constraints: string[] }[];
  budgetMinutes: number;
  maxExperimentsPerAgent: number;
  workspacePath?: string;
}

export interface SwarmTriggerResult {
  ok: boolean;
  action: 'started' | 'error' | 'skipped';
  detail: string;
  swarmId?: string;
  workspacePath?: string;
}

// ─── LLM Config Extraction ─────────────────────────────────────────────────

/**
 * Use Claude CLI to extract swarm configuration from an issue description.
 * Returns structured config or throws on failure.
 */
export function extractSwarmConfig(
  issueTitle: string,
  issueDescription: string,
): SwarmConfig {
  const prompt = `You are a configuration extractor. Given a Linear issue that describes a research optimization task, extract the swarm configuration.

You MUST respond in this exact JSON format — the orchestrator parses it programmatically:

<config>
{
  "metric": "name of the metric to optimize (e.g., balanced_accuracy, val_loss, f1_score)",
  "higherIsBetter": true or false,
  "evalCommand": "shell command that prints the metric value to stdout",
  "targetFiles": ["list", "of", "files", "agents", "can", "modify"],
  "directions": [
    { "focus": "research direction 1", "constraints": ["constraint1", "constraint2"] },
    { "focus": "research direction 2", "constraints": [] }
  ],
  "budgetMinutes": 120,
  "maxExperimentsPerAgent": 20,
  "workspacePath": "/absolute/path/to/project (if mentioned in description, otherwise null)"
}
</config>

Rules:
- metric and evalCommand are REQUIRED — if the issue doesn't specify them, set them to empty string
- higherIsBetter defaults to true for accuracy/f1/precision/recall, false for loss/error/bpb
- targetFiles should be specific files mentioned, not directories
- directions should be 2 distinct research approaches (different strategies, not duplicates)
- budgetMinutes caps at ${MAX_BUDGET_MINUTES} (4 hours)
- maxExperimentsPerAgent defaults to ${DEFAULT_MAX_EXPERIMENTS}
- workspacePath is optional — extract if an absolute path is mentioned

Issue:
**${issueTitle}**

${issueDescription || '(No description provided)'}`;

  const result = spawnSync('claude', ['-p', '--output-format', 'text'], {
    input: prompt,
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 512 * 1024,
  });

  if (result.error) {
    throw new Error(`LLM config extraction failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`LLM exited with code ${result.status}: ${(result.stderr || '').substring(0, 200)}`);
  }

  const output = (result.stdout || '').trim();
  if (!output) {
    throw new Error('LLM returned empty response');
  }

  // Parse the <config> block
  const configMatch = output.match(/<config>([\s\S]*?)<\/config>/);
  if (!configMatch) {
    throw new Error(`LLM response missing <config> block. Response: ${output.substring(0, 300)}`);
  }

  const parsed = JSON.parse(configMatch[1].trim()) as Record<string, unknown>;

  return {
    metric: String(parsed.metric || ''),
    higherIsBetter: parsed.higherIsBetter !== false,
    evalCommand: String(parsed.evalCommand || ''),
    targetFiles: Array.isArray(parsed.targetFiles)
      ? (parsed.targetFiles as string[]).map(String)
      : [],
    directions: Array.isArray(parsed.directions)
      ? (parsed.directions as { focus: string; constraints: string[] }[]).map(d => ({
          focus: String(d.focus || 'exploration'),
          constraints: Array.isArray(d.constraints) ? d.constraints.map(String) : [],
        }))
      : [
          { focus: 'parameter-optimization', constraints: [] },
          { focus: 'algorithm-exploration', constraints: [] },
        ],
    budgetMinutes: Math.min(
      Number(parsed.budgetMinutes) || DEFAULT_BUDGET_MINUTES,
      MAX_BUDGET_MINUTES,
    ),
    maxExperimentsPerAgent: Number(parsed.maxExperimentsPerAgent) || DEFAULT_MAX_EXPERIMENTS,
    workspacePath: parsed.workspacePath ? String(parsed.workspacePath) : undefined,
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validate extracted swarm config. Returns error message or null if valid.
 */
export function validateSwarmConfig(config: SwarmConfig): string | null {
  if (!config.metric) {
    return 'Missing required field: metric. The issue description must specify what metric to optimize.';
  }
  if (!config.evalCommand) {
    return 'Missing required field: evalCommand. The issue description must specify a shell command that outputs the metric value.';
  }
  if (config.targetFiles.length === 0) {
    return 'Missing required field: targetFiles. The issue description must specify which files agents can modify.';
  }
  return null;
}

// ─── Main Trigger Function ──────────────────────────────────────────────────

/**
 * Trigger a swarm from a Linear issue.
 * Extracts config, validates, initializes swarm, starts researcher agents.
 */
export async function triggerSwarmFromIssue(
  issueKey: string,
): Promise<SwarmTriggerResult> {
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.bold(`[${ts}] Swarm trigger: ${issueKey}`));

  // 1. Fetch issue details
  let issue: Awaited<ReturnType<typeof getIssue>>;
  try {
    issue = await getIssue(issueKey);
  } catch (err) {
    return { ok: false, action: 'error', detail: `Failed to fetch issue: ${(err as Error).message}` };
  }

  // 2. Extract config via LLM
  let config: SwarmConfig;
  try {
    console.log(chalk.dim(`  Extracting swarm config from ${issueKey} description...`));
    config = extractSwarmConfig(issue.title, issue.description || '');
  } catch (err) {
    const msg = `Config extraction failed: ${(err as Error).message}`;
    console.log(chalk.red(`  ${msg}`));
    try {
      await addComment(issue.id, `**Swarm trigger failed**: ${msg}\n\nThe issue description must include:\n- **Metric**: what to optimize (e.g., balanced_accuracy)\n- **Eval command**: shell command that prints metric value\n- **Target files**: which files agents can modify`);
    } catch { /* best effort */ }
    return { ok: false, action: 'error', detail: msg };
  }

  // 3. Validate config
  const validationError = validateSwarmConfig(config);
  if (validationError) {
    console.log(chalk.red(`  Validation failed: ${validationError}`));
    try {
      await addComment(issue.id, `**Swarm trigger failed**: ${validationError}\n\nPlease update the issue description with the missing information and re-apply the "Swarm" label.`);
    } catch { /* best effort */ }
    return { ok: false, action: 'error', detail: validationError };
  }

  // 4. Resolve workspace
  const workspacePath = config.workspacePath && existsSync(config.workspacePath)
    ? resolve(config.workspacePath)
    : resolveWorkspace(issueKey, issue.project);

  if (!existsSync(workspacePath)) {
    const msg = `Workspace not found: ${workspacePath}`;
    console.log(chalk.red(`  ${msg}`));
    try {
      await addComment(issue.id, `**Swarm trigger failed**: ${msg}`);
    } catch { /* best effort */ }
    return { ok: false, action: 'error', detail: msg };
  }

  // 5. Check for existing swarm
  const manager = new SwarmStateManager(workspacePath);
  if (manager.exists()) {
    const existingConfig = manager.getConfig();
    if (existingConfig.status === 'running') {
      const msg = `Swarm already running at ${workspacePath} (${existingConfig.name})`;
      console.log(chalk.yellow(`  ${msg}`));
      return { ok: false, action: 'skipped', detail: msg };
    }
  }

  // 6. Ensure directions are padded to MAX_AGENTS
  while (config.directions.length < MAX_AGENTS) {
    config.directions.push({
      focus: `research-direction-${config.directions.length}`,
      constraints: [],
    });
  }

  // 7. Initialize swarm
  const swarmName = `${issueKey}: ${issue.title}`.substring(0, 80);
  const initOpts: SwarmInitOptions = {
    name: swarmName,
    workspacePath,
    metric: config.metric,
    higherIsBetter: config.higherIsBetter,
    evalCommand: config.evalCommand,
    targetFiles: config.targetFiles,
    agentCount: MAX_AGENTS,
    maxExperimentsPerAgent: config.maxExperimentsPerAgent,
    budgetMinutes: config.budgetMinutes,
    directions: config.directions.slice(0, MAX_AGENTS),
  };

  let swarmManager: SwarmStateManager;
  try {
    swarmManager = initSwarm(initOpts);
    console.log(chalk.green(`  Swarm initialized: ${swarmName}`));
  } catch (err) {
    const msg = `Swarm init failed: ${(err as Error).message}`;
    console.log(chalk.red(`  ${msg}`));
    try { await addComment(issue.id, `**Swarm trigger failed**: ${msg}`); } catch { /* */ }
    return { ok: false, action: 'error', detail: msg };
  }

  // 8. Run baseline
  console.log(chalk.dim('  Running baseline evaluation...'));
  const baseline = recordBaseline(swarmManager);
  if (baseline !== null) {
    console.log(chalk.green(`  Baseline ${config.metric}: ${baseline}`));
  } else {
    console.log(chalk.yellow('  Baseline eval failed — swarm will proceed without baseline'));
  }

  // 9. Seed frontier
  seedFrontier(swarmManager);
  const frontier = swarmManager.getFrontier();
  console.log(chalk.dim(`  Frontier seeded with ${frontier.length} ideas`));

  // 10. Register with swarm monitor for serve integration
  registerSwarm(workspacePath, issueKey, issue.id);

  // 11. Post config summary to Linear
  const swarmConfig = swarmManager.getConfig();
  try {
    await addComment(issue.id, [
      `## Swarm Initialized`,
      ``,
      `**${swarmName}**`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Metric | ${config.metric} (${config.higherIsBetter ? 'higher is better' : 'lower is better'}) |`,
      `| Baseline | ${baseline ?? 'N/A (eval failed)'} |`,
      `| Eval command | \`${config.evalCommand}\` |`,
      `| Target files | ${config.targetFiles.join(', ')} |`,
      `| Agents | ${MAX_AGENTS} |`,
      `| Max experiments/agent | ${config.maxExperimentsPerAgent} |`,
      `| Budget | ${config.budgetMinutes} minutes |`,
      `| Workspace | \`${workspacePath}\` |`,
      ``,
      `**Research Directions:**`,
      ...config.directions.slice(0, MAX_AGENTS).map((d, i) =>
        `- Agent ${i}: ${d.focus}${d.constraints.length ? ` (constraints: ${d.constraints.join(', ')})` : ''}`
      ),
      ``,
      `**Frontier:** ${frontier.length} initial ideas seeded`,
      ``,
      `Spawning researcher agents now...`,
    ].join('\n'));
  } catch { /* best effort */ }

  // 12. Spawn researcher agents
  const agentRole = 'lead-engineer';
  if (!agentExists(agentRole)) {
    const msg = `Agent role "${agentRole}" not found — cannot spawn researchers`;
    try { await addComment(issue.id, `**Swarm warning**: ${msg}`); } catch { /* */ }
    return { ok: false, action: 'error', detail: msg };
  }

  const persona = loadPersona(agentRole);
  const baseModel = persona.config.baseModel || 'cc';
  const adapter = getAdapter(baseModel);

  let spawned = 0;
  for (let i = 0; i < MAX_AGENTS; i++) {
    const direction = swarmConfig.directions[i];
    const tmuxName = `aos-swarm-${swarmConfig.id}-agent-${i}`;

    if (sessionExists(tmuxName)) {
      console.log(chalk.yellow(`  Agent ${i} already running (${tmuxName})`));
      continue;
    }

    const personaGrounding = buildGroundingPrompt(persona, 'task');
    const swarmGrounding = buildResearcherGrounding(swarmManager, i);
    const fullGrounding = personaGrounding + '\n\n' + swarmGrounding;

    const taskPrompt = [
      `You are Researcher Agent ${i} in the "${swarmName}" research swarm.`,
      `Your research direction: **${direction.focus}**`,
      ``,
      `Read the "Research Swarm Protocol" section in your system prompt carefully.`,
      `Your workspace is: ${workspacePath}`,
      ``,
      `Begin your experiment loop now. Start by:`,
      `1. Reading .swarm/config.json to understand the full swarm setup`,
      `2. Reading .swarm/frontier.json for available ideas`,
      `3. Pick your first experiment and begin`,
      ``,
      `Remember: commit improvements, revert regressions, record everything.`,
    ].join('\n');

    console.log(chalk.cyan(`  Spawning Agent ${i}: ${direction.focus} [${baseModel}]`));

    try {
      await adapter.spawn({
        issueKey: `swarm-${i}`,
        title: `Research Swarm: ${direction.focus}`,
        systemPrompt: fullGrounding,
        initialPrompt: taskPrompt,
        workspacePath,
        attemptNumber: 1,
        agentRole,
      });
      spawned++;
      console.log(chalk.green(`  Agent ${i} spawned`));
    } catch (err) {
      console.log(chalk.red(`  Agent ${i} failed: ${(err as Error).message}`));
    }
  }

  // 13. Post spawn result
  try {
    await addComment(issue.id,
      `**Swarm started**: ${spawned}/${MAX_AGENTS} researcher agents spawned.\n\n` +
      `Progress updates will be posted automatically every ~10 minutes.\n` +
      `To stop: \`linear-tool swarm-stop ${issueKey}\``
    );
  } catch { /* best effort */ }

  console.log(chalk.green(`  Swarm started: ${spawned} agents, ${frontier.length} frontier ideas`));

  return {
    ok: true,
    action: 'started',
    detail: `Swarm started with ${spawned} agents`,
    swarmId: swarmConfig.id,
    workspacePath,
  };
}
