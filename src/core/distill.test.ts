import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  clusterMemories,
  generateProposals,
  generatePruneProposals,
  memPruneDays,
  getMemoryDirForRole,
  listAvailableRoles,
  loadDistillConfig,
  loadMemoriesForRole,
  MIN_PROPOSAL_CONFIDENCE,
  SHARED_MEMORY_DIR,
  SHARED_ROLE,
  type DistillCluster,
  type DistillConfig,
  type DistillMemory,
} from './distill.js';

// Construct a synthetic DistillMemory without touching disk. Token sets are
// derived from the body via the engine's own tokenizer, so test bodies use
// deliberately crafted vocabularies to control jaccard overlap.
function mkMem(opts: Partial<DistillMemory> & { filename: string; body: string }): DistillMemory {
  const role = opts.role ?? 'cto';
  const ryaMatch = opts.filename.match(/\b([A-Z]{2,5})-?(\d+)\b/i);
  const issueKey = opts.issue_key !== undefined
    ? opts.issue_key
    : (ryaMatch ? `${ryaMatch[1].toUpperCase()}-${ryaMatch[2]}` : null);
  return {
    memory_id: opts.memory_id ?? `mem_${role}_${opts.filename.replace(/\W/g, '').slice(0, 8)}`,
    role,
    filename: opts.filename,
    file_path: opts.file_path ?? `/tmp/${opts.filename}`,
    issue_key: issueKey,
    name: opts.name ?? opts.filename.replace(/\.md$/, ''),
    description: opts.description ?? '',
    type: opts.type ?? 'project',
    content: opts.content ?? opts.body,
    body: opts.body,
    body_size: opts.body_size ?? opts.body.length,
    content_hash: opts.content_hash ?? opts.filename,
    mtime: opts.mtime ?? Date.now(),
  };
}

describe('DEFAULT_CONFIG (RYA-966 thresholds)', () => {
  it('exposes the raised content-similarity floor and topic floor', () => {
    const cfg = loadDistillConfig();
    expect(cfg.min_token_overlap).toBeGreaterThanOrEqual(0.40);
    expect(cfg.topic_min_overlap).toBeGreaterThanOrEqual(0.20);
  });

  it('exposes a 0.50 confidence floor', () => {
    expect(MIN_PROPOSAL_CONFIDENCE).toBe(0.50);
  });
});

describe('clusterMemories — same_rya happy path', () => {
  it('clusters two memories sharing an issue key into a same_rya cluster', () => {
    const mems = [
      mkMem({ filename: 'rya-100-foo.md', body: 'router evaluation framework testing infrastructure node setup configuration alpha gamma'.repeat(4) }),
      mkMem({ filename: 'rya-100-bar.md', body: 'router evaluation framework testing infrastructure node setup configuration beta delta'.repeat(4) }),
    ];
    const clusters = clusterMemories(mems);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].strategy).toBe('same_rya');
    expect(clusters[0].members).toHaveLength(2);
  });

  it('produces a high-confidence merge proposal for high-overlap same-RYA pairs', () => {
    const shared = 'router evaluation framework testing infrastructure node setup configuration ';
    const mems = [
      mkMem({ filename: 'rya-100-foo.md', body: shared.repeat(8) + ' alpha' }),
      mkMem({ filename: 'rya-100-bar.md', body: shared.repeat(8) + ' beta' }),
    ];
    const proposals = generateProposals(clusterMemories(mems));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe('merge');
    expect(proposals[0].strategy).toBe('same_rya');
    // High overlap → confidence >= 0.85 per generateProposals math.
    expect(proposals[0].confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('still emits a proposal for low-overlap same-RYA pairs (composes as aspects)', () => {
    // Same RYA but disjoint vocabularies — engine should still merge as
    // separate sections (not flag), since same_rya is the gold strategy.
    const mems = [
      mkMem({ filename: 'rya-101-config.md', body: 'apple banana cherry grape lemon mango orange peach plum kiwi'.repeat(3) }),
      mkMem({ filename: 'rya-101-runtime.md', body: 'planet asteroid comet meteor nebula galaxy supernova quasar pulsar'.repeat(3) }),
    ];
    const proposals = generateProposals(clusterMemories(mems));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].strategy).toBe('same_rya');
    expect(proposals[0].kind).toBe('merge_aspects');
    expect(proposals[0].confidence).toBeGreaterThanOrEqual(MIN_PROPOSAL_CONFIDENCE);
  });
});

