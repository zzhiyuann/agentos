/**
 * aos swarm — Multi-agent research swarm CLI commands.
 *
 * Implements Karpathy autoresearch loop with 2-3 AgentOS agents
 * coordinating via shared .swarm/ directory.
 */

import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  initSwarm,
  recordBaseline,
  seedFrontier,
  buildResearcherGrounding,
  getSwarmStatus,
  stopSwarm,
  generateSwarmReport,
} from '../core/swarm-coordinator.js';
import { SwarmStateManager } from '../core/swarm-state.js';
import { buildGroundingPrompt, loadPersona, agentExists } from '../core/persona.js';
import { getAdapter } from '../adapters/index.js';
import { getConfig } from '../core/config.js';
import { sessionExists, killSession, listSessionsByPrefix } from '../core/tmux.js';
import { registerSwarm, unregisterSwarm } from '../serve/swarm-monitor.js';

// ─── aos swarm init ─────────────────────────────────────────────────────────

interface SwarmInitArgs {
  name: string;
  workspace: string;
  metric: string;
  evalCommand: string;
  targetFiles: string[];
  agents?: number;
  maxExperiments?: number;
  budget?: number;
  higherIsBetter?: boolean;
  directions?: string[];
  frontier?: string[];
  parentIssueKey?: string;
  parentIssueId?: string;
}

export async function swarmInitCommand(opts: SwarmInitArgs): Promise<void> {
  const workspacePath = resolve(opts.workspace);
  if (!existsSync(workspacePath)) {
    console.log(chalk.red(`Workspace not found: ${workspacePath}`));
    return;
  }

  // Resolve parent issue ID from key if needed
  let parentIssueId = opts.parentIssueId;
  if (opts.parentIssueKey && !parentIssueId) {
    try {
      const { getIssue } = await import('../core/linear.js');
      const issue = await getIssue(opts.parentIssueKey);
      parentIssueId = issue.id;
      console.log(chalk.dim(`  Linked to issue: ${opts.parentIssueKey} (${parentIssueId})`));
    } catch (err) {
      console.log(chalk.yellow(`  Could not resolve issue ${opts.parentIssueKey}: ${(err as Error).message}`));
    }
  }

  const agentCount = opts.agents ?? 2;
  if (agentCount < 1 || agentCount > 5) {
    console.log(chalk.red('Agent count must be 1-5'));
    return;
  }

  // Parse directions (format: "focus:constraint1,constraint2")
  const directions = (opts.directions || []).map(d => {
    const [focus, ...rest] = d.split(':');
    return {
      focus: focus.trim(),
      constraints: rest.join(':').split(',').map(c => c.trim()).filter(Boolean),
    };
  });

  // Pad directions to match agent count
  while (directions.length < agentCount) {
    directions.push({
      focus: `research-direction-${directions.length}`,
      constraints: [],
    });
  }

  console.log(chalk.bold('Initializing research swarm...'));
  console.log(chalk.dim(`  Name: ${opts.name}`));
  console.log(chalk.dim(`  Workspace: ${workspacePath}`));
  console.log(chalk.dim(`  Metric: ${opts.metric} (${opts.higherIsBetter !== false ? 'higher is better' : 'lower is better'})`));
  console.log(chalk.dim(`  Agents: ${agentCount}`));
  console.log(chalk.dim(`  Max experiments/agent: ${opts.maxExperiments ?? 20}`));

  try {
    const manager = initSwarm({
      name: opts.name,
      workspacePath,
      metric: opts.metric,
      higherIsBetter: opts.higherIsBetter !== false,
      evalCommand: opts.evalCommand,
      targetFiles: opts.targetFiles,
      agentCount,
      maxExperimentsPerAgent: opts.maxExperiments ?? 20,
      budgetMinutes: opts.budget ?? 0,
      directions,
    });

    // Run baseline
    console.log(chalk.dim('\nRunning baseline evaluation...'));
    const baseline = recordBaseline(manager);
    if (baseline !== null) {
      console.log(chalk.green(`  Baseline ${opts.metric}: ${baseline}`));
    } else {
      console.log(chalk.yellow(`  Baseline eval failed — swarm will proceed without baseline`));
      console.log(chalk.yellow('  You can set baseline later with: aos swarm baseline'));
    }

    // Seed frontier
    seedFrontier(manager, opts.frontier);
    const frontier = manager.getFrontier();
    console.log(chalk.dim(`  Frontier seeded with ${frontier.length} ideas`));

    // Register with swarm monitor for serve integration
    registerSwarm(workspacePath, opts.parentIssueKey, parentIssueId);

    console.log(chalk.green('\n✓ Swarm initialized'));
    console.log(`  Config: ${workspacePath}/.swarm/config.json`);
    console.log(`  Start:  ${chalk.bold('aos swarm start --workspace ' + workspacePath)}`);
  } catch (err) {
    console.log(chalk.red(`Init failed: ${(err as Error).message}`));
  }
}

