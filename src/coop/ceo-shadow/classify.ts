/**
 * Classify CEO comment bodies into decision categories.
 *
 * Heuristic — meant to provide initial labels for the Shadow predictor's
 * few-shot training set. The downstream model can refine these. We bias
 * towards high-precision approve/reject/dispatch detection and bucket
 * the residual as "comment".
 *
 * Languages handled: English + Mandarin (CEO frequently codeswitches).
 */

import type { AgentRole, DecisionCategory } from './types.js';
import { AGENT_USER_IDS } from './users.js';

interface ClassifyResult {
  category: DecisionCategory;
  /** When category=='dispatch', the parsed target role (best effort). */
  dispatch_target?: AgentRole | null;
  /** Short reasoning excerpt from the comment, when interpretable. */
  reasoning_excerpt?: string | null;
}

const APPROVE_PATTERNS: RegExp[] = [
  /\b(approve|approved|approving|approval)\b/i,
  /\b(lgtm|ship\s*it|go\s*ahead|proceed|do\s*it|let'?s\s*do\s*it|sounds\s*good|looks\s*good)\b/i,
  /\b(yes,?\s*do|yes,?\s*go|yes,?\s*proceed|ok\s*go|ok\s*do)\b/i,
  /\b(green[\s-]?light|greenlit)\b/i,
  /(✅|👍|🚀)/,
  // Mandarin: \b doesn't apply to CJK — match raw substring.
  /(同意|批准|可以|去做|做吧|开始|赞成|通过|执行)/,
];

const REJECT_PATTERNS: RegExp[] = [
  /\b(reject|rejected|rejecting|rejection|denied|veto)\b/i,
  /\b(no,?\s*don'?t|don'?t\s*do|stop|cancel|kill\s*it|kill\s*this|abort)\b/i,
  /\b(not\s*now|not\s*yet|hold\s*off|park\s*this|defer|drop\s*this)\b/i,
  /\b(bad\s*idea|won'?t\s*do|nope)\b/i,
  /(❌|🛑|⛔)/,
  /(拒绝|不要|否决|搁置|取消|不做|停止|算了)/,
];

// Strong dispatch markers — explicit @role tags or imperative "do this" to an agent.
const DISPATCH_AT_PATTERN = /@([a-z][a-z\-]*)/gi;
const DISPATCH_VERBS = [
  /\b(dispatch|assign|hand\s*off|handoff|delegate|route|push\s*to)\b/i,
  /\b(派|分派|交给|让.{0,5}做)\b/,
];

const QUESTION_PATTERNS: RegExp[] = [
  /\?\s*$/,
  /^(why|what|how|when|where|who|which|is\s|are\s|can\s|could\s|should\s|do\s|does\s|did\s)/i,
  /(吗|呢)\?*\s*$/,
];

const ROLE_ALIASES: Record<string, AgentRole> = {
  cto: 'cto',
  cpo: 'cpo',
  coo: 'coo',
  ceo: 'ceo',
  ceooffice: 'ceo-office',
  'ceo-office': 'ceo-office',
  leadengineer: 'lead-engineer',
  'lead-engineer': 'lead-engineer',
  researchlead: 'research-lead',
  'research-lead': 'research-lead',
  qaengineer: 'qa-engineer',
  'qa-engineer': 'qa-engineer',
  engineer: 'engineer',
  ops: 'ops',
  strategist: 'strategist',
};

function snippet(s: string, n = 240): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function parseMentionTargets(body: string): AgentRole[] {
  const out = new Set<AgentRole>();
  for (const m of body.matchAll(DISPATCH_AT_PATTERN)) {
    const raw = m[1].toLowerCase();
    const role = ROLE_ALIASES[raw];
    if (role && role !== 'ceo') out.add(role);
  }
  return Array.from(out);
}

/**
 * Classify a CEO comment.
 *
 * Precedence: dispatch > approve > reject > question > comment.
 * Dispatch wins over approve when both signals are present (e.g.,
 * "@cto approve and ship" — the call-to-action *is* a dispatch).
 */
export function classifyCeoComment(body: string): ClassifyResult {
  const t = body.trim();
  if (!t) return { category: 'comment' };

  const mentions = parseMentionTargets(t);
  const hasDispatchVerb = DISPATCH_VERBS.some((r) => r.test(t));
  const hasMention = mentions.length > 0;

  const approve = APPROVE_PATTERNS.some((r) => r.test(t));
  const reject = REJECT_PATTERNS.some((r) => r.test(t));
  const question = QUESTION_PATTERNS.some((r) => r.test(t));

  // Dispatch — explicit verb OR @-mention with imperative tone.
  if (hasMention && (hasDispatchVerb || /^[\s@a-z\-]*[,，:：]?\s*(please|go|do|fix|build|ship|make|run)/i.test(t))) {
    return {
      category: 'dispatch',
      dispatch_target: mentions[0],
      reasoning_excerpt: snippet(t),
    };
  }

  // Plain @role with no clear approve/reject — treat as dispatch (CEO addressing an agent).
  // Even if the body is a question, the @-mention is the dispatch signal.
  if (hasMention && !approve && !reject) {
    return {
      category: 'dispatch',
      dispatch_target: mentions[0],
      reasoning_excerpt: snippet(t),
    };
  }

  if (approve && !reject) {
    return {
      category: 'approve',
      reasoning_excerpt: snippet(t),
    };
  }
  if (reject && !approve) {
    return {
      category: 'reject',
      reasoning_excerpt: snippet(t),
    };
  }
  if (approve && reject) {
    // Mixed — bias to whichever appears earlier.
    const aIdx = APPROVE_PATTERNS.map((r) => t.search(r)).filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    const rIdx = REJECT_PATTERNS.map((r) => t.search(r)).filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
    return {
      category: aIdx <= rIdx ? 'approve' : 'reject',
      reasoning_excerpt: snippet(t),
    };
  }

  return {
    category: 'comment',
    reasoning_excerpt: snippet(t),
  };
}

/** Public for tests. */
export const _internal = {
  APPROVE_PATTERNS,
  REJECT_PATTERNS,
  DISPATCH_VERBS,
  QUESTION_PATTERNS,
  parseMentionTargets,
};
