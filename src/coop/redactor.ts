/**
 * Redactor interface and stub implementations.
 *
 * IMPORTANT: This file defines the CONTRACT only. The real implementation
 * lives in RYA-623 (`src/redact/` — expected). When that lands, replace
 * `defaultRedactor()` so it imports and returns the real module.
 *
 * The contract is intentionally narrow: one function, `redact(s, ctx)`,
 * returns redacted text + a count of how many substitutions happened.
 * Collectors MUST call this for every string field that hits the site.
 *
 * Until RYA-623 ships, `StubRedactor` applies a conservative regex pass
 * so the scaffold produces plausible output. `NoOpRedactor` passes text
 * through unchanged — useful only for fixture tests that assert structure.
 * `StrictRedactor` throws on any match — used by the integration test to
 * prove the pipeline does not leak known-sensitive patterns.
 */

export interface RedactContext {
  /** Logical source, e.g. 'linear', 'retros', 'git'. */
  source: string;
  /** Optional field name, e.g. 'title', 'body', 'comment'. */
  field?: string;
}

export interface RedactResult {
  text: string;
  /** Number of substitutions applied. */
  redactions: number;
  /** Which rules triggered (for audit / strict-mode error messages). */
  matchedRules: string[];
}

export interface Redactor {
  redact(input: string, ctx: RedactContext): RedactResult;
}

// --- Conservative regex rules (shared by Stub + Strict). ---
//
// These are a deliberately short list. The real redactor from RYA-623
// will maintain the canonical ruleset. This stub exists so the pipeline
// produces reasonable output until then.

interface Rule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  // Email addresses
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  // Absolute macOS paths that leak /Users/<name>/
  {
    name: 'home-path',
    pattern: /\/Users\/[A-Za-z0-9._-]+/g,
    replacement: '/Users/[REDACTED]',
  },
  // OAuth / bearer / api key markers
  {
    name: 'bearer-token',
    pattern: /\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  // GitHub PAT style (ghp_, gho_, ghu_, ghs_)
  {
    name: 'github-pat',
    pattern: /\bgh[posu]_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  // IP addresses (v4)
  {
    name: 'ipv4',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '[REDACTED_IP]',
  },
  // Known-internal host suffixes — extend in RYA-623
  {
    name: 'internal-host',
    pattern: /\b[a-z0-9.-]+\.internal\b/g,
    replacement: '[REDACTED_HOST]',
  },
];

function applyRules(input: string): RedactResult {
  let text = input;
  let redactions = 0;
  const matchedRules: string[] = [];
  for (const rule of RULES) {
    const before = text;
    text = text.replace(rule.pattern, rule.replacement);
    if (text !== before) {
      const matches = before.match(rule.pattern);
      redactions += matches ? matches.length : 1;
      matchedRules.push(rule.name);
    }
  }
  return { text, redactions, matchedRules };
}

export class StubRedactor implements Redactor {
  redact(input: string, _ctx: RedactContext): RedactResult {
    return applyRules(input);
  }
}

export class NoOpRedactor implements Redactor {
  redact(input: string, _ctx: RedactContext): RedactResult {
    return { text: input, redactions: 0, matchedRules: [] };
  }
}

export class StrictRedactor implements Redactor {
  redact(input: string, ctx: RedactContext): RedactResult {
    const out = applyRules(input);
    if (out.redactions > 0) {
      throw new Error(
        `StrictRedactor: leak in ${ctx.source}.${ctx.field ?? '?'} — rules: ${out.matchedRules.join(', ')}`,
      );
    }
    return out;
  }
}

/**
 * Returns the active redactor. When RYA-623 ships, update this to import
 * and return the real implementation. Tests can inject their own redactor
 * via the collector options, so this single switch is the only production path.
 */
export function defaultRedactor(): Redactor {
  return new StubRedactor();
}