// ─── aos swarm start ────────────────────────────────────────────────────────

interface SwarmStartArgs {
  workspace: string;
  role?: string;
}

export async function swarmStartCommand(opts: SwarmStartArgs): Promise<void> {
  const workspacePath = resolve(opts.workspace);
  const manager = new SwarmStateManager(workspacePath);

  if (!manager.exists()) {
    console.log(chalk.red('No swarm found. Run: aos swarm init'));
    return;
  }

  const config = manager.getConfig();
  if (config.status !== 'running') {
    manager.setStatus('running');
  }

  const agentRole = opts.role || 'lead-engineer';
  if (!agentExists(agentRole)) {
    console.log(chalk.red(`Agent role "${agentRole}" not found.`));
    return;
  }

  console.log(chalk.bold(`Starting research swarm: ${config.name}`));
  console.log(chalk.dim(`  ${config.agentCount} agents, max ${config.maxExperimentsPerAgent} experiments each`));
  console.log(chalk.dim(`  Metric: ${config.metric} (baseline: ${manager.getBaseline() ?? 'TBD'})`));

  const persona = loadPersona(agentRole);
  const baseModel = persona.config.baseModel || 'cc';
  const adapter = getAdapter(baseModel);

  // Spawn one agent per research direction
  for (let i = 0; i < config.agentCount; i++) {
    const direction = config.directions[i];
    const tmuxName = `aos-swarm-${config.id}-agent-${i}`;

    if (sessionExists(tmuxName)) {
      console.log(chalk.yellow(`  Agent ${i} already running (${tmuxName})`));
      continue;
    }

    // Build grounding: persona + swarm context
    const personaGrounding = buildGroundingPrompt(persona, 'task');
    const swarmGrounding = buildResearcherGrounding(manager, i);
    const fullGrounding = personaGrounding + '\n\n' + swarmGrounding;

    const taskPrompt = [
      `You are Researcher Agent ${i} in the "${config.name}" research swarm.`,
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
      console.log(chalk.green(`  ✓ Agent ${i} spawned → ${tmuxName}`));
    } catch (err) {
      console.log(chalk.red(`  ✗ Agent ${i} failed: ${(err as Error).message}`));
    }
  }

  console.log(chalk.green(`\n✓ Swarm started with ${config.agentCount} agents`));
  console.log(`  Monitor: ${chalk.bold('aos swarm status --workspace ' + workspacePath)}`);
  console.log(`  Stop:    ${chalk.bold('aos swarm stop --workspace ' + workspacePath)}`);
}

// ─── aos swarm status ───────────────────────────────────────────────────────

interface SwarmStatusArgs {
  workspace: string;
  report?: boolean;
}

