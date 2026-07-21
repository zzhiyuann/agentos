/**
 * Heuristic task-vs-meta classifier for AOS sessions.
 *
 * The "meta-tax" is the share of tokens an AI-native company spends on
 * governance overhead (HANDOFF.md, .agent-memory/, progress comments,
 * status-transition prose, retrospectives) instead of the user's actual work.
 *
 * Each assistant message is classified by inspecting its tool calls and
 * routed to either the "task" or "meta" bucket. Rules are config-driven
 * via ~/.aos/pnl-rules.json so operators can tune without code changes.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { STATE_DIR } from '../core/config.js';

export type Bucket = 'task' | 'meta';

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Single classification rule. First match wins. */
export interface ClassifyRule {
  bucket: Bucket;
  /** Optional tool name (exact match). Empty/undefined = applies to all tools. */
  tool?: string;
  /** Regex applied to a specific input field; if matches → rule fires. */
  inputField?: string;
  inputPattern?: string; // serialized regex source
  /** Human-readable label for explainability. */
  label: string;
}

export interface ClassifierConfig {
  /** Default bucket when no rule matches. */
  defaultBucket: Bucket;
  rules: ClassifyRule[];
}

/**
 * Default rules — encoded heuristics from RYA-763.
 *
 * Order matters: meta-paths are listed before task-paths because some files
 * could be argued either way; we err on the side of meta to be honest about
 * governance overhead.
 */
export const DEFAULT_RULES: ClassifyRule[] = [
  // --- Meta: memory / handoff / retros ---
  {
    bucket: 'meta',
    tool: 'Edit',
    inputField: 'file_path',
    inputPattern: '(HANDOFF\\.md|\\.agent-memory/|MEMORY\\.md|retrospectives/|\\.agent-memory-index\\.md|/\\.aos/work/)',
    label: 'edit-memory-or-handoff',
  },
  {
    bucket: 'meta',
    tool: 'Write',
    inputField: 'file_path',
    inputPattern: '(HANDOFF\\.md|\\.agent-memory/|MEMORY\\.md|retrospectives/|\\.agent-memory-index\\.md|/\\.aos/work/)',
    label: 'write-memory-or-handoff',
  },
  {
    bucket: 'meta',
    tool: 'Read',
    inputField: 'file_path',
    inputPattern: '(HANDOFF\\.md|\\.agent-memory/|MEMORY\\.md|retrospectives/|\\.agent-memory-index\\.md|CLAUDE\\.md|system-memory\\.md|/\\.aos/(work|agents|shared-memory)/)',
    label: 'read-memory-or-handoff',
  },
  // --- Meta: linear governance commands ---
  {
    bucket: 'meta',
    tool: 'Bash',
    inputField: 'command',
    inputPattern: 'linear-tool\\s+(comment|notify|ask|reply|group|create-doc|upload-deliverables|attach|set-status|set-priority|recall|view|sub-issues|relations|team-status)',
    label: 'linear-governance',
  },
  // --- Meta: status / progress reads ---
  {
    bucket: 'meta',
    tool: 'Bash',
    inputField: 'command',
    inputPattern: '(linear-tool\\s+(handoff|dispatch|mention|spawn-worker|plan|create-issue|block|unblock|relate|duplicate))',
    label: 'linear-coordination',
  },
  // --- Task: actual code work ---
  {
    bucket: 'task',
    tool: 'Edit',
    inputField: 'file_path',
    inputPattern: '/(src/|scripts/|tests?/|\\.github/)',
    label: 'edit-code',
  },
  {
    bucket: 'task',
    tool: 'Write',
    inputField: 'file_path',
    inputPattern: '/(src/|scripts/|tests?/|\\.github/)',
    label: 'write-code',
  },
  {
    bucket: 'task',
    tool: 'Bash',
    inputField: 'command',
    inputPattern: '(npm\\s+(test|run|install)|npx\\s+(vitest|tsc|eslint)|tsc(\\s|$)|vitest|cargo\\s+(test|build|run)|pytest|go\\s+(test|build|run))',
    label: 'run-tests-or-build',
  },
  {
    bucket: 'task',
    tool: 'Bash',
    inputField: 'command',
    inputPattern: '(git\\s+(commit|push|diff|log|show|checkout|merge|rebase))',
    label: 'git-operations',
  },
  {
    bucket: 'task',
    tool: 'Grep',
    label: 'code-grep',
  },
  {
    bucket: 'task',
    tool: 'Glob',
    label: 'code-glob',
  },
];

const RULES_CONFIG_PATH = join(STATE_DIR, 'pnl-rules.json');

/**
 * Load classifier config from disk, or return defaults. Config can override
 * rules entirely or set a different default bucket.
 */
export function loadClassifierConfig(): ClassifierConfig {
  if (existsSync(RULES_CONFIG_PATH)) {
    try {
      const data = JSON.parse(readFileSync(RULES_CONFIG_PATH, 'utf-8')) as Partial<ClassifierConfig>;
      return {
        defaultBucket: data.defaultBucket ?? 'task',
        rules: data.rules && data.rules.length > 0 ? data.rules : DEFAULT_RULES,
      };
    } catch {
      // Fall through to defaults on parse error
    }
  }
  return { defaultBucket: 'task', rules: DEFAULT_RULES };
}

interface ClassifyResult {
  bucket: Bucket;
  matchedRule: string;
}

/** Classify a single tool call against the rules. */
export function classifyToolCall(call: ToolCall, config: ClassifierConfig): ClassifyResult {
  for (const rule of config.rules) {
    if (rule.tool && rule.tool !== call.name) continue;
    if (rule.inputField && rule.inputPattern) {
      const value = call.input?.[rule.inputField];
      if (typeof value !== 'string') continue;
      const re = new RegExp(rule.inputPattern);
      if (!re.test(value)) continue;
    }
    return { bucket: rule.bucket, matchedRule: rule.label };
  }
  return { bucket: config.defaultBucket, matchedRule: 'default' };
}

/**
 * Classify an assistant message based on its tool calls.
 *
 * Strategy: if ANY tool call is meta and ALL non-meta calls are absent, the
 * whole message is meta. Otherwise task. This biases toward "this turn
 * produced real work" — a fair-to-task interpretation.
 *
 * Empty messages (no tool calls, just thinking/text) are classified by the
 * default bucket — typically "task" because pure reasoning is part of work.
 */
export function classifyMessage(toolCalls: ToolCall[], config: ClassifierConfig): ClassifyResult {
  if (toolCalls.length === 0) {
    return { bucket: config.defaultBucket, matchedRule: 'no-tool-calls' };
  }
  let hasTask = false;
  let lastMetaRule = '';
  for (const call of toolCalls) {
    const r = classifyToolCall(call, config);
    if (r.bucket === 'task') {
      hasTask = true;
    } else {
      lastMetaRule = r.matchedRule;
    }
  }
  if (hasTask) return { bucket: 'task', matchedRule: 'has-task-tool' };
  return { bucket: 'meta', matchedRule: lastMetaRule || 'all-meta' };
}
