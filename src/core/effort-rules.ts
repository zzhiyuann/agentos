/**
 * A4.4 / RYA-1298: Effort-scaled dispatch rules with intelligent auto-routing.
 *
 * ~/.aos/effort-rules.json maps issues to Claude model tiers:
 *
 *   {
 *     "rules": [
 *       { "match": { "labels": ["chore"], "priorityAtLeast": 4 },
 *         "model": "claude-sonnet-4-6" }
 *     ],
 *     "auto": true   // signal-based auto-classification when no rule matches
 *   }
 *
 * Resolution order:
 *   1. Explicit rules (first matching rule wins — human rules always take priority)
 *   2. Signal-based auto-classification (when auto !== false)
 *      Signals: priority, labels, title keywords, description length → score → tier
 *   3. Config "default" (when auto is disabled)
 *   4. null → inherit the adapter's default model
 *
 * Matching semantics (explicit rules):
 *   - labels: ANY overlap with the issue's labels (case-insensitive)
 *   - priorityAtLeast: issue.priority >= N. Linear priorities are
 *     1=urgent..4=low, so "at least 4" means priority VALUE >= 4, i.e. low.
 *     Priority 0 ("no priority") never satisfies priorityAtLeast.
 *   - All criteria present in a rule's match must hold (AND).
 *   - First matching rule wins.
 *
 * Missing/invalid file → no rules (resolve always returns { model: null }).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from './config.js';

// ---------------------------------------------------------------------------
// Model tier constants
// ---------------------------------------------------------------------------

export const MODEL_FABLE = 'claude-fable-5';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface EffortRuleMatch {
  /** Case-insensitive label names; rule matches when ANY overlaps. */
  labels?: string[];
  /** Matches when issue.priority >= N (Linear: 1=urgent..4=low; 0 never matches). */
  priorityAtLeast?: number;
}

export interface EffortRule {
  match: EffortRuleMatch;
  /** Claude model id to pass to the runner (e.g. claude-sonnet-4-6). */
  model: string;
}

export interface EffortRules {
  rules: EffortRule[];
  /** Fallback model when no rule matches AND auto is disabled (null = inherit adapter default). */
  default: string | null;
  /**
   * Enable signal-based auto-classification when no explicit rule matches.
   * Default: true (omit or set true to enable; set false for legacy default-only behavior).
   */
  auto?: boolean;
  /**
   * When true, use a Haiku LLM call for ambiguous signal cases (score in [-1, 1]).
   * On failure → fable-5 (宁贵勿错). Default: false (adds latency; use resolveEffortRuleAsync).
   */
  autoLLM?: boolean;
}

export interface EffortIssue {
  labels?: string[];
  priority?: number;
  /** Used by signal-based classifier for keyword and length analysis. */
  title?: string;
  /** Used by signal-based classifier for length analysis. */
  description?: string;
}

