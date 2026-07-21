/**
 * RYA-1299/RYA-1304: Smart claim for unmentioned Discord channel messages.
 *
 * When the CEO posts in the company channel without @mentioning anyone, the
 * bot classifies which agent role is most relevant and routes the message to
 * that role's session (chat tier or task tier, decided downstream). The bot
 * reacts 👀 to signal the claim; the claiming agent reacts 🚧 (working) and
 * ✅ (done) via `linear-tool discord-react`.
 *
 * RYA-1304 changes: the classifier MUST always return a best-guess role —
 * "none" output is forbidden. On API failure the router retries once, then
 * falls back to FALLBACK_ROLE. No message is ever silently dropped.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { STATE_DIR } from '../core/config.js';
import { listAgents } from '../core/persona.js';

export interface RoleRouteDecision {
  /** Canonical agent role, or null when the classifier could not pick one. */
  role: string | null;
  confidence: 'high' | 'low';
  /** chat = conversational reply suffices; task = real work is being requested. */
  complexity: 'chat' | 'task';
  reason: string;
}

export const ROLE_ROUTER_TIMEOUT_MS = 10_000;

/**
 * Role used when the LLM cannot determine the best role or the API fails.
 * ceo-office covers "catch-all / unclear ownership" per its charter.
 */
export const FALLBACK_ROLE = 'ceo-office';

/** AOS_ROLE_ROUTER_MODEL, default Haiku tier — role picking is a trivial classification. */
export function roleRouterModel(): string {
  return process.env.AOS_ROLE_ROUTER_MODEL || 'claude-haiku-4-5-20251001';
}

/**
 * Role charters for the classification prompt. Roles discovered via
 * listAgents() that are missing here get a generic line, so a new agent
 * directory is routable without touching this map.
 */
export const ROLE_CHARTERS: Record<string, string> = {
  'cto': '技术架构、系统设计、技术选型、基础设施、代码评审、技术风险评估',
  'cpo': '产品设计、用户体验、需求定义、产品规划、竞品分析',
  'coo': '运营、流程、发布协调、对外事务、商务、排期',
  'lead-engineer': '写代码、修 bug、实现功能、调试、重构、测试',
  'research-lead': '学术调研、文献综述、实验设计、数据分析、论文写作',
  'ceo-office': '跨角色协调、行政杂务、备忘记录、归属不明确的事项',
};

export function buildRoleRouterPrompt(
  message: string,
  roles: string[],
  quotedContext?: string,
): string {
  const roleLines = roles
    .map(r => `- ${r}: ${ROLE_CHARTERS[r] || 'AI agent 角色'}`)
    .join('\n');

  const lines = [
    '你是 YourOrg（AI 公司）的消息路由器。CEO 在公司 Discord 频道发了一条没有@任何人的消息，判断哪个角色最适合认领处理。',
    '',
    '可选角色：',
    roleLines,
    '',
  ];
  if (quotedContext) {
    lines.push(`该消息引用了此前的发言：${quotedContext}`, '');
  }
  lines.push(
    '消息内容：',
    '"""',
    message.slice(0, 1500),
    '"""',
    '',
    '规则：**必须**选择一个最贴近话题的角色，禁止输出 "none"。闲聊/问候/泛泛问题也要选最接近的角色，confidence 设 "low"。',
    'complexity：纯聊天/查询用 "chat"，明确要求做事（改代码、调研、产出交付物）用 "task"。',
    '',
    '只输出 JSON：{"role": "<角色名>", "confidence": "high|low", "complexity": "chat|task", "reason": "<15字以内理由>"}',
  );
  return lines.join('\n');
}

/**
 * Parse the classifier's JSON response. Defensive: strips markdown fences,
 * extracts the first JSON object, validates the role against validRoles.
 * Unknown/none role → decision with role null. Unparseable → null.
 */
