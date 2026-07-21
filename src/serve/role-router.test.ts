import { describe, it, expect, vi } from 'vitest';
import {
  buildRoleRouterPrompt,
  parseRoleRouterResponse,
  classifyMessageRole,
  roleRouterModel,
  ROLE_CHARTERS,
  FALLBACK_ROLE,
} from './role-router.js';

const ROLES = ['cto', 'cpo', 'coo', 'lead-engineer', 'research-lead', 'ceo-office'];

function mockFetchResponding(text: string, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ content: [{ type: 'text', text }] }),
  })) as unknown as typeof fetch;
}

describe('buildRoleRouterPrompt', () => {
  it('includes the message, every role, and its charter', () => {
    const prompt = buildRoleRouterPrompt('登录页有个 bug，点按钮没反应', ROLES);
    expect(prompt).toContain('登录页有个 bug');
    for (const role of ROLES) {
      expect(prompt).toContain(`- ${role}:`);
    }
    expect(prompt).toContain(ROLE_CHARTERS['lead-engineer']);
  });

  it('includes quoted context when provided', () => {
    const prompt = buildRoleRouterPrompt('这个方案再想想', ROLES, 'CTO: "建议用 SQLite"');
    expect(prompt).toContain('引用了此前的发言');
    expect(prompt).toContain('建议用 SQLite');
  });

  it('omits the quoted-context section when absent', () => {
    const prompt = buildRoleRouterPrompt('hello', ROLES);
    expect(prompt).not.toContain('引用了此前的发言');
  });

  it('caps very long messages at 1500 chars', () => {
    const long = 'x'.repeat(5000);
    const prompt = buildRoleRouterPrompt(long, ROLES);
    expect(prompt.length).toBeLessThan(3000);
  });

  it('falls back to a generic charter for unknown roles', () => {
    const prompt = buildRoleRouterPrompt('hi', ['brand-new-role']);
    expect(prompt).toContain('- brand-new-role: AI agent 角色');
  });
});

describe('parseRoleRouterResponse', () => {
  it('parses a plain JSON decision', () => {
    const d = parseRoleRouterResponse(
      '{"role": "lead-engineer", "confidence": "high", "complexity": "task", "reason": "修bug"}',
      ROLES,
    );
    expect(d).toEqual({ role: 'lead-engineer', confidence: 'high', complexity: 'task', reason: '修bug' });
  });

  it('parses fenced JSON', () => {
    const d = parseRoleRouterResponse(
      '```json\n{"role": "cpo", "confidence": "low", "complexity": "chat", "reason": "产品话题"}\n```',
      ROLES,
    );
    expect(d?.role).toBe('cpo');
    expect(d?.confidence).toBe('low');
  });

  it('normalizes hyphen/space variants of role names', () => {
    expect(parseRoleRouterResponse('{"role": "lead engineer"}', ROLES)?.role).toBe('lead-engineer');
    expect(parseRoleRouterResponse('{"role": "leadengineer"}', ROLES)?.role).toBe('lead-engineer');
    expect(parseRoleRouterResponse('{"role": "CTO"}', ROLES)?.role).toBe('cto');
  });

  it('maps "none" to a null role but still returns a decision', () => {
    const d = parseRoleRouterResponse('{"role": "none", "reason": "无法判断"}', ROLES);
    expect(d).not.toBeNull();
    expect(d?.role).toBeNull();
    expect(d?.reason).toBe('无法判断');
  });

  it('maps unknown roles to null role', () => {
    const d = parseRoleRouterResponse('{"role": "qa-engineer", "confidence": "high"}', ROLES);
    expect(d?.role).toBeNull();
  });

  it('defaults confidence to low and complexity to chat', () => {
    const d = parseRoleRouterResponse('{"role": "coo"}', ROLES);
    expect(d?.confidence).toBe('low');
    expect(d?.complexity).toBe('chat');
  });

  it('returns null for garbage, empty, and JSON-free text', () => {
    expect(parseRoleRouterResponse('', ROLES)).toBeNull();
    expect(parseRoleRouterResponse('sorry I cannot help', ROLES)).toBeNull();
    expect(parseRoleRouterResponse('{broken json', ROLES)).toBeNull();
  });
});

