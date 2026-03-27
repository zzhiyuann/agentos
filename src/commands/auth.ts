import chalk from 'chalk';
import { runOAuthFlow, getOAuthToken } from '../core/oauth.js';

async function verifyToken(token: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
      },
      body: JSON.stringify({ query: '{ viewer { id name } }' }),
    });
    const json = await res.json() as { data?: { viewer?: { name: string } }; errors?: { message: string }[] };
    return json.data?.viewer?.name ?? null;
  } catch {
    return null;
  }
}

export async function authCommand(options: { clientId?: string; clientSecret?: string }): Promise<void> {
  // Check existing auth
  const existingToken = getOAuthToken();
  if (existingToken && existingToken !== 'undefined' && !options.clientId) {
    console.log(chalk.green('✓ OAuth token found'));
    const name = await verifyToken(existingToken);
    if (name) {
      console.log(chalk.green(`✓ Authenticated as: ${name}`));
    } else {
      console.log(chalk.yellow('⚠ Token may be expired. Re-run with --client-id and --client-secret'));
    }
    return;
  }

  if (!options.clientId || !options.clientSecret) {
    console.log(chalk.bold('OAuth Setup Required'));
    console.log('');
    console.log('1. Go to: https://linear.app/<your-workspace>/settings/api/applications');
    console.log('2. Create a new OAuth application');
    console.log('3. Run: aos auth --client-id <ID> --client-secret <SECRET>');
    return;
  }

  console.log(chalk.dim('Starting OAuth flow...'));
  try {
    const token = await runOAuthFlow(options.clientId, options.clientSecret);
    console.log(chalk.green('\n✓ OAuth authorization complete!'));

    const name = await verifyToken(token);
    if (name) {
      console.log(chalk.green(`✓ Agent identity: ${name}`));
    }
    console.log(chalk.dim('  AgentOS can now create sessions and emit activities in Linear.'));
  } catch (err: unknown) {
    console.log(chalk.red(`✗ OAuth failed: ${(err as Error).message}`));
  }
}
