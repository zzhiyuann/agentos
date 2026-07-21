/**
 * Walks Claude Code session transcripts (JSONL files under
 * ~/.claude/projects/) over a time window, classifies each assistant
 * message via pnl-classifier, and aggregates token + cost totals by
 * (role, issue, bucket).
 *
 * Maps issue keys back to roles via the AOS attempts table — Claude Code
 * doesn't record the agent role itself, but workspace_path encodes
 * `agent-workspaces/RYA-XXX` → state.db.attempts.agent_type gives us role.
 *
 * v1 reads from JSONL only. When the dedicated attribution schema (RYA-895)
 * lands, swap the data source — the aggregator output shape stays stable.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import {
  classifyMessage,
  loadClassifierConfig,
  type ToolCall,
  type Bucket,
  type ClassifierConfig,
} from './pnl-classifier.js';
import {
  costForUsage,
  totalTokensForUsage,
  type UsageRecord,
} from './pnl-pricing.js';
import { getIssueRoleMap } from '../core/db.js';

export interface AggregateBuckets {
  taskTokens: number;
  metaTokens: number;
  taskCostUsd: number;
  metaCostUsd: number;
  messageCount: number;
}

export interface SessionBuckets extends AggregateBuckets {
  role: string;
  issueKey: string;
  sessionId: string;
  /** ms epoch of earliest timestamp seen. */
  firstSeenMs: number;
  /** ms epoch of latest timestamp seen. */
  lastSeenMs: number;
}

export interface AggregatorOptions {
  /** Window start (ms epoch). Sessions with no messages after this are skipped. */
  sinceMs: number;
  /** Window end (ms epoch). Defaults to now. */
  untilMs?: number;
  /** Override Claude projects dir (for tests). */
  projectsDir?: string;
  /** Override classifier (for tests). */
  classifier?: ClassifierConfig;
  /** Map of issue_key → role (for tests). When omitted, derives from state.db. */
  issueRoles?: Map<string, string>;
}

export interface DigestData {
  sinceMs: number;
  untilMs: number;
  totals: AggregateBuckets;
  perRole: Map<string, AggregateBuckets>;
  perIssue: Map<string, AggregateBuckets & { role: string }>;
  /** Granular per-session results — exposed so callers can persist to DB. */
  sessions: SessionBuckets[];
  sessionCount: number;
  unattributedSessions: number;
}

const PROJECT_DIR_REGEX = /-Users-[^-]+-agent-workspaces-([A-Z]+-\d+)/;

/** Extract issue key from a Claude projects directory name. */
export function issueKeyFromProjectDir(dir: string): string | null {
  const m = dir.match(PROJECT_DIR_REGEX);
  return m ? m[1] : null;
}

/** Re-export the issue→role lookup so callers can prefetch or override. */
export const loadIssueRoles = getIssueRoleMap;

interface AssistantMessage {
  type: 'assistant';
  timestamp?: string;
  message?: {
    model?: string;
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: 'tool_use'; name?: string; input?: Record<string, unknown> }
      | { type: string }
    >;
    usage?: UsageRecord;
  };
}

