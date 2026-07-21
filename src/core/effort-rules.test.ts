import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  loadEffortRules, resolveEffortRule, ruleMatches, classifyBySignals,
  resolveEffortRuleAsync, MODEL_FABLE, MODEL_SONNET, MODEL_HAIKU,
  type EffortRules,
} from './effort-rules.js';

const TEST_DIR = '/tmp/aos-effort-rules-test';
const TEST_PATH = join(TEST_DIR, 'effort-rules.json');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const SAMPLE: EffortRules = {
  rules: [
    { match: { labels: ['chore', 'docs'], priorityAtLeast: 4 }, model: 'claude-sonnet-4-6' },
    { match: { labels: ['research'] }, model: 'claude-fable-5' },
  ],
  default: null,
};

describe('loadEffortRules', () => {
  it('returns null when the file is missing', () => {
    expect(loadEffortRules(join(TEST_DIR, 'nope.json'))).toBeNull();
  });

  it('returns null for malformed JSON (never blocks dispatch)', () => {
    writeFileSync(TEST_PATH, '{ not json');
    expect(loadEffortRules(TEST_PATH)).toBeNull();
  });

  it('parses rules and default, dropping invalid entries', () => {
    writeFileSync(TEST_PATH, JSON.stringify({
      rules: [
        { match: { labels: ['chore'] }, model: 'claude-sonnet-4-6' },
        { match: { labels: ['bad'] } },             // missing model — dropped
        { model: 'claude-haiku-4-5' },              // missing match — dropped
        'garbage',                                   // dropped
      ],
      default: 'claude-fable-5',
    }));
    const rules = loadEffortRules(TEST_PATH)!;
    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0].model).toBe('claude-sonnet-4-6');
    expect(rules.default).toBe('claude-fable-5');
  });

  it('defaults auto to true when not set', () => {
    writeFileSync(TEST_PATH, JSON.stringify({ rules: [], default: null }));
    expect(loadEffortRules(TEST_PATH)?.auto).toBe(true);
  });

  it('respects explicit auto: false', () => {
    writeFileSync(TEST_PATH, JSON.stringify({ rules: [], default: null, auto: false }));
    expect(loadEffortRules(TEST_PATH)?.auto).toBe(false);
  });

  it('defaults autoLLM to false when not set', () => {
    writeFileSync(TEST_PATH, JSON.stringify({ rules: [], default: null }));
    expect(loadEffortRules(TEST_PATH)?.autoLLM).toBe(false);
  });
});

describe('ruleMatches + resolveEffortRule — explicit rules (backward compat)', () => {
  // [description, issue, expected model]
  const cases: [string, { labels?: string[]; priority?: number }, string | null][] = [
    ['label overlap + priority >= 4 (low) matches first rule', { labels: ['chore'], priority: 4 }, 'claude-sonnet-4-6'],
    ['label match is case-insensitive', { labels: ['CHORE'], priority: 4 }, 'claude-sonnet-4-6'],
    ['ANY label overlap is enough', { labels: ['feature', 'docs'], priority: 4 }, 'claude-sonnet-4-6'],
    ['priority below threshold (urgent=1) fails priorityAtLeast', { labels: ['chore'], priority: 1 }, null],
    ['priority 3 (medium) fails priorityAtLeast 4', { labels: ['docs'], priority: 3 }, null],
    ['priority 0 (none) never satisfies priorityAtLeast', { labels: ['chore'], priority: 0 }, null],
    ['missing priority fails a priorityAtLeast rule', { labels: ['chore'] }, null],
    ['no label overlap fails even at low priority', { labels: ['feature'], priority: 4 }, null],
    ['no labels on issue fails a labels rule', { priority: 4 }, null],
    ['label-only rule ignores priority (research, urgent)', { labels: ['research'], priority: 1 }, 'claude-fable-5'],
    ['first match wins (chore+research at low priority → first rule)', { labels: ['chore', 'research'], priority: 4 }, 'claude-sonnet-4-6'],
  ];

  // Use auto: false so these tests only exercise explicit rule matching
  const rulesNoAuto: EffortRules = { ...SAMPLE, auto: false };

  for (const [desc, issue, expected] of cases) {
    it(desc, () => {
      expect(resolveEffortRule(issue, rulesNoAuto).model).toBe(expected);
    });
  }

  it('no rules object (missing file) → null model', () => {
    expect(resolveEffortRule({ labels: ['chore'], priority: 4 }, null).model).toBeNull();
  });

  it('falls back to config default when no rule matches (auto disabled)', () => {
    const withDefault: EffortRules = { ...SAMPLE, auto: false, default: 'claude-fable-5' };
    expect(resolveEffortRule({ labels: ['feature'], priority: 2 }, withDefault).model).toBe('claude-fable-5');
  });

  it('empty match object matches everything (vacuous AND)', () => {
    expect(ruleMatches({}, { labels: [], priority: undefined })).toBe(true);
  });
});

