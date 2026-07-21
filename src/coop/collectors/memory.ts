/**
 * memory.ts — scans ~/.aos/shared-memory/*.md for files whose
 * front-matter explicitly marks them `public: true`.
 *
 * Introduces the `public:` front-matter convention. Any file without
 * `public: true` is skipped. No exceptions — this is the only whitelist.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { CollectorOutput, MemoryEntry } from '../types.js';
import { defaultRedactor, type Redactor } from '../redactor.js';

export interface MemoryOptions {
  sharedMemoryDir?: string;
  redactor?: Redactor;
  now?: Date;
}

interface ParsedFrontMatter {
  body: string;
  data: Record<string, string | boolean>;
}

function parseFrontMatter(text: string): ParsedFrontMatter {
  if (!text.startsWith('---\n')) return { body: text, data: {} };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { body: text, data: {} };
  const header = text.slice(4, end);
  const body = text.slice(end + 5);
  const data: Record<string, string | boolean> = {};
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: string | boolean = line.slice(idx + 1).trim();
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else val = val.replace(/^['"]|['"]$/g, '');
    data[key] = val;
  }
  return { body, data };
}

function extractTitle(body: string, fallback: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return fallback;
}

export function collectMemory(opts: MemoryOptions = {}): CollectorOutput<MemoryEntry> {
  const dir = opts.sharedMemoryDir ?? join(homedir(), '.aos', 'shared-memory');
  const redactor = opts.redactor ?? defaultRedactor();
  const now = opts.now ?? new Date();

  const items: MemoryEntry[] = [];
  let totalRedactions = 0;

  if (!existsSync(dir)) {
    return { source: 'memory', collectedAt: now.toISOString(), items, redactions: 0 };
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const raw = readFileSync(join(dir, file), 'utf-8');
    const parsed = parseFrontMatter(raw);
    if (parsed.data.public !== true) continue;
    const title = typeof parsed.data.title === 'string' && parsed.data.title.length > 0
      ? parsed.data.title
      : extractTitle(parsed.body, file.replace(/\.md$/, ''));
    const r = redactor.redact(parsed.body, { source: 'memory', field: 'body' });
    totalRedactions += r.redactions;
    items.push({ file, title, body: r.text, public: true });
  }

  items.sort((a, b) => a.title.localeCompare(b.title));

  return { source: 'memory', collectedAt: now.toISOString(), items, redactions: totalRedactions };
}
