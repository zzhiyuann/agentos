import {
  readFileSync, existsSync, mkdirSync, writeFileSync, statSync, readdirSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import chalk from 'chalk';
import {
  getAttemptById, getAttemptEvents, getAttemptsByIssue,
  type Attempt, type AttemptEvent,
} from '../core/db.js';
import { sessionExists, capturePane } from '../core/tmux.js';
import { getConfig } from '../core/config.js';

const SCHEMA_VERSION = 'replay/v1';
const EXTRACTOR_NAME = 'aos-replay-capture';
const EXTRACTOR_VERSION = '0.2.0'; // 0.2.0 adds rendered_context + tool_result_supplement (CTO ADR D1)
const MAX_INLINE_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_INLINE_BYTES = 64 * 1024;
const TMUX_SCROLLBACK_LINES = 5000;

type ReplayRecord = Record<string, unknown>;

interface CaptureOptions {
  out?: string;
  outDir?: string;
  noThinking?: boolean;
}

interface CaptureResult {
  outputPath: string;
  recordCount: number;
  sourcesPresent: string[];
  sourcesMissing: string[];
  degraded: boolean;
}

/** Top-level entry point for `aos replay capture <ATTEMPT_ID>` */
export async function replayCaptureCommand(
  attemptIdOrIssue: string,
  options: CaptureOptions = {},
): Promise<void> {
  const attempt = resolveAttempt(attemptIdOrIssue);
  if (!attempt) {
    console.error(chalk.red(`No attempt found for "${attemptIdOrIssue}".`));
    console.error(chalk.dim('Pass an attempt UUID, or an issue key (RYA-844) — latest attempt is used.'));
    process.exitCode = 1;
    return;
  }

  const result = await captureAttempt(attempt, options);

  console.log(chalk.green(`✓ Captured ${attempt.issue_key} (${attempt.id.slice(0, 8)})`));
  console.log(`  ${chalk.dim('output:')}    ${result.outputPath}`);
  console.log(`  ${chalk.dim('records:')}   ${result.recordCount}`);
  console.log(`  ${chalk.dim('sources:')}   ${result.sourcesPresent.join(', ') || '(none)'}`);
  if (result.sourcesMissing.length > 0) {
    console.log(`  ${chalk.dim('missing:')}   ${chalk.yellow(result.sourcesMissing.join(', '))}`);
  }
  if (result.degraded) {
    console.log(`  ${chalk.yellow('⚠ degraded capture — primary sources missing')}`);
  }
}

/** Resolve to a single attempt: UUID first, else latest attempt for an issue key. */
function resolveAttempt(idOrKey: string): Attempt | undefined {
  const direct = getAttemptById(idOrKey);
  if (direct) return direct;
  // Issue-key fallback: pick most recent attempt
  if (/^[A-Z]+-\d+$/.test(idOrKey)) {
    const list = getAttemptsByIssue(idOrKey);
    return list[0];
  }
  return undefined;
}

/** Build the .jsonl capture file for one attempt. */
export async function captureAttempt(
  attempt: Attempt,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const records: ReplayRecord[] = [];
  let seq = 0;
  const next = () => seq++;

  const sourcesPresent: string[] = ['state.db'];
  const sourcesMissing: string[] = [];

  // 1. Lifecycle events from state.db
  const events = getAttemptEvents(attempt.id);
  if (events.length === 0 && isOlderThanDays(attempt.created_at, 7)) {
    sourcesMissing.push('events (purged)');
  }
  for (const ev of events) {
    records.push(buildLifecycleRecord(ev, next()));
    const handoff = maybeBuildHandoffRecord(ev, next);
    if (handoff) records.push(handoff);
  }

  // 2. System prompt from workspace .claude/.agent-grounding-*.md
  if (attempt.workspace_path && existsSync(attempt.workspace_path)) {
    const sysRecords = collectSystemPromptRecords(attempt, next);
    records.push(...sysRecords);
    if (sysRecords.length > 0) sourcesPresent.push('workspace');
  } else if (attempt.workspace_path) {
    sourcesMissing.push('workspace');
  }

  // 3. Claude Code session JSONL files
  const claudeFiles = findClaudeSessionFiles(attempt);
  if (claudeFiles.length > 0) {
    sourcesPresent.push('claude-jsonl');
    for (const file of claudeFiles) {
      const fileRecords = parseClaudeJsonl(file, attempt, next, options);
      records.push(...fileRecords);
    }
  } else {
    sourcesMissing.push('claude-jsonl');
  }

  // 4. Workspace artifact files (HANDOFF.md, etc.) — final snapshot
  const artifactRecords = collectArtifactRecords(attempt, next);
  records.push(...artifactRecords);

  // 5. State-dir files (~/.aos/work/<issue>/)
  const stateRecords = collectStateDirRecords(attempt, next);
  records.push(...stateRecords);

  // 6. Live tmux pane (if alive)
  if (attempt.tmux_session && sessionExists(attempt.tmux_session)) {
    sourcesPresent.push('tmux');
    const pane = capturePane(attempt.tmux_session, TMUX_SCROLLBACK_LINES);
    records.push({
      v: SCHEMA_VERSION,
      kind: 'tmux_pane',
      ts: new Date().toISOString(),
      seq: next(),
      source: 'tmux',
      tmux_session: attempt.tmux_session,
      lines: pane.split('\n').length,
      content: pane,
    });
  } else if (attempt.tmux_session) {
    sourcesMissing.push('tmux (session ended)');
  }

  // 7. Env vars (workspace .env.aos), redacted
  const envRecord = collectEnvRecord(attempt, next);
  if (envRecord) records.push(envRecord);

  // ---- Header / write ----
  const degraded = !sourcesPresent.includes('claude-jsonl');
  const outDir = options.outDir ?? join(homedir(), '.aos', 'replays');
  mkdirSync(outDir, { recursive: true });
  const outputPath = options.out ?? join(outDir, `${attempt.id}.jsonl`);
  const payloadDir = `${outputPath.replace(/\.jsonl$/, '')}.payloads`;

  const meta = buildMetaRecord(attempt, {
    sourcesPresent,
    sourcesMissing,
    degraded,
    claudeFiles: claudeFiles.map((f) => basename(f)),
  });

  // Resolve oversized tool_result content into sidecar files
  const finalRecords = spillLargeToolResults(records, payloadDir);
  const lines = [meta, ...finalRecords].map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(outputPath, lines, 'utf-8');

  return {
    outputPath,
    recordCount: 1 + finalRecords.length,
    sourcesPresent,
    sourcesMissing,
    degraded,
  };
}

// ----- Builders -----

function buildMetaRecord(
  attempt: Attempt,
  ctx: { sourcesPresent: string[]; sourcesMissing: string[]; degraded: boolean; claudeFiles: string[] },
): ReplayRecord {
  return {
    v: SCHEMA_VERSION,
    kind: 'meta',
    attempt_id: attempt.id,
    issue_key: attempt.issue_key,
    agent_type: attempt.agent_type,
    agent_session_id: attempt.agent_session_id,
    tmux_session: attempt.tmux_session,
    attempt_number: attempt.attempt_number,
    status: attempt.status,
    host: attempt.host,
    workspace_path: attempt.workspace_path,
    budget_usd: attempt.budget_usd,
    cost_usd: attempt.cost_usd,
    created_at: toIso(attempt.created_at),
    completed_at: attempt.completed_at ? toIso(attempt.completed_at) : null,
    error_log: attempt.error_log,
    extractor: {
      name: EXTRACTOR_NAME,
      version: EXTRACTOR_VERSION,
      captured_at: new Date().toISOString(),
      sources_present: ctx.sourcesPresent,
      sources_missing: ctx.sourcesMissing,
      degraded: ctx.degraded,
      claude_jsonl_files: ctx.claudeFiles,
    },
  };
}

function buildLifecycleRecord(ev: AttemptEvent, seq: number): ReplayRecord {
  let payload: unknown = null;
  if (ev.payload) {
    try { payload = JSON.parse(ev.payload); } catch { payload = ev.payload; }
  }
  return {
    v: SCHEMA_VERSION,
    kind: 'lifecycle',
    ts: toIso(ev.created_at),
    seq,
    source: 'state.db',
    event_type: ev.event_type,
    payload,
  };
}

function maybeBuildHandoffRecord(ev: AttemptEvent, next: () => number): ReplayRecord | null {
  if (ev.event_type !== 'handoff') return null;
  let payload: { to?: string; message?: string } = {};
  if (ev.payload) {
    try { payload = JSON.parse(ev.payload); } catch { /* ignore */ }
  }
  return {
    v: SCHEMA_VERSION,
    kind: 'handoff',
    ts: toIso(ev.created_at),
    seq: next(),
    source: 'state.db',
    to: payload.to ?? null,
    message: payload.message ?? null,
  };
}

function collectSystemPromptRecords(attempt: Attempt, next: () => number): ReplayRecord[] {
  if (!attempt.workspace_path) return [];
  const claudeDir = join(attempt.workspace_path, '.claude');
  if (!existsSync(claudeDir)) return [];
  let entries: string[];
  try { entries = readdirSync(claudeDir); } catch { return []; }
  const groundingFiles = entries.filter((f) => f.startsWith('.agent-grounding-') && f.endsWith('.md'));
  const out: ReplayRecord[] = [];
  for (const f of groundingFiles) {
    const path = join(claudeDir, f);
    try {
      const buf = readFileSync(path);
      const content = buf.toString('utf-8');
      const sha = sha256(buf);
      out.push({
        v: SCHEMA_VERSION,
        kind: 'system_prompt',
        ts: toIso(statSync(path).mtime.toISOString()),
        seq: next(),
        source: 'workspace',
        path: `.claude/${f}`,
        sha256: sha,
        bytes: buf.byteLength,
        content: buf.byteLength > MAX_INLINE_BYTES ? null : content,
      });
    } catch { /* skip unreadable */ }
  }
  return out;
}

function collectArtifactRecords(attempt: Attempt, next: () => number): ReplayRecord[] {
  if (!attempt.workspace_path) return [];
  const out: ReplayRecord[] = [];
  for (const name of ['HANDOFF.md', 'BLOCKED.md', 'PROGRESS.md']) {
    const path = join(attempt.workspace_path, name);
    if (!existsSync(path)) continue;
    out.push(buildFileDiffRecord(path, name, 'final', next()));
  }
  return out;
}

function collectStateDirRecords(attempt: Attempt, next: () => number): ReplayRecord[] {
  const stateDir = join(getConfig().stateDir, 'work', attempt.issue_key);
  if (!existsSync(stateDir)) return [];
  const out: ReplayRecord[] = [];
  let entries: string[];
  try { entries = readdirSync(stateDir); } catch { return []; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const path = join(stateDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
    } catch { continue; }
    const operation = name.includes('TEMPLATE') ? 'template' : 'final';
    out.push(buildFileDiffRecord(path, name, operation, next(), { stateDir: true }));
  }
  return out;
}

function buildFileDiffRecord(
  absPath: string,
  relPath: string,
  operation: string,
  seq: number,
  flags: { stateDir?: boolean } = {},
): ReplayRecord {
  let buf: Buffer;
  try { buf = readFileSync(absPath); } catch {
    return {
      v: SCHEMA_VERSION,
      kind: 'file_diff',
      ts: new Date().toISOString(),
      seq,
      source: 'workspace',
      path: relPath,
      operation: 'removed',
    };
  }
  const stat = statSync(absPath);
  const rec: ReplayRecord = {
    v: SCHEMA_VERSION,
    kind: 'file_diff',
    ts: toIso(stat.mtime.toISOString()),
    seq,
    source: 'workspace',
    path: relPath,
    operation,
    sha256: sha256(buf),
    bytes: buf.byteLength,
    content: buf.byteLength > MAX_INLINE_BYTES ? null : buf.toString('utf-8'),
  };
  if (flags.stateDir) rec.state_dir_path = absPath;
  return rec;
}

function collectEnvRecord(attempt: Attempt, next: () => number): ReplayRecord | null {
  if (!attempt.workspace_path) return null;
  const envFile = join(attempt.workspace_path, '.env.aos');
  if (!existsSync(envFile)) return null;
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(envFile, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) vars[m[1]] = redactValue(m[1], m[2]);
    }
  } catch { return null; }
  return {
    v: SCHEMA_VERSION,
    kind: 'env',
    ts: new Date().toISOString(),
    seq: next(),
    source: 'workspace',
    vars,
  };
}

