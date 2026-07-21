/**
 * git.ts — shipped-today digest: `git log --since=yesterday --pretty`,
 * parsed and redacted per commit.
 */

import { execFileSync } from 'child_process';
import type { CollectorOutput, GitCommitEntry } from '../types.js';
import { defaultRedactor, type Redactor } from '../redactor.js';

export interface GitOptions {
  gitRoot?: string;
  redactor?: Redactor;
  now?: Date;
  /** `--since` value for git log. Default '1 day ago'. */
  since?: string;
}

const SEP = '====COMMIT====';
const FIELD_SEP = '----FIELD----';

export function collectGit(opts: GitOptions = {}): CollectorOutput<GitCommitEntry> {
  const redactor = opts.redactor ?? defaultRedactor();
  const now = opts.now ?? new Date();
  const since = opts.since ?? '1 day ago';
  const gitRoot = opts.gitRoot ?? process.cwd();

  const items: GitCommitEntry[] = [];
  let totalRedactions = 0;

  const format = `${SEP}%n%H${FIELD_SEP}%aI${FIELD_SEP}%an${FIELD_SEP}%s${FIELD_SEP}%b`;
  let output = '';
  try {
    output = execFileSync('git', ['log', `--since=${since}`, `--pretty=format:${format}`], {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Not a git repo, or git not installed — return empty.
    return { source: 'git', collectedAt: now.toISOString(), items, redactions: 0 };
  }

  const commits = output.split(SEP).map((c) => c.trim()).filter(Boolean);
  for (const raw of commits) {
    const fields = raw.split(FIELD_SEP);
    if (fields.length < 5) continue;
    const [sha, date, author, subject, body] = fields;

    const subjR = redactor.redact(subject, { source: 'git', field: 'subject' });
    const bodyR = redactor.redact(body, { source: 'git', field: 'body' });
    const authorR = redactor.redact(author, { source: 'git', field: 'author' });
    totalRedactions += subjR.redactions + bodyR.redactions + authorR.redactions;

    items.push({
      sha: sha.slice(0, 12),
      date,
      subject: subjR.text,
      author: authorR.text,
      body: bodyR.text,
    });
  }

  return { source: 'git', collectedAt: now.toISOString(), items, redactions: totalRedactions };
}
