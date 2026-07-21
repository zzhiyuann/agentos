import { describe, it, expect } from 'vitest';
import { WORKFLOW_STATES, AGENT_LABELS } from './types.js';

describe('WORKFLOW_STATES', () => {
  it('has all expected states', () => {
    expect(WORKFLOW_STATES.BACKLOG).toBe('Backlog');
    expect(WORKFLOW_STATES.TODO).toBe('Todo');
    expect(WORKFLOW_STATES.IN_PROGRESS).toBe('In Progress');
    expect(WORKFLOW_STATES.IN_REVIEW).toBe('In Review');
    expect(WORKFLOW_STATES.DONE).toBe('Done');
    expect(WORKFLOW_STATES.CANCELED).toBe('Canceled');
  });
});

describe('AGENT_LABELS', () => {
  it('has all expected labels', () => {
    expect(AGENT_LABELS.CC).toBe('agent:cc');
    expect(AGENT_LABELS.CODEX).toBe('agent:codex');
    expect(AGENT_LABELS.BLOCKED).toBe('agent:blocked');
  });
});
