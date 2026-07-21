/**
 * Proactive Channel: always-on strategic exploration sessions per agent role.
 *
 * Each role gets one reserved "proactive" slot that runs continuously with a
 * strategic exploration prompt. Ideas flow through Linear as sub-issues under
 * a parent "Proactive Ideas" issue, with board-vote comments before execution.
 *
 * Architecture:
 *   - Heartbeat (every 10 min): checks if proactive sessions are alive, restarts dead ones
 *   - Proactive prompt: role-specific strategic exploration directives
 *   - Board discussion: when an idea is proposed, all agents evaluate before committing
 *   - Kill switch: AOS_NO_PROACTIVE=1 disables the system
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { getConfig } from '../core/config.js';
import {
  getReadClient, getAgentClient, getWorkflowStateId, addComment,
} from '../core/linear.js';
import {
  getActiveAttempts, getActiveAttempt, getAttemptsByIssue,
  type Attempt,
} from '../core/db.js';
import { sessionExists, sendKeys } from '../core/tmux.js';
import { agentExists, loadAgentConfig, listAgents, getAgentLinearToken } from '../core/persona.js';
import { canStartNewSession, hasCapacity } from './concurrency.js';
import { handleDispatch } from './dispatch.js';
import { WORKFLOW_STATES } from '../types.js';

// ─── Configuration ───

const PROACTIVE_HEARTBEAT_INTERVAL_MS = 10 * 60_000; // 10 minutes
const PROACTIVE_STATE_DIR = join(process.env.HOME || '', '.aos', 'proactive');
const PROACTIVE_STATE_FILE = join(PROACTIVE_STATE_DIR, 'state.json');
// Per-role cadence: each agent runs proactive exploration at most once every N ms.
// Override with AOS_PROACTIVE_INTERVAL_MS for testing. Default: 7 days.
const PROACTIVE_PER_ROLE_INTERVAL_MS = Number(process.env.AOS_PROACTIVE_INTERVAL_MS)
  || 7 * 24 * 60 * 60_000;
// Same-role same-day cap (RYA-912): scheduler must not dispatch the same role
// more than once in this window, regardless of whether the prior issue is
// still open or already Done/Canceled. The existing open-issue guards filter
// by OPEN_LINEAR_STATES, so a fast Done/Canceled cycle within the per-role
// interval lets duplicates through (W19: RYA-892 done → RYA-897 canceled →
// RYA-909 in progress, all on 2026-05-06). Default 24h, override with
// AOS_PROACTIVE_SAME_DAY_CAP_MS for testing.
const PROACTIVE_SAME_ROLE_SAME_DAY_CAP_MS = Number(process.env.AOS_PROACTIVE_SAME_DAY_CAP_MS)
  || 24 * 60 * 60_000;
// Parent-hub dedupe window (RYA-912): when ceo-office bulk-cancels phantom
// hubs, the open-state search misses them and the heartbeat creates a new
// one. If a hub of any state was created within this window, skip the cycle
// rather than spawn another phantom. Default 7 days.
const PROACTIVE_PARENT_HUB_DEDUPE_MS = Number(process.env.AOS_PROACTIVE_HUB_DEDUPE_MS)
  || 7 * 24 * 60 * 60_000;
// Transient Linear errors (rate-limit / network). Any guard whose catch block
// gates creation/dispatch on a boolean MUST fail-CLOSED on these (return the
// value that prevents the duplicate) instead of fail-open. RYA-1032: fail-open
// under rate-limit was a positive feedback loop — every blocked query spawned
// another duplicate that ate more API budget. RYA-1033: extended fail-CLOSED
// to the open-issue guards (`hasOpenProactiveIssueForRole*`) so the same-day
// cap is not the only fail-CLOSED line of defense.
// Exported so future src/serve/ guards reuse the same regex rather than
// re-deriving (and drifting from) the transient-error fingerprint.
export const TRANSIENT_LINEAR_ERROR_RE = /rate.?limit|429|ECONN|ETIMEDOUT|ENETUNREACH|fetch/i;

// Board vote: how many agents must approve before an idea is accepted
const BOARD_QUORUM = 3; // At least 3 "approve" votes needed
const BOARD_VOTE_WINDOW_MS = 30 * 60_000; // 30 minutes for voting

// Cool-down schedule for consecutive failed spawns (RYA-698).
// When sustained rate-limit or auth failures cause spawns to fail, back off
// exponentially so we don't create 100+ zombie issues per day.
const FAILURE_COOLDOWN_THRESHOLD = 3;            // after 3 consecutive failures, cool down
const FAILURE_COOLDOWN_MS_SHORT = 60 * 60_000;   // 1 hour
const FAILURE_COOLDOWN_MS_LONG = 4 * 60 * 60_000; // 4 hours (after 5 consecutive failures)
const FAILURE_COOLDOWN_THRESHOLD_LONG = 5;

// Linear workflow state names considered "open" for the proactive guard.
const OPEN_LINEAR_STATES = new Set(['Backlog', 'Todo', 'In Progress', 'In Review']);

// ISO 8601 week key, e.g. "2026-W18". Used as the per-week dedupe token in
// proactive issue titles so scheduling collapses to one issue/role/week.
function getIsoWeekKey(d: Date): string {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // Thu of this week
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((target.getTime() - firstThu.getTime()) / 86_400_000 / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

let lastProactiveHeartbeatAt = 0;

// ─── Proactive Role Config ───

export interface ProactiveRoleConfig {
  enabled: boolean;
  focusAreas: string[];
  searchDirectives: string[];
  thinkingPrompt: string;
}

/**
 * Default proactive configuration per role.
 * These define what each role explores in their proactive slot.
 */
