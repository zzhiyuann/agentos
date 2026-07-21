/** Smart routing: domain-aware dispatch replacing mechanical COO triage.
 *
 * Classifies issues by title + description keywords to route them to the
 * right agent without waking COO for every unassigned issue.
 */

import { listAgents } from './persona.js';

export type AgentRole = string;

export interface ClassificationResult {
  role: AgentRole;
  confidence: 'high' | 'medium' | 'low';
  matchedKeywords: string[];
}

/** Keyword sets per agent domain. Order within each set doesn't matter —
 *  we count total matches and pick the domain with the most hits. */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  cpo: [
    'product', 'ux', 'user experience', 'growth', 'content', 'landing page',
    'user', 'onboarding', 'funnel', 'retention', 'churn', 'pricing',
    'feature request', 'copy', 'branding', 'brand', 'marketing',
    'launch', 'positioning', 'persona', 'customer', 'feedback',
    'wireframe', 'mockup', 'design', 'navigation', 'accessibility',
    'conversion', 'engagement', 'analytics', 'a/b test', 'workshop',
    'education', 'curriculum', 'course', 'tutorial',
  ],
  coo: [
    'infrastructure', 'ops', 'deploy', 'deployment', 'monitor', 'monitoring',
    'server', 'cost', 'budget', 'incident', 'alert', 'uptime', 'downtime',
    'health check', 'log', 'logging', 'observability', 'ci/cd', 'pipeline',
    'backup', 'restore', 'scaling', 'performance', 'latency',
    'rate limit', 'rate-limit', 'quota', 'disk', 'memory usage',
    'cpu', 'process', 'daemon', 'cron', 'systemd', 'docker',
    'nginx', 'ssl', 'certificate', 'dns', 'domain',
    'triage', 'operational', 'sla', 'runbook',
  ],
  'research-lead': [
    'research', 'paper', 'literature', 'experiment', 'survey', 'study',
    'hypothesis', 'methodology', 'dataset', 'data collection',
    'statistical', 'analysis', 'findings', 'citation', 'bibliography',
    'arxiv', 'publication', 'peer review', 'pilot', 'calibration',
    'landscape scan', 'competitive analysis', 'benchmark',
    'semantic scholar', 'openalex', 'academic', 'journal',
    'autoresearch', 'swarm', 'exploration',
  ],
  cto: [
    'architecture', 'design', 'review', 'quality', 'security',
    'code review', 'tech debt', 'technical debt', 'refactor',
    'pattern', 'abstraction', 'system design',
    'api design', 'schema', 'migration', 'breaking change',
    'vulnerability', 'owasp', 'audit', 'compliance',
    'test strategy', 'qa', 'quality assurance',
    'evaluation', 'trade-off', 'tradeoff', 'rfc',
    'smart routing', 'routing', 'dispatch',
    'llm', 'language model', 'embedding', 'prompt engineering',
    'tokenizer', 'rag', 'retrieval',
  ],
  'lead-engineer': [
    'implement', 'implementation', 'bug', 'fix', 'feature',
    'refactor', 'test', 'tests', 'testing', 'unit test',
    'integration test', 'e2e', 'end-to-end',
    'build', 'compile', 'typescript', 'javascript',
    'function', 'method', 'class', 'module',
    'error', 'crash', 'exception', 'stack trace',
    'pr', 'pull request', 'merge', 'branch',
    'dependency', 'package', 'npm', 'vitest',
    'hotfix', 'patch', 'regression', 'debug', 'debugging',
    'sql', 'database', 'query', 'orm',
  ],
};

/** Words that signal a "[to decide]" issue — route to CEO Office, not an agent. */
const CEO_DECISION_MARKERS = [
  'to decide', '[to decide]', 'ceo decision', 'ceo review',
  'budget approval', 'hiring', 'strategic',
];

/**
 * Match `[proactive] {role}: …` and `[proactive] {role} …` title prefixes so
 * the proactive scheduler's intended target survives smart-router re-routing.
 * Returns the role string (e.g. "cto") on match, null otherwise.
 *
 * RYA-831: without this, proactive titles like "[proactive] cto: Strategic
 * exploration (…)" matched 'strategic' in CEO_DECISION_MARKERS and got
 * re-routed to ceo-office, causing identity confusion (RYA-824 case).
 */
const PROACTIVE_ROLE_REGEX = /^\s*\[proactive\]\s+([a-z][a-z0-9-]*)\s*[:\s]/i;
export function extractProactiveRole(title: string): string | null {
  const m = PROACTIVE_ROLE_REGEX.exec(title);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Classify an issue's domain based on its title and description.
 * Returns the best-matching agent role with confidence level.
 *
 * Confidence levels:
 * - high: 3+ keyword matches OR strong title-only signal
 * - medium: 1-2 keyword matches
 * - low: no matches (ambiguous — should go to COO for human triage)
 */
export function classifyDomain(title: string, description?: string): ClassificationResult {
  // Proactive issues encode their target role in the title prefix. Honor that
  // first — before CEO_DECISION_MARKERS or keyword scoring — so words like
  // "strategic" or "exploration" in a proactive prompt don't redirect the
  // session to the wrong agent (RYA-831).
  const proactiveRole = extractProactiveRole(title);
  if (proactiveRole) {
    const existingAgents = new Set(listAgents());
    if (existingAgents.has(proactiveRole)) {
      return { role: proactiveRole, confidence: 'high', matchedKeywords: ['[proactive]'] };
    }
  }

  const text = `${title} ${description || ''}`.toLowerCase();

  // CEO decision issues bypass agent routing entirely
  for (const marker of CEO_DECISION_MARKERS) {
    if (text.includes(marker)) {
      return { role: 'ceo-office', confidence: 'high', matchedKeywords: [marker] };
    }
  }

  // Score each domain by keyword matches
  const scores: Record<string, { count: number; matched: string[] }> = {};

  for (const [role, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    scores[role] = { count: 0, matched: [] };

    for (const kw of keywords) {
      // Simple substring matching — multi-word keywords provide natural disambiguation
      if (text.includes(kw)) {
        scores[role].count++;
        scores[role].matched.push(kw);
      }
    }
  }

  // Find the domain with the highest score
  let bestRole = '';
  let bestScore = 0;
  let secondBestScore = 0;

  for (const [role, { count }] of Object.entries(scores)) {
    if (count > bestScore) {
      secondBestScore = bestScore;
      bestScore = count;
      bestRole = role;
    } else if (count > secondBestScore) {
      secondBestScore = count;
    }
  }

  // No matches at all — ambiguous
  if (bestScore === 0) {
    return { role: 'coo', confidence: 'low', matchedKeywords: [] };
  }

  // If top two scores are tied or very close (within 1), confidence is reduced
  const margin = bestScore - secondBestScore;

  // Only route to agents that actually exist
  const existingAgents = new Set(listAgents());
  if (!existingAgents.has(bestRole)) {
    return { role: 'coo', confidence: 'low', matchedKeywords: scores[bestRole]?.matched || [] };
  }

  let confidence: 'high' | 'medium' | 'low';
  if (bestScore >= 3 && margin >= 2) {
    confidence = 'high';
  } else if (bestScore >= 1 && margin >= 1) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    role: bestRole,
    confidence,
    matchedKeywords: scores[bestRole].matched,
  };
}

/**
 * Determine if smart routing should directly dispatch or defer to COO.
 * Only routes with 'high' or 'medium' confidence are auto-dispatched.
 * 'low' confidence issues go to COO for human judgment.
 */
export function shouldAutoRoute(result: ClassificationResult): boolean {
  return result.confidence === 'high' || result.confidence === 'medium';
}