describe('resolveEffortRule — returns reason', () => {
  it('includes reason string for explicit rule match', () => {
    const rules: EffortRules = {
      rules: [{ match: { labels: ['chore'] }, model: MODEL_SONNET }],
      default: null,
      auto: false,
    };
    const { reason } = resolveEffortRule({ labels: ['chore'] }, rules);
    expect(reason).toContain('explicit-rule');
  });

  it('includes reason string for auto classification', () => {
    const rules: EffortRules = { rules: [], default: null, auto: true };
    const { reason } = resolveEffortRule({ priority: 1 }, rules);
    expect(reason).toContain('auto[score=');
  });

  it('reason is "config-default" when auto is off and no rule matches', () => {
    const rules: EffortRules = { rules: [], default: MODEL_FABLE, auto: false };
    const { reason } = resolveEffortRule({ priority: 2 }, rules);
    expect(reason).toBe('config-default');
  });

  it('reason is "no-config" when rules is null', () => {
    const { reason } = resolveEffortRule({}, null);
    expect(reason).toBe('no-config');
  });
});

describe('classifyBySignals — signal scoring', () => {
  it('urgent priority (1) → fable', () => {
    const { model, score } = classifyBySignals({ priority: 1 });
    expect(model).toBe(MODEL_FABLE);
    expect(score).toBe(3);
  });

  it('high priority (2) → sonnet (score=1)', () => {
    const { model, score } = classifyBySignals({ priority: 2 });
    expect(model).toBe(MODEL_SONNET);
    expect(score).toBe(1);
  });

  it('low priority (4) → haiku (score=-2)', () => {
    const { model, score } = classifyBySignals({ priority: 4 });
    expect(model).toBe(MODEL_HAIKU);
    expect(score).toBe(-2);
  });

  it('medium priority (3) → sonnet (score=0)', () => {
    const { model, score } = classifyBySignals({ priority: 3 });
    expect(model).toBe(MODEL_SONNET);
    expect(score).toBe(0);
  });

  it('no priority (0) → sonnet (score=0)', () => {
    const { model, score } = classifyBySignals({ priority: 0 });
    expect(model).toBe(MODEL_SONNET);
    expect(score).toBe(0);
  });

  it('"research" label → fable (score=2)', () => {
    const { model, score } = classifyBySignals({ labels: ['research'] });
    expect(model).toBe(MODEL_FABLE);
    expect(score).toBe(2);
  });

  it('"security" label → fable (score=2)', () => {
    const { model } = classifyBySignals({ labels: ['security'] });
    expect(model).toBe(MODEL_FABLE);
  });

  it('"chore" label → sonnet (score=-1, middle tier)', () => {
    const { model, score } = classifyBySignals({ labels: ['chore'] });
    expect(model).toBe(MODEL_SONNET);
    expect(score).toBe(-1);
  });

  it('"typo" label low priority → haiku (score=-3)', () => {
    const { model, score } = classifyBySignals({ labels: ['typo'], priority: 4 });
    expect(model).toBe(MODEL_HAIKU);
    expect(score).toBe(-3);
  });

  it('complex title keyword → +1 to score', () => {
    const base = classifyBySignals({ priority: 3 }); // score=0
    const withTitle = classifyBySignals({ priority: 3, title: 'Implement new auth system' });
    expect(withTitle.score).toBe(base.score + 1);
  });

  it('trivial title keyword → -1 to score', () => {
    const base = classifyBySignals({ priority: 3 }); // score=0
    const withTitle = classifyBySignals({ priority: 3, title: 'fix typo in README' });
    expect(withTitle.score).toBe(base.score - 1);
  });

  it('long description (>1000 chars) → +2 to score', () => {
    const longDesc = 'a'.repeat(1001);
    const { score } = classifyBySignals({ description: longDesc });
    expect(score).toBe(2);
  });

  it('medium description (301-1000 chars) → +1 to score', () => {
    const medDesc = 'a'.repeat(500);
    const { score } = classifyBySignals({ description: medDesc });
    expect(score).toBe(1);
  });

  it('short description → no signal', () => {
    const { score } = classifyBySignals({ description: 'short desc' });
    expect(score).toBe(0);
  });

  it('research label + urgent priority → strong fable signal', () => {
    const { model, score } = classifyBySignals({ labels: ['research'], priority: 1 });
    expect(model).toBe(MODEL_FABLE);
    expect(score).toBeGreaterThanOrEqual(5);
  });

  it('reason string describes factors', () => {
    const { reason } = classifyBySignals({ priority: 1, labels: ['security'] });
    expect(reason).toContain('priority:urgent');
    expect(reason).toContain('label:security');
  });

  it('no signals → sonnet with "no signals" reason', () => {
    const { model, reason } = classifyBySignals({});
    expect(model).toBe(MODEL_SONNET);
    expect(reason).toContain('no signals');
  });
});

