/** Shared helper functions for serve subsystems. */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import { agentExists, loadAgentConfig, listAgents } from '../core/persona.js';
import { getRecentCommentBodies } from '../core/linear.js';
import { getQueueItems } from '../core/queue.js';
import { TRANSIENT_LINEAR_ERROR_RE } from './proactive.js';
import type { Attempt } from '../core/db.js';

// ─── Group chat ───

export async function postToGroupChat(role: string, message: string): Promise<boolean> {
  // Sequential transport fallback (Discord → Telegram). Aggregate errors and
  // only log when ALL configured transports fail — preserves the "wrong
  // transport, try next" control flow without per-attempt log noise (RYA-742).
  let lastErr: unknown;
  try {
    const { loadDiscordConfig, postToDiscord } = await import('../core/discord.js');
    const dcConfig = loadDiscordConfig();
    if (dcConfig.webhookUrl) {
      return await postToDiscord(role, message);
    }
  } catch (err) {
    lastErr = err;
  }
  try {
    const { loadTelegramConfig, postToGroup } = await import('../core/telegram.js');
    const tgConfig = loadTelegramConfig();
    if (tgConfig.groupChatId) {
      return await postToGroup(role, message);
    }
  } catch (err) {
    lastErr = err;
  }
  if (lastErr) {
    console.log(chalk.dim(`[group-chat] all transports failed: ${(lastErr as Error).message}`));
  }
  return false;
}

// ─── Routing ───

export interface RoutingRule {
  project?: string;
  label?: string;
  default?: string;
  agent: string;
}

export function loadRoutingRules(): RoutingRule[] {
  const path = join(getConfig().stateDir, 'routing.json');
  if (existsSync(path)) {
    const config = JSON.parse(readFileSync(path, 'utf-8'));
    return config.rules || [];
  }
  return [{ default: 'lead-engineer', agent: 'lead-engineer' }];
}

/**
 * Wrap a raw user message with follow-up instructions so the agent knows
 * to post its reply as a visible Linear comment (not just tmux output).
 *
 * Used when piping follow-up messages into running/idle sessions via sendKeys,
 * where the agent doesn't receive the full spawnFollowUp prompt.
 */
export function wrapFollowUpMessage(issueKey: string, userMessage: string, commentId?: string): string {
  const replyCmd = commentId
    ? `linear-tool reply ${issueKey} ${commentId} "your response"`
    : `linear-tool comment ${issueKey} "your response"`;

  return [
    `[FOLLOW-UP] User left a new message on ${issueKey}:`,
    `> ${userMessage}`,
    ``,
    `IMPORTANT: Post your reply using: ${replyCmd}`,
    `Do NOT write HANDOFF.md for this — just reply and wait at the prompt.`,
  ].join('\n');
}

export function resolveAgentForIssue(issue: { identifier: string; labels: string[]; title: string; project?: string }): string {
  const rules = loadRoutingRules();
  for (const rule of rules) {
    if (rule.label && issue.labels.some((l) => l.toLowerCase() === rule.label!.toLowerCase())) {
      return rule.agent;
    }
  }
  for (const rule of rules) {
    if (rule.project && issue.project && issue.project.toLowerCase() === rule.project.toLowerCase()) {
      return rule.agent;
    }
  }
  const defaultRule = rules.find((r) => r.default);
  return defaultRule?.agent || 'lead-engineer';
}

/**
 * Check if an issue has an explicit routing signal (label or project matching a routing rule).
 * Returns false for labels like "Plan" that don't match any routing rule.
 */
export function hasExplicitRouting(issue: { labels: string[]; project?: string }): boolean {
  const rules = loadRoutingRules();
  const hasLabel = rules.some(r =>
    r.label && issue.labels.some(l => l.toLowerCase() === r.label!.toLowerCase())
  );
  if (hasLabel) return true;
  const hasProject = rules.some(r =>
    r.project && issue.project && issue.project.toLowerCase() === r.project!.toLowerCase()
  );
  return hasProject;
}

export function resolveAgentFromWebhook(webhookId?: string): string | null {
  if (!webhookId) return null;
  const mappingPath = join(getConfig().stateDir, 'webhook-map.json');
  if (existsSync(mappingPath)) {
    const map = JSON.parse(readFileSync(mappingPath, 'utf-8'));
    return map[webhookId] || null;
  }
  return null;
}

// ─── Agent identity ───

/** Cached agent user IDs — refreshed every 60s to pick up new agents without re-reading config on every webhook */
let _agentUserIdsCache: Set<string> | null = null;
let _agentUserIdsCacheTime = 0;
const AGENT_ID_CACHE_TTL_MS = 60_000;