const PROACTIVE_ROLE_DEFAULTS: Record<string, ProactiveRoleConfig> = {
  'cto': {
    enabled: true,
    focusAreas: [
      'Emerging technology that could 10x human capability',
      'AI-human collaboration paradigms that preserve human dignity',
      'Technical architectures for products that push humanity forward',
      'Open-source projects that could become industry-defining',
    ],
    searchDirectives: [
      'Search for breakthrough research papers in AI, biotech, energy, space',
      'Analyze trending GitHub repos and HackerNews for paradigm shifts',
      'Evaluate emerging protocols, standards, and platforms',
      'Study how technology can make humans more capable, not more dependent',
    ],
    thinkingPrompt: 'You are the CTO thinking strategically about what technology could genuinely advance humanity. Not incremental improvements — transformative leaps. Consider: What can a small, AI-native company build that a large corporation cannot? What technology would people look back on in 20 years and say "that changed everything"?',
  },
  'cpo': {
    enabled: true,
    focusAreas: [
      'Products that give people genuine agency and dignity in the AI era',
      'Unmet human needs that technology can address at scale',
      'Product experiences that are both viral (explosive growth) and meaningful (real value)',
      'Markets where a small team can create outsized impact',
    ],
    searchDirectives: [
      'Study ProductHunt, IndieHackers, and emerging product trends',
      'Analyze user sentiment and pain points in AI-adjacent communities',
      'Research products that achieved product-market fit with minimal resources',
      'Look for gaps between what AI can do and what products actually deliver',
    ],
    thinkingPrompt: 'You are the CPO thinking about products that matter. Not another SaaS tool — something that makes people more human, not less. Consider: What would a product look like that both goes viral AND genuinely improves human lives? What needs are so fundamental that solving them creates lasting value?',
  },
  'research-lead': {
    enabled: true,
    focusAreas: [
      'Scientific frontiers where AI can accelerate discovery by 100x',
      'Research that could become the foundation of a transformative product',
      'Cross-disciplinary breakthroughs (AI + biology, AI + physics, AI + cognition)',
      'Open problems where a novel approach could leapfrog established labs',
    ],
    searchDirectives: [
      'Monitor arXiv, Semantic Scholar, and Nature for breakthrough papers',
      'Track research competitions and benchmarks for emerging opportunities',
      'Study successful research-to-product transitions for patterns',
      'Identify research areas where compute (not data) is the bottleneck — our strength',
    ],
    thinkingPrompt: 'You are the Research Lead exploring the frontier. Not incremental papers — paradigm-shifting research. Consider: What research could a small, compute-rich team do that would be impossible for large bureaucratic labs? What scientific question, if answered, would unlock an entirely new category of human capability?',
  },
  'lead-engineer': {
    enabled: true,
    focusAreas: [
      'Engineering innovations that enable 10x productivity for individuals',
      'Tools and frameworks that democratize advanced capabilities',
      'Infrastructure patterns that make complex systems accessible',
      'Open-source tooling that fills critical gaps in the ecosystem',
    ],
    searchDirectives: [
      'Analyze GitHub trending repos for engineering innovation patterns',
      'Study developer tooling that achieves rapid adoption',
      'Research infrastructure-as-code and automation frontiers',
      'Look for engineering bottlenecks that, if solved, would unblock entire categories of products',
    ],
    thinkingPrompt: 'You are the Lead Engineer thinking about engineering leverage. Not better CRUD apps — infrastructure that fundamentally changes what\'s possible. Consider: What tool, if it existed, would make every developer 10x more capable? What engineering problem, if solved, would unlock a wave of innovation?',
  },
  'coo': {
    enabled: true,
    focusAreas: [
      'Operational models that enable AI-native companies to outperform 100x larger orgs',
      'Partnership and distribution strategies for maximum reach with minimal resources',
      'Community-building approaches that create compounding value',
      'Resource acquisition strategies (grants, partnerships, open-source funding)',
    ],
    searchDirectives: [
      'Study successful one-person and small-team companies (Pieter Levels, etc.)',
      'Research grant programs, accelerators, and funding for AI/tech innovation',
      'Analyze viral distribution mechanisms for developer/prosumer tools',
      'Look for operational patterns that scale without headcount',
    ],
    thinkingPrompt: 'You are the COO thinking about how a tiny company can have outsized impact. Not through brute force — through leverage. Consider: What operational model would let a team of AI agents and one human compete with companies 100x their size? What partnerships or distribution channels could create exponential reach?',
  },
};

/**
 * Load proactive config for a role: merge defaults with per-agent overrides.
 * Override file: ~/.aos/agents/{role}/proactive.json
 */
export function getProactiveConfig(role: string): ProactiveRoleConfig | null {
  const defaults = PROACTIVE_ROLE_DEFAULTS[role];
  if (!defaults) return null;

  // Check for per-agent override
  const overridePath = join(process.env.HOME || '', '.aos', 'agents', role, 'proactive.json');
  if (existsSync(overridePath)) {
    try {
      const override = JSON.parse(readFileSync(overridePath, 'utf-8')) as Partial<ProactiveRoleConfig>;
      return { ...defaults, ...override };
    } catch (err) { console.log(chalk.dim(`[proactive] Failed to load override for ${role}: ${(err as Error).message}`)); }
  }

  return defaults;
}

// ─── Proactive State ───

export interface ProactiveState {
  parentIssueKey: string | null; // The parent Linear issue for all proactive ideas
  parentIssueId: string | null;
  activeChannels: Record<string, {
    issueKey: string;
    issueId: string;
    startedAt: string;
    lastHeartbeatAt: string;
    // RYA-698: back-off state for failed spawns.
    consecutiveFailures?: number;
    cooldownUntil?: string;   // ISO timestamp; skip spawn while > now
    lastFailureAt?: string;   // ISO timestamp of last observed failed attempt
  }>;
  proposedIdeas: Array<{
    id: string;
    issueKey: string;
    title: string;
    proposedBy: string;
    proposedAt: string;
    votes: Record<string, 'approve' | 'reject' | 'abstain'>;
    status: 'voting' | 'approved' | 'rejected' | 'executing';
  }>;
  stats: {
    totalIdeasProposed: number;
    totalIdeasApproved: number;
    totalIdeasRejected: number;
    lastCycleAt: string | null;
  };
}