describe('auto mode integration — resolveEffortRule with auto=true', () => {
  it('auto mode classifies urgent task as fable when no explicit rule matches', () => {
    const rules: EffortRules = { rules: [], default: null, auto: true };
    const { model } = resolveEffortRule({ priority: 1 }, rules);
    expect(model).toBe(MODEL_FABLE);
  });

  it('auto mode classifies trivial task as haiku (low priority + typo label)', () => {
    const rules: EffortRules = { rules: [], default: null, auto: true };
    const { model } = resolveEffortRule({ priority: 4, labels: ['typo'] }, rules);
    expect(model).toBe(MODEL_HAIKU);
  });

  it('explicit rules take priority over auto classification', () => {
    const rules: EffortRules = {
      rules: [{ match: { labels: ['chore'] }, model: MODEL_SONNET }],
      default: null,
      auto: true,
    };
    // Even if priority=1 would normally trigger fable, chore label matches the explicit rule
    const { model, reason } = resolveEffortRule({ labels: ['chore'], priority: 1 }, rules);
    expect(model).toBe(MODEL_SONNET);
    expect(reason).toContain('explicit-rule');
  });

  it('auto mode is default (auto field absent) — explicit rules still work', () => {
    writeFileSync(TEST_PATH, JSON.stringify({
      rules: [{ match: { labels: ['maint'] }, model: MODEL_SONNET }],
      // no "auto" field — defaults to true
    }));
    const rules = loadEffortRules(TEST_PATH)!;
    expect(rules.auto).toBe(true);
    // Explicit rule still takes priority
    const { model } = resolveEffortRule({ labels: ['maint'], priority: 1 }, rules);
    expect(model).toBe(MODEL_SONNET);
    // No-match → auto classify
    const { model: m2 } = resolveEffortRule({ priority: 1 }, rules);
    expect(m2).toBe(MODEL_FABLE);
  });
});

describe('resolveEffortRuleAsync — LLM path', () => {
  it('skips LLM when autoLLM is false', async () => {
    const rules: EffortRules = { rules: [], default: null, auto: true, autoLLM: false };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await resolveEffortRuleAsync({ priority: 2 }, rules);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('skips LLM when explicit rule matches (reason does not start with auto[)', async () => {
    const rules: EffortRules = {
      rules: [{ match: { labels: ['chore'] }, model: MODEL_SONNET }],
      default: null,
      auto: true,
      autoLLM: true,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // Explicit rule matches — no ambiguity — LLM should not fire
    await resolveEffortRuleAsync({ labels: ['chore'], priority: 2 }, rules);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('skips LLM when signal score is unambiguous (>= 2)', async () => {
    const rules: EffortRules = { rules: [], default: null, auto: true, autoLLM: true };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // priority=1 gives score=3 — unambiguous fable
    await resolveEffortRuleAsync({ priority: 1 }, rules);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('falls back to fable when LLM call fails (宁贵勿错)', async () => {
    const rules: EffortRules = { rules: [], default: null, auto: true, autoLLM: true };
    // priority=2 → score=1 → ambiguous → tries LLM → fails → fable
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
    const { model, reason } = await resolveEffortRuleAsync({ priority: 2 }, rules);
    expect(model).toBe(MODEL_FABLE);
    expect(reason).toContain('llm-failed');
    vi.restoreAllMocks();
  });

  it('uses LLM result when call succeeds on ambiguous score', async () => {
    const rules: EffortRules = { rules: [], default: null, auto: true, autoLLM: true };
    // priority=2 → score=1 → ambiguous → tries LLM → returns haiku
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ tier: 'haiku', reason: 'trivial fix' }) }],
      }),
    } as Response);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const { model, reason } = await resolveEffortRuleAsync({ priority: 2 }, rules);
    delete process.env.ANTHROPIC_API_KEY;
    expect(model).toBe(MODEL_HAIKU);
    expect(reason).toContain('trivial fix');
    vi.restoreAllMocks();
  });
});
