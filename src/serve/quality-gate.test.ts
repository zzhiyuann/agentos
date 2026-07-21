import { describe, it, expect, afterEach } from 'vitest';
import {
  evaluateHandoff, findProseFollowups, qualityGateMode, qualityGateDecision,
  formatGateFailures, MemoryValidator,
} from './quality-gate.js';
import type { MemoryValidationResult } from '../core/memory-validation.js';

function memOk(role: string): MemoryValidationResult {
  return {
    role,
    warnings: [],
    unindexedFiles: [],
    staleReferences: [],
    memoryFileCount: 3,
    indexedReferenceCount: 3,
  };
}

function memWarn(warnings: string[]): MemoryValidator {
  return (role: string) => ({ ...memOk(role), warnings });
}

const attempt = { agent_type: 'coo' };

const GOOD_HANDOFF = `---
status_intent: in-review
---
# HANDOFF — RYA-100

## Summary
Implemented the thing.

## Verification
Ran \`npx vitest run\` — all tests pass.

## Next Steps
- Created RYA-101: deploy verification (dispatched to coo)
`;

// ─── findProseFollowups ──────────────────────────────────────────────

describe('findProseFollowups', () => {
  it('flags bullets in Next Steps without issue keys', () => {
    const handoff = `# HANDOFF\n## Next Steps\n- consider refactoring the queue\n- maybe add metrics later\n`;
    const result = findProseFollowups(handoff);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('consider refactoring');
  });

  it('accepts bullets that reference issue keys', () => {
    const handoff = `# HANDOFF\n## Next Steps\n- Created RYA-123: deploy follow-up\n- RYA-124 tracks the metrics work\n`;
    expect(findProseFollowups(handoff)).toEqual([]);
  });

  it('handles Remaining Issues sections', () => {
    const handoff = `# HANDOFF\n## Remaining Issues\n- flaky test in queue.test.ts needs attention\n`;
    expect(findProseFollowups(handoff)).toHaveLength(1);
  });

  it('mixed bullets: only keyless ones are flagged', () => {
    const handoff = `# HANDOFF\n## Next Steps\n- RYA-200 covers the migration\n- write more docs sometime\n`;
    const result = findProseFollowups(handoff);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('write more docs');
  });

  it('stops at the next heading', () => {
    const handoff = `# HANDOFF\n## Next Steps\n- RYA-1 done\n## Files Changed\n- src/foo.ts updated\n- src/bar.ts updated\n`;
    expect(findProseFollowups(handoff)).toEqual([]);
  });

  it('ignores non-bullet prose in the section', () => {
    const handoff = `# HANDOFF\n## Next Steps\nNothing further — all follow-ups are tracked.\n`;
    expect(findProseFollowups(handoff)).toEqual([]);
  });

  it('handles numbered bullets', () => {
    const handoff = `# HANDOFF\n## Next Steps\n1. polish the dashboard\n2. RYA-55 handles deploy\n`;
    const result = findProseFollowups(handoff);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('polish the dashboard');
  });

  it('returns empty for handoffs without follow-up sections', () => {
    expect(findProseFollowups('# HANDOFF\n## Summary\nDone.\n- a bullet outside any section')).toEqual([]);
  });

  it('matches bold-style section markers', () => {
    const handoff = `# HANDOFF\n**Next Steps**\n- do something vague\n`;
    expect(findProseFollowups(handoff)).toHaveLength(1);
  });
});

// ─── evaluateHandoff ─────────────────────────────────────────────────