function loadProactiveState(): ProactiveState {
  if (!existsSync(PROACTIVE_STATE_FILE)) {
    return {
      parentIssueKey: null,
      parentIssueId: null,
      activeChannels: {},
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    };
  }
  try {
    return JSON.parse(readFileSync(PROACTIVE_STATE_FILE, 'utf-8'));
  } catch {
    return {
      parentIssueKey: null,
      parentIssueId: null,
      activeChannels: {},
      proposedIdeas: [],
      stats: { totalIdeasProposed: 0, totalIdeasApproved: 0, totalIdeasRejected: 0, lastCycleAt: null },
    };
  }
}

function saveProactiveState(state: ProactiveState): void {
  if (!existsSync(PROACTIVE_STATE_DIR)) {
    mkdirSync(PROACTIVE_STATE_DIR, { recursive: true });
  }
  // Atomic write: temp file + rename prevents partial reads on crash
  const tmp = `${PROACTIVE_STATE_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, PROACTIVE_STATE_FILE);
}

// ─── Parent Issue Management ───

const PROACTIVE_PARENT_TITLE = 'Proactive: Strategic Exploration Hub';

/**
 * Ensure the parent "Proactive: Strategic Exploration" issue exists in Linear.
 * Creates it if missing. Returns the issue key and id.
 *
 * RYA-831: before creating a new parent, search the team for any existing live
 * parent with the canonical title. State-file loss (or running on a fresh host)
 * was producing duplicate parent issues every cycle, each spawning its own
 * sibling tree of stuck Strategic-exploration children.
 */
export async function ensureParentIssue(state: ProactiveState): Promise<{ key: string; id: string } | null> {
  // If we already have a parent issue, verify it still exists AND is live.
  // Linear's SDK returns a stub (not an error) for deleted issues with
  // `trashed` / `archivedAt` set — checking `if (issue)` alone is insufficient
  // and leaves sessions injecting a dead parent key forever (RYA-637).
  if (state.parentIssueKey && state.parentIssueId) {
    try {
      const client = getReadClient();
      const issue = await client.issue(state.parentIssueId);
      if (issue && !issue.trashed && !issue.archivedAt) {
        return { key: state.parentIssueKey, id: state.parentIssueId };
      }
      // Issue was deleted, trashed, or archived — recreate
      state.parentIssueKey = null;
      state.parentIssueId = null;
    } catch {
      // Issue was deleted — recreate
      state.parentIssueKey = null;
      state.parentIssueId = null;
    }
  }

  const config = getConfig();

  // Search-before-create: avoid duplicate parents (RYA-831). Look for any
  // open issue in the team with the canonical title.
  if (config.linearTeamId) {
    try {
      const client = getReadClient();
      const existing = await client.issues({
        filter: {
          team: { id: { eq: config.linearTeamId } },
          title: { eq: PROACTIVE_PARENT_TITLE },
          state: { name: { in: Array.from(OPEN_LINEAR_STATES) } },
        },
        first: 5,
      });
      if (existing.nodes.length > 0) {
        // Pick the oldest live one — duplicates created later are the noise.
        // Linear returns nodes in createdAt DESC by default; sort ASC here so
        // we always converge on the original.
        const oldest = [...existing.nodes].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )[0];
        state.parentIssueKey = oldest.identifier;
        state.parentIssueId = oldest.id;
        saveProactiveState(state);
        console.log(chalk.dim(`[proactive] Adopted existing parent issue: ${oldest.identifier}`));
        return { key: oldest.identifier, id: oldest.id };
      }
    } catch (err) {
      // Search failed — fall through to create. A duplicate is recoverable;
      // failing the heartbeat is not.
      console.log(chalk.dim(`[proactive] Parent search failed: ${(err as Error).message}`));
    }
  }

  // RYA-912: parent-hub same-week dedupe. The open-state search above misses
  // hubs that ceo-office bulk-cancels (RYA-908/896/891/886/839 sweep on
  // 2026-05-06). Without this guard, every cycle after a cleanup creates a
  // brand-new phantom hub. If any hub of any state was created within the
  // dedupe window, skip this cycle so the noise stops compounding.
  if (await hasRecentParentHub()) {
    console.log(chalk.dim(`[proactive] Recent parent hub exists (any state) within ${PROACTIVE_PARENT_HUB_DEDUPE_MS / 86_400_000}d — skipping hub creation this cycle`));
    return null;
  }

  // Create the parent issue
  try {
    const agentClient = getAgentClient();
    const backlogStateId = await getWorkflowStateId('Backlog');

    const description = `# Proactive Strategic Exploration

This is the parent issue for all proactive ideas generated by the agent team.

## How It Works

Each agent role has a dedicated "proactive channel" — an always-on session focused on strategic exploration, research, and idea generation. When an agent discovers a high-value opportunity, they propose it as a sub-issue here.

## Board Discussion Protocol

When a new idea is proposed:
1. All agents are invited to evaluate the idea
2. Each agent votes: **approve**, **reject**, or **abstain** (with reasoning)
3. An idea needs ${BOARD_QUORUM}+ approvals to proceed
4. The board considers: Is this genuinely transformative? Can we execute it? Does it align with our mission?

## Quality Bar

We only pursue ideas that are:
- **Transformative**: Could genuinely push humanity forward (not just another tool)
- **Practical**: Achievable by a small, AI-native team with limited resources
- **Viral + Meaningful**: Both explosive growth potential AND real human value
- **Non-obvious**: Takes advantage of our unique position (AI agents + speed + no bureaucracy)

## Current Focus

Finding and building things that:
- Give people genuine agency and dignity in the AI era
- Create technology that makes humans more capable, not more dependent
- Build products that people will look back on and say "that changed everything"
`;

    const result = await agentClient.createIssue({
      teamId: config.linearTeamId,
      title: PROACTIVE_PARENT_TITLE,
      description,
      priority: 2, // High
      stateId: backlogStateId,
    });

    if (!result.success) return null;
    const issue = await result.issue;
    if (!issue) return null;

    state.parentIssueKey = issue.identifier;
    state.parentIssueId = issue.id;
    saveProactiveState(state);

    console.log(chalk.green(`[proactive] Created parent issue: ${issue.identifier}`));
    return { key: issue.identifier, id: issue.id };
  } catch (err) {
    console.log(chalk.red(`[proactive] Failed to create parent issue: ${(err as Error).message}`));
    return null;
  }
}

// ─── Proactive Prompt Generation ───

/**
 * Build the proactive exploration prompt for a given role.
 */
export function buildProactivePrompt(role: string, parentIssueKey: string): string {
  const config = PROACTIVE_ROLE_DEFAULTS[role];
  if (!config) return '';

  const focusAreas = config.focusAreas.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const directives = config.searchDirectives.map((d, i) => `${i + 1}. ${d}`).join('\n');

  return `# Proactive Strategic Exploration — ${role.toUpperCase()}

${config.thinkingPrompt}

## Your Mission

You are in your **proactive channel** — a dedicated thinking and exploration session. Your goal is NOT to complete a task. Your goal is to **discover the next thing worth building**.

Think big. Think transformative. Think about what would make you proud to have built.

## Focus Areas
${focusAreas}

## Research Directives
${directives}

## Process

### Phase 1: Explore (use web search, read papers, analyze trends)
- Cast a wide net. Follow curiosity.
- Look for signals of paradigm shifts.
- Identify unmet needs at the intersection of technology and human flourishing.

### Phase 2: Synthesize
- What patterns emerge?
- What opportunities are underexploited?
- What could a small, fast-moving AI-native team uniquely build?

### Phase 3: Propose (if you find something worth pursuing)
When you discover a genuinely high-value idea, propose it by creating a sub-issue:

\`\`\`bash
AGENT_ROLE=${role} linear-tool create-issue "[proactive] <Idea Title>" "<detailed description with: problem, solution, why us, impact potential, execution sketch>" 2 ${parentIssueKey}
\`\`\`

Then tag it for board discussion:
\`\`\`bash
AGENT_ROLE=${role} linear-tool comment <new-issue-key> "🗳️ BOARD VOTE REQUEST: I'm proposing this as a high-value project. All board members please evaluate and vote (approve/reject/abstain with reasoning). Quorum: ${BOARD_QUORUM} approvals needed."
\`\`\`

### Phase 4: Evaluate Others' Ideas
Check for other proactive ideas that need your vote:
\`\`\`bash
AGENT_ROLE=${role} linear-tool list-issues "Backlog"
\`\`\`

Look for issues with "[proactive]" in the title. Read them carefully and vote:
\`\`\`bash
AGENT_ROLE=${role} linear-tool comment <issue-key> "BOARD VOTE: [approve/reject/abstain] — <your reasoning from your role's perspective>"
\`\`\`

## Quality Bar

Only propose ideas that pass ALL of these:
- [ ] **Transformative**: Would genuinely change something fundamental for humanity
- [ ] **Feasible**: A small team with AI agents could build an MVP in days to weeks
- [ ] **Viral + Meaningful**: Has both explosive growth potential AND real human value
- [ ] **Non-obvious**: Leverages our unique position (AI agents, speed, no bureaucracy)
- [ ] **Not another SaaS**: We're not building "Jira but with AI" — think bigger

## Constraints
- You are a board member. Your opinion matters and shapes the company's direction.
- Be bold in exploration but rigorous in evaluation.
- One great idea is worth more than a hundred mediocre ones.
- If you don't find anything worth proposing this cycle, that's fine. Report what you explored and why nothing cleared the bar.
- Post a summary of your exploration to the parent issue: \`AGENT_ROLE=${role} linear-tool comment ${parentIssueKey} "Exploration summary: ..."\`

## End of Cycle
After exploring, post your findings to Discord:
\`\`\`bash
AGENT_ROLE=${role} linear-tool group "Proactive exploration complete. [1-2 sentence summary of what I explored and whether anything clears the bar]"
\`\`\`

Then write a brief memory file with your findings for future reference.
`;
}

