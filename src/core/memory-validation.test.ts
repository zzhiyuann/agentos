import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validatePostSessionMemory,
  parseMemoryIndex,
  formatMemoryWarnings,
} from './memory-validation.js';

// Mock config
vi.mock('./config.js', () => ({
  getConfig: () => ({ stateDir: '/tmp/aos-test-memval' }),
}));

// Mock fs — we control what's "on disk"
let mockFiles: Record<string, string> = {};
let mockDirs: Record<string, string[]> = {};

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: (p: string) => {
      if (mockDirs[p] !== undefined) return true;
      return mockFiles[p] !== undefined;
    },
    readFileSync: (p: string) => {
      if (mockFiles[p] !== undefined) return mockFiles[p];
      throw new Error(`ENOENT: no such file: ${p}`);
    },
    readdirSync: (p: string) => {
      if (mockDirs[p] !== undefined) return mockDirs[p];
      throw new Error(`ENOENT: no such directory: ${p}`);
    },
  };
});

function setMemoryFiles(role: string, files: Record<string, string>) {
  const memDir = `/tmp/aos-test-memval/agents/${role}/memory`;
  mockDirs[memDir] = Object.keys(files);
  for (const [name, content] of Object.entries(files)) {
    mockFiles[`${memDir}/${name}`] = content;
  }
}

function setMemoryIndex(role: string, content: string) {
  mockFiles[`/tmp/aos-test-memval/agents/${role}/MEMORY.md`] = content;
}

describe('parseMemoryIndex', () => {
  it('returns empty array for empty content', () => {
    expect(parseMemoryIndex('')).toEqual([]);
    expect(parseMemoryIndex('   ')).toEqual([]);
  });

  it('parses markdown links: [text](path.md)', () => {
    const content = '- [Failure patterns](memory/failure-patterns.md) — Known bugs';
    const refs = parseMemoryIndex(content);
    expect(refs).toContain('memory/failure-patterns.md');
  });

  it('parses multiple markdown links', () => {
    const content = `# Memory Index
- [Patterns](memory/patterns.md) — patterns
- [Audit](memory/audit-findings.md) — findings`;
    const refs = parseMemoryIndex(content);
    expect(refs).toContain('memory/patterns.md');
    expect(refs).toContain('memory/audit-findings.md');
  });

  it('parses inline code refs: `file.md`', () => {
    const content = 'See `memory/architecture.md` for details';
    const refs = parseMemoryIndex(content);
    expect(refs).toContain('memory/architecture.md');
  });

  it('parses bare file references in bullet lists', () => {
    const content = `# Index
- failure-patterns.md
- test-coverage.md`;
    const refs = parseMemoryIndex(content);
    expect(refs).toContain('failure-patterns.md');
    expect(refs).toContain('test-coverage.md');
  });

  it('deduplicates references', () => {
    const content = `- [Patterns](memory/patterns.md)
See also \`memory/patterns.md\` for details`;
    const refs = parseMemoryIndex(content);
    const patternsRefs = refs.filter((r) => r.includes('patterns'));
    expect(patternsRefs.length).toBe(1);
  });
});

