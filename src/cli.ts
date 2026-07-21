#!/usr/bin/env node

import 'dotenv/config';
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
import { pnlAttributeCommand } from './commands/pnl-attribute.js';
import { pnlDigestCommand } from './commands/pnl.js';
import { replayCaptureCommand } from './commands/replay.js';
import { replayTestCommand } from './commands/replay-test.js';
import { replayForkCommand } from './commands/replay-fork.js';
import {
  distillProposeCommand, distillApplyCommand, distillRejectCommand,
  distillMetricsCommand, distillListRunsCommand, distillRestoreCommand,
  distillConfigCommand, dreamCommand,
} from './commands/memory.js';
import { searchMemories, syncAllMemories } from './core/memory-store.js';

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
  .description('Start an agent with full persona + memory (e.g., aos agent start cto RYA-7)')
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
  .option('--issue <key>', 'Parent Linear issue key for progress reporting (e.g. RYA-42)')
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

// --- Agent P&L (RYA-895) ---

const pnl = program.command('pnl').description('Agent P&L: token + meta-tax accounting');

pnl
  .command('attribute')
  .description('Classify JSONL transcripts and persist per-session token attribution to state.db')
  .option('--since <window>', 'Window length, e.g. 4w, 7d, 24h (default 4w)', '4w')
  .option('--dry-run', 'Compute attributions without writing to SQLite')
  .option('--limit <n>', 'Process at most N transcripts (smoke test)', (v) => parseInt(v, 10))
  .option('--json', 'Output JSON summary instead of pretty-printed text')
  .action((opts) => pnlAttributeCommand({
    since: opts.since,
    dryRun: opts.dryRun,
    limit: opts.limit,
    json: opts.json,
  }));

pnl
  .command('digest')
  .description('Generate the weekly Agent P&L digest and post to Discord')
  .option('--since <window>', 'Window length, e.g. 7d, 24h, 2w', '7d')
  .option('--dry-run', 'Format only — do not post to Discord')
  .option('--no-persist', 'Skip persisting snapshot/attribution rows')
  .action((opts) => pnlDigestCommand({
    since: opts.since,
    dryRun: opts.dryRun,
    noPersist: !opts.persist,
  }));

// --- Session Replay (RYA-844 / RYA-870 / RYA-883) ---

const replay = program.command('replay').description('Capture, fork, and regression-test agent session traces');

replay
  .command('capture <attempt-id-or-issue-key>')
  .description('Extract one .jsonl trace from state.db + Claude session + workspace artifacts')
  .option('-o, --out <path>', 'Override output file path (default: ~/.aos/replays/<id>.jsonl)')
  .option('--out-dir <dir>', 'Override output directory (default: ~/.aos/replays/)')
  .option('--no-thinking', 'Strip model thinking blocks from the trace')
  .action((id, opts) => replayCaptureCommand(id, {
    out: opts.out,
    outDir: opts.outDir,
    noThinking: opts.thinking === false,
  }));

replay
  .command('test <trace.jsonl>')
  .description('Assert a captured trace against a baseline (or intrinsic checks). For CI regression gating.')
  .option('--assert <modes...>', 'One or more of: tool-sequence, file-state, exit-code')
  .option('--baseline <path>', 'Baseline trace file to compare against')
  .option('--expected-status <s>', 'Expected exit status when no baseline (default: completed)')
  .option('--json', 'Emit JSON report instead of human-readable output')
  .action((trace, opts) => replayTestCommand(trace, {
    assert: opts.assert,
    baseline: opts.baseline,
    expectedStatus: opts.expectedStatus,
    json: opts.json,
  }));

replay
  .command('fork <trace.jsonl>')
  .description('Fork a captured session at step N with an edited prompt or tool result')
  .requiredOption('--from-step <n>', 'Step index (0-based) to fork at', (v) => parseInt(v, 10))
  .option('--edit-prompt <text>', 'Replace the user prompt at this step')
  .option('--edit-tool-result <text>', 'Replace the tool result at this step')
  .option('--tool-result-is-error', 'Mark the edited tool result as an error')
  .option('--workspace <path>', 'Override fork workspace path')
  .option('--fork-id <id>', 'Override fork id')
  .option('--fork-sid <sid>', 'Override Claude Code fork session id')
  .option('--print-plan', 'Print the fork plan and stop (no spawn, no workspace prep)')
  .option('--no-spawn', 'Prepare seed JSONL + workspace but skip the live spawn')
  .option('--agent-role <role>', 'Override AGENT_ROLE for the spawned process')
  .action(async (trace, opts) => {
    await replayForkCommand(trace, {
      fromStep: opts.fromStep,
      editPrompt: opts.editPrompt,
      editToolResult: opts.editToolResult,
      toolResultIsError: opts.toolResultIsError,
      workspace: opts.workspace,
      forkId: opts.forkId,
      forkSid: opts.forkSid,
      printPlan: opts.printPlan,
      noSpawn: opts.spawn === false,
      agentRole: opts.agentRole,
    });
  });