// ----- Claude JSONL parsing -----

function findClaudeSessionFiles(attempt: Attempt): string[] {
  if (!attempt.workspace_path) return [];
  const projectDir = join(homedir(), '.claude', 'projects', encodeWorkspacePath(attempt.workspace_path));
  if (!existsSync(projectDir)) return [];

  // 1. Direct match by agent_session_id
  if (attempt.agent_session_id) {
    const direct = join(projectDir, `${attempt.agent_session_id}.jsonl`);
    if (existsSync(direct)) return [direct];
  }

  // 2. Window-overlap match
  const startMs = Date.parse(toIso(attempt.created_at));
  const endIso = attempt.completed_at ? toIso(attempt.completed_at) : new Date().toISOString();
  const endMs = Date.parse(endIso) + 5 * 60 * 1000;

  let entries: string[];
  try { entries = readdirSync(projectDir); } catch { return []; }
  const matches: string[] = [];
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const full = join(projectDir, f);
    const range = readJsonlTimeRange(full);
    if (!range) continue;
    if (range.firstMs > endMs) continue;
    if (range.lastMs < startMs) continue;
    matches.push(full);
  }
  return matches;
}

function readJsonlTimeRange(path: string): { firstMs: number; lastMs: number } | null {
  let content: string;
  try { content = readFileSync(path, 'utf-8'); } catch { return null; }
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: { timestamp?: string };
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.timestamp) continue;
    const ms = Date.parse(obj.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (ms < firstMs) firstMs = ms;
    if (ms > lastMs) lastMs = ms;
  }
  if (!Number.isFinite(firstMs)) return null;
  return { firstMs, lastMs };
}