// ─── Board Discussion Mechanism ───

/**
 * Process board votes on proactive ideas.
 * Called from the heartbeat to check if any ideas have reached quorum.
 */
export async function processBoardVotes(state: ProactiveState): Promise<void> {
  const votingIdeas = state.proposedIdeas.filter(i => i.status === 'voting');
  if (votingIdeas.length === 0) return;

  const now = Date.now();

  for (const idea of votingIdeas) {
    const proposedAt = new Date(idea.proposedAt).getTime();
    const elapsed = now - proposedAt;

    const approvals = Object.values(idea.votes).filter(v => v === 'approve').length;
    const rejections = Object.values(idea.votes).filter(v => v === 'reject').length;
    const totalVotes = Object.keys(idea.votes).length;
    const totalRoles = listAgents().length;

    // Check for approval quorum
    if (approvals >= BOARD_QUORUM) {
      idea.status = 'approved';
      state.stats.totalIdeasApproved++;
      console.log(chalk.green(`[proactive] Idea approved: ${idea.title} (${approvals}/${totalVotes} votes)`));

      // Notify on the issue
      try {
        await addComment(
          idea.id, // Linear issue UUID, not the human-readable key
          `✅ **BOARD APPROVED** — ${approvals} approvals, ${rejections} rejections. This idea has cleared the bar. Moving to execution planning.`,
        );
      } catch (err) { console.log(chalk.dim(`[proactive] Failed to comment on approved idea: ${(err as Error).message}`)); }
      continue;
    }

    // Check for rejection (majority rejects)
    if (rejections > totalRoles / 2) {
      idea.status = 'rejected';
      state.stats.totalIdeasRejected++;
      console.log(chalk.yellow(`[proactive] Idea rejected: ${idea.title} (${rejections} rejections)`));
      continue;
    }

    // Check for timeout (voting window expired without quorum or majority rejection)
    if (elapsed > BOARD_VOTE_WINDOW_MS) {
      idea.status = 'rejected';
      state.stats.totalIdeasRejected++;
      console.log(chalk.dim(`[proactive] Idea timed out without quorum: ${idea.title}`));
    }
  }

  saveProactiveState(state);
}

