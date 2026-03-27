import chalk from 'chalk';
import { getActiveAttempt, updateAttemptStatus, logEvent } from '../core/db.js';
import { getAdapter } from '../adapters/index.js';
import {
  addComment, updateIssueState,
  hasAgentAccess, emitActivity,
} from '../core/linear.js';
import { WORKFLOW_STATES } from '../types.js';

export async function killCommand(issueKey: string, options: { done?: boolean }): Promise<void> {
  const key = issueKey.toUpperCase();
  const attempt = getActiveAttempt(key);

  if (!attempt) {
    console.log(chalk.red(`No active attempt for ${key}`));
    return;
  }

  // Kill via adapter
  if (attempt.tmux_session) {
    console.log(chalk.dim(`Killing session: ${attempt.tmux_session}`));
    try {
      const adapter = getAdapter(attempt.agent_type);
      adapter.kill(attempt.tmux_session);
    } catch { /* session may already be gone */ }
  }

  // Update DB
  const newStatus = options.done ? 'completed' : 'completed';
  updateAttemptStatus(attempt.id, newStatus as 'completed');
  logEvent(attempt.id, 'killed', { reason: options.done ? 'marked done' : 'manual kill' });

  // Update Linear
  if (hasAgentAccess() && attempt.agent_session_id) {
    const body = options.done
      ? 'Task completed. Terminated by operator.'
      : 'Session terminated manually by operator.';
    await emitActivity(attempt.agent_session_id, { type: 'response', body });
  } else {
    const comment = options.done
      ? '**Agent session completed** — marked as done by operator.'
      : '**Agent session terminated** — manually killed by operator.';
    await addComment(attempt.issue_id, comment);
  }

  if (options.done) {
    try {
      await updateIssueState(attempt.issue_id, WORKFLOW_STATES.DONE);
    } catch { /* may already be done */ }
  }

  console.log(chalk.green(`✓ Attempt #${attempt.attempt_number} for ${key} terminated`));
}