function encodeWorkspacePath(p: string): string {
  // Claude Code replaces "/" with "-" in workspace paths to derive the project dir under ~/.claude/projects/
  return p.replace(/\//g, '-');
}

export function parseClaudeJsonl(
  path: string,
  attempt: Attempt,
  next: () => number,
  options: CaptureOptions,
): ReplayRecord[] {
  let content: string;
  try { content = readFileSync(path, 'utf-8'); } catch { return []; }
  const out: ReplayRecord[] = [];
  // Filter to records that fall within the attempt window
  const startMs = Date.parse(toIso(attempt.created_at));
  const endIso = attempt.completed_at ? toIso(attempt.completed_at) : new Date().toISOString();
  const endMs = Date.parse(endIso) + 5 * 60 * 1000;

  // First pass: index tool_call ts for duration computation in supplements.
  const toolCallTs = new Map<string, string>();
  const toolCallInputs = new Map<string, unknown>();
  const toolCallNames = new Map<string, string>();
  const seenToolUseIds = new Set<string>();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: ClaudeRecord;
    try { obj = JSON.parse(line) as ClaudeRecord; } catch { continue; }
    const ts = obj.timestamp ?? null;
    if (ts) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms) && (ms < startMs || ms > endMs)) continue;
    }

    const tsIso = ts ?? new Date().toISOString();
    if (obj.type === 'assistant') {
      out.push(...buildAssistantRecords(obj, tsIso, next, options, toolCallTs, toolCallInputs, toolCallNames, seenToolUseIds));
    } else if (obj.type === 'user') {
      out.push(...buildUserRecords(obj, tsIso, next, toolCallTs, toolCallInputs, toolCallNames, seenToolUseIds));
    } else if (obj.type === 'system') {
      out.push(...buildSystemRecords(obj, tsIso, next));
    } else if (obj.type === 'attachment') {
      out.push({
        v: SCHEMA_VERSION,
        kind: 'attachment',
        ts: tsIso,
        seq: next(),
        source: 'claude-jsonl',
        original: obj,
      });
    } else if (obj.type === 'file-history-snapshot') {
      // Pass through; viewer may interpret. Phase 1: opaque.
      out.push({
        v: SCHEMA_VERSION,
        kind: 'attachment',
        subkind: 'file-history-snapshot',
        ts: tsIso,
        seq: next(),
        source: 'claude-jsonl',
        original: obj,
      });
    }
    // permission-mode and last-prompt are ignored in v1 (low signal for replay)
  }

  // Emit orphan supplements for tool_calls that never received a tool_result.
  for (const [toolUseId, callTs] of toolCallTs) {
    if (seenToolUseIds.has(toolUseId)) continue;
    out.push({
      v: SCHEMA_VERSION,
      kind: 'tool_result_supplement',
      ts: callTs,
      seq: next(),
      source: 'claude-jsonl',
      tool_use_id: toolUseId,
      tool_name: toolCallNames.get(toolUseId) ?? null,
      input_hash: hashCanonicalJson(toolCallInputs.get(toolUseId)),
      result_bytes_sha256: null,
      duration_ms: null,
      fs_pre_snapshot: null,
      wallclock_iso: callTs,
      is_orphan: true,
    });
  }
  return out;
}

