/**
 * Per-session token attribution — RYA-895.
 *
 * Walks Claude Code JSONL transcripts and writes one row per session into
 * the `attempt_attributions` SQLite table with task_tokens, meta_tokens,
 * task_cost_usd, meta_cost_usd, message counts, and classification_confidence.
 *
 * "Confidence" is the share of classified messages that hit a non-default
 * rule. Messages that fall through to the default bucket (e.g., empty turns,
 * pure thinking, unrecognized tool patterns) lower confidence — they are the
 * messages a human reviewer would most want to spot-check.
 *
 * This is the persistence layer for the same heuristic the in-memory
 * pnl-aggregator already uses. Persisted output unlocks: (a) historical
 * backfill, (b) joining attribution with attempts/issues for SQL queries,
 * (c) the weekly digest reading from DB instead of re-walking JSONL.
 *
 * Heuristic, not ML. Rules live in pnl-classifier.ts (config-driven via
 * ~/.aos/pnl-rules.json).
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
import {
  getIssueRoleMap,
  upsertAttribution,
  findAttemptForSession,
} from '../core/db.js';
import { issueKeyFromProjectDir } from './pnl-aggregator.js';

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

export interface SessionAttribution {
  sessionId: string;
  issueKey: string;
  role: string;
  attemptId: string | null;
  taskTokens: number;
  metaTokens: number;
  taskCostUsd: number;
  metaCostUsd: number;
  taskMessages: number;
  metaMessages: number;
  /** Share of classified messages that hit a non-default rule (0..1). */
  classificationConfidence: number;
  firstSeenIso: string | null;
  lastSeenIso: string | null;
  transcriptPath: string;
}

export interface BackfillOptions {
  /** ms epoch — only sessions with messages on or after this are processed. */
  sinceMs: number;
  /** ms epoch — defaults to now. */
  untilMs?: number;
  /** Override Claude projects dir (for tests). */
  projectsDir?: string;
  /** Override classifier rules (for tests). */
  classifier?: ClassifierConfig;
  /** Override issue→role map (for tests). When omitted, derives from state.db. */
  issueRoles?: Map<string, string>;
  /** When true, do not write to SQLite — just return the attributions. */
  dryRun?: boolean;
  /** When set, only process this many transcripts (for smoke tests). */
  limit?: number;
}

export interface BackfillResult {
  sinceMs: number;
  untilMs: number;
  attributions: SessionAttribution[];
  rowsWritten: number;
  unattributedSessions: number;
  skippedOutOfWindow: number;
}

