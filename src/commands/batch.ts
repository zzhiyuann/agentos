import chalk from 'chalk';
import { spawnCommand } from './spawn.js';

export async function batchCommand(issueKeys: string[], options: { agent?: string }): Promise<void> {
  if (issueKeys.length === 0) {
    console.log(chalk.red('No issue keys provided'));
    return;
  }

  console.log(chalk.bold(`Spawning ${issueKeys.length} agent sessions...`));

  const results: { key: string; status: 'ok' | 'error'; error?: string }[] = [];

  // Spawn sequentially to avoid SSH connection overload
  for (const key of issueKeys) {
    try {
      await spawnCommand(key, options);
      results.push({ key, status: 'ok' });
    } catch (err: unknown) {
      const error = err as Error;
      results.push({ key, status: 'error', error: error.message });
      console.log(chalk.red(`  Failed: ${key} — ${error.message}`));
    }
  }

  // Summary
  const ok = results.filter(r => r.status === 'ok').length;
  const failed = results.filter(r => r.status === 'error').length;
  console.log(`\n${chalk.green(`✓ ${ok} spawned`)}${failed > 0 ? `, ${chalk.red(`✗ ${failed} failed`)}` : ''}`);
}
