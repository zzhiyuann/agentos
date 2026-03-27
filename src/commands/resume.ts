import chalk from 'chalk';
import { getActiveAttempt, getAttemptsByIssue, logEvent } from '../core/db.js';
import { getAdapter } from '../adapters/index.js';
import { hasAgentAccess, emitActivity } from '../core/linear.js';
import { spawnCommand } from './spawn.js';

export async function resumeCommand(issueKey: string): Promise<void> {
  const key = issueKey.toUpperCase();

  // Check for active attempt
  const active = getActiveAttempt(key);
  if (active) {
    console.log(chalk.yellow(`Active attempt exists for ${key}: ${active.tmux_session}`));
    console.log(`  Use: ${chalk.bold(`aos jump ${key}`)}`);
    return;
  }

  // Check for previous attempts
  const attempts = getAttemptsByIssue(key);
  if (attempts.length === 0) {
    console.log(chalk.dim(`No previous attempts for ${key}. Spawning new...`));
    await spawnCommand(key, {});
    return;
  }

  const lastAttempt = attempts[0];
  console.log(chalk.bold(`Resuming ${key} (previous: attempt #${lastAttempt.attempt_number}, ${lastAttempt.status})`));

  // Spawn a new attempt (next attempt number is auto-calculated by DB)
  await spawnCommand(key, { agent: lastAttempt.agent_type });
}