function parseTimestamp(line: { timestamp?: string }): number {
  if (!line.timestamp) return 0;
  const t = Date.parse(line.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Classify one JSONL transcript file. Returns null if no messages fall in
 * the window. The result is in-memory only — caller is responsible for
 * persisting via upsertAttribution.
 */
export function classifyTranscript(
  filePath: string,
  issueKey: string,
  role: string,
  classifier: ClassifierConfig,
  sinceMs: number,
  untilMs: number,
): SessionAttribution | null {
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
  let taskMessages = 0;
  let metaMessages = 0;
  let nonDefaultMatches = 0;
  let totalClassified = 0;
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
    const obj = parsed as { type?: string };
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

    totalClassified += 1;
    // Confidence: penalize messages that fell through to the default bucket
    // (rule labels "default" or "no-tool-calls"). These are the rows a human
    // reviewer would most want to inspect.
    if (verdict.matchedRule !== 'default' && verdict.matchedRule !== 'no-tool-calls') {
      nonDefaultMatches += 1;
    }

    if (verdict.bucket === 'task') {
      taskTokens += tokens;
      taskCost += cost;
      taskMessages += 1;
    } else {
      metaTokens += tokens;
      metaCost += cost;
      metaMessages += 1;
    }
  }

  if (!inWindow || totalClassified === 0) return null;

  const confidence = totalClassified > 0 ? nonDefaultMatches / totalClassified : 0;
  const firstSeenIso = firstSeenMs !== Number.MAX_SAFE_INTEGER
    ? new Date(firstSeenMs).toISOString()
    : null;
  const lastSeenIso = lastSeenMs > 0 ? new Date(lastSeenMs).toISOString() : null;
  const attemptId = findAttemptForSession(issueKey, role, firstSeenIso, lastSeenIso);

  return {
    sessionId,
    issueKey,
    role,
    attemptId,
    taskTokens,
    metaTokens,
    taskCostUsd: taskCost,
    metaCostUsd: metaCost,
    taskMessages,
    metaMessages,
    classificationConfidence: confidence,
    firstSeenIso,
    lastSeenIso,
    transcriptPath: filePath,
  };
}

/**
 * Backfill (or refresh) the attempt_attributions table over a time window.
 * Idempotent — re-running on the same window UPSERTs the same session_ids.
 */
export function backfillWindow(opts: BackfillOptions): BackfillResult {
  const sinceMs = opts.sinceMs;
  const untilMs = opts.untilMs ?? Date.now();
  const projectsDir = opts.projectsDir ?? join(homedir(), '.claude', 'projects');
  const classifier = opts.classifier ?? loadClassifierConfig();
  const issueRoles = opts.issueRoles ?? getIssueRoleMap();

  const attributions: SessionAttribution[] = [];
  let unattributedSessions = 0;
  let skippedOutOfWindow = 0;
  let processed = 0;

  if (!existsSync(projectsDir)) {
    return { sinceMs, untilMs, attributions, rowsWritten: 0, unattributedSessions, skippedOutOfWindow };
  }

  const dirs = readdirSync(projectsDir);
  outer: for (const dirName of dirs) {
    const issueKey = issueKeyFromProjectDir(dirName);
    if (!issueKey) continue;
    const role = issueRoles.get(issueKey);
    if (!role) {
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

    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(fullDir, file);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < sinceMs) {
        skippedOutOfWindow += 1;
        continue;
      }

      const attribution = classifyTranscript(filePath, issueKey, role, classifier, sinceMs, untilMs);
      if (!attribution) {
        skippedOutOfWindow += 1;
        continue;
      }

      attributions.push(attribution);
      processed += 1;
      if (opts.limit && processed >= opts.limit) break outer;
    }
  }

  let rowsWritten = 0;
  if (!opts.dryRun) {
    for (const a of attributions) {
      upsertAttribution({
        session_id: a.sessionId,
        attempt_id: a.attemptId,
        issue_key: a.issueKey,
        role: a.role,
        task_tokens: a.taskTokens,
        meta_tokens: a.metaTokens,
        task_cost_usd: a.taskCostUsd,
        meta_cost_usd: a.metaCostUsd,
        task_messages: a.taskMessages,
        meta_messages: a.metaMessages,
        classification_confidence: a.classificationConfidence,
        first_seen_at: a.firstSeenIso,
        last_seen_at: a.lastSeenIso,
        transcript_path: a.transcriptPath,
      });
      rowsWritten += 1;
    }
  }

  return { sinceMs, untilMs, attributions, rowsWritten, unattributedSessions, skippedOutOfWindow };
}

/** Summary stats over a backfill result — useful for CLI output. */
export interface BackfillSummary {
  sessions: number;
  rolesCovered: number;
  issuesCovered: number;
  totalTaskTokens: number;
  totalMetaTokens: number;
  totalTaskCostUsd: number;
  totalMetaCostUsd: number;
  metaTaxPct: number;
  meanConfidence: number;
  lowConfidenceSessions: number;
  /** sessions with attempt_id resolved (non-null). */
  matchedAttempts: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

export function summarize(result: BackfillResult): BackfillSummary {
  const rolesCovered = new Set<string>();
  const issuesCovered = new Set<string>();
  let totalTaskTokens = 0;
  let totalMetaTokens = 0;
  let totalTaskCostUsd = 0;
  let totalMetaCostUsd = 0;
  let confidenceSum = 0;
  let lowConfidence = 0;
  let matched = 0;

  for (const a of result.attributions) {
    rolesCovered.add(a.role);
    issuesCovered.add(a.issueKey);
    totalTaskTokens += a.taskTokens;
    totalMetaTokens += a.metaTokens;
    totalTaskCostUsd += a.taskCostUsd;
    totalMetaCostUsd += a.metaCostUsd;
    confidenceSum += a.classificationConfidence;
    if (a.classificationConfidence < LOW_CONFIDENCE_THRESHOLD) lowConfidence += 1;
    if (a.attemptId) matched += 1;
  }

  const sessions = result.attributions.length;
  const totalTokens = totalTaskTokens + totalMetaTokens;
  return {
    sessions,
    rolesCovered: rolesCovered.size,
    issuesCovered: issuesCovered.size,
    totalTaskTokens,
    totalMetaTokens,
    totalTaskCostUsd,
    totalMetaCostUsd,
    metaTaxPct: totalTokens > 0 ? (totalMetaTokens / totalTokens) * 100 : 0,
    meanConfidence: sessions > 0 ? confidenceSum / sessions : 0,
    lowConfidenceSessions: lowConfidence,
    matchedAttempts: matched,
  };
}

// Re-export Bucket so callers can type against it without two imports.
export type { Bucket };
