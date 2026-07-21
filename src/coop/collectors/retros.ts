/**
 * retros.ts — scans ~/.aos/agents/<role>/retrospectives/*.md,
 * parses daily entries, and runs each through the redactor.
 *
 * File layout convention: each file is named YYYY-MM-DD.md and contains
 * one or more H2 sections that start with `## YYYY-MM-DD — <title>`.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { CollectorOutput, RetroEntry, AgentRole } from '../types.js';
import { defaultRedactor, type Redactor } from '../redactor.js';

export interface RetrosOptions {
  agentsDir?: string;
  redactor?: Redactor;
  now?: Date;
  /** Only include entries whose date is within this many days. Default 30. */
  withinDays?: number;
}

const DATE_HEADER = /^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/m;

function parseFile(role: AgentRole, file: string, text: string, redactor: Redactor): {
  entries: RetroEntry[];
  redactions: number;
} {
  // Split on H2 date headers. We keep the header with each chunk.
  const parts: { date: string; body: string }[] = [];
  const lines = text.split('\n');
  let current: { date: string; body: string[] } | null = null;

  for (const line of lines) {
    const m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+/);
    if (m) {
      if (current) parts.push({ date: current.date, body: current.body.join('\n') });
      current = { date: m[1], body: [line] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) parts.push({ date: current.date, body: current.body.join('\n') });

  // Fallback: if no H2 date headers, treat the filename (YYYY-MM-DD) as the date
  // and the whole file as one entry.
  if (parts.length === 0) {
    const name = file.replace(/\.md$/, '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
      parts.push({ date: name, body: text });
    }
  }

  let totalRedactions = 0;
  const entries: RetroEntry[] = parts.map(({ date, body }) => {
    const r = redactor.redact(body, { source: 'retros', field: 'body' });
    totalRedactions += r.redactions;
    return { role, date, body: r.text };
  });

  return { entries, redactions: totalRedactions };
}

export function collectRetros(opts: RetrosOptions = {}): CollectorOutput<RetroEntry> {
  const agentsDir = opts.agentsDir ?? join(homedir(), '.aos', 'agents');
  const redactor = opts.redactor ?? defaultRedactor();
  const now = opts.now ?? new Date();
  const withinDays = opts.withinDays ?? 30;
  const cutoff = new Date(now.getTime() - withinDays * 24 * 60 * 60 * 1000);

  const items: RetroEntry[] = [];
  let totalRedactions = 0;

  if (!existsSync(agentsDir)) {
    return {
      source: 'retros',
      collectedAt: now.toISOString(),
      items,
      redactions: 0,
    };
  }

  const roles = readdirSync(agentsDir).filter((name) => {
    const full = join(agentsDir, name);
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  });

  for (const role of roles) {
    const retroDir = join(agentsDir, role, 'retrospectives');
    if (!existsSync(retroDir)) continue;
    const files = readdirSync(retroDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const text = readFileSync(join(retroDir, file), 'utf-8');
      const parsed = parseFile(role, file, text, redactor);
      for (const entry of parsed.entries) {
        if (new Date(entry.date) >= cutoff) items.push(entry);
      }
      totalRedactions += parsed.redactions;
    }
  }

  // Newest first.
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    source: 'retros',
    collectedAt: now.toISOString(),
    items,
    redactions: totalRedactions,
  };
}