// ─── Invite Board to Vote ───

/**
 * When a new proactive idea is detected (sub-issue with [proactive] prefix),
 * invite all agents to evaluate it by sending messages to their active sessions.
 */
export async function inviteBoardToVote(ideaIssueKey: string, ideaTitle: string, proposedBy: string): Promise<void> {
  const ts = new Date().toLocaleTimeString();
  const roles = listAgents();

  for (const role of roles) {
    if (role === proposedBy) continue; // Don't ask the proposer to vote on their own idea

    // Try to send to an active proactive session first, then any active session
    const tmuxName = `aos-${role}`;
    const proactiveTmux = `aos-${role}-proactive`;

    const targetSession = sessionExists(proactiveTmux) ? proactiveTmux
      : sessionExists(tmuxName) ? tmuxName
      : null;

    if (targetSession) {
      try {
        const voteMsg = `[BOARD VOTE REQUEST] New proactive idea from ${proposedBy}: "${ideaTitle}" (${ideaIssueKey}). Please review and vote:\nAGENT_ROLE=${role} linear-tool comment ${ideaIssueKey} "BOARD VOTE: [approve/reject/abstain] — <your reasoning>"`;
        sendKeys(targetSession, voteMsg);
        console.log(chalk.blue(`[${ts}] Board vote invite: ${role} on ${ideaIssueKey}`));
      } catch (err) {
        console.log(chalk.dim(`[proactive] Failed to invite ${role} to vote: ${(err as Error).message}`));
      }
    }
  }
}

// ─── Spawn Gating Helpers (RYA-698) ───

/**
 * Is the tracked proactive session for this role still running?
 * Matches the DB attempt by exact issue_key — the broken filter this fix
 * replaces used `issue_key.includes('proactive')`, which never matched because
 * Linear issue keys are `RYA-NNN` and never contain the string 'proactive'.
 */
export function isTrackedProactiveSessionRunning(
  role: string,
  trackedIssueKey: string | undefined,
  activeAttempts: Attempt[],
): boolean {
  if (!trackedIssueKey) return false;
  return activeAttempts.some(
    a => a.agent_type === role
      && a.status === 'running'
      && a.issue_key === trackedIssueKey,
  );
}

/**
 * Update the cool-down fields on a channel based on the final status of its
 * most recent attempt. Mutates and returns the channel.
 *
 * - failed       → bump consecutiveFailures and set cooldownUntil at thresholds
 * - completed    → reset counters
 * - running/etc  → leave counters intact
 */
export function applyCoolDownFromAttempt(
  channel: NonNullable<ProactiveState['activeChannels'][string]>,
  latestAttempt: Attempt | undefined,
  now: number = Date.now(),
): NonNullable<ProactiveState['activeChannels'][string]> {
  if (!latestAttempt) return channel;

  if (latestAttempt.status === 'failed') {
    const next = (channel.consecutiveFailures ?? 0) + 1;
    channel.consecutiveFailures = next;
    channel.lastFailureAt = latestAttempt.completed_at ?? new Date(now).toISOString();
    if (next >= FAILURE_COOLDOWN_THRESHOLD_LONG) {
      channel.cooldownUntil = new Date(now + FAILURE_COOLDOWN_MS_LONG).toISOString();
    } else if (next >= FAILURE_COOLDOWN_THRESHOLD) {
      channel.cooldownUntil = new Date(now + FAILURE_COOLDOWN_MS_SHORT).toISOString();
    }
    return channel;
  }

  if (latestAttempt.status === 'completed') {
    channel.consecutiveFailures = 0;
    delete channel.cooldownUntil;
    return channel;
  }

  return channel;
}

/** Is the role currently in a back-off window? */
export function isInCoolDown(
  channel: ProactiveState['activeChannels'][string] | undefined,
  now: number = Date.now(),
): boolean {
  if (!channel?.cooldownUntil) return false;
  return new Date(channel.cooldownUntil).getTime() > now;
}

/**
 * Title prefix shared by every proactive Strategic-exploration child issue —
 * regardless of suffix format (date "(YYYY-MM-DD)" or ISO week "(YYYY-Wnn)").
 * Used as the single-slot-lock key in `hasOpenProactiveIssueForRole` so old
 * and new dupes both block respawns (RYA-831).
 */
export function proactiveTitlePrefix(role: string): string {
  return `[proactive] ${role}: Strategic exploration`;
}

/**
 * Belt-and-suspenders single-slot lock: returns true when the role already has
 * any open `[proactive] {role}: Strategic exploration*` sub-issue under the
 * parent. PREFIX-matches the title so a suffix change (date → week-key, or any
 * future format) doesn't silently bypass the dedupe.
 *
 * Fail-CLOSED on rate-limit / network errors (RYA-1033): returns true so the
 * heartbeat skips the spawn instead of pushing through during a transient
 * Linear outage. Until RYA-1033 this guard fail-opened, with the same-day cap
 * (RYA-1032) as the only fail-CLOSED line of defense — a fragile single point
 * of failure if cool-down state were ever lost or the cap window shortened.
 * Generic non-network errors (GraphQL/permission/schema) still fail-open
 * because those are not the burst pattern that produced the W19 incident, and
 * the team-wide variant + same-day cap remain as fallback.
 */
