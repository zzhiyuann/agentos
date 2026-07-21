/**
 * cost.ts — parses ~/.aos/budget.json (per-agent $ limits) and optional
 * token log, and produces a weekly aggregate per agent.
 *
 * Phase-1 approach: if no detailed token log is available, surface the
 * *budget* per agent as a single current-week entry. When RYA-628+ wire
 * in actual usage logging, extend this to emit per-week actuals.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { CollectorOutput, CostEntry, AgentRole } from '../types.js';

export interface CostOptions {
  budgetFile?: string;
  now?: Date;
}

interface BudgetFile {
  dailyLimit?: number;
  perAttemptLimit?: number;
  perAgentLimits?: Record<string, number>;
}

function isoWeek(d: Date): string {
  // ISO week (Monday-based). Algorithm from ISO 8601.
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

export function collectCost(opts: CostOptions = {}): CollectorOutput<CostEntry> {
  const now = opts.now ?? new Date();
  const file = opts.budgetFile ?? join(homedir(), '.aos', 'budget.json');

  const items: CostEntry[] = [];
  if (!existsSync(file)) {
    return { source: 'cost', collectedAt: now.toISOString(), items, redactions: 0 };
  }

  let data: BudgetFile = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return { source: 'cost', collectedAt: now.toISOString(), items, redactions: 0 };
  }

  const week = isoWeek(now);
  const perAgent = data.perAgentLimits ?? {};
  for (const [role, usd] of Object.entries(perAgent)) {
    items.push({
      role: role as AgentRole,
      week,
      // Placeholder: tokens unknown until usage logging lands (RYA-628+)
      tokens: 0,
      usd,
    });
  }

  items.sort((a, b) => a.role.localeCompare(b.role));
  return { source: 'cost', collectedAt: now.toISOString(), items, redactions: 0 };
}
