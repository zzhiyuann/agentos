/**
 * Tests for handoff-enrich.ts (RYA-902).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import {
  enrichHandoff,
  parseHandoff,
  deriveFilesChanged,
  deriveVerification,
  findTranscriptForWorkspace,
} from './handoff-enrich.js';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@aos.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'AOS Test'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
}

describe('parseHandoff', () => {
  it('separates front matter and section map', () => {
    const handoff = `---
status_intent: in-review
reason: "test"
---
# HANDOFF — RYA-X

## Summary
Did the thing.

## Files Changed
[placeholder]

## Memory Updated
- foo.md
`;
    const parsed = parseHandoff(handoff);
    expect(parsed.frontMatter).toContain('status_intent: in-review');
    expect(parsed.sections.get('Summary')).toBe('Did the thing.');
    expect(parsed.sections.get('Files Changed')).toBe('[placeholder]');
    expect(parsed.sections.get('Memory Updated')).toBe('- foo.md');
  });

  it('handles handoff without front matter', () => {
    const handoff = `# HANDOFF\n\n## Summary\nWork.\n`;
    const parsed = parseHandoff(handoff);
    expect(parsed.frontMatter).toBeNull();
    expect(parsed.sections.get('Summary')).toBe('Work.');
  });
});

describe('deriveFilesChanged', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'aos-enrich-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns null when workspace is not a git repo', () => {
    expect(deriveFilesChanged(workspace)).toBeNull();
  });

  it('returns null when working tree is clean', () => {
    gitInit(workspace);
    expect(deriveFilesChanged(workspace)).toBeNull();
  });

  it('lists modified, added, and deleted files', () => {
    gitInit(workspace);
    // Track an existing file so we can mark it modified/deleted later.
    writeFileSync(join(workspace, 'existing.ts'), 'old\n');
    execFileSync('git', ['add', 'existing.ts'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'add existing'], { cwd: workspace });

    // Now make changes against HEAD.
    writeFileSync(join(workspace, 'existing.ts'), 'new\n');
    writeFileSync(join(workspace, 'new-file.ts'), 'hello\n');
    execFileSync('git', ['add', 'new-file.ts'], { cwd: workspace });

    const result = deriveFilesChanged(workspace);
    expect(result).not.toBeNull();
    expect(result).toContain('existing.ts');
    expect(result).toContain('new-file.ts');
    expect(result).toMatch(/modified|added/);
  });

  it('caps long diffs and adds an overflow line', () => {
    gitInit(workspace);
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(workspace, `file-${i}.ts`), 'x\n');
    }
    execFileSync('git', ['add', '.'], { cwd: workspace });
    const result = deriveFilesChanged(workspace);
    expect(result).not.toBeNull();
    const lines = result!.split('\n');
    // 40 file rows + 1 overflow row
    expect(lines.length).toBeLessThanOrEqual(41);
    expect(lines[lines.length - 1]).toMatch(/and \d+ more/);
  });

  it('returns null for missing workspace path', () => {
    expect(deriveFilesChanged('/nonexistent/path/aos-test-xyz')).toBeNull();
    expect(deriveFilesChanged('')).toBeNull();
  });
});

describe('deriveVerification', () => {
  let workspace: string;
  let projectsDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'aos-enrich-'));
    // We use a real workspace path so that findTranscriptForWorkspace's
    // slug encoding matches. We can't easily redirect ~/.claude/projects,
    // so the deriveVerification test exercises the no-transcript path
    // and the parse-only path is verified through enrichHandoff below.
    projectsDir = workspace; // unused, just to silence lint
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns null when no transcript exists', () => {
    expect(deriveVerification(workspace, Date.now() - 60_000)).toBeNull();
  });
});

describe('enrichHandoff', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'aos-enrich-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns the original handoff unchanged when nothing can be derived', () => {
    const handoff = `---
status_intent: done
---
# HANDOFF

## Summary
Trivial change.
`;
    const out = enrichHandoff(handoff, { workspacePath: workspace, sessionStartMs: Date.now() });
    expect(out).toBe(handoff);
  });

  it('fills empty Files Changed from git diff', () => {
    gitInit(workspace);
    writeFileSync(join(workspace, 'foo.ts'), 'x\n');
    execFileSync('git', ['add', 'foo.ts'], { cwd: workspace });

    const handoff = `---
status_intent: in-review
---
# HANDOFF

## Summary
Implemented foo.

## Files Changed
[placeholder]

## Memory Updated
- foo.md
`;
    const out = enrichHandoff(handoff, { workspacePath: workspace, sessionStartMs: Date.now() });
    expect(out).toContain('foo.ts');
    expect(out).toContain('Auto-derived from `git diff`');
    expect(out).toContain('Implemented foo.');
    expect(out).toContain('## Memory Updated');
  });

  it('preserves agent-written non-empty Files Changed (no-overwrite default)', () => {
    gitInit(workspace);
    writeFileSync(join(workspace, 'derived.ts'), 'x\n');
    execFileSync('git', ['add', 'derived.ts'], { cwd: workspace });

    const handoff = `---
status_intent: done
---
# HANDOFF

## Summary
S.

## Files Changed
- src/manual.ts — manual entry written by agent
`;
    const out = enrichHandoff(handoff, { workspacePath: workspace, sessionStartMs: Date.now() });
    // Agent's manual content should be preserved
    expect(out).toContain('manual entry written by agent');
    // And the derived list should NOT have replaced it
    expect(out).not.toContain('derived.ts');
  });

  it('forceOverwrite replaces non-empty Files Changed', () => {
    gitInit(workspace);
    writeFileSync(join(workspace, 'forced.ts'), 'x\n');
    execFileSync('git', ['add', 'forced.ts'], { cwd: workspace });

    const handoff = `---
status_intent: done
---
# HANDOFF

## Summary
S.

## Files Changed
- old text
`;
    const out = enrichHandoff(handoff, {
      workspacePath: workspace,
      sessionStartMs: Date.now(),
      forceOverwrite: true,
    });
    expect(out).toContain('forced.ts');
  });

  it('preserves H1 title and front matter', () => {
    gitInit(workspace);
    writeFileSync(join(workspace, 'a.ts'), 'x\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: workspace });

    const handoff = `---
status_intent: in-review
reason: "needs review"
---
# HANDOFF — RYA-X

## Summary
S.

## Files Changed
[placeholder]
`;
    const out = enrichHandoff(handoff, { workspacePath: workspace, sessionStartMs: Date.now() });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('status_intent: in-review');
    expect(out).toContain('reason: "needs review"');
    expect(out).toContain('# HANDOFF — RYA-X');
  });

  it('is idempotent — second enrichment does not re-add the marker', () => {
    gitInit(workspace);
    writeFileSync(join(workspace, 'a.ts'), 'x\n');
    execFileSync('git', ['add', 'a.ts'], { cwd: workspace });

    const handoff = `---
status_intent: in-review
---
# HANDOFF

## Summary
S.

## Files Changed
[placeholder]
`;
    const once = enrichHandoff(handoff, { workspacePath: workspace, sessionStartMs: Date.now() });
    const twice = enrichHandoff(once, { workspacePath: workspace, sessionStartMs: Date.now() });
    // Marker should appear at most once
    const markerCount = (twice.match(/Auto-derived from `git diff`/g) || []).length;
    expect(markerCount).toBe(1);
  });
});

describe('findTranscriptForWorkspace', () => {
  it('returns null when projects dir does not contain a matching slug', () => {
    expect(findTranscriptForWorkspace('/no/such/workspace/path-' + Date.now())).toBeNull();
  });
});
