import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfig } from '../core/config.js';
import { listAgents, loadAgentConfig, agentExists } from '../core/persona.js';
import { sessionExists } from '../core/tmux.js';
import { getActiveAttempts } from '../core/db.js';
import { agentStopCommand } from './agent.js';

const COMPANY_DIR = join(getConfig().stateDir, 'company');
const STATE_FILE = join(COMPANY_DIR, 'state.json');
const RESPONSIBILITIES_FILE = join(COMPANY_DIR, 'responsibilities.json');

interface CompanyState {
  enabled: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastPulse?: string;
  dutyLog: Record<string, string>; // dutyId → lastExecuted ISO
}

function ensureCompanyDir(): void {
  mkdirSync(COMPANY_DIR, { recursive: true });
}

function loadState(): CompanyState {
  ensureCompanyDir();
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return { enabled: false, dutyLog: {} };
}

function saveState(state: CompanyState): void {
  ensureCompanyDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function companyStartCommand(): Promise<void> {
  const state = loadState();
  state.enabled = true;
  state.startedAt = new Date().toISOString();
  saveState(state);

  console.log(chalk.bold('Company is ON'));
  console.log(chalk.dim('Agents on duty:'));
  for (const role of listAgents()) {
    const config = loadAgentConfig(role);
    console.log(`  ${chalk.cyan(role.padEnd(18))} ${config.baseModel}`);
  }
  console.log(chalk.dim('\nRun `aos company pulse` periodically (or set up cron) to trigger standing duties.'));
}

export async function companyStopCommand(options: { force?: boolean }): Promise<void> {
  const state = loadState();
  state.enabled = false;
  state.stoppedAt = new Date().toISOString();
  saveState(state);

  // Stop all running agents
  for (const role of listAgents()) {
    const tmuxName = `aos-${role}`;
    if (sessionExists(tmuxName)) {
      try {
        if (options.force) {
          const { killSession } = await import('../core/tmux.js');
          killSession(tmuxName);
          console.log(chalk.dim(`  Killed ${role}`));
        } else {
          await agentStopCommand(role);
        }
      } catch { /**/ }
    }
  }

  console.log(chalk.bold('Company is OFF. All agents stopped.'));
}

export async function companyStatusCommand(): Promise<void> {
  const state = loadState();
  const agents = listAgents();
  const activeAttempts = getActiveAttempts();

  console.log(chalk.bold(`AgentOS Company — ${state.enabled ? chalk.green('ON') : chalk.red('OFF')}`));
  if (state.startedAt) console.log(chalk.dim(`Started: ${state.startedAt}`));
  if (state.lastPulse) console.log(chalk.dim(`Last pulse: ${state.lastPulse}`));
  console.log('─'.repeat(60));

  for (const role of agents) {
    const config = loadAgentConfig(role);
    const tmuxName = `aos-${role}`;
    const running = sessionExists(tmuxName);
    const active = activeAttempts.find(a => a.agent_type === role);

    const status = running
      ? chalk.green(`active${active ? ` (${active.issue_key})` : ''}`)
      : chalk.dim('idle');

    console.log(`  ${chalk.bold(role.padEnd(18))} ${chalk.dim(config.baseModel.padEnd(7))} ${status}`);
  }

  // Show responsibilities summary if configured
  if (existsSync(RESPONSIBILITIES_FILE)) {
    const responsibilities = JSON.parse(readFileSync(RESPONSIBILITIES_FILE, 'utf-8'));
    console.log(chalk.dim('\nStanding Duties:'));
    for (const [role, duties] of Object.entries(responsibilities)) {
      const allDuties = [
        ...((duties as any).hourly || []),
        ...((duties as any).daily || []),
        ...((duties as any).weekly || []),
      ];
      if (allDuties.length > 0) {
        console.log(`  ${chalk.cyan(role)}: ${allDuties.map((d: any) => d.name).join(', ')}`);
      }
    }
  }
}

export async function companyPulseCommand(): Promise<void> {
  const state = loadState();
  if (!state.enabled) {
    console.log(chalk.dim('Company is OFF. Run `aos company start` first.'));
    return;
  }

  const ts = new Date().toLocaleTimeString();
  console.log(chalk.bold(`[${ts}] Company pulse`));
  state.lastPulse = new Date().toISOString();

  if (!existsSync(RESPONSIBILITIES_FILE)) {
    console.log(chalk.dim('  No responsibilities configured. Create ~/.aos/company/responsibilities.json'));
    saveState(state);
    return;
  }

  const responsibilities = JSON.parse(readFileSync(RESPONSIBILITIES_FILE, 'utf-8'));
  const now = new Date();

  for (const [role, duties] of Object.entries(responsibilities)) {
    if (!agentExists(role)) continue;

    const allDuties = [
      ...((duties as any).hourly || []).map((d: any) => ({ ...d, frequency: 'hourly' })),
      ...((duties as any).daily || []).map((d: any) => ({ ...d, frequency: 'daily' })),
      ...((duties as any).weekly || []).map((d: any) => ({ ...d, frequency: 'weekly' })),
    ];

    for (const duty of allDuties) {
      const lastRun = state.dutyLog[duty.id];
      if (lastRun && !isDutyDue(duty.frequency, lastRun, now)) {
        continue;
      }

      console.log(chalk.cyan(`  [${role}] ${duty.name} — due`));
      state.dutyLog[duty.id] = now.toISOString();

      // Create Linear issue and dispatch the agent
      try {
        const { execSync } = await import('child_process');

        // Create issue via linear-tool
        const title = `[${duty.frequency}] ${duty.name}`;
        const desc = `Standing duty for ${role}.\n\n## Action\n\n${duty.action}\n\n## Instructions\n\n- Complete the action described above\n- Post findings to Discord: \`AGENT_ROLE=${role} linear-tool group "summary of findings"\`\n- Write HANDOFF.md when done\n- Exit with /exit`;

        const createResult = execSync(
          `AGENT_ROLE=${role} linear-tool create-issue "${title.replace(/"/g, '\\"')}" "${desc.replace(/"/g, '\\"')}" 3`,
          { encoding: 'utf-8', timeout: 30_000 }
        ).trim();

        const issueKey = createResult.split(':')[0]?.trim();
        if (issueKey && /^[A-Z]+-\d+$/.test(issueKey)) {
          console.log(chalk.green(`    Created ${issueKey} → dispatching ${role}`));

          // Dispatch via HTTP to serve endpoint
          const dispatchResult = execSync(
            `curl -s -X POST http://localhost:3848/dispatch -H 'Content-Type: application/json' -d '${JSON.stringify({ role, issueKey })}'`,
            { encoding: 'utf-8', timeout: 30_000 }
          ).trim();
          console.log(chalk.dim(`    Dispatch: ${dispatchResult}`));
        } else {
          console.log(chalk.yellow(`    Issue creation returned: ${createResult}`));
        }
      } catch (err) {
        console.log(chalk.red(`    Failed: ${(err as Error).message}`));
      }
    }
  }

  saveState(state);
  console.log(chalk.dim(`  Pulse complete`));
}

function isDutyDue(frequency: string, lastRun: string, now: Date): boolean {
  const last = new Date(lastRun);
  const diffMs = now.getTime() - last.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  switch (frequency) {
    case 'hourly': return diffHours >= 1;
    case 'daily': return diffHours >= 20; // 20h buffer
    case 'weekly': return diffHours >= 144; // 6 days buffer
    default: return false;
  }
}
