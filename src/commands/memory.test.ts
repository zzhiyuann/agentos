/**
 * Tests for `aos memory distill` CLI commands (RYA-967).
 *
 * Tests the CLI plumbing layer in src/commands/memory.ts. The underlying
 * engine in src/core/distill.ts has its own engine-level coverage; here
 * we verify:
 *   - Option parsing routes through the right engine functions
 *   - --notify wires postToDiscord
 *   - Error paths exit non-zero (missing run-id, bad min-confidence, etc.)
 *   - --json mode produces machine-readable output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the engine so we can verify call arguments without scanning the real
// ~/.aos/agents/ directory in tests.
vi.mock('../core/distill.js', () => ({
  runPropose: vi.fn(),
  listRuns: vi.fn(),
  loadRun: vi.fn(),
  saveRun: vi.fn(),
  applyProposal: vi.fn(),
  rejectProposal: vi.fn(),
  computeMetrics: vi.fn(),
  runBulkApply: vi.fn(),
  restoreArchivedFile: vi.fn(),
  listAvailableRoles: vi.fn(),
  loadDistillConfig: vi.fn(() => ({})),
  DISTILL_DIR: '/tmp/distill-test',
  ARCHIVE_DIR: '/tmp/distill-test/archive',
}));

vi.mock('../core/discord.js', () => ({
  postToDiscord: vi.fn(),
}));

import * as engine from '../core/distill.js';
import { postToDiscord } from '../core/discord.js';
import {
  distillProposeCommand, distillApplyCommand, distillRejectCommand,
  distillMetricsCommand, distillListRunsCommand, distillRestoreCommand,
} from './memory.js';

describe('distillProposeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    (engine.runPropose as ReturnType<typeof vi.fn>).mockReturnValue({
      run_id: 'run-test',
      proposals_path: '/tmp/proposals.json',
      summary_path: '/tmp/proposals.md',
      meta: {
        run_id: 'run-test',
        generated_at: '2026-05-06T00:00:00Z',
        roles: ['lead-engineer'],
        total_memories_scanned: 100,
        total_clusters: 10,
        total_proposals: 12,
        config: {},
      },
      proposals: [],
    });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('routes --role <name> through runPropose with single role', async () => {
    await distillProposeCommand({ role: 'lead-engineer' });
    expect(engine.runPropose).toHaveBeenCalledWith({ roles: ['lead-engineer'] });
    expect(process.exitCode).not.toBe(1);
  });

  it('--all-roles fans out to listAvailableRoles()', async () => {
    (engine.listAvailableRoles as ReturnType<typeof vi.fn>).mockReturnValue(['cto', 'cpo', 'lead-engineer']);
    await distillProposeCommand({ allRoles: true });
    expect(engine.runPropose).toHaveBeenCalledWith({ roles: ['cto', 'cpo', 'lead-engineer'] });
  });

  it('exits 1 when neither --role nor --all-roles given', async () => {
    (engine.listAvailableRoles as ReturnType<typeof vi.fn>).mockReturnValue([]);
    await distillProposeCommand({});
    expect(process.exitCode).toBe(1);
    expect(engine.runPropose).not.toHaveBeenCalled();
  });

  it('--notify posts a Discord summary referencing the run', async () => {
    (postToDiscord as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await distillProposeCommand({ role: 'lead-engineer', notify: true });
    expect(postToDiscord).toHaveBeenCalled();
    const [role, msg] = (postToDiscord as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(role).toBe('system');
    expect(msg).toContain('run-test');
    expect(msg).toContain('aos memory distill apply');
  });

  it('does NOT call postToDiscord without --notify', async () => {
    await distillProposeCommand({ role: 'lead-engineer' });
    expect(postToDiscord).not.toHaveBeenCalled();
  });
});

describe('distillApplyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    (engine.runBulkApply as ReturnType<typeof vi.fn>).mockReturnValue({
      candidates: 5,
      applied: 5,
      skipped: 0,
      applied_proposals: [],
    });
  });

  it('exits 1 with no run-id', async () => {
    await distillApplyCommand('');
    expect(process.exitCode).toBe(1);
    expect(engine.runBulkApply).not.toHaveBeenCalled();
  });

  it('exits 1 when no filters supplied (RYA-972 footgun)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await distillApplyCommand('run-x');
    expect(process.exitCode).toBe(1);
    expect(engine.runBulkApply).not.toHaveBeenCalled();
    const printed = errSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toMatch(/No filters supplied/);
    expect(printed).toMatch(/--proposal-id/);
    expect(printed).toMatch(/--kind/);
    expect(printed).toMatch(/--min-confidence/);
    errSpy.mockRestore();
  });

  it('--dry-run alone is still rejected (no filters)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await distillApplyCommand('run-x', { dryRun: true });
    expect(process.exitCode).toBe(1);
    expect(engine.runBulkApply).not.toHaveBeenCalled();
  });

  it('parses --min-confidence as float', async () => {
    await distillApplyCommand('run-x', { minConfidence: '0.65' });
    const opts = (engine.runBulkApply as ReturnType<typeof vi.fn>).mock.calls[0][1] as { minConfidence: number };
    expect(opts.minConfidence).toBeCloseTo(0.65);
  });

  it('--min-confidence 0 is accepted as an explicit filter (not treated as missing)', async () => {
    await distillApplyCommand('run-x', { minConfidence: '0' });
    expect(engine.runBulkApply).toHaveBeenCalled();
    const opts = (engine.runBulkApply as ReturnType<typeof vi.fn>).mock.calls[0][1] as { minConfidence: number };
    expect(opts.minConfidence).toBe(0);
  });

  it('exits 1 on non-numeric --min-confidence', async () => {
    await distillApplyCommand('run-x', { minConfidence: 'banana' });
    expect(process.exitCode).toBe(1);
    expect(engine.runBulkApply).not.toHaveBeenCalled();
  });

  it('threads --proposal-id, --kind, --dry-run', async () => {
    await distillApplyCommand('run-x', {
      proposalId: 'prop_abc',
      kind: 'merge',
      dryRun: true,
    });
    const [runId, opts] = (engine.runBulkApply as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runId).toBe('run-x');
    expect(opts.proposalId).toBe('prop_abc');
    expect(opts.kind).toBe('merge');
    expect(opts.dryRun).toBe(true);
  });

  it('catches engine errors and exits 1', async () => {
    (engine.runBulkApply as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('No such run: run-x');
    });
    await distillApplyCommand('run-x', { kind: 'merge' });
    expect(process.exitCode).toBe(1);
  });
});

describe('distillRejectCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    (engine.loadRun as ReturnType<typeof vi.fn>).mockReturnValue({
      meta: { run_id: 'run-x' },
      proposals: [{ proposal_id: 'prop_a', confidence: 0.8 }],
    });
    (engine.rejectProposal as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('exits 1 with no run-id or proposal-id', async () => {
    await distillRejectCommand('', '');
    expect(process.exitCode).toBe(1);
    expect(engine.loadRun).not.toHaveBeenCalled();
  });

  it('exits 1 when proposal not in run', async () => {
    await distillRejectCommand('run-x', 'prop_missing');
    expect(process.exitCode).toBe(1);
    expect(engine.rejectProposal).not.toHaveBeenCalled();
  });

  it('threads --reason through to engine and persists run', async () => {
    await distillRejectCommand('run-x', 'prop_a', { reason: 'low signal' });
    expect(engine.rejectProposal).toHaveBeenCalledWith('run-x', expect.any(Object), 'low signal');
    expect(engine.saveRun).toHaveBeenCalled();
  });

  it('uses default reason when --reason omitted', async () => {
    await distillRejectCommand('run-x', 'prop_a');
    const [, , reason] = (engine.rejectProposal as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(reason).toBe('no reason given');
  });
});

describe('distillMetricsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    (engine.loadRun as ReturnType<typeof vi.fn>).mockReturnValue({
      meta: { run_id: 'run-x', total_memories_scanned: 100 },
      proposals: [],
    });
    (engine.computeMetrics as ReturnType<typeof vi.fn>).mockReturnValue({
      run_id: 'run-x',
      total_proposals: 14,
      engine_proposals: 14,
      manual_proposals: 0,
      applied: 6,
      rejected: 8,
      pending: 0,
      false_positive_rate_combined: 0.571,
      false_positive_rate_engine_only: 0.571,
      memories_before: 100,
      memories_merged_into_supersedes: 12,
      memories_after_estimated: 88,
      reduction_pct: 12,
    });
  });

  it('exits 1 with no run-id', async () => {
    await distillMetricsCommand('');
    expect(process.exitCode).toBe(1);
  });

  it('--json prints raw metrics object', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await distillMetricsCommand('run-x', { json: true });
    const printed = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('"run_id"');
    expect(printed).toContain('"reduction_pct"');
    logSpy.mockRestore();
  });

  it('exits 1 when run cannot be loaded', async () => {
    (engine.loadRun as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('No such run: run-missing');
    });
    await distillMetricsCommand('run-missing');
    expect(process.exitCode).toBe(1);
  });
});

describe('distillListRunsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it('lists runs from engine.listRuns()', async () => {
    (engine.listRuns as ReturnType<typeof vi.fn>).mockReturnValue(['run-1', 'run-2']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await distillListRunsCommand();
    const printed = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('run-1');
    expect(printed).toContain('run-2');
    logSpy.mockRestore();
  });

  it('--json wraps the list', async () => {
    (engine.listRuns as ReturnType<typeof vi.fn>).mockReturnValue(['run-1']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await distillListRunsCommand({ json: true });
    const printed = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('"runs"');
    expect(printed).toContain('"run-1"');
    logSpy.mockRestore();
  });

  it('handles empty list gracefully (no exit code change)', async () => {
    (engine.listRuns as ReturnType<typeof vi.fn>).mockReturnValue([]);
    await distillListRunsCommand();
    expect(process.exitCode).not.toBe(1);
  });
});

describe('distillRestoreCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it('exits 1 if only run-id given (no filename, no --list)', async () => {
    await distillRestoreCommand('run-x', undefined);
    expect(process.exitCode).toBe(1);
    expect(engine.restoreArchivedFile).not.toHaveBeenCalled();
  });

  it('routes both args through to engine.restoreArchivedFile', async () => {
    (engine.restoreArchivedFile as ReturnType<typeof vi.fn>).mockReturnValue({
      archived_path: '/tmp/a',
      restored_path: '/tmp/b',
      role: 'lead-engineer',
    });
    await distillRestoreCommand('run-x', 'lead-engineer__foo.md');
    expect(engine.restoreArchivedFile).toHaveBeenCalledWith('run-x', 'lead-engineer__foo.md');
  });

  it('catches engine errors and exits 1', async () => {
    (engine.restoreArchivedFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Archive entry not found');
    });
    await distillRestoreCommand('run-x', 'missing.md');
    expect(process.exitCode).toBe(1);
  });
});
