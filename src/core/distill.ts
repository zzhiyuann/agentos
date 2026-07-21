/**
 * Memory distill engine — RYA-857 / RYA-940.
 *
 * Scans memory files, clusters them, generates merge proposals, and applies
 * approved merges with a `supersedes` chain so the lineage stays queryable.
 * Used by `aos memory distill <subcommand>`.
 *
 * Originally implemented as standalone .mjs scripts in $HOME/.aos/work/RYA-857/.
 * Ported to TypeScript here so it's first-class CLI.
 */

import {
  readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync,
  statSync, renameSync, appendFileSync,
} from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import { STATE_DIR } from './config.js';
import { getAgentsDir } from './persona.js';
import { getMemoryRetrievalInfo } from './memory-store.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DISTILL_DIR = join(STATE_DIR, 'distill');
export const ARCHIVE_DIR = join(DISTILL_DIR, 'archive');

// Synthetic role for cross-agent shared memory (RYA-973). The shared corpus at
// ~/.aos/shared-memory/ is structurally outside ~/.aos/agents/<role>/memory/,
// so the engine treats it as a virtual role keyed by this constant.
export const SHARED_ROLE = 'shared';
export const SHARED_MEMORY_DIR = join(STATE_DIR, 'shared-memory');

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// Resolve the memory source directory for a role. The synthetic 'shared' role
// reads/writes to ~/.aos/shared-memory/; all other roles use the agent layout.
export function getMemoryDirForRole(role: string): string {
  if (role === SHARED_ROLE) return SHARED_MEMORY_DIR;
  return join(getAgentsDir(), role, 'memory');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DistillConfig {
  min_token_overlap: number;
  topic_min_overlap: number;
  topic_min_cluster_size: number;
  auto_propose_same_rya: boolean;
  size_threshold_dup_chars: number;
  topic_keywords: Record<string, string>;
  exclude_patterns: string[];
}

// Confidence floor: proposals scoring below this are dropped at generation time
// (RYA-966). Tuned after Day-30 review showed weak associations dominating
// engine-only false positives.
export const MIN_PROPOSAL_CONFIDENCE = 0.50;

const DEFAULT_CONFIG: DistillConfig = {
  // Raised from 0.30 → 0.40 in RYA-966: 0.30 accepted weak content-similarity
  // associations that curators rejected ~50% of the time.
  min_token_overlap: 0.40,
  // Raised from 0.18 → 0.20 in RYA-966: at 0.18 the topic_cluster strategy
  // mis-fired on heterogeneous filename-keyword matches.
  topic_min_overlap: 0.20,
  topic_min_cluster_size: 3,
  auto_propose_same_rya: true,
  size_threshold_dup_chars: 100,
  topic_keywords: {
    'noise': 'noise-reduction',
    'dismiss': 'noise-reduction',
    'nudge': 'noise-reduction',
    'oss': 'oss-launch',
    'public-repo': 'oss-launch',
    'sanitization': 'oss-launch',
    'readme': 'oss-launch',
    'docs': 'oss-launch',
    'deliverable': 'deliverable-system',
    'linkify': 'deliverable-system',
    'oauth': 'auth-system',
    'token': 'auth-system',
    'identity': 'auth-system',
    'router': 'router-evals',
    'vote': 'vote-summaries',
    'proposal': 'vote-summaries',
    'idea': 'vote-summaries',
    'standdown': 'vote-summaries',
  },
  exclude_patterns: [
    '^MEMORY\\.md$',
    '^system-memory\\.md$',
    '^daily-retro-',
  ],
};

export function loadDistillConfig(): DistillConfig {
  const p = join(STATE_DIR, 'distill-config.json');
  if (!existsSync(p)) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistillMemory {
  memory_id: string;
  role: string;
  filename: string;
  file_path: string;
  issue_key: string | null;
  name: string;
  description: string;
  type: string;
  content: string;
  body: string;
  body_size: number;
  content_hash: string;
  mtime: number;
}

export interface DistillCluster {
  cluster_id: string;
  strategy: 'same_rya' | 'name_prefix' | 'topic_cluster' | 'content_similarity';
  members: DistillMemory[];
  signal: string;
  avg_similarity_hint?: number;
}

// Note: 'flag_burst' is intentionally retained for backward compatibility with
// archived run JSON. The burst_cluster strategy that produced it was removed in
// RYA-966 (100% engine-only FP rate at Day-30 gate), so generateProposals will
// no longer emit this kind, but `loadRun()` may still read older runs.
export type ProposalKind =
  | 'merge'
  | 'merge_aspects'
  | 'merge_redundant'
  | 'merge_topic'
  | 'merge_topical_manual'
  | 'flag_burst'
  | 'flag_topic'
  | 'flag_redundancy'
  | 'prune';

export interface DistillProposal {
  proposal_id: string;
  cluster_id: string;
  strategy: string;
  kind: ProposalKind;
  role: string;
  issue_key: string | null;
  source_memory_ids: string[];
  source_files: string[];
  total_source_size: number;
  avg_similarity: number | null;
  confidence: number;
  contradiction_reason: string;
  proposed_new_memory_id: string;
  proposed_filename: string;
  proposed_merged_content: string;
  signal: string;
  applied_at?: string;
  applied_to?: string;
  archived_files?: { from: string; to: string }[];
  rejected_at?: string;
  rejection_reason?: string;
}

export interface DistillRunMeta {
  run_id: string;
  generated_at: string;
  roles: string[];
  total_memories_scanned: number;
  total_clusters: number;
  total_proposals: number;
  config: DistillConfig;
  curated_at?: string;
  curation_summary?: Record<string, unknown>;
}

export interface DistillRunData {
  meta: DistillRunMeta;
  proposals: DistillProposal[];
}

export interface DistillMetrics {
  run_id: string;
  total_proposals: number;
  engine_proposals: number;
  manual_proposals: number;
  applied: number;
  rejected: number;
  pending: number;
  false_positive_rate_combined: number;
  false_positive_rate_engine_only: number;
  memories_before: number;
  memories_merged_into_supersedes: number;
  memories_after_estimated: number;
  reduction_pct: number;
}

// ---------------------------------------------------------------------------
// Frontmatter parser (minimal — handles strings and bracketed arrays)
// ---------------------------------------------------------------------------

interface ParsedMemory {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

function parseFrontmatter(content: string): ParsedMemory {
  const fm: Record<string, string | string[]> = {};
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: fm, body: content };
  }
  const after = content.slice(content.indexOf('\n') + 1);
  const closeIdx = after.indexOf('\n---');
  if (closeIdx === -1) return { frontmatter: fm, body: content };
  const raw = after.slice(0, closeIdx);
  const bodyStart = after.indexOf('\n', closeIdx + 1);
  const body = bodyStart === -1 ? '' : after.slice(bodyStart + 1);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let val = trimmed.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      const inner = val.slice(1, -1).trim();
      fm[key] = inner === '' ? [] : inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body };
}

