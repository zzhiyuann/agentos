/**
 * Model pricing in USD per million tokens. Used to convert raw token counts
 * into USD cost estimates for the weekly P&L digest.
 *
 * Numbers are best-effort approximations as of 2026-05. They are NOT meant
 * to be billed against — they exist so the digest can ballpark dollar spend.
 * Override via ~/.aos/pnl-pricing.json if Anthropic's published rates change.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from '../core/config.js';

export interface ModelPricing {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface UsageRecord {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Best-effort defaults. Anthropic-listed rates as of 2026-05. */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Fable 5
  'claude-fable-5': {
    input: 10, output: 50,
    cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20,
  },
  // Opus 4.x
  'claude-opus-4-7': {
    input: 15, output: 75,
    cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30,
  },
  'claude-opus-4-6': {
    input: 15, output: 75,
    cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30,
  },
  'claude-opus-4-5': {
    input: 15, output: 75,
    cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30,
  },
  // Sonnet 4.x
  'claude-sonnet-4-6': {
    input: 3, output: 15,
    cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6,
  },
  'claude-sonnet-4-5': {
    input: 3, output: 15,
    cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6,
  },
  // Haiku 4.x
  'claude-haiku-4-5': {
    input: 1, output: 5,
    cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2,
  },
};

/** Fallback pricing used when model is unknown — assumes Sonnet rates. */
export const FALLBACK_PRICING: ModelPricing = DEFAULT_PRICING['claude-sonnet-4-6'];

const PRICING_CONFIG_PATH = join(STATE_DIR, 'pnl-pricing.json');

let cachedPricing: Record<string, ModelPricing> | null = null;

export function loadPricing(): Record<string, ModelPricing> {
  if (cachedPricing) return cachedPricing;
  if (existsSync(PRICING_CONFIG_PATH)) {
    try {
      const data = JSON.parse(readFileSync(PRICING_CONFIG_PATH, 'utf-8')) as Record<string, ModelPricing>;
      cachedPricing = { ...DEFAULT_PRICING, ...data };
      return cachedPricing;
    } catch {
      // fall through
    }
  }
  cachedPricing = { ...DEFAULT_PRICING };
  return cachedPricing;
}

/** Visible for testing. */
export function _resetPricingCache(): void {
  cachedPricing = null;
}

/**
 * Match a model id (which may include suffixes like "-20251001" or "[1m]")
 * against the pricing table. Strips trailing date / variant suffixes.
 */
export function lookupPricing(model: string): ModelPricing {
  const table = loadPricing();
  if (table[model]) return table[model];
  // Strip date suffix: "claude-opus-4-7-20251201" → "claude-opus-4-7"
  const stripped = model.replace(/-\d{8}$/, '').replace(/\[[^\]]+\]$/, '');
  if (table[stripped]) return table[stripped];
  // Family fallback: extract the major.minor (e.g., claude-opus-4-7)
  const family = stripped.match(/^(claude-[a-z]+-\d+-\d+)/)?.[1];
  if (family && table[family]) return table[family];
  return FALLBACK_PRICING;
}

/** Compute USD cost for a single message-level usage record. */
export function costForUsage(model: string, usage: UsageRecord): number {
  const p = lookupPricing(model);
  const eph5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const eph1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // If cache_creation breakdown is present, use it. Otherwise treat
  // cache_creation_input_tokens as 5m-bucket (conservative — cheaper).
  const cacheWrite5m = eph5m + eph1h > 0 ? eph5m : (usage.cache_creation_input_tokens ?? 0);
  const cacheWrite1h = eph1h;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const cost =
    (usage.input_tokens / 1_000_000) * p.input +
    (usage.output_tokens / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * p.cacheRead +
    (cacheWrite5m / 1_000_000) * p.cacheWrite5m +
    (cacheWrite1h / 1_000_000) * p.cacheWrite1h;
  return cost;
}

/** Total tokens (all categories combined). */
export function totalTokensForUsage(usage: UsageRecord): number {
  return (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0);
}
