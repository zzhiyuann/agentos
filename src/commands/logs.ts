import chalk from 'chalk';
import { getActiveAttempt, getAttemptsByIssue, getAttemptEvents, getAllAttempts } from '../core/db.js';

export async function logsCommand(issueKey?: string): Promise<void> {
  if (issueKey) {
    const key = issueKey.toUpperCase();
    const attempts = getAttemptsByIssue(key);
    if (attempts.length === 0) {
      console.log(chalk.red(`No attempts found for ${key}`));
      return;
    }

    for (const attempt of attempts) {
      console.log(chalk.bold(`${attempt.issue_key} #${attempt.attempt_number} (${attempt.status}) [${attempt.agent_type}]`));
      const events = getAttemptEvents(attempt.id);
      for (const event of events) {
        console.log(`  ${chalk.dim(event.created_at)} ${formatEventType(event.event_type)} ${event.payload || ''}`);
      }
      console.log('');
    }
  } else {
    const attempts = getAllAttempts(10);
    for (const attempt of attempts) {
      console.log(chalk.bold(`${attempt.issue_key} #${attempt.attempt_number} (${attempt.status}) [${attempt.agent_type}]`));
      const events = getAttemptEvents(attempt.id);
      for (const event of events.slice(-3)) {
        console.log(`  ${chalk.dim(event.created_at)} ${formatEventType(event.event_type)} ${event.payload || ''}`);
      }
      console.log('');
    }
  }
}

function formatEventType(type: string): string {
  switch (type) {
    case 'spawned': return chalk.green('SPAWNED');
    case 'progress': return chalk.blue('PROGRESS');
    case 'completed': return chalk.cyan('COMPLETED');
    case 'failed': return chalk.red('FAILED');
    case 'killed': return chalk.yellow('KILLED');
    case 'cost_update': return chalk.magenta('COST');
    default: return type;
  }
}