interface ClaudeRecord {
  type?: string;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  requestId?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: ClaudeMessage;
}

interface ClaudeMessage {
  role?: string;
  model?: string;
  stop_reason?: string;
  usage?: Record<string, unknown>;
  content?: ClaudeContentBlock[] | string;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function buildAssistantRecords(
  obj: ClaudeRecord,
  tsIso: string,
  next: () => number,
  options: CaptureOptions,
  toolCallTs: Map<string, string>,
  toolCallInputs: Map<string, unknown>,
  toolCallNames: Map<string, string>,
  _seenToolUseIds: Set<string>,
): ReplayRecord[] {
  const msg = obj.message ?? {};
  const out: ReplayRecord[] = [];
  const llmIo: ReplayRecord = {
    v: SCHEMA_VERSION,
    kind: 'llm_io',
    ts: tsIso,
    seq: next(),
    source: 'claude-jsonl',
    uuid: obj.uuid,
    parent_uuid: obj.parentUuid ?? null,
    request_id: obj.requestId,
    session_id: obj.sessionId,
    model: msg.model,
    cwd: obj.cwd,
    git_branch: obj.gitBranch,
    version: obj.version,
    stop_reason: msg.stop_reason,
    usage: msg.usage,
  };
  out.push(llmIo);

  // CTO ADR D1: per-turn rendered_context supplement (synthesize what we can; rendered:false in Phase 1).
  out.push(buildRenderedContextRecord(obj, msg, tsIso, next));

  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({
          v: SCHEMA_VERSION,
          kind: 'text',
          ts: tsIso,
          seq: next(),
          source: 'claude-jsonl',
          parent_uuid: obj.uuid,
          content: block.text,
        });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        if (options.noThinking) continue;
        out.push({
          v: SCHEMA_VERSION,
          kind: 'thinking',
          ts: tsIso,
          seq: next(),
          source: 'claude-jsonl',
          parent_uuid: obj.uuid,
          content: block.thinking,
        });
      } else if (block.type === 'tool_use') {
        out.push({
          v: SCHEMA_VERSION,
          kind: 'tool_call',
          ts: tsIso,
          seq: next(),
          source: 'claude-jsonl',
          parent_uuid: obj.uuid,
          tool_use_id: block.id,
          tool_name: block.name,
          input: block.input,
        });
        if (block.id) {
          toolCallTs.set(block.id, tsIso);
          toolCallInputs.set(block.id, block.input);
          if (block.name) toolCallNames.set(block.id, block.name);
        }
      }
    }
  }
  return out;
}

