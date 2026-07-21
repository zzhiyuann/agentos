/**
 * Swarm Coordinator — Orchestrates multi-agent research swarms.
 *
 * Implements the Karpathy autoresearch loop:
 *   1. Initialize swarm with metric, target files, and research directions
 *   2. Run baseline evaluation
 *   3. Seed frontier with initial ideas per direction
 *   4. Dispatch 2-3 researcher agents in parallel
 *   5. Monitor convergence (agents self-coordinate via .swarm/ files)
 *
 * Each researcher agent:
 *   - Reads .swarm/config.json for its direction
 *   - Claims ideas from .swarm/frontier.json
 *   - Runs experiments, evaluates, records results
 *   - Commits improvements, reverts regressions
 *   - Repeats until budget exhausted or convergence detected
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SwarmStateManager, type SwarmConfig, type ResearchDirection } from './swarm-state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SwarmInitOptions {
  /** Human-readable name */
  name: string;
  /** Workspace path where the research project lives */
  workspacePath: string;
  /** Metric name (e.g., "balanced_accuracy", "val_bpb") */
  metric: string;
  /** Higher is better? (true for accuracy, false for loss/bpb) */
  higherIsBetter: boolean;
  /** Shell command that prints metric value to stdout */
  evalCommand: string;
  /** Files agents are allowed to modify */
  targetFiles: string[];
  /** Number of researcher agents (2-3) */
  agentCount: number;
  /** Max experiments per agent */
  maxExperimentsPerAgent: number;
  /** Time budget in minutes (0 = unlimited) */
  budgetMinutes: number;
  /** Research directions — one per agent */
  directions: { focus: string; constraints: string[] }[];
}

export interface EvalResult {
  success: boolean;
  value: number | null;
  error?: string;
}

export interface ConvergenceResult {
  converged: boolean;
  reason: string;
  /** Number of consecutive non-improving experiments */
  nonImprovingStreak: number;
}

export interface SwarmStatus {
  running: boolean;
  config: SwarmConfig | null;
  baseline: number | null;
  bestMetric: number | null;
  bestExperimentId: string | null;
  totalExperiments: number;
  frontierSize: number;
  agentExperimentCounts: number[];
  /** Per-agent convergence state (empty if no swarm) */
  agentConvergence: ConvergenceResult[];
  /** True if all agents converged or hit max experiments */
  swarmConverged: boolean;
}

// ─── Coordinator ────────────────────────────────────────────────────────────

/**
 * Initialize a new research swarm in the given workspace.
 * Creates .swarm/ directory with config, seeds frontier.
 */
export function initSwarm(opts: SwarmInitOptions): SwarmStateManager {
  const manager = new SwarmStateManager(opts.workspacePath);

  if (manager.exists()) {
    throw new Error(`Swarm already exists at ${opts.workspacePath}/.swarm/. Use 'aos swarm stop' first.`);
  }

  const directions: ResearchDirection[] = opts.directions.map((d, i) => ({
    agentIndex: i,
    focus: d.focus,
    constraints: d.constraints,
  }));

  const config: SwarmConfig = {
    id: `swarm-${Date.now()}`,
    name: opts.name,
    metric: opts.metric,
    higherIsBetter: opts.higherIsBetter,
    evalCommand: opts.evalCommand,
    targetFiles: opts.targetFiles,
    agentCount: opts.agentCount,
    maxExperimentsPerAgent: opts.maxExperimentsPerAgent,
    budgetMinutes: opts.budgetMinutes,
    directions,
    workspacePath: opts.workspacePath,
    createdAt: new Date().toISOString(),
    status: 'running',
  };

  manager.init(config);
  return manager;
}

/**
 * Run the evaluation command safely — returns a result object instead of throwing.
 * Use this when you need graceful degradation (e.g., recording outcome=error).
 */
