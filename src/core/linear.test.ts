import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getReadClient, getAgentClient, hasAgentAccess,
  getIssue, getWorkflowStateId,
} from './linear.js';

const hasLocalEnv = existsSync(join(homedir(), '.aos', 'agents'));
const describeLocal = hasLocalEnv ? describe : describe.skip;

describeLocal('Linear clients', () => {
  it('getReadClient returns a LinearClient', () => {
    const client = getReadClient();
    expect(client).toBeDefined();
    expect(typeof client.issue).toBe('function');
  });

  it('getAgentClient returns a LinearClient', () => {
    const client = getAgentClient();
    expect(client).toBeDefined();
  });

  it('hasAgentAccess returns boolean', () => {
    const result = hasAgentAccess();
    expect(typeof result).toBe('boolean');
  });
});

const describeLive = process.env.AOS_LIVE_TESTS === '1' ? describe : describe.skip;

describeLive('Linear API - live queries', () => {
  it('getWorkflowStateId resolves known states', async () => {
    const inProgressId = await getWorkflowStateId('In Progress');
    expect(inProgressId).toBeDefined();
    expect(typeof inProgressId).toBe('string');
    expect(inProgressId.length).toBeGreaterThan(5);
  });

  it('getWorkflowStateId throws for unknown state', async () => {
    await expect(getWorkflowStateId('NonExistentState')).rejects.toThrow();
  });

  it('getIssue fetches a real issue by key', async () => {
    // RYA-8 is the first integration test issue — should exist
    const issue = await getIssue('RYA-8');
    expect(issue.id).toBeDefined();
    expect(issue.identifier).toBe('RYA-8');
    expect(issue.title).toBeTruthy();
    expect(typeof issue.priority).toBe('number');
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(issue.url).toContain('linear.app');
  });

  it('getIssue includes project field', async () => {
    const issue = await getIssue('RYA-8');
    // project may or may not be set — just verify the field exists
    expect('project' in issue).toBe(true);
  });

  it('getIssue throws for non-existent issue', async () => {
    await expect(getIssue('RYA-99999')).rejects.toThrow();
  });
});

describe('linkifyDeliverables regex', () => {
  // Test the regex pattern used by linkifyDeliverables without mocking the API
  const fileRefPattern = /(?:^|\s|[-*•]\s*|\d+\.\s*)`?((?:\.\/)?([A-Z][A-Z0-9_-]+\.md|[A-Za-z][A-Za-z0-9_-]*\.html))`?(?=[\s—,;)\]`]|$)/gm;

  function findMatches(text: string): string[] {
    const matches: string[] = [];
    let m;
    const re = new RegExp(fileRefPattern.source, fileRefPattern.flags);
    while ((m = re.exec(text)) !== null) {
      matches.push(m[2]);
    }
    return matches;
  }

  it('matches bare uppercase .md filenames', () => {
    const text = '- BRAND-PLAYBOOK.md — A playbook';
    expect(findMatches(text)).toContain('BRAND-PLAYBOOK.md');
  });

  it('matches backtick-wrapped uppercase .md filenames', () => {
    const text = '- `SHARE-SESSION-GUIDE.md` — Revised guide';
    expect(findMatches(text)).toContain('SHARE-SESSION-GUIDE.md');
  });

  it('matches backtick-wrapped .html filenames', () => {
    const text = '- `presentation.html` — Complete rewrite';
    expect(findMatches(text)).toContain('presentation.html');
  });

  it('matches bare .html filenames', () => {
    const text = '- presentation.html — Complete rewrite';
    expect(findMatches(text)).toContain('presentation.html');
  });

  it('skips HANDOFF.md', () => {
    const text = '- HANDOFF.md — The handoff';
    // Pattern matches it, but linkifyDeliverables skips it in the filter
    // Here we just verify the regex CAN match it (the skip is in the function logic)
    expect(findMatches(text)).toContain('HANDOFF.md');
  });

  it('handles multiple deliverables in one text', () => {
    const text = `## Files Changed
- \`presentation.html\` — Slides
- \`SHARE-SESSION-GUIDE.md\` — Guide
- \`QUICKSTART-HANDOUT.md\` — Handout`;
    const matches = findMatches(text);
    expect(matches).toContain('presentation.html');
    expect(matches).toContain('SHARE-SESSION-GUIDE.md');
    expect(matches).toContain('QUICKSTART-HANDOUT.md');
  });

  it('does not match lowercase .md filenames (too noisy)', () => {
    const text = '- package.md — Not a deliverable';
    // Lowercase .md shouldn't match (only uppercase .md or any-case .html)
    expect(findMatches(text)).not.toContain('package.md');
  });

  it('matches .html with numbered list prefix', () => {
    const text = '1. report.html — The report';
    expect(findMatches(text)).toContain('report.html');
  });
});
