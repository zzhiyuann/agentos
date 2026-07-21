/**
 * Taxonomy loader — parses the chaos drill taxonomy markdown into FailureMode
 * objects. The taxonomy file is the contract with sub-task 1 of RYA-766.
 *
 * Default location: src/chaos/seed-taxonomy.md (replaced by COO when ready).
 * Override path with the AOS_CHAOS_TAXONOMY env var or loadTaxonomy(path).
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { FailureMode, FailureSymptom } from './types.js';

const DEFAULT_TAXONOMY_PATH = path.resolve(import.meta.dirname, 'seed-taxonomy.md');

/** Resolve which taxonomy file to use. */
export function resolveTaxonomyPath(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.AOS_CHAOS_TAXONOMY) return path.resolve(process.env.AOS_CHAOS_TAXONOMY);
  // Prefer .agent-memory/chaos-drills-taxonomy.md if present (sub-task 1 output).
  const memoryPath = path.resolve(process.cwd(), '.agent-memory/chaos-drills-taxonomy.md');
  if (existsSync(memoryPath)) return memoryPath;
  return DEFAULT_TAXONOMY_PATH;
}

/** Load and parse the taxonomy file. Throws if shape is invalid. */
export function loadTaxonomy(override?: string): FailureMode[] {
  const file = resolveTaxonomyPath(override);
  if (!existsSync(file)) {
    throw new Error(`Chaos taxonomy not found at ${file}`);
  }
  const raw = readFileSync(file, 'utf-8');
  return parseTaxonomy(raw);
}

/**
 * Parse the markdown taxonomy. Each `## failure-mode: <id>` section followed
 * by a fenced ```yaml block becomes one FailureMode. Format is intentionally
 * simple so the COO can edit it with a normal text editor.
 */
export function parseTaxonomy(raw: string): FailureMode[] {
  const modes: FailureMode[] = [];
  const sectionRe = /^##\s+failure-mode:\s*([a-z0-9][a-z0-9-]*)\s*$/gm;
  const matches = [...raw.matchAll(sectionRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const id = m[1];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : raw.length;
    const section = raw.slice(start, end);

    const yamlBlock = extractYamlBlock(section);
    if (!yamlBlock) {
      throw new Error(`Failure mode "${id}" has no \`\`\`yaml block`);
    }
    const parsed = parseSimpleYaml(yamlBlock);
    modes.push(buildFailureMode(id, parsed));
  }

  if (modes.length === 0) {
    throw new Error('No failure modes parsed from taxonomy file');
  }
  return modes;
}

function extractYamlBlock(section: string): string | null {
  const fenceRe = /```yaml\s*\n([\s\S]*?)\n```/;
  const m = section.match(fenceRe);
  return m ? m[1] : null;
}

/**
 * Tiny YAML-ish parser. Supports the subset used by the taxonomy:
 *   - scalar string values (with or without quotes)
 *   - block scalars folded onto one line
 *   - nested arrays via `-` lists with inline `{ key: value, ... }` objects
 *
 * Does NOT support nested maps, anchors, references — none of which the
 * taxonomy uses. Keeping this dep-free avoids pulling in a YAML library.
 */
export function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const value = kv[2];

    if (value === '' || value === undefined) {
      // Look ahead for a list of `-` entries
      const items: unknown[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const trimmed = next.trim();
        if (trimmed.startsWith('- ')) {
          items.push(parseInlineValue(trimmed.slice(2)));
          i++;
        } else if (trimmed === '') {
          i++;
          break;
        } else {
          break;
        }
      }
      out[key] = items;
    } else {
      out[key] = parseInlineValue(value);
      i++;
    }
  }
  return out;
}

function parseInlineValue(v: string): unknown {
  const t = v.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    return parseInlineObject(t);
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map(parseInlineValue);
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function parseInlineObject(t: string): Record<string, unknown> {
  const inner = t.slice(1, -1).trim();
  const obj: Record<string, unknown> = {};
  if (!inner) return obj;
  for (const pair of splitTopLevel(inner, ',')) {
    const colon = pair.indexOf(':');
    if (colon === -1) continue;
    const k = pair.slice(0, colon).trim();
    const v = pair.slice(colon + 1).trim();
    obj[k] = parseInlineValue(v);
  }
  return obj;
}

/** Split on a delimiter, respecting balanced braces/brackets and quotes. */
function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr && s[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c as '"' | "'"; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === delim && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(x => x.length > 0);
}

const VALID_SURFACES = new Set(['dispatch', 'handoff', 'memory', 'rate-limit', 'auth', 'identity', 'state', 'recovery', 'other']);
const VALID_SEVERITIES = new Set(['critical', 'important', 'informational']);
const VALID_CHANNELS = new Set(['logs', 'linear-comments', 'linear-status', 'session-state', 'discord', 'metrics']);

function buildFailureMode(id: string, raw: Record<string, unknown>): FailureMode {
  const title = expectString(raw, 'title', id);
  const description = expectString(raw, 'description', id);
  const surface = expectString(raw, 'surface', id);
  if (!VALID_SURFACES.has(surface)) {
    throw new Error(`Failure mode "${id}": invalid surface "${surface}"`);
  }
  const severity = expectString(raw, 'severity', id);
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`Failure mode "${id}": invalid severity "${severity}"`);
  }
  const expectedRecovery = expectString(raw, 'expectedRecovery', id);
  const incidentRefs = Array.isArray(raw.incidentRefs) ? (raw.incidentRefs as unknown[]).map(String) : undefined;

  if (!Array.isArray(raw.symptoms)) {
    throw new Error(`Failure mode "${id}": symptoms must be a list`);
  }
  const symptoms: FailureSymptom[] = (raw.symptoms as unknown[]).map((s, idx) => buildSymptom(id, idx, s));

  return {
    id,
    title,
    description,
    surface: surface as FailureMode['surface'],
    severity: severity as FailureMode['severity'],
    symptoms,
    expectedRecovery,
    incidentRefs,
  };
}

function buildSymptom(modeId: string, idx: number, raw: unknown): FailureSymptom {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Failure mode "${modeId}" symptom[${idx}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const channel = expectString(r, 'channel', `${modeId}.symptoms[${idx}]`);
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`Failure mode "${modeId}" symptom[${idx}]: invalid channel "${channel}"`);
  }
  const pattern = expectString(r, 'pattern', `${modeId}.symptoms[${idx}]`);
  const required = r.required === true;
  return { channel: channel as FailureSymptom['channel'], pattern, required };
}

function expectString(raw: Record<string, unknown>, key: string, ctx: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${ctx}: missing or empty string field "${key}"`);
  }
  return v;
}

/** Look up a single failure mode by id; throws if not found. */
export function findFailureMode(modes: FailureMode[], id: string): FailureMode {
  const m = modes.find(x => x.id === id);
  if (!m) {
    throw new Error(`Failure mode "${id}" not in taxonomy. Available: ${modes.map(x => x.id).join(', ')}`);
  }
  return m;
}
