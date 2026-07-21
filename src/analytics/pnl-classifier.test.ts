import { describe, it, expect } from 'vitest';
import {
  classifyToolCall,
  classifyMessage,
  loadClassifierConfig,
  DEFAULT_RULES,
  type ClassifierConfig,
} from './pnl-classifier.js';

const cfg: ClassifierConfig = { defaultBucket: 'task', rules: DEFAULT_RULES };

describe('classifyToolCall', () => {
  it('classifies HANDOFF.md edit as meta', () => {
    const r = classifyToolCall(
      { name: 'Edit', input: { file_path: '/Users/x/.aos/work/RYA-1/HANDOFF.md', old_string: '', new_string: '' } },
      cfg,
    );
    expect(r.bucket).toBe('meta');
    expect(r.matchedRule).toBe('edit-memory-or-handoff');
  });

  it('classifies .agent-memory write as meta', () => {
    const r = classifyToolCall(
      { name: 'Write', input: { file_path: '/Users/x/agent-workspaces/RYA-2/.agent-memory/findings.md' } },
      cfg,
    );
    expect(r.bucket).toBe('meta');
  });

  it('classifies linear-tool comment as meta', () => {
    const r = classifyToolCall(
      { name: 'Bash', input: { command: 'AGENT_ROLE=lead-engineer linear-tool comment RYA-100 "Done"' } },
      cfg,
    );
    expect(r.bucket).toBe('meta');
    expect(r.matchedRule).toBe('linear-governance');
  });

  it('classifies linear-tool dispatch as meta (coordination)', () => {
    const r = classifyToolCall(
      { name: 'Bash', input: { command: 'linear-tool dispatch cto RYA-9 "review"' } },
      cfg,
    );
    expect(r.bucket).toBe('meta');
    expect(r.matchedRule).toBe('linear-coordination');
  });

  it('classifies src/ edit as task', () => {
    const r = classifyToolCall(
      { name: 'Edit', input: { file_path: '/Users/x/projects/agentos/src/core/foo.ts' } },
      cfg,
    );
    expect(r.bucket).toBe('task');
    expect(r.matchedRule).toBe('edit-code');
  });

  it('classifies vitest run as task', () => {
    const r = classifyToolCall(
      { name: 'Bash', input: { command: 'npx vitest run src/foo.test.ts' } },
      cfg,
    );
    expect(r.bucket).toBe('task');
    expect(r.matchedRule).toBe('run-tests-or-build');
  });

  it('classifies Grep as task by default', () => {
    const r = classifyToolCall(
      { name: 'Grep', input: { pattern: 'foo' } },
      cfg,
    );
    expect(r.bucket).toBe('task');
  });

  it('falls back to default bucket when no rule matches', () => {
    const r = classifyToolCall(
      { name: 'WeirdTool', input: {} },
      cfg,
    );
    expect(r.bucket).toBe('task');
    expect(r.matchedRule).toBe('default');
  });

  it('classifies Read of HANDOFF.md as meta', () => {
    const r = classifyToolCall(
      { name: 'Read', input: { file_path: '/x/.aos/work/RYA-7/HANDOFF.md' } },
      cfg,
    );
    expect(r.bucket).toBe('meta');
  });

  it('classifies Read of CLAUDE.md as meta', () => {
    const r = classifyToolCall(
      { name: 'Read', input: { file_path: '/Users/x/.claude/CLAUDE.md' } },
      cfg,
    );
    expect(r.bucket).toBe('meta');
  });
});

describe('classifyMessage', () => {
  it('returns meta when no tool calls and default is meta', () => {
    const r = classifyMessage([], { defaultBucket: 'meta', rules: DEFAULT_RULES });
    expect(r.bucket).toBe('meta');
  });

  it('returns task if any tool call is task', () => {
    const r = classifyMessage(
      [
        { name: 'Edit', input: { file_path: '/a/HANDOFF.md' } },
        { name: 'Edit', input: { file_path: '/a/src/foo.ts' } },
      ],
      cfg,
    );
    expect(r.bucket).toBe('task');
  });

  it('returns meta when all tool calls are meta', () => {
    const r = classifyMessage(
      [
        { name: 'Edit', input: { file_path: '/a/HANDOFF.md' } },
        { name: 'Bash', input: { command: 'linear-tool comment RYA-1 "hi"' } },
      ],
      cfg,
    );
    expect(r.bucket).toBe('meta');
  });
});

describe('loadClassifierConfig', () => {
  it('loads defaults when no config file present', () => {
    const c = loadClassifierConfig();
    expect(c.rules.length).toBeGreaterThan(0);
    expect(c.defaultBucket).toMatch(/task|meta/);
  });
});
