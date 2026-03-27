/**
 * Swarm Memory — Extracts findings from completed swarms and writes to agent memory.
 *
 * When a swarm completes, this module:
 * 1. Extracts structured findings (best config, failed approaches, trajectory)
 * 2. Optionally uses LLM to generate a narrative summary
 * 3. Writes a memory file to the relevant agent's memory directory
 * 4. Updates the agent's MEMORY.md index
 *
 * This bridges the gap between ephemeral .swarm/ data and persistent agent knowledge.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { SwarmStateManager, type SwarmSnapshot, type Experiment, type SwarmConfig } from './swarm-state.js';
import { getSwarmStatus, generateSwarmReport, checkConvergence } from './swarm-coordinator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SwarmFindings {
  /** Swarm identification */
  swarmName: string;
  swarmId: string;
  completedAt: string;

  /** Performance trajectory */
  metric: string;
  higherIsBetter: boolean;
  baseline: number | null;
  bestMetric: number | null;
  bestDelta: number | null;
  totalExperiments: number;
  improvements: number;
  regressions: number;
  errors: number;

  /** Best configuration found */
  bestExperiment: {
    id: string;
    hypothesis: string;
    changes: string[];
    metricValue: number;
    commitHash?: string;
  } | null;

  /** Top improvements (up to 5) */
  topImprovements: {
    id: string;
    hypothesis: string;
    metricValue: number | null;
    delta: number | null;
  }[];

  /** Failed approaches — negative results are knowledge too */
  failedApproaches: {
    id: string;
    hypothesis: string;
    outcome: string;
    metricValue: number | null;
    delta: number | null;
  }[];

  /** Surprising findings — unexpected outcomes */
  surprises: {
    id: string;
    hypothesis: string;
    why: string;
    metricValue: number | null;
    delta: number | null;
  }[];

  /** Per-agent summary */
  agentSummaries: {
    index: number;
    focus: string;
    experiments: number;
    improvements: number;
    converged: boolean;
    convergenceReason: string;
  }[];
}

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract structured findings from a swarm snapshot.
 * Pure function — no I/O, no LLM calls.
 */
export function extractSwarmFindings(snapshot: SwarmSnapshot): SwarmFindings {
  const { config, baseline, bestMetric, bestExperimentId, experiments } = snapshot;

  const improvements = experiments.filter(e => e.outcome === 'improvement');
  const regressions = experiments.filter(e => e.outcome === 'regression');
  const errors = experiments.filter(e => e.outcome === 'error');

  // Find the best experiment
  let bestExperiment: SwarmFindings['bestExperiment'] = null;
  if (bestExperimentId) {
    const exp = experiments.find(e => e.id === bestExperimentId);
    if (exp && exp.metricValue !== null) {
      bestExperiment = {
        id: exp.id,
        hypothesis: exp.hypothesis,
        changes: exp.changes,
        metricValue: exp.metricValue,
        commitHash: exp.commitHash,
      };
    }
  }

  // Top improvements sorted by delta magnitude
  const topImprovements = improvements
    .filter(e => e.metricValue !== null)
    .sort((a, b) => {
      const aDelta = Math.abs(a.delta ?? 0);
      const bDelta = Math.abs(b.delta ?? 0);
      return bDelta - aDelta;
    })
    .slice(0, 5)
    .map(e => ({
      id: e.id,
      hypothesis: e.hypothesis,
      metricValue: e.metricValue,
      delta: e.delta,
    }));

  // Failed approaches — regressions and errors, deduped by hypothesis similarity
  const failedApproaches = [...regressions, ...errors]
    .slice(0, 10)
    .map(e => ({
      id: e.id,
      hypothesis: e.hypothesis,
      outcome: e.outcome,
      metricValue: e.metricValue,
      delta: e.delta,
    }));

  // Surprising findings — large unexpected deltas (improvements with big jump, or expected improvements that regressed)
  const surprises = detectSurprises(experiments, config);

  // Per-agent summaries
  const agentSummaries = config.directions.map((dir, i) => {
    const agentExps = experiments.filter(e => e.agentIndex === i);
    const agentImprovements = agentExps.filter(e => e.outcome === 'improvement').length;
    // Use a simple convergence check (3 consecutive non-improving)
    const streak = countTrailingNonImproving(agentExps);
    const converged = streak >= 3 || agentExps.length >= config.maxExperimentsPerAgent;
    const reason = agentExps.length >= config.maxExperimentsPerAgent
      ? 'max experiments reached'
      : streak >= 3
        ? `${streak} consecutive non-improving`
        : 'still active';

    return {
      index: i,
      focus: dir.focus,
      experiments: agentExps.length,
      improvements: agentImprovements,
      converged,
      convergenceReason: reason,
    };
  });

  const bestDelta = (baseline !== null && bestMetric !== null)
    ? bestMetric - baseline
    : null;

  return {
    swarmName: config.name,
    swarmId: config.id,
    completedAt: new Date().toISOString(),
    metric: config.metric,
    higherIsBetter: config.higherIsBetter,
    baseline,
    bestMetric,
    bestDelta,
    totalExperiments: experiments.length,
    improvements: improvements.length,
    regressions: regressions.length,
    errors: errors.length,
    bestExperiment,
    topImprovements,
    failedApproaches,
    surprises,
    agentSummaries,
  };
}