export function parseRoleRouterResponse(
  text: string,
  validRoles: string[],
): RoleRouteDecision | null {
  if (!text) return null;
  let cleaned = text.trim();

  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();

  const objMatch = cleaned.match(/\{[\s\S]*?\}/);
  if (!objMatch) return null;

  try {
    const parsed = JSON.parse(objMatch[0]) as {
      role?: unknown; confidence?: unknown; complexity?: unknown; reason?: unknown;
    };
    const rawRole = String(parsed.role ?? '').toLowerCase().trim();
    // Normalize hyphen/space variants ("lead engineer" → "lead-engineer")
    const stripped = rawRole.replace(/[\s-]/g, '');
    const role = validRoles.find(r => r.replace(/-/g, '') === stripped) || null;

    const confidence = parsed.confidence === 'high' ? 'high' : 'low';
    const complexity = parsed.complexity === 'task' ? 'task' : 'chat';
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '';

    return { role, confidence, complexity, reason };
  } catch (err) {
    console.log(chalk.dim(`[role-router] response parse failed: ${(err as Error).message}`));
    return null;
  }
}

/** Read Anthropic API key — mirrors effort-rules.ts / task-enrichment.ts pattern. */
function getAnthropicApiKey(): string | null {
  const keyFile = join(STATE_DIR, '.anthropic-key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf-8').trim();
  return process.env.ANTHROPIC_API_KEY || null;
}

export interface ClassifyOptions {
  quotedContext?: string;
  /** Override role list (tests). Default: listAgents(). */
  roles?: string[];
  /** Override API key (tests). Default: ~/.aos/.anthropic-key or env. */
  apiKey?: string;
  /** Injectable fetch (tests). Default: global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Delay between the first failure and the retry, ms. Default: 1000. Set to 0 in tests. */
  retryDelayMs?: number;
}

/** Construct a fallback routing decision and warn. */
function makeFallback(reason: string): RoleRouteDecision {
  console.log(chalk.yellow(`[role-router] fallback → ${FALLBACK_ROLE}: ${reason}`));
  return { role: FALLBACK_ROLE, confidence: 'low', complexity: 'chat', reason: `[fallback] ${reason.slice(0, 100)}` };
}

/**
 * Classify which agent role should claim an unmentioned Discord message.
 *
 * RYA-1304: NEVER returns null in normal operation. API failures are retried
 * once, then the message is routed to FALLBACK_ROLE. The only case that returns
 * null is when no agent roles are registered (system misconfiguration).
 */
export async function classifyMessageRole(
  message: string,
  opts: ClassifyOptions = {},
): Promise<RoleRouteDecision | null> {
  const roles = opts.roles ?? listAgents();
  if (roles.length === 0) {
    console.log(chalk.dim('[role-router] no agent roles found — cannot route'));
    return null;
  }

  const rawKey = opts.apiKey ?? getAnthropicApiKey();
  if (!rawKey) {
    return makeFallback('无 Anthropic API Key');
  }
  const apiKey: string = rawKey; // narrow to non-null for closures

  const prompt = buildRoleRouterPrompt(message, roles, opts.quotedContext);
  const fetchFn = opts.fetchFn ?? fetch;

  async function tryOnce(): Promise<RoleRouteDecision | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? ROLE_ROUTER_TIMEOUT_MS);
    try {
      const response = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: roleRouterModel(),
          max_tokens: 128,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        console.log(chalk.yellow(`[role-router] API ${response.status}`));
        return null;
      }

      const data = await response.json() as { content?: Array<{ type: string; text: string }> };
      const text = data.content?.[0]?.text?.trim();
      if (!text) {
        console.log(chalk.yellow('[role-router] empty API response'));
        return null;
      }

      const decision = parseRoleRouterResponse(text, roles);
      if (!decision) return null;

      // If LLM returned "none" or an unknown role despite the prompt forbidding it, substitute fallback.
      if (!decision.role) {
        return { ...decision, role: FALLBACK_ROLE, confidence: 'low', reason: `[LLM无法判断,fallback] ${decision.reason}` };
      }
      return decision;
    } catch (err) {
      console.log(chalk.yellow(`[role-router] API call failed: ${(err as Error).message}`));
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  const first = await tryOnce();
  if (first) return first;

  // One retry after a short delay
  const delay = opts.retryDelayMs ?? 1000;
  if (delay > 0) await new Promise(r => setTimeout(r, delay));
  const second = await tryOnce();
  if (second) return second;

  return makeFallback('API 连续失败两次');
}
