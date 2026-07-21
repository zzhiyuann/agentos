/**
 * `aos coop build` — run the full COOP pipeline.
 *
 * Default output: <cwd>/dist/coop/
 * Use --out to override, --strict to fail on any redactor violation.
 */

import { resolve } from 'path';
import { build } from '../coop/build.js';

export interface CoopBuildOptions {
  out?: string;
  strict?: boolean;
  gitRoot?: string;
}

export async function coopBuildCommand(opts: CoopBuildOptions = {}): Promise<void> {
  const outDir = resolve(opts.out ?? 'dist/coop');
  const gitRoot = opts.gitRoot ? resolve(opts.gitRoot) : process.cwd();
  console.log(`[coop] building → ${outDir}`);
  try {
    const result = await build({
      outDir,
      strict: opts.strict === true,
      gitRoot,
    });
    console.log(`[coop] ${result.pages.length} pages written`);
    console.log(`[coop] ${result.totalRedactions} redactions applied across collectors`);
    if (result.auditViolations > 0) {
      console.warn(`[coop] ⚠ ${result.auditViolations} audit violation(s) — re-run with --strict to see details`);
    } else {
      console.log('[coop] ✓ audit clean');
    }
  } catch (err) {
    console.error('[coop] build failed:', (err as Error).message);
    process.exitCode = 1;
  }
}