describe('clusterMemories — heterogeneous burst is no longer proposed', () => {
  it('emits zero clusters for sequential RYAs with disjoint vocabularies', () => {
    // Pre-RYA-966 these would have formed a burst_cluster (sequential RYAs in
    // the same role, all <2KB). After RYA-966 the burst_cluster strategy was
    // removed because curators rejected 100% of these (7/7 at Day-30 gate).
    // With distinct filename bases, no topic keyword in filename, and no
    // pairwise content overlap, nothing else should fire either.
    const mems = [
      mkMem({ filename: 'rya-200-alpha.md', body: 'apple banana cherry grape lemon mango orange peach plum kiwi'.repeat(8) }),
      mkMem({ filename: 'rya-201-beta.md', body: 'planet asteroid comet meteor nebula galaxy supernova quasar pulsar'.repeat(8) }),
      mkMem({ filename: 'rya-202-gamma.md', body: 'piano violin cello flute drums guitar harp tuba banjo'.repeat(8) }),
      mkMem({ filename: 'rya-203-zeta.md', body: 'maple birch willow walnut chestnut almond pecan pistachio'.repeat(8) }),
      mkMem({ filename: 'rya-204-iota.md', body: 'soccer hockey tennis cricket bowling archery skating boxing'.repeat(8) }),
      mkMem({ filename: 'rya-205-kappa.md', body: 'silk wool cotton linen denim leather suede nylon'.repeat(8) }),
    ];
    const clusters = clusterMemories(mems);
    expect(clusters).toHaveLength(0);

    const proposals = generateProposals(clusters);
    expect(proposals).toHaveLength(0);
    // Defensive: even if a future strategy regrouped them, no flag_burst kind.
    expect(proposals.find(p => p.kind === 'flag_burst')).toBeUndefined();
  });
});

describe('generateProposals — topic floor', () => {
  it('drops topic_cluster proposals whose avg overlap is below 0.20', () => {
    // 3 memories whose filenames contain "router" (a topic_keyword) but whose
    // bodies share no tokens. clusterMemories will form the topic_cluster
    // (filename-keyword match), but generateProposals must skip it because
    // avgSim < topic_min_overlap.
    const mems = [
      mkMem({ filename: 'router-alpha-notes.md', body: 'apple banana cherry grape lemon mango orange peach plum kiwi'.repeat(5) }),
      mkMem({ filename: 'router-beta-notes.md', body: 'planet asteroid comet meteor nebula galaxy supernova quasar pulsar'.repeat(5) }),
      mkMem({ filename: 'router-gamma-notes.md', body: 'piano violin cello flute drums guitar harp tuba banjo'.repeat(5) }),
    ];
    const clusters = clusterMemories(mems);
    expect(clusters.find(c => c.strategy === 'topic_cluster')).toBeDefined();

    const proposals = generateProposals(clusters);
    expect(proposals.find(p => p.strategy === 'topic_cluster')).toBeUndefined();
    expect(proposals).toHaveLength(0);
  });

  it('emits a flag_topic proposal when avg overlap is at or above 0.20', () => {
    // Each memory shares 5 jargon tokens plus 6 distinct ones — pairwise
    // jaccard ≈ 5/17 ≈ 0.29, comfortably above the 0.20 floor and below the
    // 0.40 merge_topic threshold → flag_topic.
    const shared = 'router evaluation pipeline testing framework';
    const mems = [
      mkMem({ filename: 'router-eval-config.md', body: `${shared} alphas gammas deltas yotta omegas kappa`.repeat(4) }),
      mkMem({ filename: 'router-eval-runtime.md', body: `${shared} mango papaya guava grape banana lychee`.repeat(4) }),
      mkMem({ filename: 'router-eval-dispatch.md', body: `${shared} mountain canyon meadow forest valley plateau`.repeat(4) }),
    ];
    const proposals = generateProposals(clusterMemories(mems));
    const tp = proposals.find(p => p.strategy === 'topic_cluster');
    expect(tp).toBeDefined();
    expect(tp!.kind).toBe('flag_topic');
    expect(tp!.confidence).toBeGreaterThanOrEqual(MIN_PROPOSAL_CONFIDENCE);
  });
});