describe('classifyMessageRole', () => {
  it('returns the parsed decision on a successful API call', async () => {
    const fetchFn = mockFetchResponding(
      '{"role": "research-lead", "confidence": "high", "complexity": "task", "reason": "文献调研"}',
    );
    const d = await classifyMessageRole('帮我查一下 agent memory 相关的论文', {
      roles: ROLES,
      apiKey: 'test-key',
      fetchFn,
    });
    expect(d?.role).toBe('research-lead');
    expect(d?.complexity).toBe('task');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends the message and model in the API request', async () => {
    const fetchFn = mockFetchResponding('{"role": "cto"}');
    await classifyMessageRole('架构问题', { roles: ROLES, apiKey: 'test-key', fetchFn });
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('api.anthropic.com');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(roleRouterModel());
    expect(body.messages[0].content).toContain('架构问题');
  });

  it('returns fallback on a non-OK API response (retries once then falls back)', async () => {
    const fetchFn = mockFetchResponding('', false, 500);
    const d = await classifyMessageRole('hi', { roles: ROLES, apiKey: 'test-key', fetchFn, retryDelayMs: 0 });
    expect(d?.role).toBe(FALLBACK_ROLE);
    expect(d?.confidence).toBe('low');
    expect(fetchFn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('returns fallback when fetch throws (retries once then falls back)', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const d = await classifyMessageRole('hi', { roles: ROLES, apiKey: 'test-key', fetchFn, retryDelayMs: 0 });
    expect(d?.role).toBe(FALLBACK_ROLE);
    expect(d?.confidence).toBe('low');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns null without calling fetch when no roles exist', async () => {
    const fetchFn = mockFetchResponding('{"role": "cto"}');
    const d = await classifyMessageRole('hi', { roles: [], apiKey: 'test-key', fetchFn });
    expect(d).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns fallback on an empty API response body (retries once then falls back)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [] }),
    })) as unknown as typeof fetch;
    const d = await classifyMessageRole('hi', { roles: ROLES, apiKey: 'test-key', fetchFn, retryDelayMs: 0 });
    expect(d?.role).toBe(FALLBACK_ROLE);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('substitutes fallback when LLM returns "none" despite prompt forbidding it', async () => {
    const fetchFn = mockFetchResponding('{"role": "none", "confidence": "low", "complexity": "chat", "reason": "无法判断"}');
    const d = await classifyMessageRole('随便说说', { roles: ROLES, apiKey: 'test-key', fetchFn, retryDelayMs: 0 });
    expect(d?.role).toBe(FALLBACK_ROLE);
    expect(d?.confidence).toBe('low');
    expect(d?.reason).toContain('LLM无法判断');
    expect(fetchFn).toHaveBeenCalledTimes(1); // no retry needed, parse succeeded
  });
});

describe('roleRouterModel', () => {
  it('honors the AOS_ROLE_ROUTER_MODEL override', () => {
    const prev = process.env.AOS_ROLE_ROUTER_MODEL;
    process.env.AOS_ROLE_ROUTER_MODEL = 'claude-test-model';
    try {
      expect(roleRouterModel()).toBe('claude-test-model');
    } finally {
      if (prev === undefined) delete process.env.AOS_ROLE_ROUTER_MODEL;
      else process.env.AOS_ROLE_ROUTER_MODEL = prev;
    }
  });

  it('defaults to the Haiku tier', () => {
    const prev = process.env.AOS_ROLE_ROUTER_MODEL;
    delete process.env.AOS_ROLE_ROUTER_MODEL;
    try {
      expect(roleRouterModel()).toContain('haiku');
    } finally {
      if (prev !== undefined) process.env.AOS_ROLE_ROUTER_MODEL = prev;
    }
  });
});