describe('validatePostSessionMemory', () => {
  beforeEach(() => {
    mockFiles = {};
    mockDirs = {};
  });

  afterEach(() => {
    mockFiles = {};
    mockDirs = {};
  });

  it('returns no warnings when memory files match MEMORY.md', () => {
    setMemoryFiles('cto', {
      'architecture.md': '# Architecture\nSome content',
    });
    setMemoryIndex('cto', '- [Architecture](memory/architecture.md) — arch notes');

    const result = validatePostSessionMemory('cto');
    expect(result.warnings).toEqual([]);
    expect(result.memoryFileCount).toBe(1);
    expect(result.indexedReferenceCount).toBe(1);
    expect(result.unindexedFiles).toEqual([]);
    expect(result.staleReferences).toEqual([]);
  });

  it('detects memory files not indexed in MEMORY.md', () => {
    setMemoryFiles('cto', {
      'architecture.md': '# Arch',
      'debug-notes.md': '# Debug',
    });
    setMemoryIndex('cto', '- [Architecture](memory/architecture.md)');

    const result = validatePostSessionMemory('cto');
    expect(result.warnings.length).toBe(1);
    expect(result.unindexedFiles).toContain('debug-notes.md');
    expect(result.warnings[0]).toContain('not indexed');
    expect(result.warnings[0]).toContain('debug-notes.md');
  });

  it('detects stale MEMORY.md references to missing files', () => {
    setMemoryFiles('cpo', {
      'strategy.md': '# Strategy',
    });
    setMemoryIndex(
      'cpo',
      `- [Strategy](memory/strategy.md)
- [Old notes](memory/old-notes.md)`,
    );

    const result = validatePostSessionMemory('cpo');
    expect(result.staleReferences).toContain('memory/old-notes.md');
    expect(result.warnings.some((w) => w.includes('stale'))).toBe(true);
  });

  it('warns when session completed work but zero memory files', () => {
    // No memory dir at all
    setMemoryIndex('lead-engineer', '');

    const result = validatePostSessionMemory('lead-engineer', true);
    expect(result.warnings.some((w) => w.includes('zero memory files'))).toBe(true);
    expect(result.memoryFileCount).toBe(0);
  });

  it('does not warn about zero memory when session did not complete work', () => {
    // No memory files, but sessionCompletedWork = false
    const result = validatePostSessionMemory('lead-engineer', false);
    expect(result.warnings.filter((w) => w.includes('zero memory'))).toEqual([]);
  });

  it('handles missing agent directory gracefully', () => {
    // No files or dirs set — everything is missing
    const result = validatePostSessionMemory('nonexistent-role');
    expect(result.warnings).toEqual([]);
    expect(result.memoryFileCount).toBe(0);
    expect(result.indexedReferenceCount).toBe(0);
  });

  it('handles empty MEMORY.md', () => {
    setMemoryFiles('cto', {
      'test-patterns.md': '# Test patterns',
    });
    setMemoryIndex('cto', '');

    const result = validatePostSessionMemory('cto');
    expect(result.unindexedFiles).toContain('test-patterns.md');
    expect(result.warnings.length).toBe(1);
  });

  it('reports multiple warnings simultaneously', () => {
    // Has unindexed files AND stale refs AND zero-memory-with-handoff
    setMemoryIndex('coo', '- [Missing](memory/missing.md)');
    // No memory dir at all → zero files + stale ref

    const result = validatePostSessionMemory('coo', true);
    // Should have: stale ref warning + zero memory warning
    expect(result.warnings.length).toBe(2);
    expect(result.staleReferences).toContain('memory/missing.md');
    expect(result.warnings.some((w) => w.includes('zero memory files'))).toBe(true);
  });

  it('matches memory files by basename without .md extension', () => {
    setMemoryFiles('cto', {
      'failure-patterns.md': '# Patterns',
    });
    // Index references the file without path prefix
    setMemoryIndex('cto', '## Failure Patterns\n- [failure-patterns.md](memory/failure-patterns.md)');

    const result = validatePostSessionMemory('cto');
    expect(result.unindexedFiles).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('detects all unindexed files when MEMORY.md is completely empty', () => {
    setMemoryFiles('research-lead', {
      'papers.md': '# Papers',
      'experiments.md': '# Experiments',
      'findings.md': '# Findings',
    });
    setMemoryIndex('research-lead', '');

    const result = validatePostSessionMemory('research-lead');
    expect(result.unindexedFiles.length).toBe(3);
    expect(result.memoryFileCount).toBe(3);
    expect(result.indexedReferenceCount).toBe(0);
  });
});

describe('formatMemoryWarnings', () => {
  it('returns empty string when no warnings', () => {
    const result = formatMemoryWarnings({
      role: 'cto',
      warnings: [],
      unindexedFiles: [],
      staleReferences: [],
      memoryFileCount: 1,
      indexedReferenceCount: 1,
    });
    expect(result).toBe('');
  });

  it('formats warnings with role and stats', () => {
    const result = formatMemoryWarnings({
      role: 'lead-engineer',
      warnings: ['1 memory file(s) not indexed in MEMORY.md: debug.md'],
      unindexedFiles: ['debug.md'],
      staleReferences: [],
      memoryFileCount: 2,
      indexedReferenceCount: 1,
    });
    expect(result).toContain('lead-engineer');
    expect(result).toContain('debug.md');
    expect(result).toContain('2 memory file(s) on disk');
    expect(result).toContain('1 reference(s) in MEMORY.md');
  });

  it('formats multiple warnings as bullet list', () => {
    const result = formatMemoryWarnings({
      role: 'cpo',
      warnings: ['warning one', 'warning two'],
      unindexedFiles: [],
      staleReferences: [],
      memoryFileCount: 0,
      indexedReferenceCount: 0,
    });
    expect(result).toContain('- warning one');
    expect(result).toContain('- warning two');
  });
});
