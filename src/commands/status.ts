import chalk from 'chalk';
import { getActiveAttempts, getAllAttempts, updateAttemptStatus } from '../core/db.js';
import { getAdapter } from '../adapters/index.js';

function formatDuration(start: string): string {
  const ms = Date.now() - new Date(start + 'Z').getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return chalk.green(status);
    case 'completed': return chalk.blue(status);
    case 'failed': return chalk.red(status);
    case 'blocked': return chalk.yellow(status);
    case 'pending': return chalk.dim(status);
    default: return status;
  }
}

export async function statusCommand(options: { all?: boolean }): Promise<void> {
  const attempts = options.all ? getAllAttempts() : getActiveAttempts();

  if (attempts.length === 0) {
    console.log(chalk.dim('No active agent sessions.'));
    return;
  }

  // Health check active attempts
  for (const attempt of attempts) {
    if (attempt.status === 'running' && attempt.tmux_session) {
      try {
        const adapter = getAdapter(attempt.agent_type);
        const alive = adapter.isAlive(attempt.tmux_session);
        if (!alive) {
          updateAttemptStatus(attempt.id, 'failed', 'Session no longer exists');
          attempt.status = 'failed';
        }
      } catch { /* ignore adapter errors during status check */ }
    }
  }

  // Print table
  const header = [
    chalk.bold('Issue'.padEnd(10)),
    chalk.bold('#'.padEnd(3)),
    chalk.bold('Agent'.padEnd(7)),
    chalk.bold('Status'.padEnd(12)),
    chalk.bold('Duration'.padEnd(10)),
    chalk.bold('Cost'.padEnd(8)),
  ].join(' ');

  console.log(header);
  console.log('─'.repeat(55));

  for (const attempt of attempts) {
    const row = [
      chalk.cyan(attempt.issue_key.padEnd(10)),
      String(attempt.attempt_number).padEnd(3),
      attempt.agent_type.padEnd(7),
      statusColor(attempt.status).padEnd(12 + 10),
      formatDuration(attempt.created_at).padEnd(10),
      attempt.cost_usd > 0 ? `$${attempt.cost_usd.toFixed(2)}` : chalk.dim('–'),
    ].join(' ');
    console.log(row);
  }

  console.log(chalk.dim(`\n${attempts.length} attempt(s)`));
}
