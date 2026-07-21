import { describe, it, expect } from 'vitest';
import {
  parseMemoryFile,
  deriveLegacyMemoryId,
  inferDerivedFrom,
  inferConfidenceDecay,
  decayAdjust,
  validateProvenance,
} from './provenance.js';

describe('parseMemoryFile', () => {
  it('splits frontmatter and body', () => {
    const raw = '---\nname: Foo\ntype: project\n---\nbody line one\nline two';
    const out = parseMemoryFile(raw);
    expect(out.frontmatter.name).toBe('Foo');
    expect(out.frontmatter.type).toBe('project');
    expect(out.body).toBe('body line one\nline two');
  });

  it('returns empty frontmatter when missing', () => {
    const out = parseMemoryFile('# just a heading\nno frontmatter here');
    expect(out.frontmatter).toEqual({});
    expect(out.body).toContain('just a heading');
  });

  it('parses inline arrays for derived_from / supersedes', () => {
    const raw = '---\nderived_from: [RYA-1, RYA-2, RYA-3]\nsupersedes: [mem_cto_abcd1234]\n---\nbody';
    const out = parseMemoryFile(raw);
    expect(out.frontmatter.derived_from).toEqual(['RYA-1', 'RYA-2', 'RYA-3']);
    expect(out.frontmatter.supersedes).toEqual(['mem_cto_abcd1234']);
  });

  it('parses confidence_decay as integer or null', () => {
    expect(parseMemoryFile('---\nconfidence_decay: 30\n---\n').frontmatter.confidence_decay).toBe(30);
    expect(parseMemoryFile('---\nconfidence_decay: null\n---\n').frontmatter.confidence_decay).toBeNull();
    expect(parseMemoryFile('---\nname: x\n---\n').frontmatter.confidence_decay).toBeUndefined();
  });

  it('strips wrapping quotes from string scalars', () => {
    const raw = '---\nname: "hello world"\ndescription: \'one liner\'\n---\nbody';
    const out = parseMemoryFile(raw);
    expect(out.frontmatter.name).toBe('hello world');
    expect(out.frontmatter.description).toBe('one liner');
  });

  it('ignores unknown frontmatter keys for forward-compat', () => {
    const raw = '---\nname: x\nauthors: [cto, ceo-office]\ntags: [oauth, restart]\n---\n';
    const out = parseMemoryFile(raw);
    expect(out.frontmatter.name).toBe('x');
    // No throw, no crash; unknown keys silently dropped
  });
});

describe('deriveLegacyMemoryId', () => {
  it('is deterministic for same role+path', () => {
    const a = deriveLegacyMemoryId('cto', 'rya-603-foo.md');
    const b = deriveLegacyMemoryId('cto', 'rya-603-foo.md');
    expect(a).toBe(b);
  });

  it('differs by role even with same filename', () => {
    expect(deriveLegacyMemoryId('cto', 'foo.md')).not.toBe(deriveLegacyMemoryId('coo', 'foo.md'));
  });

  it('matches the mem_<role>_<8hex> shape', () => {
    expect(deriveLegacyMemoryId('lead-engineer', 'foo.md')).toMatch(/^mem_lead-engineer_[a-f0-9]{8}$/);
  });
});

describe('inferDerivedFrom', () => {
  it('finds the issue key in the filename', () => {
    expect(inferDerivedFrom('rya-603-foo.md', '')).toEqual(['RYA-603']);
  });

  it('uses filename only — does NOT scan body prose', () => {
    // Per RYA-849 review: body scanning produces false-positive sources from
    // incidental cross-references. Migration will re-stamp frontmatter
    // authoritatively from human-curated values.
    const got = inferDerivedFrom('rya-603-foo.md', 'See RYA-700 and RYA-800 in body.');
    expect(got).toEqual(['RYA-603']);
  });

  it('returns empty for filename without an issue key', () => {
    expect(inferDerivedFrom('random-note.md', 'mentions RYA-99 in body')).toEqual([]);
  });

  it('handles RYA123 form (no hyphen) in filename', () => {
    expect(inferDerivedFrom('rya123-something.md', '')).toEqual(['RYA-123']);
  });
});

describe('inferConfidenceDecay', () => {
  it('returns null for feedback/reference/user', () => {
    expect(inferConfidenceDecay('feedback')).toBeNull();
    expect(inferConfidenceDecay('reference')).toBeNull();
    expect(inferConfidenceDecay('user')).toBeNull();
  });
  it('returns 90 for project', () => {
    expect(inferConfidenceDecay('project')).toBe(90);
  });
  it('returns null for unknown / undefined types', () => {
    expect(inferConfidenceDecay(undefined)).toBeNull();
    expect(inferConfidenceDecay('made-up')).toBeNull();
  });
  it('returns 30 for daily-retro files regardless of type', () => {
    expect(inferConfidenceDecay('project', 'daily-retro-2026-04-22.md')).toBe(30);
    expect(inferConfidenceDecay(undefined, 'daily-retro-2026-04-22.md')).toBe(30);
  });
  it('does not override decay when filename pattern does not match', () => {
    expect(inferConfidenceDecay('project', 'rya-603-foo.md')).toBe(90);
  });
});

describe('decayAdjust', () => {
  it('returns raw score when half-life is null', () => {
    expect(decayAdjust(1.0, 100, null)).toBe(1.0);
  });
  it('halves at exactly one half-life', () => {
    expect(decayAdjust(1.0, 30, 30)).toBeCloseTo(0.5, 5);
  });
  it('quarters at two half-lives', () => {
    expect(decayAdjust(1.0, 60, 30)).toBeCloseTo(0.25, 5);
  });
  it('treats negative half-life as no decay', () => {
    expect(decayAdjust(1.0, 100, -1)).toBe(1.0);
  });
});

describe('validateProvenance', () => {
  it('accepts well-formed frontmatter', () => {
    const issues = validateProvenance({
      derived_from: ['RYA-1', 'CRX-42'],
      supersedes: ['mem_cto_abcd1234'],
      confidence_decay: 30,
    });
    expect(issues).toEqual([]);
  });

  it('warns on non-Linear derived_from keys', () => {
    const issues = validateProvenance({ derived_from: ['not-an-issue'] });
    expect(issues.some(i => i.message.includes('derived_from'))).toBe(true);
  });

  it('warns on malformed supersedes ids', () => {
    const issues = validateProvenance({ supersedes: ['mem_BAD_xyz'] });
    expect(issues.some(i => i.message.includes('supersedes'))).toBe(true);
  });

  it('errors on non-positive-integer confidence_decay', () => {
    const issues = validateProvenance({ confidence_decay: -5 });
    expect(issues.some(i => i.level === 'error')).toBe(true);
  });
});