describe('generateProposals — confidence floor', () => {
  it('drops proposals below the 0.50 confidence floor', () => {
    // Synthetic content_similarity cluster: confidence == min(avgSim, 0.85)
    // for that strategy, so we feed two memories with overlap below 0.50 and
    // assert the proposal is dropped.
    const memA = mkMem({
      filename: 'one.md',
      body: 'alpha beta gamma delta epsilon zeta theta iota kappa lambda'.repeat(3),
    });
    const memB = mkMem({
      filename: 'two.md',
      body: 'alpha beta gamma delta epsilon mango papaya guava grape banana'.repeat(3),
    });
    // Overlap on {alpha, beta, gamma, delta, epsilon} = 5 of 15 union ≈ 0.33.
    const cluster: DistillCluster = {
      cluster_id: 'content-sim-test-low',
      strategy: 'content_similarity',
      members: [memA, memB],
      signal: 'synthetic — low overlap',
    };
    expect(generateProposals([cluster])).toHaveLength(0);
  });

  it('keeps proposals at or above the 0.50 confidence floor', () => {
    const shared = 'alpha beta gamma delta epsilon zeta theta iota kappa lambda mu pi xi';
    const memA = mkMem({ filename: 'a.md', body: `${shared} apple` });
    const memB = mkMem({ filename: 'b.md', body: `${shared} banana` });
    const cluster: DistillCluster = {
      cluster_id: 'content-sim-test-high',
      strategy: 'content_similarity',
      members: [memA, memB],
      signal: 'synthetic — high overlap',
    };
    const proposals = generateProposals([cluster]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].confidence).toBeGreaterThanOrEqual(MIN_PROPOSAL_CONFIDENCE);
  });

  it('respects an explicit config override for the topic floor', () => {
    // Same payload as the above topic-floor "drop" case, but with an explicit
    // config that loosens the floor — proposal should now be emitted.
    const baseCfg = loadDistillConfig();
    const loose: DistillConfig = { ...baseCfg, topic_min_overlap: 0.0 };
    const mems = [
      mkMem({ filename: 'router-alpha-notes.md', body: 'apple banana cherry grape lemon mango orange peach plum kiwi'.repeat(5) }),
      mkMem({ filename: 'router-beta-notes.md', body: 'planet asteroid comet meteor nebula galaxy supernova quasar pulsar'.repeat(5) }),
      mkMem({ filename: 'router-gamma-notes.md', body: 'piano violin cello flute drums guitar harp tuba banjo'.repeat(5) }),
    ];
    const proposals = generateProposals(clusterMemories(mems, loose), loose);
    // Even with the topic floor disabled, the 0.50 confidence floor still
    // kicks in (avgSim ≈ 0 → confidence ≈ 0.45) → no proposal.
    expect(proposals).toHaveLength(0);
  });
});

