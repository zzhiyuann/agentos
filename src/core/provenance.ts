/**
 * Memory provenance — frontmatter parsing, memory_id derivation, validation.
 * Read-only utilities. No file mutation. See PROVENANCE-SCHEMA.md for spec.
 */

import { createHash } from 'crypto';

export interface MemoryFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  memory_id?: string;
  derived_from?: string[];
  supersedes?: string[];
  confidence_decay?: number | null;
  created_at?: string;
}

export interface ParsedMemory {
  frontmatter: MemoryFrontmatter;
  body: string;
  rawFrontmatter: string;
}

const ISSUE_KEY_RE = /^[A-Z]{2,5}-\d+$/;

/**
 * Split a memory file's content into frontmatter (parsed) and body (markdown).
 * Returns empty frontmatter if the file has no `---` block at the top.
 *
 * Minimal YAML parser — handles the subset our memory files actually use:
 *   key: scalar
 *   key: [item1, item2]
 *   key: null / true / false / number
 * No block-style sequences, no nested objects, no anchors. If we ever need more
 * we'll swap to a real parser, but adding js-yaml just for memories is overkill.
 */
export function parseMemoryFile(content: string): ParsedMemory {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content, rawFrontmatter: '' };
  }
  const after = content.slice(content.indexOf('\n') + 1);
  const closeIdx = after.indexOf('\n---');
  if (closeIdx === -1) {
    return { frontmatter: {}, body: content, rawFrontmatter: '' };
  }
  const rawFrontmatter = after.slice(0, closeIdx);
  // Body starts after the closing `---` and its newline
  const bodyStart = after.indexOf('\n', closeIdx + 1);
  const body = bodyStart === -1 ? '' : after.slice(bodyStart + 1);
  const frontmatter = parseFrontmatterYaml(rawFrontmatter);
  return { frontmatter, body, rawFrontmatter };
}

function parseFrontmatterYaml(raw: string): MemoryFrontmatter {
  const fm: MemoryFrontmatter = {};
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let val = trimmed.slice(colon + 1).trim();

    // Strip wrapping quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Inline arrays: [a, b, c]
    let parsed: unknown = val;
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      parsed = inner === '' ? [] : inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else if (val === 'null' || val === '~' || val === '') {
      parsed = null;
    } else if (val === 'true') {
      parsed = true;
    } else if (val === 'false') {
      parsed = false;
    } else if (/^-?\d+$/.test(val)) {
      parsed = parseInt(val, 10);
    } else if (/^-?\d+\.\d+$/.test(val)) {
      parsed = parseFloat(val);
    }

    switch (key) {
      case 'name':
      case 'description':
      case 'type':
      case 'memory_id':
      case 'created_at':
        fm[key] = typeof parsed === 'string' ? parsed : String(parsed ?? '');
        break;
      case 'derived_from':
      case 'supersedes':
        fm[key] = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        break;
      case 'confidence_decay':
        fm.confidence_decay = parsed === null ? null : (typeof parsed === 'number' ? parsed : null);
        break;
      // Unknown keys: ignore (forward-compat for future fields like authors, tags)
    }
  }
  return fm;
}

/**
 * Derive a stable, deterministic memory_id for a legacy file lacking explicit `memory_id`.
 * Format: mem_<role>_<8-hex-of-relpath>. Same role+relpath always yields the same id.
 *
 * The hash includes role+filename so:
 *   - same filename in different roles → different ids
 *   - rename or role-move (during read-only indexing) → different id; that's fine
 *     because legacy ids only exist until the migration writes a permanent id
 *     into frontmatter.
 */
export function deriveLegacyMemoryId(role: string, relativePath: string): string {
  const hash = createHash('sha256').update(`${role}::${relativePath}`).digest('hex').slice(0, 8);
  return `mem_${role}_${hash}`;
}

/**
 * Generate a fresh memory_id for a new memory. NOT used in read-only mode —
 * reserved for migration (sub-task 3).
 */
export function newMemoryId(role: string): string {
  const hash = createHash('sha256')
    .update(`${role}::${Date.now()}::${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `mem_${role}_${hash}`;
}

/**
 * Infer derived_from issue keys when frontmatter doesn't specify them.
 * **Filename only** — body prose is too noisy. Per RYA-849 review: inferring
 * from "first 400 chars of body" picks up issue keys mentioned in passing
 * (cross-references, prior incidents) and pollutes the provenance graph
 * with false-positive sources. Migration (sub-task 3) will re-stamp these
 * authoritatively from human-curated frontmatter.
 *
 * Filename patterns we handle:
 *   rya-603-aos-serve-restart.md  → ["RYA-603"]
 *   rya123-something.md           → ["RYA-123"]
 *   RYA-457-ceo-brief.md          → ["RYA-457"]
 *   no-issue-name.md              → []
 */
export function inferDerivedFrom(filename: string, _body: string): string[] {
  const fnMatch = filename.match(/\b([A-Z]{2,5})-?(\d+)\b/i);
  if (!fnMatch) return [];
  return [`${fnMatch[1].toUpperCase()}-${fnMatch[2]}`];
}

/**
 * Default confidence_decay (in days) when frontmatter doesn't specify.
 * `null` means permanent (no decay).
 *
 * Filename-based override: daily retros are tactical and decay fast.
 * Per RYA-849 review answer to open question 2.
 */
export function inferConfidenceDecay(type: string | undefined, filename?: string): number | null {
  if (filename && /^daily-retro-\d{4}-\d{2}-\d{2}\.md$/i.test(filename)) return 30;
  switch ((type || '').toLowerCase()) {
    case 'feedback':
    case 'reference':
    case 'user':
      return null;
    case 'project':
      return 90;
    default:
      return null;
  }
}

/**
 * Compute decay-adjusted relevance score.
 *   score * 0.5^(ageDays / halfLifeDays)
 * If halfLifeDays is null/undefined, no decay (multiplier = 1).
 */
export function decayAdjust(rawScore: number, ageDays: number, halfLifeDays: number | null | undefined): number {
  if (halfLifeDays == null || halfLifeDays <= 0) return rawScore;
  return rawScore * Math.pow(0.5, ageDays / halfLifeDays);
}

export interface ProvenanceValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

/**
 * Validate provenance fields against schema rules. Used by the indexer
 * to flag malformed memories without aborting the whole index.
 */
export function validateProvenance(fm: MemoryFrontmatter): ProvenanceValidationIssue[] {
  const issues: ProvenanceValidationIssue[] = [];
  if (fm.derived_from) {
    for (const key of fm.derived_from) {
      if (!ISSUE_KEY_RE.test(key)) {
        issues.push({ level: 'warning', message: `derived_from contains non-Linear key: "${key}"` });
      }
    }
  }
  if (fm.supersedes) {
    for (const id of fm.supersedes) {
      if (!/^mem_[a-z0-9-]+_[a-f0-9]{8}$/.test(id)) {
        issues.push({ level: 'warning', message: `supersedes contains malformed memory_id: "${id}"` });
      }
    }
  }
  if (fm.confidence_decay != null) {
    if (typeof fm.confidence_decay !== 'number' || fm.confidence_decay <= 0 || !Number.isInteger(fm.confidence_decay)) {
      issues.push({ level: 'error', message: `confidence_decay must be a positive integer (got ${fm.confidence_decay})` });
    }
  }
  return issues;
}