export async function swarmStatusCommand(opts: SwarmStatusArgs): Promise<void> {
  const workspacePath = resolve(opts.workspace);

  if (opts.report) {
    const report = generateSwarmReport(workspacePath);
    console.log(report);
    return;
  }

  const status = getSwarmStatus(workspacePath);

  if (!status.config) {
    console.log(chalk.dim('No swarm found at this workspace.'));
    return;
  }

  const config = status.config;
  const deltaStr = status.baseline !== null && status.bestMetric !== null
    ? `Δ${config.higherIsBetter ? '+' : ''}${(status.bestMetric - status.baseline).toFixed(4)}`
    : '';

  console.log(chalk.bold(`Research Swarm: ${config.name}`));
  console.log('─'.repeat(50));
  console.log(`  Status:     ${status.running ? chalk.green('RUNNING') : chalk.dim('STOPPED')}`);
  console.log(`  Metric:     ${config.metric} (${config.higherIsBetter ? '↑' : '↓'})`);
  console.log(`  Baseline:   ${status.baseline ?? chalk.dim('not set')}`);
  console.log(`  Best:       ${status.bestMetric ?? chalk.dim('none')} ${deltaStr}`);
  console.log(`  Experiments: ${status.totalExperiments}`);
  console.log(`  Frontier:   ${status.frontierSize} ideas remaining`);
  console.log();

  if (status.swarmConverged) {
    console.log(chalk.yellow('  ⚠ Swarm has converged — all agents stopped improving'));
  }
  console.log();

  // Per-agent breakdown
  for (let i = 0; i < config.agentCount; i++) {
    const dir = config.directions[i];
    const count = status.agentExperimentCounts[i] || 0;
    const maxStr = `${count}/${config.maxExperimentsPerAgent}`;
    const tmuxName = `aos-swarm-${config.id}-agent-${i}`;
    const alive = sessionExists(tmuxName);
    const conv = status.agentConvergence[i];
    const statusIcon = alive ? chalk.green('●') : chalk.dim('○');
    const convStr = conv?.converged ? chalk.yellow(' [converged]') : '';

    console.log(`  ${statusIcon} Agent ${i} (${dir.focus}): ${maxStr} experiments${convStr} ${alive ? '' : chalk.dim('(stopped)')}`);
  }

  // Show last 3 experiments
  const manager = new SwarmStateManager(workspacePath);
  const exps = manager.getExperiments().slice(-3);
  if (exps.length > 0) {
    console.log(chalk.dim('\nRecent experiments:'));
    for (const exp of exps) {
      const icon = exp.outcome === 'improvement' ? chalk.green('▲') :
                   exp.outcome === 'regression' ? chalk.red('▼') :
                   exp.outcome === 'error' ? chalk.red('✗') : chalk.dim('─');
      console.log(`  ${icon} ${exp.id}: ${exp.hypothesis.substring(0, 60)} (${config.metric}=${exp.metricValue ?? 'N/A'})`);
    }
  }
}

// ─── aos swarm stop ─────────────────────────────────────────────────────────

interface SwarmStopArgs {
  workspace: string;
  kill?: boolean;
}

export async function swarmStopCommand(opts: SwarmStopArgs): Promise<void> {
  const workspacePath = resolve(opts.workspace);

  try {
    const manager = new SwarmStateManager(workspacePath);
    if (!manager.exists()) {
      console.log(chalk.dim('No swarm found.'));
      return;
    }

    const config = manager.getConfig();

    // Kill tmux sessions if requested
    if (opts.kill) {
      const sessions = listSessionsByPrefix(`aos-swarm-${config.id}`);
      for (const sess of sessions) {
        try {
          killSession(sess);
          console.log(chalk.dim(`  Killed ${sess}`));
        } catch { /**/ }
      }
    }

    stopSwarm(workspacePath);
    unregisterSwarm(workspacePath);

    // Generate final report
    const report = generateSwarmReport(workspacePath);
    console.log(chalk.green('✓ Swarm stopped\n'));
    console.log(report);
  } catch (err) {
    console.log(chalk.red(`Stop failed: ${(err as Error).message}`));
  }
}

// ─── aos swarm baseline ─────────────────────────────────────────────────────

interface SwarmBaselineArgs {
  workspace: string;
}

export async function swarmBaselineCommand(opts: SwarmBaselineArgs): Promise<void> {
  const workspacePath = resolve(opts.workspace);
  const manager = new SwarmStateManager(workspacePath);

  if (!manager.exists()) {
    console.log(chalk.red('No swarm found. Run: aos swarm init'));
    return;
  }

  console.log(chalk.dim('Running baseline evaluation...'));
  const baseline = recordBaseline(manager);
  const config = manager.getConfig();
  if (baseline !== null) {
    console.log(chalk.green(`✓ Baseline ${config.metric}: ${baseline}`));
  } else {
    console.log(chalk.red('Baseline eval failed — check eval command and try again'));
  }
}
