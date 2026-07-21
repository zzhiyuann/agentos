import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../core/linear.js', () => ({ getIssue: vi.fn() }));
vi.mock('../core/persona.js', () => ({ agentExists: vi.fn(() => true) }));
vi.mock('./dispatch.js', () => ({ handleDispatch: vi.fn(async () => ({ action: 'dispatched' })) }));

import {
  classifyReviewLevel, detectReviewerFromDescription, autoDispatchReviewer,
} from './review-dispatcher.js';
import * as linear from '../core/linear.js';
import * as persona from '../core/persona.js';
import * as dispatch from './dispatch.js';
import type { HandoffActions } from './handoff-executor.js';

const emptyActions: HandoffActions = {
  statusIntent: null, dispatches: [], delegate: null,
  parentStatus: null, reviewDispatch: null, reviewLevel: null,
};

// ─── classifyReviewLevel ──────────────────────────────────────────────────────

describe('classifyReviewLevel', () => {
  const handoff = (extra = '') => `---\nstatus_intent: in-review\n${extra}---\n# HANDOFF`;

  it('defaults to cto for internal work', () => {
    expect(classifyReviewLevel('Implement new endpoint', handoff(), 'lead-engineer')).toBe('cto');
  });

  it('escalates to ceo for security titles', () => {
    expect(classifyReviewLevel('Update auth middleware', handoff(), 'lead-engineer')).toBe('ceo');
  });

  it('escalates to ceo for architecture', () => {
    expect(classifyReviewLevel('Architecture redesign', handoff(), 'lead-engineer')).toBe('ceo');
  });

  it('escalates to ceo for production deploy', () => {
    expect(classifyReviewLevel('Deploy prod', handoff(), 'coo')).toBe('ceo');
  });

  it('escalates to ceo when builder is cto', () => {
    expect(classifyReviewLevel('Internal refactor', handoff(), 'cto')).toBe('ceo');
  });

  it('escalates to ceo when builder is cpo', () => {
    expect(classifyReviewLevel('Update specs', handoff(), 'cpo')).toBe('ceo');
  });

  it('allows cto review for lead-engineer standard work', () => {
    expect(classifyReviewLevel('Add pagination', handoff(), 'lead-engineer')).toBe('cto');
  });

  it('respects review_level: ceo override', () => {
    expect(classifyReviewLevel('Safe change', handoff('review_level: ceo\n'), 'lead-engineer')).toBe('ceo');
  });

  it('respects review_level: cto override even for security titles', () => {
    expect(classifyReviewLevel('Update auth', handoff('review_level: cto\n'), 'lead-engineer')).toBe('cto');
  });

  it('escalates to ceo based on HANDOFF reason', () => {
    const h = '---\nstatus_intent: in-review\nreason: "Breaking change to auth"\n---\n# HANDOFF';
    expect(classifyReviewLevel('Update middleware', h, 'lead-engineer')).toBe('ceo');
  });

  it('escalates to ceo for external-facing', () => {
    expect(classifyReviewLevel('Public-facing API update', handoff(), 'lead-engineer')).toBe('ceo');
  });

  it('escalates to ceo for OSS release', () => {
    expect(classifyReviewLevel('OSS release v1.0', handoff(), 'lead-engineer')).toBe('ceo');
  });
});

// ─── detectReviewerFromDescription ───────────────────────────────────────────

describe('detectReviewerFromDescription', () => {
  it('detects Reviewer: CTO', () => {
    expect(detectReviewerFromDescription('Build it.\nReviewer: CTO')).toBe('cto');
  });

  it('detects Cross-review: CPO', () => {
    expect(detectReviewerFromDescription('Cross-review: CPO')).toBe('cpo');
  });

  it('detects Review by: lead-engineer', () => {
    expect(detectReviewerFromDescription('Review by: lead-engineer')).toBe('lead-engineer');
  });

  it('is case-insensitive', () => {
    expect(detectReviewerFromDescription('REVIEWER: cto')).toBe('cto');
  });

  it('returns null when no pattern found', () => {
    expect(detectReviewerFromDescription('Just a description')).toBeNull();
  });

  it('returns null for undefined/empty', () => {
    expect(detectReviewerFromDescription(undefined)).toBeNull();
    expect(detectReviewerFromDescription('')).toBeNull();
  });

  it('normalizes leadengineer to lead-engineer', () => {
    expect(detectReviewerFromDescription('Reviewer: leadengineer')).toBe('lead-engineer');
  });
});

// ─── autoDispatchReviewer ─────────────────────────────────────────────────────

describe('autoDispatchReviewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(linear.getIssue).mockResolvedValue({ description: null, title: 'Test Issue' } as any);
    vi.mocked(persona.agentExists).mockReturnValue(true);
    vi.mocked(dispatch.handleDispatch).mockResolvedValue({ action: 'dispatched' } as any);
  });

  it('dispatches from review_dispatch in HANDOFF', async () => {
    const actions = { ...emptyActions, reviewDispatch: 'cto' };
    await autoDispatchReviewer('RYA-1', 'id-1', 'Title', 'lead-engineer', actions);
    expect(dispatch.handleDispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'cto' }));
  });

  it('skips when reviewer equals builder (no self-review)', async () => {
    const actions = { ...emptyActions, reviewDispatch: 'cto' };
    await autoDispatchReviewer('RYA-1', 'id-1', 'Title', 'cto', actions);
    expect(dispatch.handleDispatch).not.toHaveBeenCalled();
  });

  it('skips when reviewer agent does not exist', async () => {
    vi.mocked(persona.agentExists).mockReturnValue(false);
    const actions = { ...emptyActions, reviewDispatch: 'nonexistent' };
    await autoDispatchReviewer('RYA-1', 'id-1', 'Title', 'lead-engineer', actions);
    expect(dispatch.handleDispatch).not.toHaveBeenCalled();
  });

  it('detects reviewer from issue description', async () => {
    vi.mocked(linear.getIssue).mockResolvedValue({ description: 'Reviewer: CTO', title: 'Test' } as any);
    await autoDispatchReviewer('RYA-1', 'id-1', 'Title', 'lead-engineer', emptyActions);
    expect(dispatch.handleDispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'cto' }));
  });

  it('uses tiered classification as fallback for internal work', async () => {
    vi.mocked(linear.getIssue).mockResolvedValue({ description: null, title: 'Internal refactor' } as any);
    const handoff = '---\nstatus_intent: in-review\n---\n# HANDOFF\nDone.';
    await autoDispatchReviewer('RYA-1', 'id-1', 'Internal refactor', 'lead-engineer', emptyActions, undefined, handoff);
    expect(dispatch.handleDispatch).toHaveBeenCalledWith(expect.objectContaining({ role: 'cto' }));
  });

  it('does not dispatch for CEO-level work (no auto-dispatch)', async () => {
    vi.mocked(linear.getIssue).mockResolvedValue({ description: null, title: 'Security audit' } as any);
    const handoff = '---\nstatus_intent: in-review\n---\n# HANDOFF\nDone.';
    await autoDispatchReviewer('RYA-1', 'id-1', 'Security audit', 'lead-engineer', emptyActions, undefined, handoff);
    expect(dispatch.handleDispatch).not.toHaveBeenCalled();
  });

  it('skips when getIssue throws and no review_dispatch', async () => {
    vi.mocked(linear.getIssue).mockRejectedValue(new Error('not found'));
    await autoDispatchReviewer('RYA-1', 'id-1', 'Title', 'lead-engineer', emptyActions);
    expect(dispatch.handleDispatch).not.toHaveBeenCalled();
  });
});
