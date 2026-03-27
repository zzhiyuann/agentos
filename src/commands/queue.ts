import chalk from 'chalk';
import { getQueueItems, isInCooldown, getCooldownRemaining } from '../core/queue.js';
import { getActiveAttempts } from '../core/db.js';
import { getAgentRegistry } from '../core/router.js';

export async function queueCommand(): Promise<void> {
  const items = getQueueItems();
  const cooldown = isInCooldown();
  const active = getActiveAttempts();
  const registry = getAgentRegistry();

  console.log(chalk.bold('Spawn Queue & Concurrency'));
  console.log('─'.repeat(65));

  // Show capacity per agent type
  console.log(chalk.bold('\n  Capacity'));
  for (const [type, def] of Object.entries(registry)) {
    const running = active.filter(a => a.agent_type === type || (type === 'cc' && !['codex', 'gemini'].includes(a.agent_type))).length;
    const max = def.maxConcurrent;
    const bar = running >= max ? chalk.red(`${running}/${max}`) : chalk.green(`${running}/${max}`);
    console.log(`  ${type.padEnd(12)} ${bar}`);
  }

  if (cooldown) {
    const remaining = Math.ceil(getCooldownRemaining() / 1000);
    console.log(chalk.yellow(`\n  Rate limit cooldown: ${remaining}s remaining`));
  }

  // Show queue
  console.log(chalk.bold('\n  Queue'));
  if (items.length === 0) {
    console.log(chalk.dim('  Empty'));
    return;
  }

  console.log(
    `  ${'Issue'.padEnd(12)} ${'Agent'.padEnd(18)} ${'Priority'.padEnd(10)} ${'Queued'.padEnd(22)} ${'Delay Until'}`
  );
  console.log('  ' + '─'.repeat(60));

  for (const item of items) {
    const delay = item.delay_until
      ? new Date(item.delay_until).toLocaleTimeString()
      : chalk.dim('—');
    console.log(
      `  ${chalk.bold(item.issue_key.padEnd(12))} ${item.agent_role.padEnd(18)} ${String(item.priority).padEnd(10)} ${item.queued_at.padEnd(22)} ${delay}`
    );
  }

  console.log(chalk.dim(`\n  ${items.length} item(s) queued`));
}
