import chalk from 'chalk';
import { getActiveAttempt } from '../core/db.js';
import { openGhosttySession, sessionExists } from '../core/tmux.js';

export async function jumpCommand(issueKey: string): Promise<void> {
  const key = issueKey.toUpperCase();
  const attempt = getActiveAttempt(key);

  if (!attempt) {
    console.log(chalk.red(`No active attempt for ${key}`));
    console.log(`  Spawn one: ${chalk.bold(`aos spawn ${key}`)}`);
    return;
  }

  if (!attempt.tmux_session) {
    console.log(chalk.red(`No tmux session for attempt (may be cloud-based)`));
    return;
  }

  if (!sessionExists(attempt.tmux_session)) {
    console.log(chalk.red(`tmux session ${attempt.tmux_session} no longer exists`));
    return;
  }

  console.log(chalk.dim(`Opening Ghostty → ${attempt.tmux_session}...`));
  openGhosttySession(attempt.tmux_session);
  console.log(chalk.green(`✓ Terminal opened for ${key}`));
}