function buildRenderedContextRecord(
  obj: ClaudeRecord,
  msg: ClaudeMessage,
  tsIso: string,
  next: () => number,
): ReplayRecord {
  const usage = (msg.usage ?? {}) as Record<string, number | undefined>;
  const genAi: Record<string, unknown> = {
    'gen_ai.request.model': msg.model ?? null,
    'gen_ai.response.model': msg.model ?? null,
    'gen_ai.conversation.id': obj.sessionId ?? null,
  };
  if (typeof usage.input_tokens === 'number') genAi['gen_ai.usage.input_tokens'] = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') genAi['gen_ai.usage.output_tokens'] = usage.output_tokens;
  return {
    v: SCHEMA_VERSION,
    kind: 'rendered_context',
    ts: tsIso,
    seq: next(),
    source: 'claude-jsonl',
    turn_uuid: obj.uuid ?? null,
    session_id: obj.sessionId ?? null,
    model_id: msg.model ?? null,
    rendered_system_prompt: null,
    rendered_tools: null,
    sampling_params: null,
    cache_state: null,
    wallclock_iso: tsIso,
    cwd: obj.cwd ?? null,
    git_branch: obj.gitBranch ?? null,
    version: obj.version ?? null,
    env_subset: null, // Filled by collectEnvRecord; left null here to avoid duplication.
    rendered: false,
    rendered_source: null,
    gen_ai: genAi,
  };
}

