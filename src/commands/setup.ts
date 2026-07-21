import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import { getLinearApiKey, storeLinearApiKey } from '../core/keychain.js';
import { ensureLabelsExist, getReadClient } from '../core/linear.js';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const REQUIRED_ENV_VARS = [
  { name: 'AOS_LINEAR_TEAM_ID', desc: 'Linear team UUID (Settings > Workspace > General)' },
  { name: 'AOS_LINEAR_TEAM_KEY', desc: 'Linear team key, e.g. "ENG" (Settings > Workspace > General)' },
  { name: 'AOS_HOST', desc: 'Execution host address (use "localhost" for local setup)' },
  { name: 'AOS_USER', desc: 'Username on the execution host' },
];

export async function setupCommand(options: { apiKey?: string }): Promise<void> {
  console.log(chalk.bold('\nAgentOS Setup\n'));

  // 0. Check for .env file
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    const examplePath = join(process.cwd(), '.env.example');
    if (existsSync(examplePath)) {
      console.log(chalk.yellow('⚠ No .env file found. Create one from the example:'));
      console.log(chalk.dim('  cp .env.example .env'));
      console.log(chalk.dim('  # Then edit .env with your values\n'));
    } else {
      console.log(chalk.yellow('⚠ No .env file found. Set required environment variables.\n'));
    }
  }

  // 1. Validate required environment variables
  const missing: typeof REQUIRED_ENV_VARS = [];
  for (const v of REQUIRED_ENV_VARS) {
    if (process.env[v.name]) {
      console.log(chalk.green(`✓ ${v.name}`));
    } else {
      missing.push(v);
      console.log(chalk.red(`✗ ${v.name} — ${v.desc}`));
    }
  }

  if (missing.length > 0) {
    console.log(chalk.red(`\nMissing ${missing.length} required variable(s). Add them to .env or your shell environment.\n`));
    return;
  }

  // 2. Load config (safe now that env vars are validated)
  const config = getConfig();

  // 3. Store or verify Linear API key
  if (options.apiKey) {
    storeLinearApiKey(options.apiKey);
    console.log(chalk.green('✓ API key stored in Keychain'));
  } else {
    try {
      getLinearApiKey();
      console.log(chalk.green('✓ API key found in Keychain'));
    } catch {
      console.log(chalk.red('✗ No API key found. Run: aos setup --api-key <YOUR_LINEAR_API_KEY>'));
      return;
    }
  }

  // 4. Verify Linear connection
  try {
    const client = getReadClient();
    const viewer = await client.viewer;
    console.log(chalk.green(`✓ Connected to Linear as ${viewer.name} (${viewer.email})`));

    const org = await viewer.organization;
    console.log(chalk.green(`✓ Organization: ${org.name}`));
  } catch (err: unknown) {
    const error = err as Error;
    console.log(chalk.red(`✗ Linear connection failed: ${error.message}`));
    return;
  }

  // 5. Ensure state directory exists
  mkdirSync(config.stateDir, { recursive: true });
  console.log(chalk.green(`✓ State directory: ${config.stateDir}`));

  // 6. Initialize DB (auto-creates on first access via db.ts import)
  const { createSession } = await import('../core/db.js');
  console.log(chalk.green(`✓ Database initialized: ${config.dbPath}`));

  // 7. Create agent labels in Linear
  try {
    await ensureLabelsExist();
    console.log(chalk.green('✓ Agent labels created'));
  } catch (err: unknown) {
    const error = err as Error;
    console.log(chalk.yellow(`⚠ Label creation: ${error.message}`));
  }

  console.log('\n' + chalk.bold('Setup complete!'));
  console.log(`  Team:       ${config.linearTeamKey}`);
  console.log(`  Host:       ${config.imacUser}@${config.imacHost}`);
  console.log(`  Workspaces: ${config.workspaceBase}`);
  console.log(`  State:      ${config.stateDir}`);
  console.log('\nNext steps:');
  console.log(`  ${chalk.dim('1.')} Set up OAuth for agent identities: ${chalk.cyan('aos auth --client-id <ID> --client-secret <SECRET>')}`);
  console.log(`  ${chalk.dim('2.')} Start the server: ${chalk.cyan('aos serve')}`);
  console.log(`  ${chalk.dim('3.')} Create a Linear issue and watch it get routed!\n`);
}