/**
 * Detect surprising experimental results.
 * Surprising = large delta (top quartile) in either direction,
 * or errors on seemingly simple changes.
 */
function detectSurprises(experiments: Experiment[], config: SwarmConfig): SwarmFindings['surprises'] {
  const withDelta = experiments.filter(e => e.delta !== null && e.metricValue !== null);
  if (withDelta.length < 4) return [];

  const deltas = withDelta.map(e => Math.abs(e.delta!));
  deltas.sort((a, b) => a - b);
  const q3 = deltas[Math.floor(deltas.length * 0.75)];

  const surprises: SwarmFindings['surprises'] = [];

  for (const exp of withDelta) {
    const absDelta = Math.abs(exp.delta!);
    if (absDelta < q3) continue;

    let why: string;
    if (exp.outcome === 'improvement' && absDelta > q3 * 1.5) {
      why = `Unexpectedly large improvement (Δ${formatDelta(exp.delta!)})`;
    } else if (exp.outcome === 'regression' && absDelta > q3 * 1.5) {
      why = `Unexpectedly large regression (Δ${formatDelta(exp.delta!)})`;
    } else {
      continue;
    }

    surprises.push({
      id: exp.id,
      hypothesis: exp.hypothesis,
      why,
      metricValue: exp.metricValue,
      delta: exp.delta,
    });
  }

  return surprises.slice(0, 5);
}