function parseTimestamp(line: { timestamp?: string }): number {
  if (!line.timestamp) return 0;
  const t = Date.parse(line.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

/** Process one JSONL transcript and return the per-session buckets, or null if outside window. */
function processTranscript(
  filePath: string,
  issueKey: string,
  role: string,
  classifier: ClassifierConfig,
  sinceMs: number,
  untilMs: number,
): SessionBuckets | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const sessionId = basename(filePath, '.jsonl');
  let taskTokens = 0;
  let metaTokens = 0;
  let taskCost = 0;
  let metaCost = 0;
  let messageCount = 0;
  let firstSeenMs = Number.MAX_SAFE_INTEGER;
  let lastSeenMs = 0;
  let inWindow = false;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as { type?: string; timestamp?: string };
    if (obj.type !== 'assistant') continue;
    const msg = parsed as AssistantMessage;
    const usage = msg.message?.usage;
    if (!usage) continue;

    const ts = parseTimestamp(msg);
    if (ts && (ts < sinceMs || ts > untilMs)) continue;
    if (ts) {
      inWindow = true;
      firstSeenMs = Math.min(firstSeenMs, ts);
      lastSeenMs = Math.max(lastSeenMs, ts);
    }

    const toolCalls: ToolCall[] = [];
    for (const c of msg.message?.content ?? []) {
      if ((c as { type?: string }).type === 'tool_use') {
        const tu = c as { name?: string; input?: Record<string, unknown> };
        if (tu.name) toolCalls.push({ name: tu.name, input: tu.input ?? {} });
      }
    }

    const verdict = classifyMessage(toolCalls, classifier);
    const tokens = totalTokensForUsage(usage);
    const model = msg.message?.model ?? 'unknown';
    const cost = costForUsage(model, usage);

    if (verdict.bucket === 'task') {
      taskTokens += tokens;
      taskCost += cost;
    } else {
      metaTokens += tokens;
      metaCost += cost;
    }
    messageCount += 1;
  }

  if (!inWindow || messageCount === 0) return null;
  return {
    role,
    issueKey,
    sessionId,
    taskTokens,
    metaTokens,
    taskCostUsd: taskCost,
    metaCostUsd: metaCost,
    messageCount,
    firstSeenMs,
    lastSeenMs,
  };
}

function emptyBuckets(): AggregateBuckets {
  return { taskTokens: 0, metaTokens: 0, taskCostUsd: 0, metaCostUsd: 0, messageCount: 0 };
}

function addBuckets(into: AggregateBuckets, from: AggregateBuckets): void {
  into.taskTokens += from.taskTokens;
  into.metaTokens += from.metaTokens;
  into.taskCostUsd += from.taskCostUsd;
  into.metaCostUsd += from.metaCostUsd;
  into.messageCount += from.messageCount;
}

/** Walk projects dir + all transcripts, aggregate buckets across the time window. */
export function aggregateWindow(opts: AggregatorOptions): DigestData {
  const sinceMs = opts.sinceMs;
  const untilMs = opts.untilMs ?? Date.now();
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  const classifier = opts.classifier ?? loadClassifierConfig();
  const issueRoles = opts.issueRoles ?? loadIssueRoles();

  const totals = emptyBuckets();
  const perRole = new Map<string, AggregateBuckets>();
  const perIssue = new Map<string, AggregateBuckets & { role: string }>();
  const sessions: SessionBuckets[] = [];
  let sessionCount = 0;
  let unattributedSessions = 0;

  if (!existsSync(projectsDir)) {
    return { sinceMs, untilMs, totals, perRole, perIssue, sessions, sessionCount, unattributedSessions };
  }

  for (const dirName of readdirSync(projectsDir)) {
    const issueKey = issueKeyFromProjectDir(dirName);
    if (!issueKey) continue; // skip non-agent-workspace dirs
    const role = issueRoles.get(issueKey);
    if (!role) {
      // Count it once for visibility — we still want to know how much data we're losing.
      unattributedSessions += 1;
      continue;
    }

    const fullDir = join(projectsDir, dirName);
    let entries: string[];
    try {
      entries = readdirSync(fullDir);
    } catch {
      continue;
    }

    // Mtime-prune at the directory level — if every file is older than the
    // window start, skip the dir without parsing.
    const recentEnough = entries.some((e) => {
      if (!e.endsWith('.jsonl')) return false;
      try {
        return statSync(join(fullDir, e)).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    });
    if (!recentEnough) continue;

    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(fullDir, file);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < sinceMs) continue;

      const session = processTranscript(filePath, issueKey, role, classifier, sinceMs, untilMs);
      if (!session) continue;

      sessionCount += 1;
      sessions.push(session);
      addBuckets(totals, session);

      let roleAgg = perRole.get(role);
      if (!roleAgg) {
        roleAgg = emptyBuckets();
        perRole.set(role, roleAgg);
      }
      addBuckets(roleAgg, session);

      let issueAgg = perIssue.get(issueKey);
      if (!issueAgg) {
        issueAgg = { ...emptyBuckets(), role };
        perIssue.set(issueKey, issueAgg);
      }
      addBuckets(issueAgg, session);
    }
  }

  return { sinceMs, untilMs, totals, perRole, perIssue, sessions, sessionCount, unattributedSessions };
}