function deriveLegacyId(role: string, relPath: string): string {
  const h = createHash('sha256').update(`${role}::${relPath}`).digest('hex').slice(0, 8);
  return `mem_${role}_${h}`;
}

// ---------------------------------------------------------------------------
// Memory loading
// ---------------------------------------------------------------------------

export function listAvailableRoles(): string[] {
  const dir = getAgentsDir();
  const roles: string[] = [];
  if (existsSync(dir)) {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) roles.push(d.name);
    }
  }
  // Include the synthetic 'shared' role when ~/.aos/shared-memory/ exists so
  // `--all-roles` picks it up alongside per-agent memories (RYA-973).
  if (existsSync(SHARED_MEMORY_DIR)) roles.push(SHARED_ROLE);
  return roles;
}

export function loadMemoriesForRole(role: string, config: DistillConfig = loadDistillConfig()): DistillMemory[] {
  const dir = getMemoryDirForRole(role);
  if (!existsSync(dir)) return [];
  const excludeRe = new RegExp(config.exclude_patterns.join('|'));
  const out: DistillMemory[] = [];
  for (const f of readdirSync(dir)) {
    if (excludeRe.test(f)) continue;
    if (!f.endsWith('.md')) continue;
    const fullPath = join(dir, f);
    const stat = statSync(fullPath);
    if (!stat.isFile()) continue;
    const content = readFileSync(fullPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (body.trim().length < config.size_threshold_dup_chars) continue;
    const fmIdRaw = frontmatter.memory_id;
    const memId = typeof fmIdRaw === 'string' && fmIdRaw ? fmIdRaw : deriveLegacyId(role, f);
    const ryaMatch = f.match(/\b([A-Z]{2,5})-?(\d+)\b/i);
    const issueKey = ryaMatch ? `${ryaMatch[1].toUpperCase()}-${ryaMatch[2]}` : null;
    const fmName = frontmatter.name;
    const fmDesc = frontmatter.description;
    const fmType = frontmatter.type;
    out.push({
      memory_id: memId,
      role,
      filename: f,
      file_path: fullPath,
      issue_key: issueKey,
      name: typeof fmName === 'string' ? fmName : f.replace(/\.md$/, ''),
      description: typeof fmDesc === 'string' ? fmDesc : '',
      type: typeof fmType === 'string' ? fmType : '',
      content,
      body,
      body_size: body.length,
      content_hash: createHash('sha256').update(content).digest('hex').slice(0, 12),
      mtime: stat.mtimeMs,
    });
  }
  return out;
}

export function loadAllMemories(roles: string[], config: DistillConfig = loadDistillConfig()): DistillMemory[] {
  const all: DistillMemory[] = [];
  for (const r of roles) all.push(...loadMemoriesForRole(r, config));
  return all;
}

// ---------------------------------------------------------------------------
// Tokenization & similarity
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on', 'for', 'at', 'by', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'from', 'not', 'no', 'so', 'which',
  'we', 'our', 'they', 'their', 'i', 'my', 'you', 'your', 'he', 'she', 'his', 'her', 'will', 'can',
  'use', 'using', 'used', 'via', 'vs', 'rya', 'ryanhub',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t))
  );
}