export async function hasOpenProactiveIssueForRole(
  parentIssueId: string,
  role: string,
): Promise<boolean> {
  const prefix = proactiveTitlePrefix(role);
  try {
    const client = getReadClient();
    const parent = await client.issue(parentIssueId);
    if (!parent) return false;
    const children = await parent.children();
    for (const child of children.nodes) {
      if (!child.title.startsWith(prefix)) continue;
      const childState = await child.state;
      const stateName = childState?.name;
      if (!stateName) continue;
      if (OPEN_LINEAR_STATES.has(stateName)) return true;
    }
    return false;
  } catch (err) {
    const msg = (err as Error).message;
    console.log(chalk.dim(`[proactive] Open-issue guard failed: ${msg}`));
    if (TRANSIENT_LINEAR_ERROR_RE.test(msg)) return true;
    return false;
  }
}

/**
 * Cross-parent single-slot lock: searches the team for any open
 * `[proactive] {role}: Strategic exploration*` issue, regardless of which
 * "Proactive: Strategic Exploration Hub" parent it sits under. Catches the
 * RYA-831 zombie-parent case where state.json drift caused us to create
 * multiple parents and spawn duplicate children under each.
 *
 * Fail-CLOSED on rate-limit / network errors (RYA-1033). Same rationale as
 * `hasOpenProactiveIssueForRole`: under sustained rate-limit, fail-open lets
 * each blocked query spawn another duplicate, which costs more API budget
 * and digs the rate-limit hole deeper. Generic non-network errors still
 * fail-open since the same-day cap remains as a fallback.
 */
export async function hasOpenProactiveIssueForRoleTeamWide(role: string): Promise<boolean> {
  const prefix = proactiveTitlePrefix(role);
  try {
    const config = getConfig();
    if (!config.linearTeamId) return false;
    const client = getReadClient();
    const result = await client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        title: { startsWith: prefix },
        state: { name: { in: Array.from(OPEN_LINEAR_STATES) } },
      },
      first: 5,
    });
    return result.nodes.length > 0;
  } catch (err) {
    const msg = (err as Error).message;
    console.log(chalk.dim(`[proactive] Team-wide open-issue guard failed: ${msg}`));
    if (TRANSIENT_LINEAR_ERROR_RE.test(msg)) return true;
    return false;
  }
}

/**
 * Same-role same-day cap (RYA-912): returns true when ANY `[proactive] {role}:
 * Strategic exploration*` issue has been created within `windowMs`, regardless
 * of its current state. Closes the gap left by `hasOpenProactiveIssueForRole*`
 * which only counts open states — once a fast cycle moves an issue to
 * Done/Canceled, the open-state guards stop blocking and the heartbeat
 * happily respawns. W19 produced three same-day dispatches for cpo
 * (RYA-892 done → RYA-897 canceled → RYA-909 in progress) by exactly this
 * route. This guard is independent of state.json so state-loss does not
 * reopen the floodgate.
 *
 * Fail-CLOSED on rate-limit / network errors (RYA-1032): when the workspace
 * is rate-limited, fail-open turned this guard into a positive feedback loop
 * — every heartbeat that couldn't query Linear spawned another duplicate,
 * burning more API budget and digging the rate-limit hole deeper (W19 cpo:
 * 30+ phantom siblings RYA-892…RYA-1031 in a few hours). Skipping a cycle
 * is recoverable next tick; a duplicate spawn is not. Generic non-network
 * errors still fail-open because the open-issue guards remain as a fallback.
 */
export async function hasRecentDispatchForRole(
  role: string,
  windowMs: number = PROACTIVE_SAME_ROLE_SAME_DAY_CAP_MS,
  now: number = Date.now(),
): Promise<boolean> {
  const prefix = proactiveTitlePrefix(role);
  try {
    const config = getConfig();
    if (!config.linearTeamId) return false;
    const client = getReadClient();
    const cutoff = new Date(now - windowMs).toISOString();
    const result = await client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        title: { startsWith: prefix },
        createdAt: { gte: cutoff },
      },
      first: 5,
    });
    return result.nodes.length > 0;
  } catch (err) {
    const msg = (err as Error).message;
    console.log(chalk.dim(`[proactive] Same-day cap guard failed: ${msg}`));
    if (TRANSIENT_LINEAR_ERROR_RE.test(msg)) return true;
    return false;
  }
}

/**
 * Parent-hub same-week dedupe (RYA-912): returns true when a
 * "Proactive: Strategic Exploration Hub" issue has been created within
 * `windowMs`, regardless of state. The existing `ensureParentIssue` search
 * filters to OPEN_LINEAR_STATES — so when ceo-office bulk-cancels phantom
 * hubs (RYA-908/896/891/886/839 sweep on 2026-05-06), the next heartbeat
 * sees zero open hubs and creates a NEW one, restarting the phantom cycle.
 * If we find any recent hub (Backlog/Todo/InProgress/InReview/Done/Canceled
 * within the window), skip the cycle instead of spawning another duplicate.
 *
 * Fail-CLOSED on rate-limit / network errors (RYA-1032). See
 * `hasRecentDispatchForRole` for rationale.
 */
