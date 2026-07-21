/** Infrastructure eval runner: baseline tracking and post-handoff regression detection. */

import { createLogger } from '../core/logger.js';
import { execFile } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { addComment } from '../core/linear.js';

const log = createLogger('eval-runner');

const EVAL_TIMEOUT_MS = 120_000;
const AGENTOS_DIR = join(homedir(), 'projects/agentos');
export const EVAL_BASELINE_PATH = join(AGENTOS_DIR, 'src/evals/eval-baseline.json');

interface EvalBaseline {
  failingTests: string[];
  updatedAt: string;
}

export function loadEvalBaseline(): Set<string> {
  try {
    if (!existsSync(EVAL_BASELINE_PATH)) return new Set();
    const data: EvalBaseline = JSON.parse(readFileSync(EVAL_BASELINE_PATH, 'utf-8'));
    return new Set(data.failingTests);
  } catch {
    return new Set();
  }
}

export function saveEvalBaseline(failingTests: string[]): void {
  const data: EvalBaseline = { failingTests, updatedAt: new Date().toISOString() };
  writeFileSync(EVAL_BASELINE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Extract failing test names from vitest JSON output. */
export function extractFailingTests(jsonOutput: string): string[] {
  try {
    const result = JSON.parse(jsonOutput);
    const failing: string[] = [];
    for (const file of result.testResults ?? []) {
      for (const test of file.assertionResults ?? []) {
        if (test.status === 'failed') {
          failing.push(test.ancestorTitles?.length
            ? `${test.ancestorTitles.join(' > ')} > ${test.title}`
            : test.title);
        }
      }
    }
    return failing;
  } catch {
    return [];
  }
}

/**
 * Run infrastructure evals asynchronously after handoff detection.
 * Only posts a warning to the issue if there are NEW failures (not in baseline).
 * Pre-existing failures are logged instead of blaming the current issue.
 */
export function runEvalsAsync(issueId: string, issueKey: string, agentToken?: string): void {
  log.debug('Running infrastructure evals', { issueKey });

  const baseline = loadEvalBaseline();

  execFile('npx', ['vitest', 'run', 'src/evals/', '--reporter=json'], {
    cwd: AGENTOS_DIR,
    timeout: EVAL_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: 'test', CI: '1' },
  }, async (error, stdout, stderr) => {
    if (!error) {
      saveEvalBaseline([]);
      log.info('Evals passed', { issueKey });
      return;
    }

    const allFailing = extractFailingTests(stdout);

    if (allFailing.length === 0) {
      if (baseline.size === 0) {
        const output = (stdout + '\n' + stderr).trim();
        const failLines = output.split('\n')
          .filter(l => /FAIL|✗|×|Error|AssertionError/i.test(l))
          .slice(0, 10)
          .join('\n');
        const summary = failLines || output.slice(-500);
        log.error('Evals failed (unparseable output)', { issueKey });
        try {
          await addComment(
            issueId,
            `⚠️ **Infrastructure evals failed** after handoff.\n\n\`\`\`\n${summary.substring(0, 1000)}\n\`\`\`\n\nThe agent should have run \`npx vitest run src/evals/\` before completing. Regressions may have been introduced.`,
            agentToken,
          );
        } catch (err) {
          log.error('Failed to post eval warning', { issueKey, error: (err as Error).message });
        }
      } else {
        log.warn('Evals failed but output unparseable — skipping issue comment (baseline has known failures)', { issueKey });
      }
      return;
    }

    saveEvalBaseline(allFailing);

    const newFailures = allFailing.filter(t => !baseline.has(t));
    const preExisting = allFailing.filter(t => baseline.has(t));

    if (preExisting.length > 0) {
      log.info('Pre-existing eval failures (not caused by this issue)', {
        issueKey,
        count: preExisting.length,
        tests: preExisting.slice(0, 5),
      });
    }

    if (newFailures.length === 0) {
      log.info('No new eval failures introduced', { issueKey, preExisting: preExisting.length });
      return;
    }

    const failSummary = newFailures.slice(0, 10).map(t => `  ✗ ${t}`).join('\n');
    log.error('New eval failures introduced', { issueKey, count: newFailures.length });
    try {
      await addComment(
        issueId,
        `⚠️ **New eval failures detected** after handoff (${newFailures.length} new, ${preExisting.length} pre-existing).\n\n\`\`\`\n${failSummary}\n\`\`\`\n\nThese failures were not present before this task. The agent should have run \`npx vitest run src/evals/\` before completing.`,
        agentToken,
      );
    } catch (err) {
      log.error('Failed to post eval warning', { issueKey, error: (err as Error).message });
    }
  });
}