export function safeRunEvaluation(workspacePath: string, evalCommand: string): EvalResult {
  try {
    const output = execSync(evalCommand, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 300_000, // 5 min timeout for eval
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Extract last number from output (handles cases where eval prints extra info)
    const numbers = output.match(/[-+]?\d*\.?\d+/g);
    if (!numbers || numbers.length === 0) {
      return { success: false, value: null, error: `Eval command produced no numbers: ${output.substring(0, 200)}` };
    }
    return { success: true, value: parseFloat(numbers[numbers.length - 1]) };
  } catch (err) {
    const msg = (err as Error).message;
    // Truncate error to avoid huge stack traces in experiment records
    return { success: false, value: null, error: `Eval command failed: ${msg.substring(0, 500)}` };
  }
}

/**
 * Run the evaluation command and return the metric value.
 * Throws on failure — use safeRunEvaluation() for graceful degradation.
 */
export function runEvaluation(workspacePath: string, evalCommand: string): number {
  const result = safeRunEvaluation(workspacePath, evalCommand);
  if (!result.success) {
    throw new Error(result.error!);
  }
  return result.value!;
}

/**
 * Run baseline evaluation and record it.
 * Returns null if eval fails (swarm can still proceed without baseline).
 */
export function recordBaseline(manager: SwarmStateManager): number | null {
  const config = manager.getConfig();
  const result = safeRunEvaluation(config.workspacePath, config.evalCommand);
  if (!result.success) {
    return null;
  }
  manager.setBaseline(result.value!);
  return result.value;
}

/**
 * Seed the frontier with initial ideas based on research directions.
 */
export function seedFrontier(manager: SwarmStateManager, customIdeas?: string[]): void {
  const config = manager.getConfig();

  if (customIdeas && customIdeas.length > 0) {
    manager.addToFrontier(customIdeas);
    return;
  }

  // Generate initial ideas per direction
  const ideas: string[] = [];
  for (const dir of config.directions) {
    ideas.push(
      `[${dir.focus}] Explore parameter sensitivity in ${config.targetFiles[0] || 'main target'}`,
      `[${dir.focus}] Try alternative algorithm for ${dir.focus}`,
      `[${dir.focus}] Optimize ${dir.focus} with grid search over key parameters`,
    );
    for (const constraint of dir.constraints) {
      ideas.push(`[${dir.focus}] Investigate: ${constraint}`);
    }
  }

  manager.addToFrontier(ideas);
}

/**
 * Build the researcher agent grounding prompt.
 * This gets injected into the agent's system prompt so it knows how to
 * participate in the swarm.
 */
export function buildResearcherGrounding(
  manager: SwarmStateManager,
  agentIndex: number,
): string {
  const config = manager.getConfig();
  const best = manager.getBest();
  const frontier = manager.getFrontier();
  const agentExps = manager.getAgentExperiments(agentIndex);
  const direction = config.directions[agentIndex];
  const convergence = checkConvergence(manager, agentIndex);

  const directionLabel = direction
    ? `**Your direction**: ${direction.focus}\n**Constraints**: ${direction.constraints.join(', ') || 'none'}`
    : 'No specific direction assigned.';

  // Show recent experiments for context
  const recentExps = agentExps.slice(-5).map(e =>
    `- ${e.id}: ${e.outcome} (${config.metric}=${e.metricValue ?? 'N/A'}, Δ${e.delta !== null ? (e.delta >= 0 ? '+' : '') + e.delta.toFixed(4) : 'N/A'}) — ${e.hypothesis}`
  ).join('\n');

  // Show available frontier ideas
  const availableIdeas = frontier.slice(0, 10).map((idea, i) => `${i + 1}. ${idea}`).join('\n');

  return `
## Research Swarm Protocol

You are **Researcher Agent ${agentIndex}** in a multi-agent research swarm.
Your goal: improve the metric **${config.metric}** (${config.higherIsBetter ? 'higher is better' : 'lower is better'}).

${directionLabel}

### Current State
- **Baseline**: ${best.bestMetric !== null ? best.bestMetric : 'not yet measured'}
- **Best so far**: ${best.bestMetric ?? 'N/A'} (experiment: ${best.bestExperimentId ?? 'none'})
- **Your experiments**: ${agentExps.length} / ${config.maxExperimentsPerAgent} max
- **Non-improving streak**: ${convergence.nonImprovingStreak} / 3 (${convergence.converged ? '⚠️ CONVERGED — stop experimenting' : 'keep going'})
- **Target files**: ${config.targetFiles.join(', ')}
- **Eval command**: \`${config.evalCommand}\`

### Your Experiment Loop

Repeat until you hit ${config.maxExperimentsPerAgent} experiments:

1. **Pick an idea** from the frontier (\`.swarm/frontier.json\`) or generate your own based on your direction
2. **Lock it** — write a lock file at \`.swarm/locks/{experiment-id}.lock\` with your agent index
3. **Implement** the change in the target files
4. **Evaluate** — run: \`${config.evalCommand}\`
5. **Record** the result:
   - If improvement: \`git commit\` the change, record in \`.swarm/experiments/\`
   - If regression or neutral: \`git checkout\` to revert, still record the result
6. **Update frontier** — add new ideas inspired by what you learned
7. **Release lock** — rename \`.swarm/locks/{id}.lock\` to \`.swarm/locks/{id}.done\`

### Recording Experiments

Write each experiment result to \`.swarm/experiments/agent-${agentIndex}-exp-{N}.json\`:
\`\`\`json
{
  "id": "agent-${agentIndex}-exp-{N}",
  "agentIndex": ${agentIndex},
  "hypothesis": "Brief description of what you tried",
  "changes": ["file:line — what changed"],
  "metricValue": <number or null>,
  "delta": <number or null>,
  "outcome": "improvement" | "regression" | "neutral" | "error",
  "errorMessage": "<error details if outcome=error>",
  "commitHash": "<hash if committed>",
  "durationSeconds": <seconds>,
  "timestamp": "<ISO timestamp>"
}
\`\`\`

Also append a human-readable entry to \`.swarm/experiment-log.md\`.

If the experiment improved the metric, update \`.swarm/best.json\`:
\`\`\`json
{
  "baseline": <original>,
  "bestMetric": <new best>,
  "bestExperimentId": "agent-${agentIndex}-exp-{N}"
}
\`\`\`

### Eval Failure Handling

If the eval command fails (non-zero exit, timeout, no numeric output):
1. **Do NOT crash or stop** — record it as \`outcome: "error"\` with \`metricValue: null\`
2. **Revert** your changes (\`git checkout\`)
3. **Include** the error message in the experiment record (\`errorMessage\` field)
4. **Continue** to the next experiment — eval failures count toward the non-improving streak
5. If 3 consecutive experiments produce errors, stop and report the issue

### Coordination Rules
- **Check locks** before starting: if another agent has locked an idea, skip it
- **Don't modify** other agents' experiment files
- **Commit improvements only** — revert everything else before starting next experiment
- **Add to frontier** after each experiment — share discoveries with other agents
- **Stop** when you hit ${config.maxExperimentsPerAgent} experiments or the metric stops improving for 3 consecutive attempts

### Recent Experiments (yours)
${recentExps || 'None yet — you are starting fresh.'}

### Frontier Ideas (pick from these or generate your own)
${availableIdeas || 'Empty — generate your own ideas based on your direction.'}
`;
}

/**
 * Check if an agent has converged (3 consecutive non-improving experiments).
 * Non-improving = regression, neutral, or error.
 */
export function checkConvergence(
  manager: SwarmStateManager,
  agentIndex: number,
  consecutiveThreshold: number = 3,
): ConvergenceResult {
  const config = manager.getConfig();
  const agentExps = manager.getAgentExperiments(agentIndex);

  // Not enough experiments to converge
  if (agentExps.length < consecutiveThreshold) {
    return { converged: false, reason: 'not enough experiments', nonImprovingStreak: 0 };
  }

  // Hit max experiments — converged by budget exhaustion
  if (agentExps.length >= config.maxExperimentsPerAgent) {
    return { converged: true, reason: 'max experiments reached', nonImprovingStreak: 0 };
  }

  // Check trailing experiments for non-improving streak
  let streak = 0;
  for (let i = agentExps.length - 1; i >= 0; i--) {
    if (agentExps[i].outcome !== 'improvement') {
      streak++;
    } else {
      break;
    }
  }

  if (streak >= consecutiveThreshold) {
    return {
      converged: true,
      reason: `${streak} consecutive non-improving experiments`,
      nonImprovingStreak: streak,
    };
  }

  return { converged: false, reason: 'still improving', nonImprovingStreak: streak };
}

/**
 * Check if the entire swarm has converged (all agents converged or hit max).
 */
export function isSwarmConverged(manager: SwarmStateManager): boolean {
  const config = manager.getConfig();
  for (let i = 0; i < config.agentCount; i++) {
    const result = checkConvergence(manager, i);
    if (!result.converged) return false;
  }
  return true;
}

/**
 * Get the current swarm status.
 */
export function getSwarmStatus(workspacePath: string): SwarmStatus {
  const manager = new SwarmStateManager(workspacePath);

  if (!manager.exists()) {
    return {
      running: false,
      config: null,
      baseline: null,
      bestMetric: null,
      bestExperimentId: null,
      totalExperiments: 0,
      frontierSize: 0,
      agentExperimentCounts: [],
      agentConvergence: [],
      swarmConverged: false,
    };
  }

  const snapshot = manager.getSnapshot();
  const agentCounts: number[] = [];
  const agentConvergence: ConvergenceResult[] = [];
  for (let i = 0; i < snapshot.config.agentCount; i++) {
    agentCounts.push(snapshot.experiments.filter(e => e.agentIndex === i).length);
    agentConvergence.push(checkConvergence(manager, i));
  }

  return {
    running: snapshot.config.status === 'running',
    config: snapshot.config,
    baseline: snapshot.baseline,
    bestMetric: snapshot.bestMetric,
    bestExperimentId: snapshot.bestExperimentId,
    totalExperiments: snapshot.experiments.length,
    frontierSize: snapshot.frontier.length,
    agentExperimentCounts: agentCounts,
    agentConvergence,
    swarmConverged: isSwarmConverged(manager),
  };
}

/**
 * Stop a running swarm.
 */
export function stopSwarm(workspacePath: string): void {
  const manager = new SwarmStateManager(workspacePath);
  if (!manager.exists()) {
    throw new Error('No swarm found at this workspace.');
  }
  manager.setStatus('stopped');
}

/**
 * Generate a swarm summary report.
 */
export function generateSwarmReport(workspacePath: string): string {
  const manager = new SwarmStateManager(workspacePath);
  if (!manager.exists()) return 'No swarm found.';

  const snapshot = manager.getSnapshot();
  const { config, baseline, bestMetric, bestExperimentId, experiments, frontier } = snapshot;

  const improvements = experiments.filter(e => e.outcome === 'improvement');
  const regressions = experiments.filter(e => e.outcome === 'regression');
  const errors = experiments.filter(e => e.outcome === 'error');

  const deltaStr = baseline !== null && bestMetric !== null
    ? `${config.higherIsBetter ? '+' : ''}${(bestMetric - baseline).toFixed(4)}`
    : 'N/A';

  const agentSummaries = config.directions.map((dir, i) => {
    const agentExps = experiments.filter(e => e.agentIndex === i);
    const agentImprovements = agentExps.filter(e => e.outcome === 'improvement').length;
    const agentErrors = agentExps.filter(e => e.outcome === 'error').length;
    const conv = checkConvergence(manager, i);
    const convLabel = conv.converged ? ` [CONVERGED: ${conv.reason}]` : '';
    const errorLabel = agentErrors > 0 ? `, ${agentErrors} errors` : '';
    return `  Agent ${i} (${dir.focus}): ${agentExps.length} experiments, ${agentImprovements} improvements${errorLabel}${convLabel}`;
  }).join('\n');

  return `
# Swarm Report — ${config.name}
**Status**: ${config.status}
**Created**: ${config.createdAt}
**Metric**: ${config.metric} (${config.higherIsBetter ? 'higher is better' : 'lower is better'})

## Results
- **Baseline**: ${baseline ?? 'N/A'}
- **Best**: ${bestMetric ?? 'N/A'} (Δ${deltaStr})
- **Best experiment**: ${bestExperimentId ?? 'none'}

## Experiment Summary
- Total: ${experiments.length}
- Improvements: ${improvements.length}
- Regressions: ${regressions.length}
- Errors: ${errors.length}

## Per-Agent
${agentSummaries}

## Remaining Frontier
${frontier.length} ideas remaining.
`.trim();
}