export async function hasRecentParentHub(
  windowMs: number = PROACTIVE_PARENT_HUB_DEDUPE_MS,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const config = getConfig();
    if (!config.linearTeamId) return false;
    const client = getReadClient();
    const cutoff = new Date(now - windowMs).toISOString();
    const result = await client.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        title: { eq: PROACTIVE_PARENT_TITLE },
        createdAt: { gte: cutoff },
      },
      first: 5,
    });
    return result.nodes.length > 0;
  } catch (err) {
    const msg = (err as Error).message;
    console.log(chalk.dim(`[proactive] Parent-hub dedupe guard failed: ${msg}`));
    if (TRANSIENT_LINEAR_ERROR_RE.test(msg)) return true;
    return false;
  }
}

// ─── Proactive Channel Heartbeat ───

/**
 * Main heartbeat: ensures each role's proactive channel is alive.
 * Spawns new proactive sessions for roles that are idle.
 * Processes board votes on proposed ideas.
 */
export async function proactiveChannelHeartbeat(): Promise<void> {
  // Disabled by default per CEO 2026-05-06 — proactive exploration generated
  // more noise (idea/vote cascades, hub duplicates) than value. Opt back in
  // by setting AOS_PROACTIVE_ENABLED=1; the legacy AOS_NO_PROACTIVE=1 kill
  // switch is honored for backward compat.
  if (process.env.AOS_NO_PROACTIVE === '1') return;
  if (process.env.AOS_PROACTIVE_ENABLED !== '1') return;

  // Cooldown
  if (Date.now() - lastProactiveHeartbeatAt < PROACTIVE_HEARTBEAT_INTERVAL_MS) return;
  lastProactiveHeartbeatAt = Date.now();

  const ts = new Date().toLocaleTimeString();
  const state = loadProactiveState();

  // Ensure parent issue exists
  const parent = await ensureParentIssue(state);
  if (!parent) {
    console.log(chalk.dim(`[${ts}] Proactive: could not ensure parent issue — skipping cycle`));
    return;
  }

  // Process board votes on existing ideas
  await processBoardVotes(state);

  // Check each role's proactive channel
  const roles = listAgents();
  let spawned = 0;

  for (const role of roles) {
    if (!agentExists(role)) continue;

    // Check if this role has proactive enabled
    const roleConfig = getProactiveConfig(role);
    if (!roleConfig?.enabled) continue;

    // RYA-698: detect an already-running proactive session via the tracked
    // issue_key in state, NOT by substring-matching 'proactive' against the
    // Linear key (RYA-NNN — which never contains that word). The old filter
    // always returned empty and caused the heartbeat to respawn every cycle,
    // producing 20+ zombie issues during rate-limit windows.
    const activeAttempts = getActiveAttempts();
    const channel = state.activeChannels[role];
    const trackedIssueKey = channel?.issueKey;

    if (isTrackedProactiveSessionRunning(role, trackedIssueKey, activeAttempts)) {
      if (channel) channel.lastHeartbeatAt = new Date().toISOString();
      continue;
    }

    // Tracked session is not running — inspect its final status to update
    // cool-down counters before deciding whether to spawn again.
    if (channel && trackedIssueKey) {
      const prior = getAttemptsByIssue(trackedIssueKey)
        .filter(a => a.agent_type === role);
      const latest = prior[0]; // getAttemptsByIssue returns DESC by created_at
      applyCoolDownFromAttempt(channel, latest);
    }

    // Tertiary: respect cool-down window for sustained failures.
    if (isInCoolDown(channel)) {
      console.log(chalk.dim(`[${ts}] Proactive: ${role} cooling down until ${channel!.cooldownUntil} (${channel!.consecutiveFailures} consecutive failures) — skipping`));
      continue;
    }

    // Per-role cadence gate: enforce min interval (default 7 days) between spawns.
    // The startedAt timestamp is the single source of truth even after a session
    // completes — channel state is not cleared on completion.
    if (channel?.startedAt) {
      const sinceLastMs = Date.now() - new Date(channel.startedAt).getTime();
      if (sinceLastMs < PROACTIVE_PER_ROLE_INTERVAL_MS) {
        const nextEligible = new Date(new Date(channel.startedAt).getTime() + PROACTIVE_PER_ROLE_INTERVAL_MS).toISOString();
        console.log(chalk.dim(`[${ts}] Proactive: ${role} last ran ${channel.startedAt} — next eligible ${nextEligible}; skipping`));
        continue;
      }
    }

    // Secondary: belt-and-suspenders check against Linear for any open
    // proactive issue for this role under the tracked parent. Prefix-matches
    // the title so date/week-key suffix variants both block respawn.
    const weekKey = getIsoWeekKey(new Date());
    const expectedTitle = `[proactive] ${role}: Strategic exploration (${weekKey})`;
    if (await hasOpenProactiveIssueForRole(parent.id, role)) {
      console.log(chalk.dim(`[${ts}] Proactive: ${role} already has an open exploration issue under ${parent.key} — skipping spawn`));
      continue;
    }

    // Tertiary: team-wide cross-parent check. Catches the case where
    // state.json drift produced multiple "Proactive: Strategic Exploration
    // Hub" parents and a stale child still exists under a different parent
    // (RYA-831). Without this, the per-parent check above misses siblings.
    if (await hasOpenProactiveIssueForRoleTeamWide(role)) {
      console.log(chalk.dim(`[${ts}] Proactive: ${role} already has an open exploration issue elsewhere in the team — skipping spawn`));
      continue;
    }

    // Quaternary: same-role same-day cap (RYA-912). The open-issue guards
    // above filter by OPEN_LINEAR_STATES, so a fast Done/Canceled cycle
    // within the per-role interval lets duplicates through. This guard
    // counts ANY recent dispatch (any state) and is the only check that
    // catches the W19-style RYA-892→897→909 chain.
    if (await hasRecentDispatchForRole(role)) {
      console.log(chalk.dim(`[${ts}] Proactive: skipped: same-role same-day cap — ${role} dispatched in last ${PROACTIVE_SAME_ROLE_SAME_DAY_CAP_MS / 60_000}min`));
      continue;
    }

    // Check capacity: proactive sessions should only spawn when the role has spare capacity
    // We need at least 2 free slots (1 for proactive + 1 reserved for reactive work)
    if (!hasCapacity(role)) {
      console.log(chalk.dim(`[${ts}] Proactive: ${role} at capacity — skipping`));
      continue;
    }

    // Global concurrency gate
    const concurrency = canStartNewSession();
    if (!concurrency.allowed) {
      console.log(chalk.dim(`[${ts}] Proactive: global cap reached — stopping`));
      break;
    }

    // Create a proactive exploration issue for this role
    try {
      const config = getConfig();
      const agentClient = getAgentClient();
      const todoStateId = await getWorkflowStateId('Todo');
      const agentConfig = loadAgentConfig(role);

      const prompt = buildProactivePrompt(role, parent.key);

      const result = await agentClient.createIssue({
        teamId: config.linearTeamId,
        title: expectedTitle,
        description: prompt,
        priority: 4, // Low priority — yields to reactive work
        stateId: todoStateId,
        parentId: parent.id,
        ...(agentConfig.linearUserId ? { delegateId: agentConfig.linearUserId } : {}),
      });

      if (!result.success) continue;
      const issue = await result.issue;
      if (!issue) continue;

      // Dispatch the agent
      await handleDispatch({
        role,
        issueKey: issue.identifier,
        message: prompt,
        from: 'proactive-scheduler',
      });

      // Track in state. Preserve cool-down counters from the prior channel so
      // a successful dispatch here followed by another startup failure still
      // increments toward the back-off threshold (RYA-698).
      const prior = state.activeChannels[role];
      state.activeChannels[role] = {
        issueKey: issue.identifier,
        issueId: issue.id,
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        ...(prior?.consecutiveFailures ? { consecutiveFailures: prior.consecutiveFailures } : {}),
        ...(prior?.lastFailureAt ? { lastFailureAt: prior.lastFailureAt } : {}),
      };

      spawned++;
      console.log(chalk.green(`[${ts}] Proactive: spawned ${role} → ${issue.identifier}`));

      // Rate limit: only spawn one per heartbeat cycle to avoid overwhelming the system
      if (spawned >= 1) break;
    } catch (err) {
      console.log(chalk.yellow(`[${ts}] Proactive: failed to spawn ${role}: ${(err as Error).message}`));
    }
  }

  state.stats.lastCycleAt = new Date().toISOString();
  saveProactiveState(state);

  if (spawned > 0) {
    console.log(chalk.green(`[${ts}] Proactive heartbeat: spawned ${spawned} channel(s)`));
  }
}

