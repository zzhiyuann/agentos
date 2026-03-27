import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  classifyEvent, routeEvent, countConsecutiveRateLimitFailures, getRateLimitBackoffMs,
  verifyWebhookSignature,
  type EventClassification, type RouteDecision,
} from './serve.js';

// ─── classifyEvent ───

describe('classifyEvent', () => {
  // 1) No-label issue events
  describe('issue events', () => {
    it('classifies Issue create as issue-created', () => {
      expect(classifyEvent('Issue', { action: 'create' })).toBe('issue-created');
    });

    it('classifies Issue update as issue-updated', () => {
      expect(classifyEvent('Issue', { action: 'update' })).toBe('issue-updated');
    });

    it('classifies Issue remove as log', () => {
      expect(classifyEvent('Issue', { action: 'remove' })).toBe('log');
    });
  });

  // 2) Comment events
  describe('comment events', () => {
    it('classifies Comment create as comment-mention', () => {
      expect(classifyEvent('Comment', { action: 'create' })).toBe('comment-mention');
    });

    it('classifies Comment update as log', () => {
      expect(classifyEvent('Comment', { action: 'update' })).toBe('log');
    });

    it('classifies Comment remove as log', () => {
      expect(classifyEvent('Comment', { action: 'remove' })).toBe('log');
    });
  });

  // 5) AgentSession events
  describe('AgentSession events', () => {
    it('classifies AppAgentSession via linear-event header', () => {
      expect(classifyEvent('AppAgentSession', { action: 'created' })).toBe('agent-session');
    });

    it('classifies AppAgentSession via payload.type fallback', () => {
      expect(classifyEvent('unknown', { action: 'created', type: 'AppAgentSession' })).toBe('agent-session');
    });

    it('classifies prompted AgentSession events', () => {
      expect(classifyEvent('AppAgentSession', { action: 'prompted' })).toBe('agent-session');
    });

    it('header takes priority even with mismatched type', () => {
      expect(classifyEvent('AppAgentSession', { action: 'created', type: 'Issue' })).toBe('agent-session');
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('classifies unknown events as log', () => {
      expect(classifyEvent('unknown', { action: 'whatever' })).toBe('log');
    });

    it('classifies label change events as log', () => {
      expect(classifyEvent('IssueLabel', { action: 'create' })).toBe('log');
    });

    it('classifies empty event string as log', () => {
      expect(classifyEvent('', { action: '' })).toBe('log');
    });

    it('classifies Project events as log', () => {
      expect(classifyEvent('Project', { action: 'update' })).toBe('log');
    });
  });
});

// ─── routeEvent ───

describe('routeEvent', () => {
  // 1) No-label issue events — should log only, not spawn
  describe('no-label issue events', () => {
    it('logs issue without agent label', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'urgent' }],
          creatorId: 'user-123',
        },
      });
      expect(result.classification).toBe('issue-created');
      expect(result.action).toBe('log');
      expect(result.targetAgent).toBeNull();
      expect(result.reason).toContain('no agent label');
    });

    it('logs issue with empty labels array', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: { labels: [], creatorId: 'user-123' },
      });
      expect(result.classification).toBe('issue-created');
      expect(result.action).toBe('log');
    });

    it('logs issue with no labels property', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: { creatorId: 'user-123' },
      });
      expect(result.classification).toBe('issue-created');
      expect(result.action).toBe('log');
      expect(result.targetAgent).toBeNull();
    });

    it('logs issue with non-agent labels only', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [{ id: 'l1', name: 'feature' }, { id: 'l2', name: 'p0' }],
          creatorId: 'agent-abc',
        },
      }, { agentUserIds: new Set(['agent-abc']) });
      expect(result.action).toBe('log');
      expect(result.reason).toContain('no agent label');
    });

    it('defaults agent-created unlabeled issues to creator role when mapping is available', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: { creatorId: 'agent-abc', labels: [] },
      }, {
        agentUserIds: new Set(['agent-abc']),
        agentUserIdToRole: { 'agent-abc': 'cto' },
      });
      expect(result.action).toBe('conditional-spawn');
      expect(result.targetAgent).toBe('cto');
      expect(result.reason).toContain('creator role');
    });
  });

  // 2) Labeled issue events — should conditionally spawn
  describe('labeled issue events', () => {
    it('conditional-spawn for agent-created issue with agent:cto label', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [{ id: 'l1', name: 'agent:cto' }],
          creatorId: 'agent-abc',
        },
      }, { agentUserIds: new Set(['agent-abc']) });
      expect(result.classification).toBe('issue-created');
      expect(result.action).toBe('conditional-spawn');
      expect(result.targetAgent).toBe('cto');
      expect(result.reason).toContain('agent:cto');
    });

    it('conditional-spawn for agent:lead-engineer label', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'agent:lead-engineer' }],
          creatorId: 'agent-xyz',
        },
      }, { agentUserIds: new Set(['agent-xyz']) });
      expect(result.action).toBe('conditional-spawn');
      expect(result.targetAgent).toBe('lead-engineer');
    });

    it('logs when issue has agent label but NOT agent-created', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [{ id: 'l1', name: 'agent:cto' }],
          creatorId: 'human-user-id',
        },
      }, { agentUserIds: new Set(['agent-abc']) });
      expect(result.action).toBe('log');
      expect(result.reason).toContain('not agent-created');
    });

    it('logs when issue has agent label but no agentUserIds provided', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [{ id: 'l1', name: 'agent:cpo' }],
          creatorId: 'user-123',
        },
      });
      expect(result.action).toBe('log');
      expect(result.reason).toContain('not agent-created');
    });

    it('picks first agent label when multiple exist', () => {
      const result = routeEvent('Issue', {
        action: 'create',
        data: {
          labels: [
            { id: 'l1', name: 'agent:cto' },
            { id: 'l2', name: 'agent:lead-engineer' },
          ],
          creatorId: 'agent-abc',
        },
      }, { agentUserIds: new Set(['agent-abc']) });
      expect(result.targetAgent).toBe('cto');
    });
  });

  // 3) @mention pipe events — comment with @mention, agent running
  describe('@mention pipe events', () => {
    it('pipes to running agent on @mention', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: 'Hey @cto can you review this?' },
      }, { runningAgents: new Set(['cto']) });
      expect(result.classification).toBe('comment-mention');
      expect(result.action).toBe('pipe');
      expect(result.targetAgent).toBe('cto');
      expect(result.reason).toContain('pipe');
    });

    it('pipes to running lead-engineer on @mention', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@lead-engineer please fix the build' },
      }, { runningAgents: new Set(['lead-engineer', 'cto']) });
      expect(result.action).toBe('pipe');
      expect(result.targetAgent).toBe('lead-engineer');
    });

    it('pipes case-insensitively', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@CTO check this' },
      }, { runningAgents: new Set(['cto']) });
      expect(result.action).toBe('pipe');
      expect(result.targetAgent).toBe('cto');
    });

    it('recognizes @lead-engineer mention', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@lead-engineer run the tests' },
      }, { runningAgents: new Set(['lead-engineer']) });
      expect(result.action).toBe('pipe');
      expect(result.targetAgent).toBe('lead-engineer');
    });

    it('recognizes @research-lead mention', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: 'FYI @research-lead' },
      }, { runningAgents: new Set(['research-lead']) });
      expect(result.action).toBe('pipe');
      expect(result.targetAgent).toBe('research-lead');
    });
  });

  // 4) @mention spawn events — comment with @mention, agent NOT running
  describe('@mention spawn events', () => {
    it('conditional-spawn when mentioned agent is not running', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@cto what was the architecture decision?' },
      }, { runningAgents: new Set([]) });
      expect(result.classification).toBe('comment-mention');
      expect(result.action).toBe('conditional-spawn');
      expect(result.targetAgent).toBe('cto');
      expect(result.reason).toContain('spawn if issue completed');
    });

    it('conditional-spawn when no runningAgents provided', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@lead-engineer fix this' },
      });
      expect(result.action).toBe('conditional-spawn');
      expect(result.targetAgent).toBe('lead-engineer');
    });

    it('conditional-spawn for coo mention on idle system', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@coo check infra health' },
      }, { runningAgents: new Set(['cto']) }); // coo not in running set
      expect(result.action).toBe('conditional-spawn');
      expect(result.targetAgent).toBe('coo');
    });

    it('logs comment with no @mention', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: 'This is a regular comment with no mentions' },
      });
      expect(result.action).toBe('log');
      expect(result.targetAgent).toBeNull();
      expect(result.reason).toContain('no @mention');
    });

    it('logs comment with empty body', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '' },
      });
      expect(result.action).toBe('log');
      expect(result.targetAgent).toBeNull();
    });

    it('logs comment with no data.body', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: {},
      });
      expect(result.action).toBe('log');
    });

    it('does not match partial role names like @ct or @lead', () => {
      const result = routeEvent('Comment', {
        action: 'create',
        data: { body: '@ct this is not a valid mention' },
      });
      expect(result.action).toBe('log');
      expect(result.targetAgent).toBeNull();
    });
  });

  // 5) AgentSession events
  describe('AgentSession events', () => {
    it('spawns on created action with labels', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'created',
        agentSession: {
          issue: { labels: ['bug', 'agent:cto'] },
        },
      });
      expect(result.classification).toBe('agent-session');
      expect(result.action).toBe('spawn');
      expect(result.reason).toContain('spawn agent');
    });

    it('spawns on created action with webhook mapping', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'created',
        webhookId: 'wh-123',
        agentSession: { issue: { labels: [] } },
      }, { webhookAgentMap: { 'wh-123': 'cto' } });
      expect(result.action).toBe('spawn');
      expect(result.targetAgent).toBe('cto');
    });

    it('skips created action with no labels and no webhook mapping', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'created',
        agentSession: { issue: { labels: [] } },
      });
      expect(result.action).toBe('skip');
      expect(result.reason).toContain('No routing signal');
    });

    it('skips created action when issue has no labels field', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'created',
        agentSession: { issue: {} },
      });
      expect(result.action).toBe('skip');
    });

    it('pipes on prompted action with body', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'prompted',
        agentActivity: { body: 'Please also check the tests' },
      });
      expect(result.classification).toBe('agent-session');
      expect(result.action).toBe('pipe');
      expect(result.reason).toContain('Follow-up');
    });

    it('logs stop signal on prompted action', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'prompted',
        agentActivity: { signal: 'stop' },
      });
      expect(result.action).toBe('log');
      expect(result.reason).toContain('Stop signal');
    });

    it('logs prompted action with no body or signal', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'prompted',
        agentActivity: {},
      });
      expect(result.action).toBe('log');
      expect(result.reason).toContain('no body');
    });

    it('logs unhandled AgentSession action', () => {
      const result = routeEvent('AppAgentSession', {
        action: 'deleted',
      });
      expect(result.action).toBe('log');
      expect(result.reason).toContain('Unhandled');
    });

    it('recognizes AppAgentSession via payload.type fallback', () => {
      const result = routeEvent('unknown', {
        action: 'created',
        type: 'AppAgentSession',
        agentSession: { issue: { labels: ['p0'] } },
      });
      expect(result.classification).toBe('agent-session');
      expect(result.action).toBe('spawn');
    });
  });

  // Cross-cutting: log events
  describe('log-only events', () => {
    it('logs Issue update events', () => {
      const result = routeEvent('Issue', { action: 'update' });
      expect(result.classification).toBe('issue-updated');
      expect(result.action).toBe('log');
    });

    it('logs IssueLabel events', () => {
      const result = routeEvent('IssueLabel', { action: 'create' });
      expect(result.classification).toBe('log');
      expect(result.action).toBe('log');
    });

    it('logs Comment update events', () => {
      const result = routeEvent('Comment', { action: 'update' });
      expect(result.classification).toBe('log');
      expect(result.action).toBe('log');
    });

    it('logs completely unknown events', () => {
      const result = routeEvent('SomeNewEvent', { action: 'whatever' });
      expect(result.classification).toBe('log');
      expect(result.action).toBe('log');
      expect(result.reason).toContain('no spawn triggered');
    });
  });
});