describe('shared role (RYA-973)', () => {
  it('SHARED_ROLE is the synthetic role name for the cross-agent corpus', () => {
    expect(SHARED_ROLE).toBe('shared');
  });

  it('SHARED_MEMORY_DIR points to ~/.aos/shared-memory/', () => {
    expect(SHARED_MEMORY_DIR).toBe(join(homedir(), '.aos', 'shared-memory'));
  });

  it('getMemoryDirForRole(SHARED_ROLE) returns SHARED_MEMORY_DIR', () => {
    expect(getMemoryDirForRole(SHARED_ROLE)).toBe(SHARED_MEMORY_DIR);
  });

  it('getMemoryDirForRole(other) returns the per-agent memory dir', () => {
    const dir = getMemoryDirForRole('cto');
    expect(dir).toMatch(/[\/\\]agents[\/\\]cto[\/\\]memory$/);
    expect(dir).not.toBe(SHARED_MEMORY_DIR);
  });

  // Disk-touching test: write a small fixture into the real shared-memory
  // directory under a unique sentinel filename, run the loader, then clean up.
  // We can't easily mock STATE_DIR (computed at import time), so this is the
  // simplest hermetic-enough path. Skip cleanly if the dir does not exist —
  // production hosts always have it; bare CI may not.
  it('loadMemoriesForRole(SHARED_ROLE) reads from ~/.aos/shared-memory/', () => {
    if (!existsSync(SHARED_MEMORY_DIR)) {
      // Bare environment without shared memory — create+delete the dir entirely.
      mkdirSync(SHARED_MEMORY_DIR, { recursive: true });
    }
    const fixturePath = join(SHARED_MEMORY_DIR, '__rya973-test-fixture.md');
    const fixtureBody = 'rya-973 shared role test fixture body content '.repeat(5);
    const fixture = `---
name: rya-973-fixture
description: synthetic test fixture for shared role loading
type: project
---

${fixtureBody}`;

    try {
      writeFileSync(fixturePath, fixture);
      const mems = loadMemoriesForRole(SHARED_ROLE);
      const fixtureMem = mems.find(m => m.filename === '__rya973-test-fixture.md');
      expect(fixtureMem).toBeDefined();
      expect(fixtureMem!.role).toBe(SHARED_ROLE);
      expect(fixtureMem!.file_path).toBe(fixturePath);
      expect(fixtureMem!.name).toBe('rya-973-fixture');
    } finally {
      if (existsSync(fixturePath)) rmSync(fixturePath);
    }
  });

  it('listAvailableRoles() includes SHARED_ROLE when ~/.aos/shared-memory/ exists', () => {
    const created = !existsSync(SHARED_MEMORY_DIR);
    if (created) mkdirSync(SHARED_MEMORY_DIR, { recursive: true });
    try {
      const roles = listAvailableRoles();
      expect(roles).toContain(SHARED_ROLE);
    } finally {
      // Only remove if we created it AND it is empty (don't nuke real data).
      if (created && existsSync(SHARED_MEMORY_DIR) && readdirSync(SHARED_MEMORY_DIR).length === 0) {
        rmSync(SHARED_MEMORY_DIR, { recursive: true });
      }
    }
  });
});

