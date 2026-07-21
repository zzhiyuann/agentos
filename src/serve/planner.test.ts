import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync,
}));

import { parsePlannerResponse, runPlanningCli } from './planner.js';

describe('parsePlannerResponse', () => {
  it('parses comment and subtasks blocks', () => {
    const response = `<comment>
## Plan for: Test

Ship it.
</comment>
<subtasks>
[
  { "title": "Implement", "description": "Write code", "assignee": "lead-engineer", "priority": 1 }
]
</subtasks>`;

    const plan = parsePlannerResponse(response, 2, 'RYA-1');
    expect(plan.parentIssueKey).toBe('RYA-1');
    expect(plan.plan).toContain('Ship it');
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].assignee).toBe('lead-engineer');
    expect(plan.subtasks[0].priority).toBe(1);
  });
});

describe('runPlanningCli', () => {
  let workspacePath: string;

  beforeEach(() => {
    spawnSync.mockReset();
    workspacePath = mkdtempSync(join(tmpdir(), 'agentos-planner-workspace-'));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('uses claude when the primary planner succeeds', async () => {
    spawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '<comment>Claude plan</comment>',
      stderr: '',
      error: undefined,
    });

    const result = await runPlanningCli('prompt', workspacePath);
    expect(result.runner).toBe('claude');
    expect(result.output).toContain('Claude plan');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('pins the claude planner to claude-opus-4-8 (AOS_PLANNER_MODEL overrides)', async () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: '<comment>Claude plan</comment>',
      stderr: '',
      error: undefined,
    });

    await runPlanningCli('prompt', workspacePath);
    expect(spawnSync.mock.calls[0][0]).toBe('claude');
    expect(spawnSync.mock.calls[0][1]).toEqual(['-p', '--output-format', 'text', '--model', 'claude-opus-4-8']);

    process.env.AOS_PLANNER_MODEL = 'claude-haiku-4-5';
    try {
      await runPlanningCli('prompt', workspacePath);
      expect(spawnSync.mock.calls[1][1]).toContain('claude-haiku-4-5');
    } finally {
      delete process.env.AOS_PLANNER_MODEL;
    }
  });

  it('falls back to codex when claude fails', async () => {
    spawnSync
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'claude unavailable',
        error: undefined,
      })
      .mockImplementationOnce((_cmd: string, args: string[]) => {
        const outputPath = args[args.indexOf('-o') + 1];
        writeFileSync(outputPath, '<comment>Codex plan</comment>', 'utf-8');
        return {
          status: 0,
          stdout: '',
          stderr: '',
          error: undefined,
        };
      });

    const result = await runPlanningCli('prompt', workspacePath);
    expect(result.runner).toBe('codex');
    expect(result.output).toContain('Codex plan');
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1][0]).toBe('codex');
  });
});