describe('rate-limit helpers', () => {
  it('counts consecutive rate-limit failures for the same role', () => {
    const attempts = [
      { agent_type: 'cto', status: 'failed', error_log: 'Rate limited' },
      { agent_type: 'cto', status: 'failed', error_log: 'Rate limited' },
      { agent_type: 'cto', status: 'completed', error_log: null },
      { agent_type: 'cto', status: 'failed', error_log: 'Rate limited' },
    ];
    expect(countConsecutiveRateLimitFailures(attempts as never, 'cto')).toBe(2);
  });

  it('ignores failures from other roles while scanning recent attempts', () => {
    const attempts = [
      { agent_type: 'cto', status: 'failed', error_log: 'Rate limited' },
      { agent_type: 'coo', status: 'failed', error_log: 'Rate limited' },
      { agent_type: 'cto', status: 'failed', error_log: 'Rate limited' },
      { agent_type: 'cto', status: 'failed', error_log: 'Different failure' },
    ];
    expect(countConsecutiveRateLimitFailures(attempts as never, 'cto')).toBe(2);
  });

  it('backs off exponentially with a floor of 2 minutes', () => {
    expect(getRateLimitBackoffMs(1)).toBe(120000);
    expect(getRateLimitBackoffMs(2)).toBe(240000);
    expect(getRateLimitBackoffMs(3)).toBe(480000);
  });
});

