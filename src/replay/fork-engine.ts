/**
 * Fork-from-checkpoint engine (RYA-870, Phase 2 of RYA-751).
 *
 * Pure functions that operate on capture-format traces (replay/v1) and on the
 * underlying Claude Code session JSONL. The orchestrator (replay-fork.ts) wires
 * these into a CLI command + spawns the live continuation.
 *
 * Determinism boundaries (per docs/replay-adr.md):
 *   L1 — prompt edit at step N
 *   L2 — tool-result edit at step N
 *   L3 — branch-after-step (no mutation, just resume)  [NOT in MVP — covered by `claude --continue`]
 *
 * Reset surface implemented here: fork workspace, Claude Code project dir per
 * fork, isolated session id. Wallclock anchor + isolated HOME deferred (see ADR D3).
 */

import { randomUUID } from 'crypto';

// ---------- Types ----------

export interface TraceRecord {
  v?: string;
  kind?: string;
  seq?: number;
  source?: string;
  uuid?: string;
  parent_uuid?: string | null;
  tool_use_id?: string;
  tool_name?: string;
  content?: unknown;
  role?: string;
  [key: string]: unknown;
}

export interface MetaRecord extends TraceRecord {
  kind: 'meta';
  attempt_id?: string;
  issue_key?: string;
  agent_type?: string;
  agent_session_id?: string;
  workspace_path?: string;
  extractor?: {
    claude_jsonl_files?: string[];
    sources_present?: string[];
    sources_missing?: string[];
    degraded?: boolean;
  };
}

export type EditMutation =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool_result'; text: string; isError?: boolean };

export interface ForkPlan {
  forkId: string;
  forkSid: string;
  parentSid: string;
  workspacePath: string;
  parentWorkspacePath: string;
  /** seq of the step to mutate, in the original trace */
  fromStep: number;
  /** uuid of the message at that step, used to truncate the original JSONL */
  fromUuid: string;
  edit: EditMutation;
  /** Path inside ~/.claude/projects/<encoded>/ where seeded JSONL is written */
  seededJsonlPath: string;
  /** Original Claude Code session JSONL path */
  sourceJsonlPath: string;
}

// ---------- Trace navigation ----------

/** Find the meta record at the head of a replay/v1 trace. */
export function findMeta(trace: TraceRecord[]): MetaRecord | null {
  for (const r of trace) {
    if (r.kind === 'meta') return r as MetaRecord;
  }
  return null;
}

/** Pick the step record at index `seq`. Throws on missing. */
export function findStep(trace: TraceRecord[], seq: number): TraceRecord {
  const matches = trace.filter((r) => r.seq === seq);
  if (matches.length === 0) {
    throw new Error(`step ${seq} not found in trace (seq values range ${seqRange(trace)})`);
  }
  // Multiple records can share a seq when a single Claude turn produces several
  // logical records (e.g., text + tool_call from one assistant message). Prefer
  // the most "structural" record for fork purposes:
  //   prompt edit  → user text record
  //   tool_result  → tool_result record
  //   otherwise    → first match by file order
  const userText = matches.find((r) => r.kind === 'text' && r.role === 'user');
  if (userText) return userText;
  const toolResult = matches.find((r) => r.kind === 'tool_result');
  if (toolResult) return toolResult;
  return matches[0];
}

function seqRange(trace: TraceRecord[]): string {
  const seqs = trace.map((r) => r.seq).filter((v): v is number => typeof v === 'number');
  if (seqs.length === 0) return '<none>';
  return `${Math.min(...seqs)}..${Math.max(...seqs)}`;
}

/** Validate that an edit mutation is compatible with the step's kind. */
export function validateEdit(step: TraceRecord, edit: EditMutation): void {
  if (edit.kind === 'prompt') {
    if (step.kind === 'text' && step.role === 'user') return;
    if (step.kind === 'lifecycle') return; // initial dispatch prompt is in lifecycle event
    throw new Error(
      `--edit-prompt requires step ${step.seq} to be a user text record (got kind=${step.kind} role=${step.role ?? '<n/a>'}). ` +
      `Pick a step where kind=text and role=user, or use --edit-tool-result on a tool_result step.`,
    );
  }
  if (edit.kind === 'tool_result') {
    if (step.kind !== 'tool_result') {
      throw new Error(
        `--edit-tool-result requires step ${step.seq} to be a tool_result record (got kind=${step.kind}). ` +
        `Pick a step where kind=tool_result.`,
      );
    }
  }
}

/**
 * Map a trace step to the Claude Code message uuid used to truncate the
 * underlying session JSONL.
 *
 * For most kinds this is direct: text/llm_io/tool_call records carry their
 * Claude `uuid`. For `tool_result` records the trace stores `tool_use_id` but
 * NOT a uuid (the originating user message uuid is implicit in the JSONL).
 * Fall back to scanning the source JSONL by `tool_use_id`.
 */
