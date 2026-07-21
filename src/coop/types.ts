/**
 * Shared types for the COOP (Company-Of-One Public) pipeline.
 *
 * Every collector produces `CollectorOutput<T>` — a tagged payload that
 * carries through the pipeline into the site generator. All strings
 * destined for the public site MUST already have been through a
 * `Redactor.redact()` call before they leave the collector.
 */

export type AgentRole =
  | 'ceo-office'
  | 'cto'
  | 'cpo'
  | 'coo'
  | 'lead-engineer'
  | 'research-lead'
  | string;

export interface CollectorOutput<T> {
  /** Collector id, e.g. 'linear', 'retros', 'memory', 'git', 'cost'. */
  source: string;
  /** When this data was collected. */
  collectedAt: string; // ISO-8601
  /** The actual payload — already redacted. */
  items: T[];
  /** Counts of redactions applied by the collector, for audit. */
  redactions: number;
}

export interface LinearIssueSummary {
  key: string;
  title: string;
  status: string;
  assignee: string | null;
  labels: string[];
  updatedAt: string;
  recentComments: { author: string; body: string; createdAt: string }[];
}

export interface RetroEntry {
  role: AgentRole;
  date: string; // YYYY-MM-DD
  /** Redacted markdown body. */
  body: string;
  /** Optional parse-extracted section headers (What went well, Learnings, etc.). */
  sections?: Record<string, string>;
}

export interface MemoryEntry {
  /** Source file basename, e.g. 'ceo-brief-format.md' */
  file: string;
  title: string;
  /** Redacted markdown body. */
  body: string;
  /** From front-matter — must be exactly `true` for the file to be included. */
  public: true;
}

export interface GitCommitEntry {
  sha: string;
  date: string; // ISO-8601
  subject: string;
  author: string;
  /** Redacted. */
  body: string;
}

export interface CostEntry {
  role: AgentRole;
  week: string; // ISO week, e.g. '2026-W17'
  tokens: number;
  usd: number;
}

export interface CoopBundle {
  builtAt: string;
  linear: CollectorOutput<LinearIssueSummary>;
  retros: CollectorOutput<RetroEntry>;
  memory: CollectorOutput<MemoryEntry>;
  git: CollectorOutput<GitCommitEntry>;
  cost: CollectorOutput<CostEntry>;
}

export interface BuildOptions {
  /** Output directory. Default: <repo>/dist/coop */
  outDir: string;
  /** Where to read cached collector data from — skips live calls when set. */
  cacheDir?: string;
  /** When true, any redactor violation aborts the build (tests use this). */
  strict?: boolean;
  /** Override the current time (for tests). */
  now?: Date;
  /** Override the agents dir scan root (for tests). */
  agentsDir?: string;
  /** Override shared-memory dir (for tests). */
  sharedMemoryDir?: string;
  /** Override budget file (for tests). */
  budgetFile?: string;
  /** Override git repo root (for tests). */
  gitRoot?: string;
}
