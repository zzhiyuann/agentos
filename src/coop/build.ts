/**
 * build.ts — the full COOP pipeline.
 *
 *   collect → redact-audit → render → write to disk
 *
 * `build()` returns a `BuildResult` so callers (CLI + tests) can inspect
 * what happened without scraping the output directory.
 */

import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { BuildOptions, CoopBundle } from './types.js';
import { defaultRedactor, StrictRedactor, type Redactor } from './redactor.js';
import { collectLinear, type LinearOptions } from './collectors/linear.js';
import { collectRetros } from './collectors/retros.js';
import { collectMemory } from './collectors/memory.js';
import { collectGit } from './collectors/git.js';
import { collectCost } from './collectors/cost.js';
import { renderSite } from './site/pages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BuildResult {
  outDir: string;
  pages: { path: string; bytes: number }[];
  bundle: CoopBundle;
  totalRedactions: number;
  /** Always 0 when strict mode passed — throws before returning otherwise. */
  auditViolations: number;
}

/**
 * Per-collector redactor — a strict pass running over the already-redacted
 * output. Any hit here means a collector missed a redaction, so we either
 * warn (default) or throw (strict mode).
 */
function auditBundle(bundle: CoopBundle, strict: boolean): number {
  const audit = new StrictRedactor();
  let violations = 0;

  const checkString = (s: string, source: string, field: string) => {
    try {
      audit.redact(s, { source, field });
    } catch (err) {
      violations++;
      if (strict) throw err;
      console.warn(`[coop:audit] ${(err as Error).message}`);
    }
  };

  for (const i of bundle.linear.items) {
    checkString(i.title, 'linear', 'title');
    if (i.assignee) checkString(i.assignee, 'linear', 'assignee');
    for (const c of i.recentComments) {
      checkString(c.body, 'linear', 'comment.body');
      checkString(c.author, 'linear', 'comment.author');
    }
  }
  for (const r of bundle.retros.items) checkString(r.body, 'retros', 'body');
  for (const m of bundle.memory.items) checkString(m.body, 'memory', 'body');
  for (const g of bundle.git.items) {
    checkString(g.subject, 'git', 'subject');
    checkString(g.body, 'git', 'body');
    checkString(g.author, 'git', 'author');
  }
  return violations;
}

export interface PipelineOverrides {
  redactor?: Redactor;
  linear?: Partial<LinearOptions>;
}

export async function buildBundle(opts: BuildOptions, overrides: PipelineOverrides = {}): Promise<CoopBundle> {
  const now = opts.now ?? new Date();
  const redactor = overrides.redactor ?? defaultRedactor();

  const [linear, retros, memory, git, cost] = await Promise.all([
    collectLinear({ redactor, now, ...overrides.linear }),
    Promise.resolve(collectRetros({ redactor, now, agentsDir: opts.agentsDir })),
    Promise.resolve(collectMemory({ redactor, now, sharedMemoryDir: opts.sharedMemoryDir })),
    Promise.resolve(collectGit({ redactor, now, gitRoot: opts.gitRoot })),
    Promise.resolve(collectCost({ now, budgetFile: opts.budgetFile })),
  ]);

  return {
    builtAt: now.toISOString(),
    linear,
    retros,
    memory,
    git,
    cost,
  };
}

export async function build(opts: BuildOptions, overrides: PipelineOverrides = {}): Promise<BuildResult> {
  const bundle = await buildBundle(opts, overrides);
  const violations = auditBundle(bundle, opts.strict === true);

  const outDir = resolve(opts.outDir);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const pages = renderSite(bundle);
  const writeLog: { path: string; bytes: number }[] = [];
  for (const page of pages) {
    const full = join(outDir, page.path.replace(/^\//, ''));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, page.html);
    writeLog.push({ path: page.path, bytes: page.html.length });
  }

  // Copy assets.
  const assetsSrc = join(__dirname, 'site', 'assets');
  if (existsSync(assetsSrc)) {
    cpSync(assetsSrc, join(outDir, 'assets'), { recursive: true });
  }

  // Persist bundle for debug / downstream (RSS / social, Phase 2).
  writeFileSync(join(outDir, 'bundle.json'), JSON.stringify(bundle, null, 2));

  const totalRedactions =
    bundle.linear.redactions +
    bundle.retros.redactions +
    bundle.memory.redactions +
    bundle.git.redactions +
    bundle.cost.redactions;

  return {
    outDir,
    pages: writeLog,
    bundle,
    totalRedactions,
    auditViolations: violations,
  };
}