describe('generatePruneProposals (A3.5)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-06-10T00:00:00Z');
  const oldMtime = now.getTime() - 45 * DAY;
  const freshMtime = now.getTime() - 2 * DAY;

  function usageMap(entries: [string, number][]): Map<string, { retrieve_count: number; last_retrieved_at: string | null }> {
    return new Map(entries.map(([k, c]) => [k, { retrieve_count: c, last_retrieved_at: c > 0 ? '2026-06-01 00:00:00' : null }]));
  }

  it('proposes pruning never-retrieved memories older than the threshold', () => {
    const mems = [mkMem({ filename: 'stale-notes.md', body: 'old unused memory content here padding padding padding padding padding'.repeat(3), mtime: oldMtime, issue_key: null })];
    const usage = usageMap([['cto::stale-notes.md', 0]]);
    const proposals = generatePruneProposals(mems, usage, { now });

    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.kind).toBe('prune');
    expect(p.strategy).toBe('prune_unused');
    expect(p.role).toBe('cto');
    expect(p.source_files).toEqual(['stale-notes.md']);
    expect(p.proposed_merged_content).toBe('');
    expect(p.signal).toContain('never retrieved');
    // propose-only: no applied_at set at generation time
    expect(p.applied_at).toBeUndefined();
  });

  it('does not propose pruning retrieved or young memories', () => {
    const mems = [
      mkMem({ filename: 'used-notes.md', body: 'retrieved memory body content padding padding padding padding padding'.repeat(3), mtime: oldMtime, issue_key: null }),
      mkMem({ filename: 'young-notes.md', body: 'fresh memory body content padding padding padding padding padding pad'.repeat(3), mtime: freshMtime, issue_key: null }),
    ];
    const usage = usageMap([['cto::used-notes.md', 5], ['cto::young-notes.md', 0]]);
    expect(generatePruneProposals(mems, usage, { now })).toHaveLength(0);
  });

  it('skips memories without a DB usage row (conservative)', () => {
    const mems = [mkMem({ filename: 'unsynced.md', body: 'memory not in database yet padding padding padding padding padding pad'.repeat(3), mtime: oldMtime, issue_key: null })];
    expect(generatePruneProposals(mems, new Map(), { now })).toHaveLength(0);
  });

  it('honours AOS_MEM_PRUNE_DAYS via memPruneDays default path', () => {
    expect(memPruneDays()).toBe(30);
    process.env.AOS_MEM_PRUNE_DAYS = '60';
    try {
      expect(memPruneDays()).toBe(60);
      const mems = [mkMem({ filename: 'midage.md', body: 'forty five day old memory content padding padding padding padding pad'.repeat(3), mtime: oldMtime, issue_key: null })];
      const usage = usageMap([['cto::midage.md', 0]]);
      // 45d old < 60d threshold → not prunable
      expect(generatePruneProposals(mems, usage, { now })).toHaveLength(0);
    } finally {
      delete process.env.AOS_MEM_PRUNE_DAYS;
    }
  });
});

describe('applyProposal — prune kind (A3.5)', () => {
  it('archives the source file without writing a merged file', async () => {
    const { applyProposal, ARCHIVE_DIR } = await import('./distill.js');
    const role = '__distill-prune-test-role';
    const roleDir = getMemoryDirForRole(role);
    const runId = `test-prune-${Date.now()}`;
    const archiveDir = join(ARCHIVE_DIR, runId);
    const distillDir = join(homedir(), '.aos', 'distill');
    mkdirSync(roleDir, { recursive: true });
    const srcPath = join(roleDir, 'prunable.md');
    writeFileSync(srcPath, 'stale content');

    const proposal: import('./distill.js').DistillProposal = {
      proposal_id: 'prop_prunetest',
      cluster_id: 'prune-test',
      strategy: 'prune_unused',
      kind: 'prune',
      role,
      issue_key: null,
      source_memory_ids: ['mem_x'],
      source_files: ['prunable.md'],
      total_source_size: 13,
      avg_similarity: null,
      confidence: 0.6,
      contradiction_reason: '',
      proposed_new_memory_id: '',
      proposed_filename: '',
      proposed_merged_content: '',
      signal: 'test',
    };

    try {
      const ok = applyProposal(runId, proposal);
      expect(ok).toBe(true);
      // Source archived
      expect(existsSync(srcPath)).toBe(false);
      expect(existsSync(join(archiveDir, `${role}__prunable.md`))).toBe(true);
      // No merged file created in the role dir
      expect(readdirSync(roleDir)).toHaveLength(0);
      expect(proposal.applied_at).toBeDefined();
      expect(proposal.applied_to).toContain('pruned');
    } finally {
      rmSync(join(homedir(), '.aos', 'agents', role), { recursive: true, force: true });
      rmSync(archiveDir, { recursive: true, force: true });
      const logFile = join(distillDir, `apply-log-${runId}.jsonl`);
      if (existsSync(logFile)) rmSync(logFile);
    }
  });
});