export interface EffortResolution {
  model: string | null;
  /** Human-readable explanation of why this model was selected (for dispatch logging). */
  reason: string;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function effortRulesPath(): string {
  return join(STATE_DIR, 'effort-rules.json');
}

/**
 * Load ~/.aos/effort-rules.json. Missing file → null (no rules). Malformed
 * file → null too (a broken config must never block dispatch).
 */
export function loadEffortRules(path: string = effortRulesPath()): EffortRules | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EffortRules>;
    const rules = Array.isArray(parsed.rules)
      ? parsed.rules.filter((r): r is EffortRule =>
          !!r && typeof r === 'object' &&
          !!r.match && typeof r.match === 'object' &&
          typeof r.model === 'string' && r.model.length > 0)
      : [];
    return {
      rules,
      default: typeof parsed.default === 'string' && parsed.default ? parsed.default : null,
      auto: parsed.auto !== false, // default true
      autoLLM: parsed.autoLLM === true, // default false
    };
  } catch (err: unknown) {
    console.debug('[effort-rules] load failed:', (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Explicit rule matching
// ---------------------------------------------------------------------------

/** Does `rule.match` accept this issue? All present criteria must hold (AND). */
export function ruleMatches(match: EffortRuleMatch, issue: EffortIssue): boolean {
  if (match.labels && match.labels.length > 0) {
    const issueLabels = new Set((issue.labels || []).map(l => l.toLowerCase()));
    const anyOverlap = match.labels.some(l => issueLabels.has(l.toLowerCase()));
    if (!anyOverlap) return false;
  }
  if (match.priorityAtLeast !== undefined) {
    const p = issue.priority;
    // Linear: 0 = "no priority" — never treat it as low-effort
    if (p === undefined || p === null || p === 0 || p < match.priorityAtLeast) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Signal-based auto-classification
// ---------------------------------------------------------------------------

// Labels that indicate complex / high-stakes work → push score up
const FABLE_LABELS = new Set([
  'research', 'architecture', 'security', 'epic', 'milestone',
  'performance', 'breaking', 'critical', 'compliance',
]);

// Labels that indicate routine / low-stakes work → push score down
const HAIKU_LABELS = new Set([
  'typo', 'cleanup', 'chore', 'docs', 'maint', 'trivial', 'minor', 'bump',
]);

// Title keyword patterns
const FABLE_TITLE_RE = /\b(implement|design|architect(?:ure)?|migrate|migration|security|audit|research|overhaul|rethink|rebuild|rewrite|refactor)\b/i;
const HAIKU_TITLE_RE = /\b(typo|minor|chore|cleanup|clean-?up|bump|rename|nit)\b/i;

export interface SignalClassification {
  model: string;
  score: number;
  reason: string;
}

/**
 * Classify task complexity from issue signals — synchronous, no LLM.
 *
 * Scoring:
 *   score >= 2  → fable-5   (complex / high-stakes)
 *   score in [-1, 1] → sonnet-4-6 (standard)
 *   score <= -2 → haiku     (trivial)
 */
export function classifyBySignals(issue: EffortIssue): SignalClassification {
  let score = 0;
  const factors: string[] = [];

  // Priority signal
  const p = issue.priority;
  if (p === 1) {
    score += 3; factors.push('priority:urgent(+3)');
  } else if (p === 2) {
    score += 1; factors.push('priority:high(+1)');
  } else if (p === 4) {
    score -= 2; factors.push('priority:low(-2)');
  }
  // p=0 (no priority) and p=3 (medium) → no change

  // Label signals
  const issueLabels = new Set((issue.labels || []).map(l => l.toLowerCase()));
  for (const l of issueLabels) {
    if (FABLE_LABELS.has(l)) {
      score += 2; factors.push(`label:${l}(+2)`);
    } else if (HAIKU_LABELS.has(l)) {
      score -= 1; factors.push(`label:${l}(-1)`);
    }
  }

  // Title keyword signals
  const title = issue.title || '';
  if (FABLE_TITLE_RE.test(title)) {
    score += 1; factors.push('title:complex(+1)');
  } else if (HAIKU_TITLE_RE.test(title)) {
    score -= 1; factors.push('title:trivial(-1)');
  }

  // Description length signal
  const descLen = (issue.description || '').length;
  if (descLen > 1000) {
    score += 2; factors.push(`desc:${descLen}chars(+2)`);
  } else if (descLen > 300) {
    score += 1; factors.push(`desc:${descLen}chars(+1)`);
  }

  // Map score to model tier
  let model: string;
  if (score >= 2) {
    model = MODEL_FABLE;
  } else if (score <= -2) {
    model = MODEL_HAIKU;
  } else {
    model = MODEL_SONNET;
  }

  const reason = factors.length > 0
    ? `auto[score=${score}]: ${factors.join(', ')}`
    : `auto[score=0]: no signals → sonnet`;

  return { model, score, reason };
}

// ---------------------------------------------------------------------------
// LLM-based classifier (optional, async)
// ---------------------------------------------------------------------------

/** Read Anthropic API key — mirrors task-enrichment.ts pattern. */
function getAnthropicApiKey(): string | null {
  const keyFile = join(STATE_DIR, '.anthropic-key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf-8').trim();
  return process.env.ANTHROPIC_API_KEY || null;
}

/**
 * Use Haiku to classify task complexity for ambiguous cases.
 * Returns one of "haiku" | "sonnet" | "fable" with a short reason.
 * Throws on any failure — caller must catch and default to fable-5.
 */
export async function classifyByLLM(
  issue: EffortIssue,
): Promise<{ model: string; reason: string }> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new Error('No Anthropic API key');

  const prompt = `You are a task complexity classifier for an AI software company.
Given a task, classify it as ONE of three tiers:
- "haiku": trivial (typos, minor renames, doc fixes, config bumps)
- "sonnet": standard (typical features, bug fixes, moderate refactors)
- "fable": complex (architecture decisions, security work, large migrations, novel systems)

Task title: ${issue.title || '(none)'}
Task description: ${issue.description ? issue.description.slice(0, 500) : '(none)'}
Priority: ${issue.priority ?? 'unset'} (1=urgent, 2=high, 3=medium, 4=low)
Labels: ${(issue.labels || []).join(', ') || 'none'}

Respond with ONLY valid JSON: {"tier": "haiku"|"sonnet"|"fable", "reason": "one sentence"}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        max_tokens: 64,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Haiku API ${response.status}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error('Empty LLM response');

  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim()) as {
    tier: string;
    reason: string;
  };

  const tierMap: Record<string, string> = {
    haiku: MODEL_HAIKU,
    sonnet: MODEL_SONNET,
    fable: MODEL_FABLE,
  };
  const model = tierMap[parsed.tier];
  if (!model) throw new Error(`Unknown tier: ${parsed.tier}`);

  return { model, reason: parsed.reason || parsed.tier };
}

// ---------------------------------------------------------------------------
// Resolution entry points
// ---------------------------------------------------------------------------

/**
 * Resolve the effort model for an issue (synchronous).
 *
 * Resolution order:
 *   1. First matching explicit rule
 *   2. Signal-based auto-classification (when auto !== false)
 *   3. Config default (when auto is disabled)
 *   4. null (inherit adapter default)
 *
 * Returns { model, reason } — reason is logged by dispatch for cost auditing.
 */
export function resolveEffortRule(
  issue: EffortIssue,
  rules: EffortRules | null = loadEffortRules(),
): EffortResolution {
  if (!rules) return { model: null, reason: 'no-config' };

  // 1. Explicit rules — human override always wins
  for (const rule of rules.rules) {
    if (ruleMatches(rule.match, issue)) {
      return { model: rule.model, reason: `explicit-rule:${JSON.stringify(rule.match)}` };
    }
  }

  // 2. Signal-based auto-classification
  const autoEnabled = rules.auto !== false; // true when unset
  if (autoEnabled) {
    const { model, reason } = classifyBySignals(issue);
    return { model, reason };
  }

  // 3. Config default (legacy / auto disabled)
  return { model: rules.default, reason: 'config-default' };
}

/**
 * Resolve the effort model for an issue (async — may call Haiku LLM).
 *
 * Same as resolveEffortRule() but additionally uses the Haiku LLM when
 * `autoLLM: true` is configured AND signal-based score is ambiguous.
 * On any LLM failure → fable-5 (宁贵勿错).
 */
export async function resolveEffortRuleAsync(
  issue: EffortIssue,
  rules: EffortRules | null = loadEffortRules(),
): Promise<EffortResolution> {
  // Sync path first (handles explicit rules + unambiguous signal cases)
  const sync = resolveEffortRule(issue, rules);

  // LLM path: only when autoLLM is enabled and score was ambiguous
  if (rules?.autoLLM && sync.reason.startsWith('auto[')) {
    const scoreMatch = sync.reason.match(/score=(-?\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;
    const isAmbiguous = score !== null && score >= -1 && score <= 1;

    if (isAmbiguous) {
      try {
        const llm = await classifyByLLM(issue);
        return { model: llm.model, reason: `llm: ${llm.reason}` };
      } catch (err) {
        // Fail-safe: fable-5 is never wrong (宁贵勿错)
        return { model: MODEL_FABLE, reason: `llm-failed→fable: ${(err as Error).message}` };
      }
    }
  }

  return sync;
}