describe('evaluateHandoff', () => {
  it('passes a clean handoff with healthy memory', () => {
    const result = evaluateHandoff(attempt, GOOD_HANDOFF, '/tmp/ws', memOk);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('fails when memory validation has warnings', () => {
    const validator = memWarn(['Session completed with HANDOFF.md but agent has zero memory files — memory persistence protocol was not followed.']);
    const result = evaluateHandoff(attempt, GOOD_HANDOFF, '/tmp/ws', validator);
    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/^Memory: /);
  });

  it('fails when handoff lacks any verification mention', () => {
    const handoff = '# HANDOFF\n## Summary\nWrote the strategy doc and saved it.\n';
    const result = evaluateHandoff(attempt, handoff, '/tmp/ws', memOk);
    expect(result.pass).toBe(false);
    expect(result.failures.some(f => f.startsWith('Verification:'))).toBe(true);
  });

  it('accepts verify/check word forms (case-insensitive)', () => {
    for (const word of ['Tested', 'verified', 'CHECKED', 'verification', 'tests']) {
      const handoff = `# HANDOFF\n## Summary\nWork ${word} thoroughly.\n`;
      const result = evaluateHandoff(attempt, handoff, '/tmp/ws', memOk);
      expect(result.failures.some(f => f.startsWith('Verification:'))).toBe(false);
    }
  });

  it('fails when Next Steps has prose bullets without issue keys', () => {
    const handoff = `# HANDOFF\n## Summary\nTested everything.\n## Next Steps\n- think about caching improvements\n`;
    const result = evaluateHandoff(attempt, handoff, '/tmp/ws', memOk);
    expect(result.pass).toBe(false);
    expect(result.failures.some(f => f.startsWith('Follow-ups:'))).toBe(true);
  });

  it('accumulates multiple failures', () => {
    const handoff = `# HANDOFF\n## Summary\nDid stuff.\n## Remaining Issues\n- something vague\n`;
    const validator = memWarn(['zero memory files']);
    const result = evaluateHandoff(attempt, handoff, '/tmp/ws', validator);
    expect(result.pass).toBe(false);
    expect(result.failures.length).toBe(3); // memory + verification + follow-ups
  });

  it('fails open when the memory validator throws', () => {
    const throwing: MemoryValidator = () => { throw new Error('boom'); };
    const result = evaluateHandoff(attempt, GOOD_HANDOFF, '/tmp/ws', throwing);
    expect(result.pass).toBe(true);
  });
});

// ─── qualityGateMode ─────────────────────────────────────────────────

describe('qualityGateMode', () => {
  afterEach(() => { delete process.env.AOS_QUALITY_GATE_MODE; });

  it('defaults to warn', () => {
    delete process.env.AOS_QUALITY_GATE_MODE;
    expect(qualityGateMode()).toBe('warn');
  });

  it('honors off and enforce', () => {
    process.env.AOS_QUALITY_GATE_MODE = 'off';
    expect(qualityGateMode()).toBe('off');
    process.env.AOS_QUALITY_GATE_MODE = 'enforce';
    expect(qualityGateMode()).toBe('enforce');
  });

  it('falls back to warn for unknown values', () => {
    process.env.AOS_QUALITY_GATE_MODE = 'banana';
    expect(qualityGateMode()).toBe('warn');
  });

  it('is case-insensitive', () => {
    process.env.AOS_QUALITY_GATE_MODE = 'ENFORCE';
    expect(qualityGateMode()).toBe('enforce');
  });
});

// ─── qualityGateDecision ─────────────────────────────────────────────

describe('qualityGateDecision', () => {
  const failures = ['Verification: missing'];

  it('proceeds when there are no failures', () => {
    expect(qualityGateDecision([], 'enforce', false)).toBe('proceed');
    expect(qualityGateDecision([], 'warn', false)).toBe('proceed');
  });

  it('proceeds silently in off mode even with failures', () => {
    expect(qualityGateDecision(failures, 'off', false)).toBe('proceed');
  });

  it('warns in warn mode', () => {
    expect(qualityGateDecision(failures, 'warn', false)).toBe('warn');
  });

  it('bounces on first failure in enforce mode', () => {
    expect(qualityGateDecision(failures, 'enforce', false)).toBe('bounce');
  });

  it('degrades to warn after a prior bounce (no infinite bounce)', () => {
    expect(qualityGateDecision(failures, 'enforce', true)).toBe('warn');
  });
});

// ─── formatGateFailures ──────────────────────────────────────────────

describe('formatGateFailures', () => {
  it('renders bullets', () => {
    expect(formatGateFailures(['a', 'b'])).toBe('- a\n- b');
  });
});
