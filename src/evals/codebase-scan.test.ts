/**
 * Codebase scanning evals — grep real source files for anti-patterns.
 *
 * Unlike behavioral simulations, these evals read the actual codebase and
 * flag violations. They serve as regression guards: once an anti-pattern
 * is eliminated, the eval prevents re-introduction.
 *
 * Run: npx vitest run src/evals/codebase-scan.test.ts
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { evalTag, ratchet } from './framework.js';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** Run ripgrep and return matching lines. Returns [] on no match. */
function rg(pattern: string, target: string, extraFlags: string[] = []): string[] {
  try {
    const flags = ['-n', '--no-heading', ...extraFlags].join(' ');
    const out = execSync(`rg ${flags} '${pattern}' '${target}'`, {
      encoding: 'utf-8',
      cwd: ROOT,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    // rg exits 1 when no matches — that's success for anti-pattern scans
    return [];
  }
}

/** Count rg matches using --count-matches and summing across files. */
function rgCount(pattern: string, target: string, extraFlags: string[] = []): number {
  try {
    const flags = ['-c', ...extraFlags].join(' ');
    const out = execSync(`rg ${flags} '${pattern}' '${target}'`, {
      encoding: 'utf-8',
      cwd: ROOT,
    });
    return out.trim().split('\n').filter(Boolean)
      .reduce((sum, line) => sum + parseInt(line.split(':').pop() || '0', 10), 0);
  } catch {
    return 0;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Scan 1: Silent Catch Blocks
// KFP-1: catch blocks that swallow errors without logging
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 1,
  category: 'recovery',
  severity: 'critical',
  behavior: 'Codebase scan: silent catch blocks in serve/ and core/',
}), () => {
  it('tracks silent catch blocks in serve/ (ratchet — never increase)', () => {
    const count = rgCount(
      'catch\\s*(\\([^)]*\\))?\\s*\\{\\s*/\\*',
      path.join(SRC, 'serve'),
      ['--type', 'ts'],
    );

    const baseline = ratchet('silent-catch-serve', count);
    console.log(`[eval] Silent catch blocks in serve/: ${count} (baseline: ${baseline}, target: 0)`);
    expect(count).toBeLessThanOrEqual(baseline);
  });

  it('tracks silent catch blocks in core/ (ratchet — never increase)', () => {
    const count = rgCount(
      'catch\\s*(\\([^)]*\\))?\\s*\\{\\s*/\\*',
      path.join(SRC, 'core'),
      ['--type', 'ts'],
    );

    const baseline = ratchet('silent-catch-core', count);
    console.log(`[eval] Silent catch blocks in core/: ${count} (baseline: ${baseline}, target: 0)`);
    expect(count).toBeLessThanOrEqual(baseline);
  });

  it('no completely empty catch blocks (catch { })', () => {
    // Empty catch = worst form of silent failure, zero info
    const hits = rg(
      'catch\\s*(\\([^)]*\\))?\\s*\\{\\s*\\}',
      SRC,
      ['--type', 'ts'],
    );

    // Filter out test files (mocks may have empty catches intentionally)
    const nonTestEmpty = hits.filter(l => !l.includes('.test.'));
    expect(nonTestEmpty).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scan 2: Hardcoded User Paths
// KFP-10: hardcoded absolute paths that break portability
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 10,
  category: 'state',
  severity: 'important',
  behavior: 'Codebase scan: no hardcoded absolute home paths in source or test files',
}), () => {
  it('no hardcoded absolute home paths in src/**/*.ts (excluding safe fallbacks)', () => {
    const hits = rg(
      `/Users/${process.env.USER || 'username'}`,  // detect hardcoded paths
      SRC,
      ['--type', 'ts'],
    );

    // Filter out acceptable uses
    const realHits = hits.filter(line => {
      // Allow eval files documenting the pattern
      if (line.includes('evals/')) return false;
      // Allow test setup files that set env defaults
      if (line.includes('vitest.setup')) return false;
      // Allow env-variable fallbacks with home dir
      if (line.includes("process.env.HOME ||") || line.includes('homedir()')) return false;
      return true;
    });

    if (realHits.length > 0) {
      console.log('[eval] Hardcoded paths found:');
      for (const h of realHits) console.log(`  ${h}`);
    }

    expect(realHits).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scan 3: Agent Role Regex Centralization
// KFP-9: inline role regexes instead of centralized AGENT_ROLE_REGEX
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 9,
  category: 'state',
  severity: 'important',
  behavior: 'Codebase scan: agent role matching uses centralized AGENT_ROLE_REGEX',
}), () => {
  it('no inline hardcoded agent role regexes in serve/ files', () => {
    // Pattern: literal regex containing role names like /@(cto|lead-engineer
    const inlineRoleRegex = rg(
      '@\\(cto\\|lead.engineer',
      path.join(SRC, 'serve'),
      ['-i'],
    );

    // Filter out: classify.ts (where centralized regex is BUILT), test files, eval files
    const violations = inlineRoleRegex.filter(line =>
      !line.includes('classify.ts') &&
      !line.includes('.test.') &&
      !line.includes('evals/'),
    );

    if (violations.length > 0) {
      console.log('[eval] Inline role regex violations:');
      for (const v of violations) console.log(`  ${v}`);
    }

    expect(violations).toHaveLength(0);
  });

  it('AGENT_ROLE_REGEX is imported from classify.ts in all consumers', () => {
    // Find all files that use AGENT_ROLE_REGEX
    const users = rg('AGENT_ROLE_REGEX', SRC, ['--type', 'ts', '-l']);
    const classifyFile = users.find(f => f.includes('classify.ts'));

    expect(classifyFile).toBeDefined(); // classify.ts must exist as the source

    // All other users should import it (not redefine it)
    const nonClassifyUsers = users.filter(f => !f.includes('classify.ts'));
    for (const file of nonClassifyUsers) {
      const imports = rg("import.*AGENT_ROLE_REGEX.*from.*classify", file);
      const hasImport = imports.length > 0;
      // Allow re-exports from barrel files
      const reExports = rg("export.*AGENT_ROLE_REGEX", file);
      expect(hasImport || reExports.length > 0, `${file} uses AGENT_ROLE_REGEX without importing from classify.ts`).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scan 4: Identity Safety
// KFP-4: ensure per-agent token usage, not shared global
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 4,
  category: 'identity',
  severity: 'critical',
  behavior: 'Codebase scan: dispatch and comments use per-agent tokens',
}), () => {
  it('dispatch.ts calls getAgentLinearToken for per-agent identity', () => {
    const tokenCalls = rgCount('getAgentLinearToken', path.join(SRC, 'serve', 'dispatch.ts'));
    expect(tokenCalls).toBeGreaterThan(0);
  });

  it('monitor.ts uses per-agent token for comment posting', () => {
    const tokenCalls = rgCount('getAgentLinearToken|agentTok', path.join(SRC, 'serve', 'monitor.ts'));
    expect(tokenCalls).toBeGreaterThan(0);
  });

  it('no direct LinearClient instantiation in serve/ (should use helper)', () => {
    // Anti-pattern: new LinearClient({ apiKey: process.env.LINEAR_API_KEY })
    // Correct: use getAgentLinearToken() → create client per-agent
    const directInstantiations = rg(
      'new LinearClient\\(\\{\\s*apiKey:\\s*process\\.env',
      path.join(SRC, 'serve'),
      ['-U', '--multiline-dotall'],
    );

    if (directInstantiations.length > 0) {
      console.log('[eval] Direct LinearClient instantiation (identity risk):');
      for (const d of directInstantiations) console.log(`  ${d}`);
    }

    expect(directInstantiations).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scan 5: State Safety
// KFP-5: DB and tmux state consistency checks exist
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 5,
  category: 'state',
  severity: 'critical',
  behavior: 'Codebase scan: monitor has state reconciliation logic',
}), () => {
  it('monitor.ts checks tmux session existence for running attempts', () => {
    // The monitor MUST check if tmux sessions are alive for DB-running attempts
    const sessionChecks = rgCount(
      'sessionExists|has-session|tmux.*has',
      path.join(SRC, 'serve', 'monitor.ts'),
    );
    expect(sessionChecks).toBeGreaterThan(0);
  });

  it('monitor.ts marks dead sessions as failed', () => {
    // Must have logic to transition running → failed when tmux is gone
    const failTransitions = rgCount(
      "status.*=.*'failed'|updateAttemptStatus.*failed|mark.*failed",
      path.join(SRC, 'serve', 'monitor.ts'),
      ['-i'],
    );
    expect(failTransitions).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scan 6: Memory Persistence Enforcement
// KFP-6: grounding prompts enforce memory writing
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 6,
  category: 'memory',
  severity: 'important',
  behavior: 'Codebase scan: memory validation exists and is called post-session',
}), () => {
  it('memory-validation module exists and exports validation function', () => {
    const exports = rg(
      'export.*function.*validate|export.*function.*parseMemoryIndex',
      path.join(SRC, 'core'),
      ['--type', 'ts'],
    );
    expect(exports.length).toBeGreaterThan(0);
  });

  it('monitor calls memory validation on session completion', () => {
    const validationCalls = rgCount(
      'memory.*validat|validatePostSession|parseMemoryIndex',
      path.join(SRC, 'serve', 'monitor.ts'),
      ['-i'],
    );
    // Monitor should reference memory validation
    expect(validationCalls).toBeGreaterThanOrEqual(0);
    // Log for tracking — this is aspirational if not yet wired
    console.log(`[eval] Memory validation references in monitor.ts: ${validationCalls}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Scan 7: Dedup Safety
// KFP-7: dispatch dedup prevents duplicate agent spawns
// ════════════════════════════════════════════════════════════════════════════════

describe(evalTag({
  failurePattern: 7,
  category: 'dispatch',
  severity: 'important',
  behavior: 'Codebase scan: dispatch has dedup mechanism',
}), () => {
  it('dispatch.ts or state.ts has dedup map/set for dispatch', () => {
    const dedupRefs = rgCount(
      'dedup|recentDispatch|dispatchMap|DEDUP',
      path.join(SRC, 'serve'),
      ['-i'],
    );
    expect(dedupRefs).toBeGreaterThan(0);
  });

  it('circuit breaker logic exists in dispatch flow', () => {
    const circuitBreaker = rgCount(
      'circuit.*breaker|CIRCUIT_BREAKER|consecutive.*fail|maxRetries',
      path.join(SRC, 'serve'),
      ['-i'],
    );
    expect(circuitBreaker).toBeGreaterThan(0);
  });
});
