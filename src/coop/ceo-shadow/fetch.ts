/**
 * Pull issues + nested history + nested comments from Linear, in pages.
 *
 * Caches each page to ~/.aos/ceo-shadow/raw/issues-page-NN.json so the
 * extractor can re-run without burning rate-limit budget. Linear has two
 * limits: 2500 req/h and 3M complexity/h. We pack as much per request as
 * possible (first:30 issues + nested first:200 history + first:200
 * comments) — typically ~10–25 requests for the full 6-month window.
 *
 * RYA-845.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { RawIssue } from './types.js';

const QUERY = `
query CeoShadowIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description priority createdAt updatedAt
      creator { id name }
      assignee { id name }
      state { name type }
      parent { identifier title }
      labels { nodes { name } }
      history(first: 200) {
        nodes {
          id createdAt
          fromState { name } toState { name }
          fromPriority toPriority
          fromAssignee { name } toAssignee { name }
          actor { id name }
        }
      }
      comments(first: 200) {
        nodes {
          id body createdAt
          user { id name }
        }
      }
    }
  }
}`;

export interface FetchOptions {
  /** Linear API key (personal). */
  apiKey: string;
  /** Linear team UUID. */
  teamId: string;
  /** ISO timestamp — lower bound on `updatedAt`. */
  since: string;
  /** Cache dir; default ~/.aos/ceo-shadow/raw. */
  cacheDir?: string;
  /** Page size. Default 25. */
  pageSize?: number;
  /** When true, force re-fetch even if cache present. */
  refresh?: boolean;
  /** Optional logger. */
  log?: (msg: string) => void;
}

interface RawPage {
  fetchedAt: string;
  cursor: string | null;
  endCursor: string | null;
  hasNextPage: boolean;
  issues: RawIssue[];
}

function cacheDirFor(opts: FetchOptions): string {
  return opts.cacheDir ?? join(homedir(), '.aos', 'ceo-shadow', 'raw');
}

function pagePath(dir: string, n: number): string {
  return join(dir, `issues-page-${String(n).padStart(3, '0')}.json`);
}

async function postGraphql(apiKey: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Linear GraphQL non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (json.errors?.length) {
    const e = json.errors[0];
    const code = e.extensions?.code ?? 'UNKNOWN';
    if (code === 'RATELIMITED') {
      const reset = res.headers.get('x-ratelimit-requests-reset');
      throw Object.assign(new Error('RATELIMITED'), { code: 'RATELIMITED', reset });
    }
    throw new Error(`Linear GraphQL error: ${e.message} (${code})`);
  }
  return { data: json.data, headers: res.headers };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch all issues updated since `opts.since`, paginated, caching every
 * page to disk. Resumes from the last cached cursor if present.
 */
export async function fetchAllIssues(opts: FetchOptions): Promise<{ pages: number; issues: number }> {
  const dir = cacheDirFor(opts);
  mkdirSync(dir, { recursive: true });
  const log = opts.log ?? (() => {});
  const pageSize = opts.pageSize ?? 25;

  let pageNum = 0;
  let cursor: string | null = null;
  let totalIssues = 0;

  // Resume: walk existing pages to find the last endCursor.
  if (!opts.refresh) {
    while (existsSync(pagePath(dir, pageNum + 1))) {
      pageNum += 1;
      const cached = JSON.parse(readFileSync(pagePath(dir, pageNum), 'utf-8')) as RawPage;
      totalIssues += cached.issues.length;
      cursor = cached.endCursor;
      if (!cached.hasNextPage) {
        log(`[fetch] cache complete: ${pageNum} pages, ${totalIssues} issues`);
        return { pages: pageNum, issues: totalIssues };
      }
    }
    if (pageNum > 0) log(`[fetch] resuming from page ${pageNum + 1}, cursor=${cursor?.slice(0, 8)}…`);
  }

  while (true) {
    pageNum += 1;
    const variables: Record<string, unknown> = {
      filter: {
        team: { id: { eq: opts.teamId } },
        updatedAt: { gte: opts.since },
      },
      first: pageSize,
      after: cursor,
    };

    let attempt = 0;
    while (true) {
      try {
        log(`[fetch] page ${pageNum} (cursor=${cursor ? cursor.slice(0, 8) + '…' : 'start'})`);
        const { data, headers } = await postGraphql(opts.apiKey, QUERY, variables);
        const result = data.issues;
        const page: RawPage = {
          fetchedAt: new Date().toISOString(),
          cursor,
          endCursor: result.pageInfo.endCursor,
          hasNextPage: result.pageInfo.hasNextPage,
          issues: result.nodes,
        };
        writeFileSync(pagePath(dir, pageNum), JSON.stringify(page));
        totalIssues += page.issues.length;
        const remaining = headers.get('x-ratelimit-requests-remaining');
        const cxRemain = headers.get('x-ratelimit-complexity-remaining');
        log(`[fetch]   got ${page.issues.length} issues; req-remaining=${remaining}, cx-remaining=${cxRemain}`);
        if (!page.hasNextPage) {
          log(`[fetch] done: ${pageNum} pages, ${totalIssues} issues`);
          return { pages: pageNum, issues: totalIssues };
        }
        cursor = page.endCursor;
        break; // success — break retry loop, continue paging
      } catch (err: any) {
        attempt += 1;
        if (err.code === 'RATELIMITED') {
          const reset = err.reset ? parseInt(err.reset, 10) : 0;
          const waitMs = Math.max(reset - Date.now(), 60_000);
          log(`[fetch] rate-limited, sleeping ${(waitMs / 1000).toFixed(0)}s…`);
          await sleep(Math.min(waitMs, 15 * 60_000));
          if (attempt >= 3) throw err;
          continue;
        }
        throw err;
      }
    }
  }
}

/**
 * Iterate cached issues from disk. Used by the extractor.
 */
export function* iterCachedIssues(cacheDir?: string): Generator<RawIssue> {
  const dir = cacheDir ?? join(homedir(), '.aos', 'ceo-shadow', 'raw');
  if (!existsSync(dir)) return;
  let n = 0;
  while (true) {
    n += 1;
    const path = pagePath(dir, n);
    if (!existsSync(path)) return;
    const page = JSON.parse(readFileSync(path, 'utf-8')) as RawPage;
    for (const issue of page.issues) yield issue;
  }
}
