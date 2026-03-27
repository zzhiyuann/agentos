#!/usr/bin/env node

import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { authCommand } from './commands/auth.js';
import { spawnCommand } from './commands/spawn.js';
import { statusCommand } from './commands/status.js';
import { jumpCommand } from './commands/jump.js';
import { killCommand } from './commands/kill.js';
import { watchCommand } from './commands/watch.js';
import { batchCommand } from './commands/batch.js';
import { logsCommand } from './commands/logs.js';
import { resumeCommand } from './commands/resume.js';
import { serveCommand } from './commands/serve.js';
import {
  agentListCommand, agentStartCommand, agentStopCommand,
  agentTalkCommand, agentMemoryCommand,
} from './commands/agent.js';
import { queueCommand } from './commands/queue.js';
import { companyStartCommand, companyStopCommand, companyStatusCommand, companyPulseCommand } from './commands/company.js';
import {
  swarmInitCommand, swarmStartCommand, swarmStatusCommand,
  swarmStopCommand, swarmBaselineCommand,
} from './commands/swarm.js';

const program = new Command();

program
  .name('aos')
  .description('AgentOS — Run your company with AI executives, not just AI tools.\n\n  AI company operating system powered by Linear. Persistent agent identities,\n  career-spanning memory, multi-model runtime, and agent-to-agent delegation.')
  .version('0.1.0');

// --- Agent Management (the company) ---

const agent = program.command('agent').description('Manage your AI executive team');

agent
  .command('list')
  .description('Show roster, status, and memory counts')
  .action(agentListCommand);

agent
  .command('start <role> [issue]')
  .description('Start an agent with full persona + memory (e.g., aos agent start cto ENG-7)')
  .option('-m, --model <model>', 'Override base model: cc, codex')
  .action(async (role, issue, opts) => { await agentStartCommand(role, issue, opts); });

agent
  .command('stop <role>')
  .description('Gracefully stop an agent (saves memory first)')
  .action(agentStopCommand);

agent
  .command('talk <role> <message>')
  .description('Send a message to a running agent session')
  .action(agentTalkCommand);

agent
  .command('memory <role>')
  .description("View an agent's accumulated knowledge and memory files")
  .action(agentMemoryCommand);

// --- Company ---

const company = program.command('company').description('Manage the AI company');
company.command('start').description('Enable company and standing duties').action(companyStartCommand);
company.command('stop').option('--force', 'Kill all agents immediately').description('Disable company and stop agents').action(companyStopCommand);
company.command('status').description('Show company health').action(companyStatusCommand);
company.command('pulse').description('Run one heartbeat cycle (for cron)').action(companyPulseCommand);

// --- Infrastructure ---

program
  .command('auth')
  .description('Set up OAuth for agent identities in Linear')
  .option('--client-id <id>', 'OAuth Client ID')
  .option('--client-secret <secret>', 'OAuth Client Secret')
  .action(authCommand);

program
  .command('setup')
  .description('Initialize AgentOS: database, credentials, Linear labels')
  .option('--api-key <key>', 'Store Linear API key in Keychain')
  .action(setupCommand);

program
  .command('serve')
  .description('Start webhook server + session monitor')
  .option('-p, --port <port>', 'Server port', '3848')
  .option('--no-auto-deploy', 'Disable auto-rebuild + restart on src/ changes')
  .action((opts) => serveCommand({ port: parseInt(opts.port), noAutoDeploy: opts.autoDeploy === false }));

// --- Task Operations ---

program
  .command('spawn <issue>')
  .description('Spawn an agent for a Linear issue (auto-routes by label)')
  .option('-a, --agent <type>', 'Agent role or type')
  .action(spawnCommand);

program
  .command('batch <issues...>')
  .description('Batch-spawn agents for multiple issues')
  .option('-a, --agent <type>', 'Agent role or type')
  .action(batchCommand);

program
  .command('resume <issue>')
  .description('Resume a failed or blocked issue with fresh attempt')
  .action(resumeCommand);

program
  .command('status')
  .description('Show active agent sessions and progress')
  .option('-a, --all', 'Include completed/failed')
  .action(statusCommand);

program
  .command('jump <issue>')
  .description('Attach to an agent\'s terminal (Ghostty) — watch them work')
  .action(jumpCommand);

program
  .command('kill <issue>')
  .description('Terminate an agent session')
  .option('-d, --done', 'Mark issue as done')
  .action(killCommand);

program
  .command('queue')
  .description('Show the priority-ordered spawn queue')
  .action(queueCommand);

program
  .command('watch')
  .description('Poll for delegated issues and auto-spawn agents')
  .action(watchCommand);

program
  .command('logs [issue]')
  .description('Show event history for an issue or all issues')
  .action(logsCommand);

// --- Research Swarm ---

const swarm = program.command('swarm').description('Multi-agent research swarm (autoresearch loop)');

swarm
  .command('init')
  .description('Initialize a research swarm in a workspace')
  .requiredOption('-n, --name <name>', 'Swarm name')
  .requiredOption('-w, --workspace <path>', 'Workspace path')
  .requiredOption('--metric <metric>', 'Metric to optimize')
  .requiredOption('--eval <command>', 'Shell command to evaluate metric')
  .requiredOption('--target <files...>', 'Target files agents can modify')
  .option('--agents <count>', 'Number of research agents (1-5)', '2')
  .option('--max-experiments <count>', 'Max experiments per agent', '20')
  .option('--budget <minutes>', 'Time budget in minutes (0=unlimited)', '0')
  .option('--lower-is-better', 'Metric is lower-is-better (default: higher)')
  .option('-d, --direction <directions...>', 'Research directions (format: focus:constraint1,constraint2)')
  .option('--frontier <ideas...>', 'Initial frontier ideas')
  .option('--issue <key>', 'Parent Linear issue key for progress reporting (e.g. ENG-42)')
  .option('--issue-id <id>', 'Parent Linear issue UUID (auto-resolved if --issue provided)')
  .action((opts) => swarmInitCommand({
    name: opts.name,
    workspace: opts.workspace,
    metric: opts.metric,
    evalCommand: opts.eval,
    targetFiles: opts.target,
    agents: parseInt(opts.agents),
    maxExperiments: parseInt(opts.maxExperiments),
    budget: parseInt(opts.budget),
    higherIsBetter: !opts.lowerIsBetter,
    directions: opts.direction,
    frontier: opts.frontier,
    parentIssueKey: opts.issue,
    parentIssueId: opts.issueId,
  }));

swarm
  .command('start')
  .description('Start researcher agents for a swarm')
  .requiredOption('-w, --workspace <path>', 'Workspace path')
  .option('-r, --role <role>', 'Agent role for researchers', 'lead-engineer')
  .action((opts) => swarmStartCommand({ workspace: opts.workspace, role: opts.role }));

swarm
  .command('status')
  .description('Show swarm status and experiment progress')
  .requiredOption('-w, --workspace <path>', 'Workspace path')
  .option('--report', 'Generate full report')
  .action((opts) => swarmStatusCommand({ workspace: opts.workspace, report: opts.report }));

swarm
  .command('stop')
  .description('Stop a running swarm')
  .requiredOption('-w, --workspace <path>', 'Workspace path')
  .option('--kill', 'Also kill tmux sessions')
  .action((opts) => swarmStopCommand({ workspace: opts.workspace, kill: opts.kill }));

swarm
  .command('baseline')
  .description('Run baseline evaluation for a swarm')
  .requiredOption('-w, --workspace <path>', 'Workspace path')
  .action((opts) => swarmBaselineCommand({ workspace: opts.workspace }));

program.parse();