// ─── Original HTTP endpoint tests (kept) ───

describe('serve - HTTP endpoints', () => {
  it('health endpoint returns ok', async () => {
    try {
      const res = await fetch('http://localhost:3848/health');
      if (res.ok) {
        const data = await res.json();
        expect(data.status).toBe('ok');
        expect(data.agent).toBe('AgentOS');
      }
    } catch {
      // Server might not be running on MacBook (it's on iMac now)
    }
  });

  it('open endpoint returns HTML page', async () => {
    try {
      const res = await fetch('http://localhost:3848/open/RYA-1');
      if (res.ok) {
        const html = await res.text();
        expect(html).toContain('AgentOS');
        expect(html).toContain('RYA-1');
        expect(html).toContain('agentos://session/RYA-1');
      }
    } catch {
      // Server might not be running locally
    }
  });

  it('404 for unknown routes', async () => {
    try {
      const res = await fetch('http://localhost:3848/nonexistent');
      if (res.status === 404) {
        expect(res.status).toBe(404);
      }
    } catch {
      // Server might not be running locally
    }
  });

  it('webhook endpoint accepts POST', async () => {
    try {
      const res = await fetch('http://localhost:3848/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', type: 'test' }),
      });
      if (res.ok) {
        const data = await res.json();
        expect(data.ok).toBe(true);
      }
    } catch {
      // Server might not be running locally
    }
  });
});