export function jaccard(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export function clusterMemories(
  mems: DistillMemory[],
  config: DistillConfig = loadDistillConfig(),
): DistillCluster[] {
  const clusters: DistillCluster[] = [];
  const used = new Set<string>();

  // Strategy 1: same issue_key + same role
  const byIssueRole = new Map<string, DistillMemory[]>();
  for (const m of mems) {
    if (!m.issue_key) continue;
    const k = `${m.role}::${m.issue_key}`;
    if (!byIssueRole.has(k)) byIssueRole.set(k, []);
    byIssueRole.get(k)!.push(m);
  }
  for (const [key, members] of byIssueRole) {
    if (members.length < 2) continue;
    const [role, issue] = key.split('::');
    clusters.push({
      cluster_id: `same-rya-${key}`,
      strategy: 'same_rya',
      members,
      signal: `${members.length} memories share issue key ${issue} in role ${role}`,
    });
    members.forEach(m => used.add(m.memory_id));
  }

  // Strategy 2: filename prefix beyond role (-final, -v2, -fix, -part1)
  const byBaseName = new Map<string, DistillMemory[]>();
  for (const m of mems) {
    if (used.has(m.memory_id)) continue;
    const baseName = m.filename
      .replace(/\.md$/, '')
      .replace(/-(final|v\d+|part\d+|fix|update|new|old)$/i, '');
    const key = `${m.role}::${baseName}`;
    if (!byBaseName.has(key)) byBaseName.set(key, []);
    byBaseName.get(key)!.push(m);
  }
  for (const [key, members] of byBaseName) {
    if (members.length < 2) continue;
    clusters.push({
      cluster_id: `name-prefix-${key}`,
      strategy: 'name_prefix',
      members,
      signal: `${members.length} memories share filename base "${key.split('::')[1]}"`,
    });
    members.forEach(m => used.add(m.memory_id));
  }

  // Strategy 2.5 (burst_cluster) removed in RYA-966 — temporal proximity of
  // sequential RYA numbers does not imply topical equivalence; Day-30 gate
  // showed 100% engine-only FP rate (7/7 rejected by curator).

  // Strategy 3: topic clustering by keyword in filename
  const byTopic = new Map<string, DistillMemory[]>();
  for (const m of mems) {
    if (used.has(m.memory_id)) continue;
    const fn = m.filename.toLowerCase();
    for (const [kw, topic] of Object.entries(config.topic_keywords)) {
      if (fn.includes(kw)) {
        const key = `${m.role}::${topic}`;
        if (!byTopic.has(key)) byTopic.set(key, []);
        byTopic.get(key)!.push(m);
        break;
      }
    }
  }
  for (const [key, members] of byTopic) {
    if (members.length < config.topic_min_cluster_size) continue;
    const memberToks = members.map(m => tokenize(m.body));
    let pairs = 0, abovePairs = 0, sumSim = 0;
    for (let i = 0; i < memberToks.length; i++) {
      for (let j = i + 1; j < memberToks.length; j++) {
        pairs++;
        const s = jaccard(memberToks[i], memberToks[j]);
        sumSim += s;
        if (s >= config.topic_min_overlap) abovePairs++;
      }
    }
    const avgSim = pairs > 0 ? sumSim / pairs : 0;
    clusters.push({
      cluster_id: `topic-${key}`,
      strategy: 'topic_cluster',
      members,
      avg_similarity_hint: avgSim,
      signal: `${members.length} memories in topic "${key.split('::')[1]}" (role ${key.split('::')[0]}), avg sim ${avgSim.toFixed(2)}, ${abovePairs}/${pairs} pairs ≥ ${config.topic_min_overlap}`,
    });
    members.forEach(m => used.add(m.memory_id));
  }

  // Strategy 4: high content similarity within same role
  const remaining = mems.filter(m => !used.has(m.memory_id));
  const toks = new Map<string, Set<string>>();
  for (const m of remaining) toks.set(m.memory_id, tokenize(m.body));

  const byRole = new Map<string, DistillMemory[]>();
  for (const m of remaining) {
    if (!byRole.has(m.role)) byRole.set(m.role, []);
    byRole.get(m.role)!.push(m);
  }
  for (const [role, members] of byRole) {
    for (let i = 0; i < members.length; i++) {
      const m1 = members[i];
      if (used.has(m1.memory_id)) continue;
      const cluster = [m1];
      for (let j = i + 1; j < members.length; j++) {
        const m2 = members[j];
        if (used.has(m2.memory_id)) continue;
        const sim = jaccard(toks.get(m1.memory_id)!, toks.get(m2.memory_id)!);
        if (sim >= config.min_token_overlap) {
          cluster.push(m2);
          used.add(m2.memory_id);
        }
      }
      if (cluster.length >= 2) {
        used.add(m1.memory_id);
        clusters.push({
          cluster_id: `content-sim-${role}-${cluster[0].content_hash}`,
          strategy: 'content_similarity',
          members: cluster,
          signal: `${cluster.length} memories with token overlap ≥ ${config.min_token_overlap} in role ${role}`,
        });
      }
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

function composeMergedFilename(members: DistillMemory[]): string {
  const issueKey = members[0].issue_key;
  if (issueKey) {
    const longest = members.reduce((a, b) => a.filename.length >= b.filename.length ? a : b);
    return longest.filename.replace(/\.md$/, '-merged.md').toLowerCase();
  }
  return `${members[0].filename.replace(/\.md$/, '')}-merged.md`;
}

function composeMergedBody(sortedMembers: DistillMemory[]): string {
  const role = sortedMembers[0].role;
  const issueKey = sortedMembers[0].issue_key || 'merged';
  const sources = sortedMembers.map(m => m.memory_id);
  const sourcesYaml = `[${sources.map(s => `"${s}"`).join(', ')}]`;
  const today = new Date().toISOString().slice(0, 10);
  const name = sortedMembers[0].name || sortedMembers[0].filename.replace(/\.md$/, '');
  const description = sortedMembers
    .map(m => m.description)
    .filter(Boolean)
    .join(' / ') || `Merged memory covering ${issueKey}`;
  const type = sortedMembers[0].type || 'project';
  const mergedId = deriveLegacyId(role, sortedMembers[0].filename.replace(/\.md$/, '-merged.md'));

  const sections = sortedMembers.map((m, i) => {
    const heading = `## Source ${i + 1}: ${m.filename}\n_(${m.memory_id}, mtime ${new Date(m.mtime).toISOString().slice(0, 10)})_`;
    return `${heading}\n\n${m.body.trim()}`;
  });

  return `---
name: ${name}
description: ${description}
type: ${type}
memory_id: ${mergedId}
supersedes: ${sourcesYaml}
created_at: ${today}
---

# ${issueKey}: Merged Memory

> Auto-distilled by RYA-857 distill engine on ${today}.
> Combines ${sortedMembers.length} prior memories into one canonical record.
> Source memory IDs are preserved in \`supersedes\` for lineage queries.

${sections.join('\n\n---\n\n')}
`;
}

export function generateProposals(
  clusters: DistillCluster[],
  config: DistillConfig = loadDistillConfig(),
): DistillProposal[] {
  const proposals: DistillProposal[] = [];
  for (const cluster of clusters) {
    const sortedByMtime = [...cluster.members].sort((a, b) => a.mtime - b.mtime);
    const sourceIds = sortedByMtime.map(m => m.memory_id);
    const sourceFiles = sortedByMtime.map(m => m.filename);
    const totalSize = sortedByMtime.reduce((sum, m) => sum + m.body_size, 0);

    const toks = sortedByMtime.map(m => tokenize(m.body));
    let avgSim = 0;
    let pairs = 0;
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        avgSim += jaccard(toks[i], toks[j]);
        pairs++;
      }
    }
    avgSim = pairs > 0 ? avgSim / pairs : 0;

    let confidence = 0.5;
    let kind: ProposalKind = 'merge';
    let contradictionReason = '';

    if (cluster.strategy === 'same_rya') {
      confidence = 0.80 + Math.min(avgSim * 0.15, 0.15);
      kind = 'merge';
      if (avgSim < 0.10) {
        kind = 'merge_aspects';
        contradictionReason = `Same RYA-${cluster.members[0].issue_key!.split('-')[1]} but very low overlap (${avgSim.toFixed(2)}) — composing as separate sections`;
        confidence = 0.65;
      } else if (avgSim < 0.40) {
        kind = 'merge_aspects';
        contradictionReason = `Same RYA, partial overlap (${avgSim.toFixed(2)}) — composing as separate sections`;
        confidence = 0.72;
      }
    } else if (cluster.strategy === 'name_prefix') {
      confidence = 0.70 + Math.min(avgSim * 0.20, 0.20);
      kind = 'merge';
    } else if (cluster.strategy === 'topic_cluster') {
      // RYA-966: skip topic clusters whose avg overlap is below the configured
      // floor — these are heterogeneous filename-keyword matches that the
      // curator rejected at the Day-30 gate.
      if (avgSim < config.topic_min_overlap) continue;
      confidence = 0.45 + Math.min(avgSim * 0.30, 0.30);
      kind = avgSim >= 0.40 ? 'merge_topic' : 'flag_topic';
    } else if (cluster.strategy === 'content_similarity') {
      confidence = Math.min(avgSim, 0.85);
      kind = avgSim >= 0.65 ? 'merge_redundant' : 'flag_redundancy';
    }

    // RYA-966: confidence floor — drop weak associations before they reach
    // the curator. Engine-only FP rate target <15% per RYA-860 Day-30 gate.
    if (confidence < MIN_PROPOSAL_CONFIDENCE) continue;

    proposals.push({
      proposal_id: `prop_${randomUUID().slice(0, 12)}`,
      cluster_id: cluster.cluster_id,
      strategy: cluster.strategy,
      kind,
      role: cluster.members[0].role,
      issue_key: cluster.members[0].issue_key,
      source_memory_ids: sourceIds,
      source_files: sourceFiles,
      total_source_size: totalSize,
      avg_similarity: Number(avgSim.toFixed(3)),
      confidence: Number(confidence.toFixed(3)),
      contradiction_reason: contradictionReason,
      proposed_new_memory_id: deriveLegacyId(
        cluster.members[0].role,
        `MERGED-${cluster.members[0].issue_key || cluster.members[0].filename.replace(/\.md$/, '')}-${randomUUID().slice(0, 8)}.md`,
      ),
      proposed_filename: composeMergedFilename(cluster.members),
      proposed_merged_content: composeMergedBody(sortedByMtime),
      signal: cluster.signal,
    });
  }
  proposals.sort((a, b) => b.confidence - a.confidence);
  return proposals;
}

// ---------------------------------------------------------------------------
// A3.5: prune proposals (never-retrieved stale memories)
// ---------------------------------------------------------------------------

/** AOS_MEM_PRUNE_DAYS, default 30 — minimum age before a memory is prunable. */
export function memPruneDays(): number {
  const n = parseInt(process.env.AOS_MEM_PRUNE_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export interface MemoryUsage {
  retrieve_count: number;
  last_retrieved_at: string | null;
}

/**
 * Propose archiving memories with retrieve_count = 0 that are older than
 * AOS_MEM_PRUNE_DAYS. Pure: callers supply the usage map (keyed
 * `${role}::${filename}`, from memory-store retrieval tracking — A3.4).
 * PROPOSE-ONLY: prune proposals go through the same curated apply flow as
 * merges (existing archive machinery, restorable via `distill restore`).
 * Conservative: memories without a DB usage row (never synced) are skipped.
 */
export function generatePruneProposals(
  mems: DistillMemory[],
  usage: Map<string, MemoryUsage>,
  opts: { now?: Date; pruneDays?: number } = {},
): DistillProposal[] {
  const now = opts.now ?? new Date();
  const pruneDays = opts.pruneDays ?? memPruneDays();
  const maxMtime = now.getTime() - pruneDays * 24 * 60 * 60 * 1000;

  const proposals: DistillProposal[] = [];
  for (const m of mems) {
    const u = usage.get(`${m.role}::${m.filename}`);
    if (!u) continue; // not in DB — don't guess
    if (u.retrieve_count > 0) continue;
    if (m.mtime > maxMtime) continue; // too young

    const ageDays = Math.floor((now.getTime() - m.mtime) / (24 * 60 * 60 * 1000));
    proposals.push({
      proposal_id: `prop_${randomUUID().slice(0, 12)}`,
      cluster_id: `prune-${m.role}-${m.content_hash}`,
      strategy: 'prune_unused',
      kind: 'prune',
      role: m.role,
      issue_key: m.issue_key,
      source_memory_ids: [m.memory_id],
      source_files: [m.filename],
      total_source_size: m.body_size,
      avg_similarity: null,
      confidence: 0.6,
      contradiction_reason: '',
      proposed_new_memory_id: '',
      proposed_filename: '',
      proposed_merged_content: '',
      signal: `never retrieved (retrieve_count=0) and ${ageDays}d old (> ${pruneDays}d threshold)`,
    });
  }
  return proposals;
}

/**
 * Build the usage map for prune proposals from memory-store retrieval
 * tracking. Best-effort: an unavailable DB yields an empty map (=> no prune
 * proposals). The synthetic 'shared' role maps to the '_shared' agent_role.
 */
function loadUsageForRoles(roles: string[]): Map<string, MemoryUsage> {
  const usage = new Map<string, MemoryUsage>();
  try {
    for (const role of roles) {
      const dbRole = role === SHARED_ROLE ? '_shared' : role;
      for (const [file, info] of getMemoryRetrievalInfo(dbRole)) {
        usage.set(`${role}::${file}`, {
          retrieve_count: info.retrieve_count,
          last_retrieved_at: info.last_retrieved_at,
        });
      }
    }
  } catch {
    // memory DB unavailable — skip prune proposals this run
  }
  return usage;
}

// ---------------------------------------------------------------------------
// Run management
// ---------------------------------------------------------------------------

function runPath(runId: string): string {
  return join(DISTILL_DIR, `proposals-${runId}.json`);
}

function summaryPath(runId: string): string {
  return join(DISTILL_DIR, `proposals-${runId}.md`);
}

function logPath(runId: string): string {
  return join(DISTILL_DIR, `apply-log-${runId}.jsonl`);
}

export function loadRun(runId: string): DistillRunData {
  const p = runPath(runId);
  if (!existsSync(p)) throw new Error(`No such run: ${runId} (expected ${p})`);
  return JSON.parse(readFileSync(p, 'utf8')) as DistillRunData;
}

export function saveRun(runId: string, data: DistillRunData): void {
  ensureDir(DISTILL_DIR);
  writeFileSync(runPath(runId), JSON.stringify(data, null, 2));
}

export function listRuns(): string[] {
  if (!existsSync(DISTILL_DIR)) return [];
  return readdirSync(DISTILL_DIR)
    .filter(f => f.startsWith('proposals-') && f.endsWith('.json'))
    .map(f => f.replace(/^proposals-/, '').replace(/\.json$/, ''))
    .sort();
}

// ---------------------------------------------------------------------------
// Propose pipeline
// ---------------------------------------------------------------------------

export interface ProposeResult {
  run_id: string;
  proposals_path: string;
  summary_path: string;
  meta: DistillRunMeta;
  proposals: DistillProposal[];
}

export function runPropose(opts: { roles: string[]; config?: DistillConfig }): ProposeResult {
  const config = opts.config ?? loadDistillConfig();
  ensureDir(DISTILL_DIR);

  const mems = loadAllMemories(opts.roles, config);
  const clusters = clusterMemories(mems, config);
  const proposals = generateProposals(clusters, config);

  // A3.5: prune proposals for never-retrieved stale memories (propose-only).
  proposals.push(...generatePruneProposals(mems, loadUsageForRoles(opts.roles)));

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const meta: DistillRunMeta = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    roles: opts.roles,
    total_memories_scanned: mems.length,
    total_clusters: clusters.length,
    total_proposals: proposals.length,
    config,
  };

  const data: DistillRunData = { meta, proposals };
  writeFileSync(runPath(runId), JSON.stringify(data, null, 2));
  writeFileSync(summaryPath(runId), renderSummary(meta, proposals));

  return {
    run_id: runId,
    proposals_path: runPath(runId),
    summary_path: summaryPath(runId),
    meta,
    proposals,
  };
}

export function renderSummary(meta: DistillRunMeta, proposals: DistillProposal[]): string {
  let out = `# Distill Run ${meta.run_id}\n\n`;
  out += `Generated: ${meta.generated_at}\n`;
  out += `Roles: ${meta.roles.join(', ')}\n`;
  out += `Memories scanned: ${meta.total_memories_scanned}\n`;
  out += `Clusters: ${meta.total_clusters}\n`;
  out += `Proposals: ${meta.total_proposals}\n\n`;
  out += `## Proposals\n\n`;
  out += `| ID | Kind | Conf | Sim | Role | Issue | Sources | Reason |\n`;
  out += `|---|---|---|---|---|---|---|---|\n`;
  for (const p of proposals) {
    const reason = p.contradiction_reason || p.signal;
    const sources = p.source_files.map(f => '`' + f + '`').join(', ');
    out += `| ${p.proposal_id} | ${p.kind} | ${p.confidence} | ${p.avg_similarity ?? '—'} | ${p.role} | ${p.issue_key || '—'} | ${p.source_files.length} files: ${sources} | ${reason} |\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apply / reject
// ---------------------------------------------------------------------------

export function applyProposal(runId: string, proposal: DistillProposal): boolean {
  if (proposal.applied_at) return false;
  if (proposal.rejected_at) return false;

  const archiveDir = join(ARCHIVE_DIR, runId);
  ensureDir(archiveDir);

  const roleDir = getMemoryDirForRole(proposal.role);
  if (!existsSync(roleDir)) {
    throw new Error(`Role memory dir missing: ${roleDir}`);
  }

  // A3.5: prune proposals archive sources without writing a merged file.
  let finalPath: string | null = null;
  if (proposal.kind !== 'prune') {
    finalPath = join(roleDir, proposal.proposed_filename);
    let suffix = 1;
    while (existsSync(finalPath)) {
      finalPath = join(roleDir, proposal.proposed_filename.replace(/\.md$/, `-${suffix}.md`));
      suffix++;
    }

    writeFileSync(finalPath, proposal.proposed_merged_content);
  }

  const archivedFiles: { from: string; to: string }[] = [];
  for (const srcFile of proposal.source_files) {
    const srcPath = join(roleDir, srcFile);
    if (!existsSync(srcPath)) continue;
    if (srcPath === finalPath) continue;
    const dest = join(archiveDir, `${proposal.role}__${srcFile}`);
    renameSync(srcPath, dest);
    archivedFiles.push({ from: srcPath, to: dest });
  }

  proposal.applied_at = new Date().toISOString();
  proposal.applied_to = finalPath ?? `(pruned — archived to ${archiveDir})`;
  proposal.archived_files = archivedFiles;

  appendFileSync(logPath(runId), JSON.stringify({
    op: 'apply',
    proposal_id: proposal.proposal_id,
    timestamp: proposal.applied_at,
    merged_path: finalPath,
    sources: proposal.source_memory_ids,
    archived: archivedFiles.length,
  }) + '\n');

  return true;
}

export function rejectProposal(runId: string, proposal: DistillProposal, reason: string): boolean {
  if (proposal.applied_at) return false;
  if (proposal.rejected_at) return false;
  proposal.rejected_at = new Date().toISOString();
  proposal.rejection_reason = reason || 'no reason given';
  appendFileSync(logPath(runId), JSON.stringify({
    op: 'reject',
    proposal_id: proposal.proposal_id,
    timestamp: proposal.rejected_at,
    reason: proposal.rejection_reason,
  }) + '\n');
  return true;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function computeMetrics(runId: string, data: DistillRunData): DistillMetrics {
  const total = data.proposals.length;
  const applied = data.proposals.filter(p => p.applied_at).length;
  const rejected = data.proposals.filter(p => p.rejected_at).length;
  const pending = total - applied - rejected;

  const fpRate = (applied + rejected) > 0 ? rejected / (applied + rejected) : 0;

  const engineProposals = data.proposals.filter(p => p.strategy !== 'manual_topical');
  const engineApplied = engineProposals.filter(p => p.applied_at).length;
  const engineRejected = engineProposals.filter(p => p.rejected_at).length;
  const engineFpRate = (engineApplied + engineRejected) > 0
    ? engineRejected / (engineApplied + engineRejected)
    : 0;

  const archivedSources = new Set<string>();
  for (const p of data.proposals) {
    if (!p.applied_at) continue;
    for (const id of p.source_memory_ids) archivedSources.add(id);
  }
  const memoriesMerged = archivedSources.size;
  const memoriesAfter = data.meta.total_memories_scanned - memoriesMerged + applied;
  const reductionPct = data.meta.total_memories_scanned > 0
    ? (1 - memoriesAfter / data.meta.total_memories_scanned) * 100
    : 0;

  return {
    run_id: runId,
    total_proposals: total,
    engine_proposals: engineProposals.length,
    manual_proposals: total - engineProposals.length,
    applied,
    rejected,
    pending,
    false_positive_rate_combined: Number(fpRate.toFixed(3)),
    false_positive_rate_engine_only: Number(engineFpRate.toFixed(3)),
    memories_before: data.meta.total_memories_scanned,
    memories_merged_into_supersedes: memoriesMerged,
    memories_after_estimated: memoriesAfter,
    reduction_pct: Number(reductionPct.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Bulk apply
// ---------------------------------------------------------------------------

export interface BulkApplyOptions {
  kind?: string;
  minConfidence?: number;
  dryRun?: boolean;
  proposalId?: string;
}

export interface BulkApplyResult {
  candidates: number;
  applied: number;
  skipped: number;
  applied_proposals: { proposal_id: string; merged_path?: string }[];
}

export function runBulkApply(runId: string, opts: BulkApplyOptions): BulkApplyResult {
  const data = loadRun(runId);
  let candidates: DistillProposal[];

  if (opts.proposalId) {
    const p = data.proposals.find(p => p.proposal_id === opts.proposalId);
    if (!p) throw new Error(`No such proposal: ${opts.proposalId}`);
    candidates = [p];
  } else {
    const kind = opts.kind ?? 'all';
    const minConf = opts.minConfidence ?? 0;
    candidates = data.proposals.filter(p =>
      (kind === 'all' || p.kind === kind) &&
      p.confidence >= minConf &&
      !p.applied_at &&
      !p.rejected_at
    );
  }

  const result: BulkApplyResult = {
    candidates: candidates.length,
    applied: 0,
    skipped: 0,
    applied_proposals: [],
  };

  for (const p of candidates) {
    if (opts.dryRun) {
      result.applied_proposals.push({ proposal_id: p.proposal_id });
      continue;
    }
    const ok = applyProposal(runId, p);
    if (ok) {
      result.applied++;
      result.applied_proposals.push({ proposal_id: p.proposal_id, merged_path: p.applied_to });
    } else {
      result.skipped++;
    }
  }

  if (!opts.dryRun) saveRun(runId, data);
  return result;
}

// ---------------------------------------------------------------------------
// Archive operations
// ---------------------------------------------------------------------------

export interface ArchiveEntry {
  run_id: string;
  files: { filename: string; path: string; role: string; original_filename: string }[];
}

export function listArchives(): ArchiveEntry[] {
  if (!existsSync(ARCHIVE_DIR)) return [];
  const out: ArchiveEntry[] = [];
  for (const runId of readdirSync(ARCHIVE_DIR)) {
    const dir = join(ARCHIVE_DIR, runId);
    if (!statSync(dir).isDirectory()) continue;
    const files: ArchiveEntry['files'] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      // Format: <role>__<original-filename>
      const sep = f.indexOf('__');
      if (sep === -1) continue;
      const role = f.slice(0, sep);
      const original = f.slice(sep + 2);
      files.push({
        filename: f,
        path: join(dir, f),
        role,
        original_filename: original,
      });
    }
    out.push({ run_id: runId, files });
  }
  return out.sort((a, b) => a.run_id.localeCompare(b.run_id));
}

export interface RestoreResult {
  archived_path: string;
  restored_path: string;
  role: string;
}

export function restoreArchivedFile(runId: string, filename: string): RestoreResult {
  const archiveDir = join(ARCHIVE_DIR, runId);
  const archivedPath = join(archiveDir, filename);
  if (!existsSync(archivedPath)) {
    throw new Error(`Archive entry not found: ${archivedPath}`);
  }
  const sep = filename.indexOf('__');
  if (sep === -1) {
    throw new Error(`Archive filename does not match <role>__<original> format: ${filename}`);
  }
  const role = filename.slice(0, sep);
  const original = filename.slice(sep + 2);
  const targetDir = getMemoryDirForRole(role);
  const restoredPath = join(targetDir, original);

  if (existsSync(restoredPath)) {
    throw new Error(`Cannot restore: target already exists: ${restoredPath}`);
  }

  ensureDir(targetDir);
  renameSync(archivedPath, restoredPath);

  return { archived_path: archivedPath, restored_path: restoredPath, role };
}