export function getAgentUserIds(): Set<string> {
  const now = Date.now();
  if (_agentUserIdsCache && now - _agentUserIdsCacheTime < AGENT_ID_CACHE_TTL_MS) {
    return _agentUserIdsCache;
  }
  const ids = new Set<string>();
  for (const role of listAgents()) {
    const config = loadAgentConfig(role);
    if (config.linearUserId) ids.add(config.linearUserId);
  }
  _agentUserIdsCache = ids;
  _agentUserIdsCacheTime = now;
  return ids;
}

/** Check if a comment body looks like an agent/system comment (not a real user message) */
export function isAgentOrSystemComment(body: string): boolean {
  return /^(This thread is for an agent session|Done\.?|Session (replaced|complete)|Dismissed|Stale session|Follow-up (answered|timed out)|Handing off to |No routing signal|–|Automatic retries paused|\*\*Quality check warnings|\*\*Agent failed after|Agent session ended|Handoff accepted|# HANDOFF)/i.test(body);
}

export function getAgentRoleByUserId(userId?: string): string | null {
  if (!userId) return null;
  for (const role of listAgents()) {
    const config = loadAgentConfig(role);
    if (config.linearUserId === userId) return role;
  }
  return null;
}

// ─── Rate limiting ───

const BASE_RATE_LIMIT_BACKOFF_MS = 2 * 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;
export const RATE_LIMIT_ESCALATION_MARKER = 'Automatic retries paused after repeated rate limits.';

export function countConsecutiveRateLimitFailures(
  attempts: Pick<Attempt, 'agent_type' | 'status' | 'error_log'>[],
  agentRole: string,
): number {
  let count = 0;
  for (const attempt of attempts) {
    if (attempt.agent_type !== agentRole) continue;
    if (attempt.status === 'failed' && attempt.error_log === 'Rate limited') {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function getRateLimitBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return BASE_RATE_LIMIT_BACKOFF_MS;
  return Math.min(
    BASE_RATE_LIMIT_BACKOFF_MS * Math.pow(2, Math.max(0, consecutiveFailures - 1)),
    MAX_RATE_LIMIT_BACKOFF_MS,
  );
}

// ─── Error classification ───

/**
 * Detect permanent issue errors that should NOT be retried.
 * These indicate the issue no longer exists in Linear (deleted, trashed)
 * or the request is fundamentally invalid.
 */
export function isPermanentIssueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found|Not Found|NOT_FOUND|Argument Validation Error|does not exist|was deleted/i.test(msg);
}

// ─── Misc ───

export function hasQueuedIssue(issueKey: string): boolean {
  return getQueueItems().some((item) => item.issue_key === issueKey);
}

export function handoffContentHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

export async function isHandoffAlreadyPosted(issueId: string, handoff: string): Promise<boolean> {
  try {
    const recentBodies = await getRecentCommentBodies(issueId, 5);
    const fingerprint = handoff.substring(0, 200);
    return recentBodies.some((body) => body.includes(fingerprint));
  } catch (err) {
    // Fail-CLOSED on transient Linear errors (RYA-1034). Under sustained
    // rate-limit, fail-open lets every blocked check post another duplicate
    // HANDOFF comment. Less viral than the proactive heartbeat (only fires on
    // completion) but still pollutes the issue. Skipping the post is
    // recoverable — the next monitor tick will retry. Generic non-transient
    // errors still fall through so a permanent bug doesn't wedge completions.
    const msg = (err as Error).message;
    console.log(chalk.dim(`[helpers] isHandoffAlreadyPosted failed: ${msg}`));
    if (TRANSIENT_LINEAR_ERROR_RE.test(msg)) return true;
    return false;
  }
}

export async function downloadCommentImages(body: string, workDir: string): Promise<{ text: string; imagePaths: string[] }> {
  const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  const imagePaths: string[] = [];
  let processed = body;

  let match;
  while ((match = imageRegex.exec(body)) !== null) {
    const [fullMatch, alt, url] = match;
    try {
      const { execFileSync } = await import('child_process');
      const imgDir = `${workDir}/.comment-images`;
      mkdirSync(imgDir, { recursive: true });
      const ext = url.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || 'png';
      const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const localPath = join(imgDir, filename);
      // Linear upload URLs require auth header
      const { getLinearApiKey } = await import('../core/keychain.js');
      const apiKey = getLinearApiKey();
      if (!apiKey) throw new Error('Linear API key not configured');
      execFileSync('curl', ['-sL', '-H', `Authorization: ${apiKey}`, '-o', localPath, url], { timeout: 15_000 });
      imagePaths.push(localPath);
      processed = processed.replace(fullMatch, `![${alt}](${localPath})`);
    } catch (err) {
      console.log(chalk.dim(`[image-download] download ${url} failed: ${(err as Error).message}`));
    }
  }

  return { text: processed, imagePaths };
}