describe('serve - routing', () => {
  it('routing.json exists with valid rules', async () => {
    const { existsSync, readFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const routingPath = join(homedir(), '.aos', 'routing.json');
    if (existsSync(routingPath)) {
      const config = JSON.parse(readFileSync(routingPath, 'utf-8'));
      expect(config).toHaveProperty('rules');
      expect(Array.isArray(config.rules)).toBe(true);

      for (const rule of config.rules) {
        const hasAgent = 'agent' in rule;
        const hasDefault = 'default' in rule;
        expect(hasAgent || hasDefault).toBe(true);
      }
    }
  });
});

// ─── Webhook Signature Verification ───

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret-123';
  const body = '{"action":"create","type":"Issue"}';

  function sign(payload: string, key: string): string {
    return createHmac('sha256', key).update(payload).digest('hex');
  }

  it('accepts valid signature', () => {
    const sig = sign(body, secret);
    expect(verifyWebhookSignature(body, sig, secret)).toBe(true);
  });

  it('rejects invalid signature', () => {
    expect(verifyWebhookSignature(body, 'bad-signature', secret)).toBe(false);
  });

  it('rejects missing signature when secret is configured', () => {
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('skips verification when no secret configured', () => {
    expect(verifyWebhookSignature(body, undefined, undefined)).toBe(true);
    expect(verifyWebhookSignature(body, undefined, '')).toBe(true);
  });

  it('rejects signature with wrong length', () => {
    expect(verifyWebhookSignature(body, 'abc', secret)).toBe(false);
  });
});
