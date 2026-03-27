import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getReadClient, getAgentClient, hasAgentAccess,
  getIssue, getWorkflowStateId,
} from './linear.js';

// These tests require a deployed AgentOS with Linear API key — skip in CI
const hasDeployedConfig = existsSync(join(homedir(), '.aos', '.linear-api-key')) ||
  existsSync(join(homedir(), '.aos', 'agents'));

const describeWithApiKey = hasDeployedConfig ? describe : describe.skip;

describeWithApiKey('Linear clients', () => {
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
    // ENG-8 is the first integration test issue — should exist
    const issue = await getIssue('ENG-8');
    expect(issue.id).toBeDefined();
    expect(issue.identifier).toBe('ENG-8');
    expect(issue.title).toBeTruthy();
    expect(typeof issue.priority).toBe('number');
    expect(Array.isArray(issue.labels)).toBe(true);
    expect(issue.url).toContain('linear.app');
  });

  it('getIssue includes project field', async () => {
    const issue = await getIssue('ENG-8');
    // project may or may not be set — just verify the field exists
    expect('project' in issue).toBe(true);
  });

  it('getIssue throws for non-existent issue', async () => {
    await expect(getIssue('ENG-99999')).rejects.toThrow();
  });
});