function countTrailingNonImproving(experiments: Experiment[]): number {
  let streak = 0;
  for (let i = experiments.length - 1; i >= 0; i--) {
    if (experiments[i].outcome !== 'improvement') {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function formatDelta(delta: number): string {
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`;
}

// ─── LLM Summarization ─────────────────────────────────────────────────────

/**
 * Use Claude CLI to generate a narrative summary of the swarm findings.
 * Falls back to a structured summary if the CLI is unavailable.
 */
export function summarizeWithLLM(findings: SwarmFindings, experimentLog: string): string {
  const prompt = buildSummarizationPrompt(findings, experimentLog);

  try {
    const result = execSync(
      `claude -p --output-format text`,
      {
        input: prompt,
        encoding: 'utf-8',
        timeout: 60_000, // 1 min timeout
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DISABLE_PROMPT_CACHING: '1' },
      }
    ).trim();

    // Validate we got something meaningful
    if (result.length < 50) {
      return buildFallbackSummary(findings);
    }

    return result;
  } catch {
    // Claude CLI unavailable or failed — use fallback
    return buildFallbackSummary(findings);
  }
}

function buildSummarizationPrompt(findings: SwarmFindings, experimentLog: string): string {
  // Truncate log if too long
  const truncatedLog = experimentLog.length > 8000
    ? experimentLog.substring(0, 8000) + '\n\n... (truncated)'
    : experimentLog;

  return `You are analyzing the results of a completed multi-agent research swarm. Produce a concise summary (3-5 paragraphs) that captures the key insights for future reference.

## Swarm: ${findings.swarmName}
- Metric: ${findings.metric} (${findings.higherIsBetter ? 'higher is better' : 'lower is better'})
- Baseline: ${findings.baseline ?? 'N/A'}
- Best result: ${findings.bestMetric ?? 'N/A'} (Δ${findings.bestDelta !== null ? formatDelta(findings.bestDelta) : 'N/A'})
- Experiments: ${findings.totalExperiments} total (${findings.improvements} improvements, ${findings.regressions} regressions, ${findings.errors} errors)

## Best Configuration
${findings.bestExperiment ? `- Experiment: ${findings.bestExperiment.id}\n- Hypothesis: ${findings.bestExperiment.hypothesis}\n- Changes: ${findings.bestExperiment.changes.join(', ')}` : 'No improvements found.'}

## Top Improvements
${findings.topImprovements.map(i => `- ${i.hypothesis} (Δ${i.delta !== null ? formatDelta(i.delta) : 'N/A'})`).join('\n') || 'None'}

## Failed Approaches
${findings.failedApproaches.map(f => `- ${f.hypothesis}: ${f.outcome} (Δ${f.delta !== null ? formatDelta(f.delta) : 'N/A'})`).join('\n') || 'None'}

## Surprises
${findings.surprises.map(s => `- ${s.hypothesis}: ${s.why}`).join('\n') || 'None detected'}

## Experiment Log
${truncatedLog}

---

Write a concise summary covering:
1. What optimization strategy worked best and why
2. What approaches failed and what pattern emerges from the failures
3. Any surprising results and what they suggest
4. Actionable recommendations for future swarm runs on this metric

Keep it factual and specific. Reference experiment IDs where relevant. No preamble — start directly with the analysis.`;
}

function buildFallbackSummary(findings: SwarmFindings): string {
  const parts: string[] = [];

  if (findings.bestExperiment) {
    parts.push(
      `The best result came from ${findings.bestExperiment.id}: "${findings.bestExperiment.hypothesis}" ` +
      `achieving ${findings.metric}=${findings.bestExperiment.metricValue}` +
      (findings.bestDelta !== null ? ` (Δ${formatDelta(findings.bestDelta)} from baseline)` : '') + '.'
    );
  } else {
    parts.push(`No improvements were found across ${findings.totalExperiments} experiments.`);
  }

  if (findings.improvements > 0) {
    parts.push(
      `${findings.improvements} of ${findings.totalExperiments} experiments showed improvement ` +
      `(${((findings.improvements / findings.totalExperiments) * 100).toFixed(0)}% success rate).`
    );
  }

  if (findings.failedApproaches.length > 0) {
    const topFails = findings.failedApproaches.slice(0, 3);
    parts.push(
      `Notable failed approaches: ${topFails.map(f => `"${f.hypothesis}" (${f.outcome})`).join(', ')}.`
    );
  }

  if (findings.surprises.length > 0) {
    parts.push(
      `Surprising findings: ${findings.surprises.map(s => s.why).join('; ')}.`
    );
  }

  return parts.join(' ');
}

// ─── Memory Writing ─────────────────────────────────────────────────────────

/**
 * Generate the memory file content from findings and optional LLM summary.
 */
export function generateMemoryContent(findings: SwarmFindings, llmSummary: string): string {
  const slug = findings.swarmName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const date = findings.completedAt.split('T')[0];
  const metricSummary = findings.bestMetric !== null
    ? `${findings.metric} ${findings.baseline ?? '?'} → ${findings.bestMetric}`
    : `${findings.metric} — no improvement`;

  const parts: string[] = [];

  parts.push(`---
name: swarm-${slug}-results
description: Research swarm "${findings.swarmName}" — ${metricSummary}. ${findings.totalExperiments} experiments, ${findings.improvements} improvements.
type: project
---

## ${date} Swarm: ${findings.swarmName}

### Overview
- **Metric**: ${findings.metric} (${findings.higherIsBetter ? 'higher is better' : 'lower is better'})
- **Baseline**: ${findings.baseline ?? 'N/A'}
- **Best**: ${findings.bestMetric ?? 'N/A'}${findings.bestDelta !== null ? ` (Δ${formatDelta(findings.bestDelta)})` : ''}
- **Experiments**: ${findings.totalExperiments} total — ${findings.improvements} improvements, ${findings.regressions} regressions, ${findings.errors} errors
- **Swarm ID**: ${findings.swarmId}`);

  // Best configuration
  if (findings.bestExperiment) {
    parts.push(`
### Best Configuration Found
- **Experiment**: ${findings.bestExperiment.id}
- **Hypothesis**: ${findings.bestExperiment.hypothesis}
- **Result**: ${findings.metric} = ${findings.bestExperiment.metricValue}
- **Changes**: ${findings.bestExperiment.changes.join(', ') || 'N/A'}${findings.bestExperiment.commitHash ? `\n- **Commit**: ${findings.bestExperiment.commitHash}` : ''}`);
  }

  // Top improvements
  if (findings.topImprovements.length > 0) {
    const lines = findings.topImprovements.map(i =>
      `- **${i.id}**: ${i.hypothesis} — ${findings.metric}=${i.metricValue ?? 'N/A'} (Δ${i.delta !== null ? formatDelta(i.delta) : 'N/A'})`
    );
    parts.push(`
### Top Improvements
${lines.join('\n')}`);
  }

  // Failed approaches
  if (findings.failedApproaches.length > 0) {
    const lines = findings.failedApproaches.map(f =>
      `- **${f.id}** (${f.outcome}): ${f.hypothesis}${f.delta !== null ? ` — Δ${formatDelta(f.delta)}` : ''}`
    );
    parts.push(`
### Failed Approaches (negative results)
${lines.join('\n')}`);
  }

  // Surprises
  if (findings.surprises.length > 0) {
    const lines = findings.surprises.map(s =>
      `- **${s.id}**: ${s.hypothesis} — ${s.why}`
    );
    parts.push(`
### Surprising Findings
${lines.join('\n')}`);
  }

  // Per-agent breakdown
  if (findings.agentSummaries.length > 0) {
    const lines = findings.agentSummaries.map(a =>
      `- **Agent ${a.index}** (${a.focus}): ${a.experiments} experiments, ${a.improvements} improvements` +
      (a.converged ? ` [${a.convergenceReason}]` : '')
    );
    parts.push(`
### Per-Agent Performance
${lines.join('\n')}`);
  }

  // LLM summary
  if (llmSummary) {
    parts.push(`
### Analysis
${llmSummary}`);
  }

  return parts.join('\n');
}

/**
 * Write swarm findings to an agent's memory directory and update the index.
 * Returns the path to the written memory file.
 */
export function writeToAgentMemory(
  agentRole: string,
  findings: SwarmFindings,
  memoryContent: string,
): string {
  const agentsDir = join(process.env.HOME || '/tmp', '.aos', 'agents');
  const memoryDir = join(agentsDir, agentRole, 'memory');
  const indexPath = join(agentsDir, agentRole, 'MEMORY.md');

  // Ensure memory directory exists
  mkdirSync(memoryDir, { recursive: true });

  // Generate filename from swarm name
  const slug = findings.swarmName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const filename = `swarm-${slug}-results.md`;
  const filepath = join(memoryDir, filename);

  // Write memory file
  writeFileSync(filepath, memoryContent);

  // Update MEMORY.md index
  updateMemoryIndex(indexPath, filename, findings);

  return filepath;
}

/**
 * Append a pointer to the new memory file in MEMORY.md.
 * Idempotent — won't add duplicate entries.
 */
function updateMemoryIndex(indexPath: string, filename: string, findings: SwarmFindings): void {
  const slug = findings.swarmName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
  const memoryName = `swarm-${slug}-results`;
  const metricSummary = findings.bestMetric !== null
    ? `${findings.metric} ${findings.baseline ?? '?'} → ${findings.bestMetric}`
    : `no improvement`;
  const indexLine = `- \`memory/${filename}\` — Swarm "${findings.swarmName}": ${metricSummary}, ${findings.totalExperiments} experiments`;

  // Read existing index
  let existing = '';
  if (existsSync(indexPath)) {
    existing = readFileSync(indexPath, 'utf-8');
  }

  // Check for duplicate (by memory name)
  if (existing.includes(memoryName)) {
    // Update existing line instead of appending
    const lines = existing.split('\n');
    const updated = lines.map(line =>
      line.includes(memoryName) ? indexLine : line
    ).join('\n');
    writeFileSync(indexPath, updated);
    return;
  }

  // Append new entry
  const separator = existing.endsWith('\n') ? '' : '\n';
  appendFileSync(indexPath, `${separator}${indexLine}\n`);
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface WriteSwarmMemoryOptions {
  /** Workspace path containing .swarm/ directory */
  workspacePath: string;
  /** Agent role to write memory to (e.g., 'lead-engineer', 'cto') */
  agentRole: string;
  /** Skip LLM summarization (faster, less insightful) */
  skipLLM?: boolean;
}

/**
 * Main entry point — extract findings from a completed swarm and write to agent memory.
 * Returns the path to the written memory file, or null if extraction failed.
 */
export function writeSwarmMemory(opts: WriteSwarmMemoryOptions): string | null {
  const { workspacePath, agentRole, skipLLM } = opts;

  const manager = new SwarmStateManager(workspacePath);
  if (!manager.exists()) {
    console.log(`[swarm-memory] No swarm found at ${workspacePath}`);
    return null;
  }

  const snapshot = manager.getSnapshot();
  if (snapshot.experiments.length === 0) {
    console.log('[swarm-memory] No experiments to extract — skipping memory write');
    return null;
  }

  // 1. Extract structured findings
  const findings = extractSwarmFindings(snapshot);

  // 2. LLM summarization (optional)
  let llmSummary = '';
  if (!skipLLM) {
    try {
      const logPath = join(workspacePath, '.swarm', 'experiment-log.md');
      const experimentLog = existsSync(logPath)
        ? readFileSync(logPath, 'utf-8')
        : '';
      llmSummary = summarizeWithLLM(findings, experimentLog);
    } catch (err) {
      console.log(`[swarm-memory] LLM summary failed: ${(err as Error).message}`);
    }
  }

  // 3. Generate memory content
  const memoryContent = generateMemoryContent(findings, llmSummary);

  // 4. Write to agent memory
  const filepath = writeToAgentMemory(agentRole, findings, memoryContent);
  console.log(`[swarm-memory] Written findings to ${filepath}`);

  return filepath;
}