// --- Memory Distill (RYA-857 / RYA-940 / RYA-967) ---

const memory = program.command('memory').description('Memory operations (distill, lineage)');
const distill = memory.command('distill').description('Distill memory corpora into canonical merged records');

distill
  .command('propose')
  .description('Generate merge proposals for one or all roles (writes proposals-*.json)')
  .option('--role <role>', 'Single role to scan (e.g. lead-engineer)')
  .option('--all-roles', 'Scan all roles under ~/.aos/agents/')
  .option('--notify', 'Post Discord summary linking to the run')
  .option('--json', 'Print machine-readable summary in addition to human output')
  .action((opts) => distillProposeCommand({
    role: opts.role,
    allRoles: opts.allRoles,
    notify: opts.notify,
    json: opts.json,
  }));

distill
  .command('apply <run-id>')
  .description('Apply approved proposals from a run (default: nothing — pass filters to select)')
  .option('--proposal-id <id>', 'Apply a single proposal by ID')
  .option('--kind <kind>', 'Filter by kind (merge, merge_aspects, merge_redundant, merge_topic, all)')
  .option('--min-confidence <n>', 'Minimum confidence threshold (0..1)')
  .option('--dry-run', 'Show what would be applied without applying')
  .action((runId, opts) => distillApplyCommand(runId, {
    proposalId: opts.proposalId,
    kind: opts.kind,
    minConfidence: opts.minConfidence,
    dryRun: opts.dryRun,
  }));

distill
  .command('reject <run-id> <proposal-id>')
  .description('Mark a proposal as rejected with a reason (writes apply log)')
  .option('--reason <text>', 'Why this proposal was rejected')
  .action((runId, proposalId, opts) => distillRejectCommand(runId, proposalId, { reason: opts.reason }));

distill
  .command('metrics <run-id>')
  .description('Show metrics: applied/rejected/pending, FP rate, reduction %')
  .option('--json', 'Output JSON instead of pretty-printed text')
  .action((runId, opts) => distillMetricsCommand(runId, { json: opts.json }));

distill
  .command('list-runs')
  .description('List all distill runs in ~/.aos/distill/')
  .option('--json', 'Output JSON instead of pretty-printed text')
  .action((opts) => distillListRunsCommand({ json: opts.json }));

distill
  .command('restore [run-id] [filename]')
  .description('Restore an archived memory file (or --list to browse)')
  .option('--list', 'List available archives')
  .action((runId, filename, opts) => distillRestoreCommand(runId, filename, { list: opts.list }));

distill
  .command('config')
  .description('Show effective distill config (~/.aos/distill-config.json + defaults)')
  .action(() => distillConfigCommand());

memory
  .command('dream')
  .description('Nightly reflection: distill each role\'s day (grades, attempts, memories) into a ≤500-token reflection memory')
  .option('--role <role>', 'Reflect for a single role (default: all roles)')
  .option('--since-hours <n>', 'Activity window in hours (default: 24)')
  .option('--json', 'Output JSON instead of pretty-printed text')
  .action((opts) => dreamCommand({
    role: opts.role,
    sinceHours: opts.sinceHours,
    json: opts.json,
  }));

memory
  .command('search <role> <query>')
  .description('Search an agent\'s memory database using FTS5 (used by linear-tool recall)')
  .option('--limit <n>', 'Max results to return', '10')
  .option('--sync', 'Sync memory files to DB before searching')
  .option('--json', 'Output JSON array (default when --json flag set)')
  .action((role, query, opts) => {
    if (opts.sync) syncAllMemories();
    const limit = parseInt(opts.limit, 10) || 10;
    const results = searchMemories(role, query, limit);
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (results.length === 0) {
        console.log('No memories found.');
        return;
      }
      for (const r of results) {
        console.log(`\n## ${r.name} (${r.agent_role})`);
        if (r.description) console.log(`> ${r.description}`);
        console.log(r.content.substring(0, 500) + (r.content.length > 500 ? '…' : ''));
      }
    }
  });

program.parse();