// ─── Scan for New Proactive Ideas (called from monitor) ───

/**
 * Scan for new sub-issues under the proactive parent that need board voting.
 * This detects when a proactive agent creates a sub-issue with [proactive] prefix.
 */
export async function scanProactiveIdeas(): Promise<void> {
  // Disabled by default per CEO 2026-05-06 — proactive exploration generated
  // more noise (idea/vote cascades, hub duplicates) than value. Opt back in
  // by setting AOS_PROACTIVE_ENABLED=1; the legacy AOS_NO_PROACTIVE=1 kill
  // switch is honored for backward compat.
  if (process.env.AOS_NO_PROACTIVE === '1') return;
  if (process.env.AOS_PROACTIVE_ENABLED !== '1') return;

  const state = loadProactiveState();
  if (!state.parentIssueId) return;

  try {
    const client = getReadClient();
    const parentIssue = await client.issue(state.parentIssueId);
    if (!parentIssue) return;

    const children = await parentIssue.children();
    const knownIssueKeys = new Set(state.proposedIdeas.map(i => i.issueKey));

    for (const child of children.nodes) {
      const key = child.identifier;
      if (knownIssueKeys.has(key)) continue;

      // Check if this is a proactive idea (not a channel issue)
      const title = child.title;
      if (title.includes(': Strategic exploration (')) continue; // Skip channel issues

      if (!title.startsWith('[proactive]')) continue;

      // New idea detected! Register it for board voting
      const assignee = await child.assignee;
      const proposedBy = assignee?.name || 'unknown';

      // Resolve proposer role from assignee
      let proposerRole = 'unknown';
      for (const role of listAgents()) {
        const cfg = loadAgentConfig(role);
        if (cfg.linearUserId && assignee?.id === cfg.linearUserId) {
          proposerRole = role;
          break;
        }
      }

      state.proposedIdeas.push({
        id: child.id,
        issueKey: key,
        title: title.replace('[proactive] ', ''),
        proposedBy: proposerRole,
        proposedAt: new Date().toISOString(),
        votes: {},
        status: 'voting',
      });

      state.stats.totalIdeasProposed++;

      console.log(chalk.cyan(`[proactive] New idea detected: ${key} — "${title}" by ${proposerRole}`));

      // Invite all board members to vote
      await inviteBoardToVote(key, title, proposerRole);
    }

    saveProactiveState(state);
  } catch (err) {
    console.log(chalk.dim(`[proactive] Scan ideas: ${(err as Error).message}`));
  }
}

// ─── Dashboard Data ───

export function getProactiveDashboardData(): {
  parentIssueKey: string | null;
  activeChannels: Record<string, { issueKey: string; startedAt: string }>;
  votingIdeas: number;
  approvedIdeas: number;
  totalProposed: number;
} {
  const state = loadProactiveState();
  return {
    parentIssueKey: state.parentIssueKey,
    activeChannels: Object.fromEntries(
      Object.entries(state.activeChannels).map(([role, ch]) => [role, { issueKey: ch.issueKey, startedAt: ch.startedAt }])
    ),
    votingIdeas: state.proposedIdeas.filter(i => i.status === 'voting').length,
    approvedIdeas: state.stats.totalIdeasApproved,
    totalProposed: state.stats.totalIdeasProposed,
  };
}
