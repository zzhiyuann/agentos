import { describe, it, expect, beforeEach } from 'vitest';
import {
  costForUsage,
  totalTokensForUsage,
  lookupPricing,
  DEFAULT_PRICING,
  FALLBACK_PRICING,
  _resetPricingCache,
} from './pnl-pricing.js';

beforeEach(() => {
  _resetPricingCache();
});

describe('lookupPricing', () => {
  it('returns exact match', () => {
    expect(lookupPricing('claude-opus-4-7')).toEqual(DEFAULT_PRICING['claude-opus-4-7']);
  });

  it('strips date suffix', () => {
    expect(lookupPricing('claude-opus-4-7-20251201')).toEqual(DEFAULT_PRICING['claude-opus-4-7']);
  });

  it('strips bracket suffix', () => {
    expect(lookupPricing('claude-opus-4-7[1m]')).toEqual(DEFAULT_PRICING['claude-opus-4-7']);
  });

  it('falls back for unknown model', () => {
    expect(lookupPricing('claude-zzz-9-9')).toEqual(FALLBACK_PRICING);
  });
});

describe('totalTokensForUsage', () => {
  it('sums all token categories', () => {
    expect(
      totalTokensForUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 10,
      }),
    ).toBe(360);
  });

  it('handles missing optional fields', () => {
    expect(totalTokensForUsage({ input_tokens: 5, output_tokens: 5 })).toBe(10);
  });
});

describe('costForUsage', () => {
  it('computes Sonnet cost correctly', () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    const c = costForUsage('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    expect(c).toBeCloseTo(18, 5);
  });

  it('attributes ephemeral cache buckets when breakdown present', () => {
    // 1M ephemeral_5m @ $18.75 + 1M ephemeral_1h @ $30 = $48.75 (Opus)
    const c = costForUsage('claude-opus-4-7', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 1_000_000,
      },
    });
    expect(c).toBeCloseTo(48.75, 5);
  });

  it('treats cache_creation_input_tokens as 5m bucket when no breakdown', () => {
    // 1M cache_creation @ $18.75 (Opus 5m rate)
    const c = costForUsage('claude-opus-4-7', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(c).toBeCloseTo(18.75, 5);
  });

  it('uses fallback pricing for unknown model', () => {
    const c = costForUsage('claude-mystery-1-0', {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    // Fallback is Sonnet: $3/M input
    expect(c).toBeCloseTo(3, 5);
  });
});