export function resolveStepUuid(step: TraceRecord, sourceJsonl: ClaudeJsonlRecord[]): string {
  if (typeof step.uuid === 'string' && step.uuid.length > 0) return step.uuid;
  if (step.kind === 'tool_result' && typeof step.tool_use_id === 'string') {
    const match = sourceJsonl.find((r) => containsToolResult(r, step.tool_use_id as string));
    if (match && match.uuid) return match.uuid;
  }
  if (step.kind === 'text' && step.role === 'user') {
    // Prompt records don't carry uuid in our extracted shape — the user message
    // uuid is on the JSONL record. Fall back to parent_uuid or first user.
    const firstUser = sourceJsonl.find((r) => r.type === 'user');
    if (firstUser && firstUser.uuid) return firstUser.uuid;
  }
  throw new Error(
    `cannot resolve Claude Code uuid for step ${step.seq} (kind=${step.kind}). ` +
    `This trace may be from a degraded capture without uuid linkage.`,
  );
}

// ---------- Claude Code JSONL operations ----------

export interface ClaudeJsonlRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: ClaudeContentBlock[] | string;
    [key: string]: unknown;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
    isImage?: boolean;
    noOutputExpected?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

function containsToolResult(rec: ClaudeJsonlRecord, toolUseId: string): boolean {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === 'object' && b.type === 'tool_result' && b.tool_use_id === toolUseId);
}

/** Parse Claude Code JSONL text → array of records. Skips malformed lines. */
export function parseClaudeJsonl(content: string): ClaudeJsonlRecord[] {
  const out: ClaudeJsonlRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ClaudeJsonlRecord); } catch { /* skip */ }
  }
  return out;
}

/**
 * Truncate a Claude Code JSONL stream to all records up to and including the
 * record whose uuid matches `untilUuid`. Returns a new array.
 */
export function truncateAtUuid(records: ClaudeJsonlRecord[], untilUuid: string): ClaudeJsonlRecord[] {
  const idx = records.findIndex((r) => r.uuid === untilUuid);
  if (idx < 0) {
    throw new Error(`uuid ${untilUuid} not found in source JSONL (length=${records.length})`);
  }
  return records.slice(0, idx + 1);
}

/**
 * Apply an edit mutation to the LAST record of a (presumably truncated) record
 * stream. Returns a new array with the mutation applied.
 *
 * Prompt edit replaces the user message text. Tool-result edit replaces the
 * tool_result content block matching `step.tool_use_id`.
 */
export function applyEdit(
  records: ClaudeJsonlRecord[],
  edit: EditMutation,
  context: { stepToolUseId?: string },
): ClaudeJsonlRecord[] {
  if (records.length === 0) throw new Error('cannot apply edit to empty record stream');
  const out = records.slice(0, -1);
  const last = JSON.parse(JSON.stringify(records[records.length - 1])) as ClaudeJsonlRecord;

  if (edit.kind === 'prompt') {
    if (last.type !== 'user') {
      throw new Error(`--edit-prompt: last truncated record must be type=user (got type=${last.type})`);
    }
    if (!last.message) last.message = { role: 'user', content: edit.text };
    else last.message.content = edit.text;
    out.push(last);
    return out;
  }

  // tool_result edit
  const toolUseId = context.stepToolUseId;
  if (!toolUseId) {
    throw new Error('--edit-tool-result: missing tool_use_id from step record');
  }
  if (last.type !== 'user') {
    throw new Error(`--edit-tool-result: last truncated record must be a user record holding tool_result (got type=${last.type})`);
  }
  const content = last.message?.content;
  if (!Array.isArray(content)) {
    throw new Error('--edit-tool-result: last record content is not a content-block array');
  }
  let replaced = false;
  const newContent = content.map((block) => {
    if (block && typeof block === 'object' && block.type === 'tool_result' && block.tool_use_id === toolUseId) {
      replaced = true;
      return { ...block, content: edit.text, is_error: edit.isError ?? false };
    }
    return block;
  });
  if (!replaced) {
    throw new Error(`--edit-tool-result: no tool_result block matched tool_use_id=${toolUseId}`);
  }
  if (last.message) last.message.content = newContent;
  // toolUseResult sidecar (Claude Code's own copy of tool output) — overwrite to match
  if (last.toolUseResult) {
    last.toolUseResult = {
      ...last.toolUseResult,
      stdout: edit.text,
      stderr: '',
      interrupted: false,
      isImage: false,
    };
  }
  out.push(last);
  return out;
}

/**
 * Rewrite sessionId on every record so the seeded JSONL is internally
 * consistent with its new filename. Claude Code reads the sessionId from the
 * file path but some downstream consumers (telemetry, viewer) read the field.
 */
