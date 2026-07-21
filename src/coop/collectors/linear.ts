/**
 * linear.ts — pull issues from Linear API for public publication.
 *
 * Filter: issues with the `[public]` label OR in status "In Review"/"Done".
 * Cache result to ~/.aos/coop/cache/linear.json so dev runs don't re-hit
 * Linear. When `cacheDir` is set and contains a recent file, we skip the
 * live fetch entirely.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import type { CollectorOutput, LinearIssueSummary } from '../types.js';
import { defaultRedactor, type Redactor } from '../redactor.js';

export interface LinearOptions {
  redactor?: Redactor;
  now?: Date;
  /** Dir to read/write the cache from. Default ~/.aos/coop/cache/ */
  cacheDir?: string;
  /** Read cached data even if stale. Default: read if < cacheTtlMs old. */
  cacheTtlMs?: number;
  /** Skip live API fetch; only use cache. Used by tests and offline builds. */
  offline?: boolean;
  /**
   * Injected fetcher — lets tests avoid the real Linear client.
   * Returns the unredacted, raw items.
   */
  fetchLive?: () => Promise<LinearIssueSummary[]>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cachePath(cacheDir: string): string {
  return join(cacheDir, 'linear.json');
}

function readCache(cacheDir: string, ttlMs: number): CollectorOutput<LinearIssueSummary> | null {
  const path = cachePath(cacheDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as CollectorOutput<LinearIssueSummary>;
    const age = Date.now() - new Date(parsed.collectedAt).getTime();
    if (age > ttlMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, data: CollectorOutput<LinearIssueSummary>): void {
  mkdirSync(dirname(cachePath(cacheDir)), { recursive: true });
  writeFileSync(cachePath(cacheDir), JSON.stringify(data, null, 2));
}

/**
 * Default live fetcher. Dynamically imports the Linear client so the
 * coop module stays loadable in contexts that don't have Linear config
 * (e.g., fixture tests).
 */
async function defaultFetchLive(): Promise<LinearIssueSummary[]> {
  const [{ getReadClient }, { getConfig }] = await Promise.all([
    import('../../core/linear-client.js'),
    import('../../core/config.js'),
  ]);
  const client = getReadClient();
  const config = getConfig();

  // Three parallel queries: [public] label; state In Review; state Done.
  const [byLabel, inReview, done] = await Promise.all([
    client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        labels: { name: { eq: '[public]' } },
      },
    }),
    client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        state: { name: { eq: 'In Review' } },
      },
    }),
    client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        state: { name: { eq: 'Done' } },
      },
    }),
  ]);

  const seen = new Set<string>();
  const combined: LinearIssueSummary[] = [];

  for (const bucket of [byLabel.nodes, inReview.nodes, done.nodes]) {
    for (const issue of bucket) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);

      const [state, labels, assigneeUser, commentsPage] = await Promise.all([
        issue.state,
        issue.labels(),
        issue.assignee,
        issue.comments({ first: 3 }),
      ]);

      const recent: { author: string; body: string; createdAt: string }[] = [];
      for (const c of commentsPage.nodes) {
        const user = await c.user;
        recent.push({
          author: user?.name ?? 'unknown',
          body: c.body,
          createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
        });
      }

      combined.push({
        key: issue.identifier,
        title: issue.title,
        status: state?.name ?? 'Unknown',
        assignee: assigneeUser?.name ?? null,
        labels: labels.nodes.map((l) => l.name),
        updatedAt: issue.updatedAt instanceof Date ? issue.updatedAt.toISOString() : String(issue.updatedAt),
        recentComments: recent,
      });
    }
  }

  // Newest first.
  combined.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return combined;
}

function redactIssue(item: LinearIssueSummary, redactor: Redactor): { item: LinearIssueSummary; redactions: number } {
  let redactions = 0;
  const titleR = redactor.redact(item.title, { source: 'linear', field: 'title' });
  redactions += titleR.redactions;
  const comments = item.recentComments.map((c) => {
    const bodyR = redactor.redact(c.body, { source: 'linear', field: 'comment' });
    const authorR = redactor.redact(c.author, { source: 'linear', field: 'author' });
    redactions += bodyR.redactions + authorR.redactions;
    return { author: authorR.text, body: bodyR.text, createdAt: c.createdAt };
  });
  const assignee = item.assignee
    ? redactor.redact(item.assignee, { source: 'linear', field: 'assignee' }).text
    : null;
  return {
    item: { ...item, title: titleR.text, assignee, recentComments: comments },
    redactions,
  };
}

export async function collectLinear(opts: LinearOptions = {}): Promise<CollectorOutput<LinearIssueSummary>> {
  const redactor = opts.redactor ?? defaultRedactor();
  const now = opts.now ?? new Date();
  const cacheDir = opts.cacheDir ?? join(homedir(), '.aos', 'coop', 'cache');
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;

  // Cache hit short-circuit (already redacted on write).
  const cached = readCache(cacheDir, ttlMs);
  if (cached) return cached;

  if (opts.offline) {
    return { source: 'linear', collectedAt: now.toISOString(), items: [], redactions: 0 };
  }

  const fetcher = opts.fetchLive ?? defaultFetchLive;
  let rawItems: LinearIssueSummary[] = [];
  try {
    rawItems = await fetcher();
  } catch (err) {
    console.warn('[coop:linear] live fetch failed:', (err as Error).message);
    return { source: 'linear', collectedAt: now.toISOString(), items: [], redactions: 0 };
  }

  let totalRedactions = 0;
  const items = rawItems.map((i) => {
    const r = redactIssue(i, redactor);
    totalRedactions += r.redactions;
    return r.item;
  });

  const out: CollectorOutput<LinearIssueSummary> = {
    source: 'linear',
    collectedAt: now.toISOString(),
    items,
    redactions: totalRedactions,
  };
  try {
    writeCache(cacheDir, out);
  } catch (err) {
    console.warn('[coop:linear] cache write failed:', (err as Error).message);
  }
  return out;
}