function buildUserRecords(
  obj: ClaudeRecord,
  tsIso: string,
  next: () => number,
  toolCallTs: Map<string, string>,
  toolCallInputs: Map<string, unknown>,
  toolCallNames: Map<string, string>,
  seenToolUseIds: Set<string>,
): ReplayRecord[] {
  const msg = obj.message ?? {};
  const content = msg.content;
  const out: ReplayRecord[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        const serialized = block.content === undefined ? '' :
          (typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        const bytes = Buffer.byteLength(serialized, 'utf-8');
        out.push({
          v: SCHEMA_VERSION,
          kind: 'tool_result',
          ts: tsIso,
          seq: next(),
          source: 'claude-jsonl',
          tool_use_id: block.tool_use_id,
          is_error: block.is_error ?? false,
          content: block.content,
          truncated: false,
          bytes,
        });
        // CTO ADR D1: per-tool-result supplement.
        if (block.tool_use_id) {
          seenToolUseIds.add(block.tool_use_id);
          const callTs = toolCallTs.get(block.tool_use_id);
          const callMs = callTs ? Date.parse(callTs) : NaN;
          const resultMs = Date.parse(tsIso);
          const durationMs = (Number.isFinite(callMs) && Number.isFinite(resultMs)) ? resultMs - callMs : null;
          out.push({
            v: SCHEMA_VERSION,
            kind: 'tool_result_supplement',
            ts: tsIso,
            seq: next(),
            source: 'claude-jsonl',
            tool_use_id: block.tool_use_id,
            tool_name: toolCallNames.get(block.tool_use_id) ?? null,
            input_hash: hashCanonicalJson(toolCallInputs.get(block.tool_use_id)),
            result_bytes_sha256: 'sha256:' + sha256(Buffer.from(serialized, 'utf-8')),
            duration_ms: durationMs,
            fs_pre_snapshot: null,
            wallclock_iso: tsIso,
          });
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        out.push({
          v: SCHEMA_VERSION,
          kind: 'text',
          ts: tsIso,
          seq: next(),
          source: 'claude-jsonl',
          parent_uuid: obj.parentUuid,
          role: 'user',
          content: block.text,
        });
      }
    }
  } else if (typeof content === 'string') {
    out.push({
      v: SCHEMA_VERSION,
      kind: 'text',
      ts: tsIso,
      seq: next(),
      source: 'claude-jsonl',
      parent_uuid: obj.parentUuid,
      role: 'user',
      content,
    });
  }
  return out;
}

function buildSystemRecords(obj: ClaudeRecord, tsIso: string, next: () => number): ReplayRecord[] {
  // Claude-emitted "system" records (system reminders, etc.) — pass through as text with role:system
  const msg = obj.message ?? {};
  const content = msg.content;
  const text = typeof content === 'string' ? content :
    Array.isArray(content) ? content.map((c) => (typeof c === 'object' && c.text) ? c.text : '').join('\n') : '';
  return [{
    v: SCHEMA_VERSION,
    kind: 'text',
    ts: tsIso,
    seq: next(),
    source: 'claude-jsonl',
    parent_uuid: obj.parentUuid,
    role: 'system',
    content: text,
  }];
}

// ----- Spillover for large tool_results -----

function spillLargeToolResults(records: ReplayRecord[], payloadDir: string): ReplayRecord[] {
  let payloadDirEnsured = false;
  return records.map((r) => {
    if (r.kind !== 'tool_result') return r;
    const bytes = (r.bytes as number | undefined) ?? 0;
    if (bytes <= MAX_TOOL_RESULT_INLINE_BYTES) return r;

    if (!payloadDirEnsured) {
      mkdirSync(payloadDir, { recursive: true });
      payloadDirEnsured = true;
    }
    const id = (r.tool_use_id as string) ?? `seq-${r.seq}`;
    const sidecar = join(payloadDir, `${id}.txt`);
    const content = r.content === undefined ? '' :
      typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2);
    writeFileSync(sidecar, content, 'utf-8');
    return { ...r, content: '<truncated>', truncated: true, sidecar };
  });
}

// ----- Helpers -----

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Stable hash of a tool input. Sorted keys, no whitespace; null/undefined collapse to ''. */
export function hashCanonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'sha256:' + sha256(Buffer.from('', 'utf-8'));
  const canonical = canonicalize(value);
  return 'sha256:' + sha256(Buffer.from(canonical, 'utf-8'));
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return 'null';
}

function isOlderThanDays(ts: string, days: number): boolean {
  const t = Date.parse(toIso(ts));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > days * 24 * 60 * 60 * 1000;
}

function toIso(ts: string): string {
  // SQLite's CURRENT_TIMESTAMP-style value is "YYYY-MM-DD HH:MM:SS" without TZ; treat as UTC.
  if (ts.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(ts)) return ts;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(ts)) {
    return ts.replace(' ', 'T') + 'Z';
  }
  return ts;
}

const SECRET_KEY_PATTERN = /KEY|TOKEN|SECRET|PASSWORD/i;
function redactValue(key: string, value: string): string {
  if (SECRET_KEY_PATTERN.test(key)) return '<redacted>';
  return value;
}
