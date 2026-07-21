import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/config.js', () => ({
  resolveStatePath: (issueKey: string, _wp: string, fname: string) =>
    `/tmp/aos-test/work/${issueKey}/${fname}`,
}));

vi.mock('../core/linear.js', () => ({
  getIssue: vi.fn(),
  addComment: vi.fn(),
  updateIssueState: vi.fn(),
}));

vi.mock('../core/persona.js', () => ({
  getAgentLinearToken: vi.fn(() => 'token-agent'),
}));

vi.mock('../core/db.js', () => ({
  getAttemptsByIssue: vi.fn(() => []),
}));

vi.mock('../core/tmux.js', () => ({
  readFileOnRemote: vi.fn(() => null),
}));

vi.mock('./planner.js', () => ({
  areAllSubIssuesDone: vi.fn(),
  getSubIssues: vi.fn(async () => []),
}));

vi.mock('./monitor.js', () => ({
  hasStickyInProgressIntent: vi.fn(() => false),
}));

import { checkParentCompletion } from './parent-tracker.js';
import { getIssue, updateIssueState } from '../core/linear.js';
import { getAttemptsByIssue } from '../core/db.js';
import { areAllSubIssuesDone } from './planner.js';
import { hasStickyInProgressIntent } from './monitor.js';
import { readFileOnRemote } from '../core/tmux.js';

describe('checkParentCompletion — RYA-1116 sticky status_intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT promote parent to In Review when parent HANDOFF has sticky in-progress intent', async () => {
    // Parent issue is In Progress with all sub-issues Done.
    vi.mocked(getIssue).mockResolvedValueOnce({
      id: 'parent-id',
      identifier: 'RYA-1107',
      state: 'In Progress',
    } as any);
    vi.mocked(areAllSubIssuesDone).mockResolvedValueOnce({
      allDone: true, total: 3, done: 3, remaining: [],
    } as any);
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      {
        id: 10, issue_key: 'RYA-1107', agent_type: 'research-lead',
        status: 'completed', workspace_path: '/tmp/aos-test/RYA-1107',
      } as any,
    ]);
    vi.mocked(readFileOnRemote).mockReturnValueOnce(
      '---\nstatus_intent: in-progress\n---\n# HANDOFF'
    );
    vi.mocked(hasStickyInProgressIntent).mockReturnValueOnce(true);

    await checkParentCompletion('RYA-1107');

    // Promotion suppressed by sticky intent.
    expect(updateIssueState).not.toHaveBeenCalled();
  });

  it('promotes parent to In Review when parent HANDOFF does NOT have sticky intent', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({
      id: 'parent-id-2',
      identifier: 'RYA-2002',
      state: 'In Progress',
    } as any);
    vi.mocked(areAllSubIssuesDone).mockResolvedValueOnce({
      allDone: true, total: 2, done: 2, remaining: [],
    } as any);
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([
      {
        id: 11, issue_key: 'RYA-2002', agent_type: 'lead-engineer',
        status: 'completed', workspace_path: '/tmp/aos-test/RYA-2002',
      } as any,
    ]);
    vi.mocked(readFileOnRemote).mockReturnValueOnce(
      '---\nstatus_intent: in-review\n---\n# HANDOFF'
    );
    vi.mocked(hasStickyInProgressIntent).mockReturnValueOnce(false);

    await checkParentCompletion('RYA-2002');

    expect(updateIssueState).toHaveBeenCalledWith(
      'parent-id-2', 'In Review', expect.any(String)
    );
  });

  it('promotes parent when no HANDOFF readable (legacy / no parent attempt)', async () => {
    vi.mocked(getIssue).mockResolvedValueOnce({
      id: 'parent-id-3',
      identifier: 'RYA-2003',
      state: 'In Progress',
    } as any);
    vi.mocked(areAllSubIssuesDone).mockResolvedValueOnce({
      allDone: true, total: 1, done: 1, remaining: [],
    } as any);
    // No attempts for this parent at all — no HANDOFF to check.
    vi.mocked(getAttemptsByIssue).mockReturnValueOnce([]);

    await checkParentCompletion('RYA-2003');

    // Without an attempt, we cannot read HANDOFF. Default behavior = promote.
    expect(updateIssueState).toHaveBeenCalledWith(
      'parent-id-3', 'In Review', undefined
    );
  });
});