export function rewriteSessionId(records: ClaudeJsonlRecord[], newSid: string): ClaudeJsonlRecord[] {
  return records.map((r) => (r.sessionId ? { ...r, sessionId: newSid } : r));
}

/** Serialize records back to JSONL (one JSON object per line, trailing newline). */
export function serializeJsonl(records: ClaudeJsonlRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// ---------- Fork plan construction ----------

export interface BuildPlanInput {
  trace: TraceRecord[];
  fromStep: number;
  edit: EditMutation;
  forkId?: string;
  /** Override the forked workspace path (default: ~/.aos/forks/<fork-id>/workspace) */
  workspacePath?: string;
  /** Override the new session id (default: fresh uuid) */
  forkSid?: string;
  /** State dir under which fork dirs and project dirs are derived */
  homeDir: string;
  stateDir: string;
}

/**
 * Validate inputs and produce a ForkPlan. Pure — does not touch the filesystem.
 */
export function buildForkPlan(input: BuildPlanInput): ForkPlan {
  const meta = findMeta(input.trace);
  if (!meta) throw new Error('trace missing meta record — not a valid replay/v1 capture');
  if (!meta.workspace_path) throw new Error('meta missing workspace_path — cannot fork without source workspace context');
  if (!meta.agent_session_id) throw new Error('meta missing agent_session_id — original Claude Code session unknown');

  const claudeFiles = meta.extractor?.claude_jsonl_files ?? [];
  if (claudeFiles.length === 0) {
    throw new Error(
      'trace was captured WITHOUT a Claude Code JSONL (degraded capture). ' +
      'Fork requires the original session JSONL — re-run capture on a session that has it, ' +
      'or use a session captured within 7 days of running.',
    );
  }
  // Locate source jsonl: ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
  const encodedCwd = encodeWorkspacePath(meta.workspace_path);
  const sourceJsonlPath = `${input.homeDir}/.claude/projects/${encodedCwd}/${meta.agent_session_id}.jsonl`;

  const step = findStep(input.trace, input.fromStep);
  validateEdit(step, input.edit);

  const forkId = input.forkId ?? `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const forkSid = input.forkSid ?? randomUUID();
  const workspacePath = input.workspacePath ?? `${input.stateDir}/forks/${forkId}/workspace`;
  const seededProjectDir = `${input.homeDir}/.claude/projects/${encodeWorkspacePath(workspacePath)}`;
  const seededJsonlPath = `${seededProjectDir}/${forkSid}.jsonl`;

  // fromUuid is best-effort here; final resolution requires reading the source
  // JSONL (because tool_result records don't carry uuid in the trace shape).
  // The orchestrator calls resolveStepUuid() after parsing the source.
  const fromUuid = typeof step.uuid === 'string' ? step.uuid : '';

  return {
    forkId,
    forkSid,
    parentSid: meta.agent_session_id,
    workspacePath,
    parentWorkspacePath: meta.workspace_path,
    fromStep: input.fromStep,
    fromUuid,
    edit: input.edit,
    seededJsonlPath,
    sourceJsonlPath,
  };
}

// ---------- File-history-snapshot extraction ----------

export interface FileSnapshotEntry {
  path: string;
  /** absolute backup path on disk (Claude Code stores backups under ~/.claude/file-history/) */
  backupPath?: string;
  /** inline content if the trace embedded it */
  content?: string;
  ts: string;
}

/**
 * Walk the trace forward up to (but not including) the truncation step and
 * return the LATEST snapshot of each file Claude Code touched. This is a
 * best-effort restoration source: it covers files Claude Code edited but NOT
 * files modified by Bash/external processes.
 */
export function extractFileSnapshotsUpTo(
  trace: TraceRecord[],
  upToSeq: number,
): FileSnapshotEntry[] {
  const latest = new Map<string, FileSnapshotEntry>();
  for (const r of trace) {
    if (typeof r.seq !== 'number' || r.seq >= upToSeq) continue;
    if (r.kind !== 'attachment') continue;
    if (r.subkind !== 'file-history-snapshot') continue;
    const original = (r as { original?: { snapshot?: { trackedFileBackups?: Record<string, unknown> } } }).original;
    const backups = original?.snapshot?.trackedFileBackups;
    if (!backups || typeof backups !== 'object') continue;
    const ts = typeof r.ts === 'string' ? r.ts : '';
    for (const [path, info] of Object.entries(backups)) {
      if (!info || typeof info !== 'object') continue;
      const backupPath = typeof (info as { backupPath?: string }).backupPath === 'string'
        ? (info as { backupPath: string }).backupPath
        : undefined;
      latest.set(path, { path, backupPath, ts });
    }
  }
  return Array.from(latest.values());
}

// ---------- Helpers ----------

/** Claude Code encodes workspace paths by replacing '/' with '-' under ~/.claude/projects/ */
export function encodeWorkspacePath(p: string): string {
  return p.replace(/\//g, '-');
}
