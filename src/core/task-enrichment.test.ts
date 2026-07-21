import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTrivialTask, formatTaskSpec, enrichTask } from './task-enrichment.js';
import type { TaskSpec } from './task-enrichment.js';

// Mock the config module to avoid real DB access
vi.mock('./config.js', () => ({
  getConfig: () => ({
    stateDir: '/tmp/test-aos',
    dbPath: ':memory:',
  }),
}));

// Mock the db cache functions
vi.mock('./db.js', () => ({
  getCachedEnrichment: vi.fn().mockReturnValue(null),
  cacheEnrichment: vi.fn(),
}));

// Mock fs to control API key lookup
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes('.anthropic-key')) return false;
      return (actual as typeof import('fs')).existsSync(path);
    }),
    readFileSync: (actual as typeof import('fs')).readFileSync,
  };
});

import { getCachedEnrichment, cacheEnrichment } from './db.js';

describe('isTrivialTask', () => {
  it('detects trivial tasks', () => {
    expect(isTrivialTask('Fix typo in README')).toBe(true);
    expect(isTrivialTask('Hotfix: broken deploy')).toBe(true);
    expect(isTrivialTask('Bump version to 1.2.3')).toBe(true);
    expect(isTrivialTask('Lint cleanup in src/')).toBe(true);
    expect(isTrivialTask('Refactor auth module')).toBe(true);
    expect(isTrivialTask('Rename variable in config')).toBe(true);
    expect(isTrivialTask('Chore: update dependencies')).toBe(true);
    expect(isTrivialTask('nit: spacing fix')).toBe(true);
    expect(isTrivialTask('Cleanup stale sessions')).toBe(true);
    expect(isTrivialTask('Patch security vulnerability')).toBe(true);
  });

  it('handles bug fix pattern', () => {
    expect(isTrivialTask('bug fix in auth')).toBe(true);
    expect(isTrivialTask('bugfix: session timeout')).toBe(true);
  });

  it('does not flag non-trivial tasks', () => {
    expect(isTrivialTask('Implement new auth system')).toBe(false);
    expect(isTrivialTask('Design API for task enrichment')).toBe(false);
    expect(isTrivialTask('[Strategy] Market Analysis')).toBe(false);
    expect(isTrivialTask('Add structured acceptance criteria to every dispatched task')).toBe(false);
    expect(isTrivialTask('Build Discord integration')).toBe(false);
    expect(isTrivialTask('Orchestrator eval harness: metrics + autoresearch optimization loop')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(isTrivialTask('')).toBe(false);
    expect(isTrivialTask('prefix fix suffix')).toBe(true);
    expect(isTrivialTask('FIXME: broken test')).toBe(false); // FIXME is not "fix" as a word
    expect(isTrivialTask('Suffix is a fix')).toBe(true);
  });
});

describe('formatTaskSpec', () => {
  const sampleSpec: TaskSpec = {
    deliverable: 'A new task enrichment module that adds acceptance criteria to dispatched tasks.',
    acceptanceCriteria: [
      'enrichTask() returns structured spec for non-trivial tasks',
      'Trivial tasks are skipped',
      'Results are cached per issue key',
      'Uses Haiku model for cost efficiency',
    ],
    dependencies: ['buildTaskPrompt() in persona.ts', 'DB cache table'],
    definitionOfDone: 'Every non-trivial dispatched task includes structured acceptance criteria in the prompt, cached per issue.',
  };

  it('formats spec as markdown with all sections', () => {
    const result = formatTaskSpec(sampleSpec);
    expect(result).toContain('## Structured Task Spec (auto-generated)');
    expect(result).toContain('### Deliverable');
    expect(result).toContain('### Acceptance Criteria');
    expect(result).toContain('### Dependencies');
    expect(result).toContain('### Definition of Done');
  });

  it('renders acceptance criteria as checkboxes', () => {
    const result = formatTaskSpec(sampleSpec);
    expect(result).toContain('- [ ] enrichTask() returns structured spec for non-trivial tasks');
    expect(result).toContain('- [ ] Trivial tasks are skipped');
    expect(result).toContain('- [ ] Results are cached per issue key');
    expect(result).toContain('- [ ] Uses Haiku model for cost efficiency');
  });

  it('renders dependencies as bullet list', () => {
    const result = formatTaskSpec(sampleSpec);
    expect(result).toContain('- buildTaskPrompt() in persona.ts');
    expect(result).toContain('- DB cache table');
  });

  it('shows "None identified" for empty dependencies', () => {
    const spec: TaskSpec = { ...sampleSpec, dependencies: [] };
    const result = formatTaskSpec(spec);
    expect(result).toContain('- None identified');
  });

  it('includes the deliverable text', () => {
    const result = formatTaskSpec(sampleSpec);
    expect(result).toContain(sampleSpec.deliverable);
  });

  it('includes definition of done', () => {
    const result = formatTaskSpec(sampleSpec);
    expect(result).toContain(sampleSpec.definitionOfDone);
  });
});

describe('enrichTask', () => {
  beforeEach(() => {
    vi.mocked(getCachedEnrichment).mockReturnValue(null);
    vi.mocked(cacheEnrichment).mockReset();
    // Reset fetch mock
    vi.restoreAllMocks();
  });

  it('returns null for trivial tasks without calling API or cache', async () => {
    const result = await enrichTask('RYA-999', 'Fix typo in README');
    expect(result).toBeNull();
    expect(getCachedEnrichment).not.toHaveBeenCalled();
  });

  it('returns null for another trivial pattern', async () => {
    const result = await enrichTask('RYA-998', 'Refactor config loading');
    expect(result).toBeNull();
    expect(getCachedEnrichment).not.toHaveBeenCalled();
  });

  it('returns cached enrichment when available', async () => {
    const cachedSpec = {
      deliverable: 'Cached deliverable',
      acceptanceCriteria: ['Criterion 1', 'Criterion 2'],
      dependencies: [],
      definitionOfDone: 'Cached DoD',
    };
    vi.mocked(getCachedEnrichment).mockReturnValue(cachedSpec);

    const result = await enrichTask('RYA-100', 'Implement new feature');
    expect(result).toEqual(cachedSpec);
    expect(getCachedEnrichment).toHaveBeenCalledWith('RYA-100');
  });

  it('returns null gracefully when no API key is available', async () => {
    // No API key set — should fail gracefully
    delete process.env.ANTHROPIC_API_KEY;
    vi.mocked(getCachedEnrichment).mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await enrichTask('RYA-200', 'Build a new module');
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[task-enrichment] Failed to enrich RYA-200')
    );
    consoleSpy.mockRestore();
  });

  it('calls Haiku API and caches result when API key is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    vi.mocked(getCachedEnrichment).mockReturnValue(null);

    const mockSpec: TaskSpec = {
      deliverable: 'New feature module',
      acceptanceCriteria: ['Works correctly', 'Has tests'],
      dependencies: ['Other module'],
      definitionOfDone: 'Feature is complete and tested',
    };

    // Mock fetch globally
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(mockSpec) }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await enrichTask('RYA-300', 'Build amazing feature', 'Detailed description here');

    expect(result).toEqual(mockSpec);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify API call shape
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.method).toBe('POST');
    expect(options.headers['x-api-key']).toBe('test-key-123');

    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-fable-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[0].content).toContain('Build amazing feature');
    expect(body.messages[0].content).toContain('Detailed description here');

    // Verify caching
    expect(cacheEnrichment).toHaveBeenCalledWith('RYA-300', expect.objectContaining({
      deliverable: 'New feature module',
    }));

    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it('handles API error gracefully', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    vi.mocked(getCachedEnrichment).mockReturnValue(null);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });
    vi.stubGlobal('fetch', mockFetch);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await enrichTask('RYA-400', 'Complex task');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Haiku API error 429')
    );
    expect(cacheEnrichment).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it('handles malformed JSON from Haiku gracefully', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    vi.mocked(getCachedEnrichment).mockReturnValue(null);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'not valid json at all' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await enrichTask('RYA-500', 'Task with bad response');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    expect(cacheEnrichment).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it('strips markdown fences from Haiku response', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    vi.mocked(getCachedEnrichment).mockReturnValue(null);

    const mockSpec: TaskSpec = {
      deliverable: 'Deliverable text',
      acceptanceCriteria: ['AC1'],
      dependencies: [],
      definitionOfDone: 'DoD text',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(mockSpec) + '\n```' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await enrichTask('RYA-600', 'Task with fenced response');
    expect(result).toEqual(mockSpec);

    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });

  it('validates task spec structure from Haiku', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    vi.mocked(getCachedEnrichment).mockReturnValue(null);

    // Missing required fields
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ deliverable: 'X' }) }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await enrichTask('RYA-700', 'Task with incomplete spec');
    expect(result).toBeNull();

    consoleSpy.mockRestore();
    delete process.env.ANTHROPIC_API_KEY;
    vi.unstubAllGlobals();
  });
});
