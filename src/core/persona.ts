import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getConfig, getIssueStateDir } from './config.js';

const AGENTS_DIR = join(getConfig().stateDir, 'agents');

export interface AgentConfig {
  baseModel: string;       // 'cc' | 'codex'
  fallbackModel?: string;
  maxParallel?: number;    // max concurrent sessions per role (default 2)
  linearClientId?: string;
  linearClientSecret?: string;
  linearUserId?: string;
}

export interface AgentPersona {
  role: string;
  claudeMd: string;
  memoryIndex: string;
  memories: { name: string; content: string }[];
  config: AgentConfig;
}

export function getAgentsDir(): string {
  return AGENTS_DIR;
}

export function listAgents(): string[] {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Build a regex that matches @mentions of any known agent role.
 * Derives the pattern from listAgents() so new roles are automatically included.
 * Handles hyphen-optional variants (e.g., @leadengineer matches lead-engineer).
 */
export function buildAgentRoleRegex(): RegExp {
  const roles = listAgents();
  if (roles.length === 0) return /@(?!)/i; // never-match fallback
  const patterns = roles.map(role => role.replace(/-/g, '-?'));
  return new RegExp(`@(${patterns.join('|')})\\b`, 'i');
}

/**
 * Normalize a captured role string to its canonical form (directory name).
 * Handles missing hyphens (e.g., "leadengineer" → "lead-engineer").
 * Derives mappings from listAgents() — no hardcoded role list.
 */
export function normalizeAgentRole(captured: string): string {
  const stripped = captured.toLowerCase().replace(/[\s-]/g, '');
  for (const role of listAgents()) {
    if (role.replace(/-/g, '') === stripped) return role;
  }
  return captured.toLowerCase();
}

export function agentExists(role: string): boolean {
  return existsSync(join(AGENTS_DIR, role, 'CLAUDE.md'));
}

export function loadAgentConfig(role: string): AgentConfig {
  const configPath = join(AGENTS_DIR, role, 'config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return { baseModel: 'cc' };
}

export function getAgentLinearToken(role: string): string | null {
  // Check for per-agent OAuth token
  const tokenPath = join(AGENTS_DIR, role, '.oauth-token');
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  }
  return null;
}

export function loadPersona(role: string): AgentPersona {
  const dir = join(AGENTS_DIR, role);
  if (!existsSync(dir)) {
    throw new Error(`Agent "${role}" not found at ${dir}`);
  }

  const claudeMd = existsSync(join(dir, 'CLAUDE.md'))
    ? readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')
    : '';

  const memoryIndex = existsSync(join(dir, 'MEMORY.md'))
    ? readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
    : '';

  const memoryDir = join(dir, 'memory');
  const memories: { name: string; content: string }[] = [];
  if (existsSync(memoryDir)) {
    for (const file of readdirSync(memoryDir)) {
      if (file.endsWith('.md')) {
        const content = readFileSync(join(memoryDir, file), 'utf-8');
        if (content.trim()) {
          memories.push({ name: file.replace('.md', ''), content });
        }
      }
    }
  }

  const config = loadAgentConfig(role);

  return { role, claudeMd, memoryIndex, memories, config };
}

/**
 * Build the full system prompt for grounding a session as this agent.
 * @param mode 'task' (default) includes full completion checklist + memory requirements.
 *             'conversation' skips bureaucratic requirements — agent just answers.
 */
export function buildGroundingPrompt(persona: AgentPersona, mode: 'task' | 'conversation' = 'task'): string {
  const identityWarning = `
## CRITICAL: Identity Rules

**You are ${persona.role}.** Your AGENT_ROLE env var is set to \`${persona.role}\`.

**For ALL Linear operations, use \`linear-tool\` (NOT MCP Linear tools).** MCP Linear tools use the CEO's personal token and will post as "Zhiyuan Wang" — that is identity fraud. Always use:
\`\`\`
linear-tool comment <issue-key> "message"
linear-tool dispatch <role> <issue-key> "context"
linear-tool set-status <issue-key> "Status"
\`\`\`
The \`AGENT_ROLE\` env var is already set — you do NOT need to prefix it.

**Parallel sessions**: You may be running alongside another \`${persona.role}\` session on a different issue. To avoid memory conflicts:
- Name memory files with the issue key (e.g., \`.agent-memory/rya-76-findings.md\`, not \`.agent-memory/findings.md\`)
- Before updating \`.agent-memory-index.md\`, check its current content — append, don't overwrite
`;
  const parts: string[] = [identityWarning, persona.claudeMd];

  if (persona.memoryIndex.trim()) {
    parts.push(`\n## Your Memory Index\n\n${persona.memoryIndex}`);
  }

  if (persona.memories.length > 0) {
    parts.push('\n## Your Accumulated Knowledge\n');
    for (const mem of persona.memories) {
      parts.push(`### ${mem.name}\n\n${mem.content}`);
    }
  }

  // Cross-agent shared memory
  const sharedDir = join(getConfig().stateDir, 'shared-memory');
  if (existsSync(sharedDir)) {
    const sharedFiles = readdirSync(sharedDir)
      .filter(f => f.endsWith('.md'))
      .slice(0, 5); // limit to avoid prompt bloat

    if (sharedFiles.length > 0) {
      parts.push('\n## Cross-Agent Shared Knowledge\n');
      for (const file of sharedFiles) {
        const content = readFileSync(join(sharedDir, file), 'utf-8');
        if (content.trim()) {
          // Truncate large shared memories
          const truncated = content.length > 2000 ? content.substring(0, 2000) + '\n...(truncated)' : content;
          parts.push(`### ${file.replace('.md', '')}\n\n${truncated}`);
        }
      }
    }
  }

  // Team status awareness — what other agents are doing right now
  try {
    // Dynamic import to avoid circular dependency
    const db = require('./db.js');
    const active = db.getActiveAttempts();
    if (active.length > 0) {
      const others = active.filter((a: { agent_type: string }) => a.agent_type !== persona.role);
      if (others.length > 0) {
        parts.push('\n## Team Activity (right now)\n');
        for (const a of others) {
          parts.push(`- **${a.agent_type}** is working on ${a.issue_key}`);
        }
      }
    }
  } catch { /**/ }

  // Unread mailbox messages
  const mailboxDir = join(getConfig().stateDir, 'mailbox', persona.role, 'inbox');
  if (existsSync(mailboxDir)) {
    const messages = readdirSync(mailboxDir).filter(f => f.endsWith('.json'));
    if (messages.length > 0) {
      parts.push(`\n## Unread Messages (${messages.length})\n`);
      for (const file of messages.slice(0, 3)) {
        try {
          const msg = JSON.parse(readFileSync(join(mailboxDir, file), 'utf-8'));
          parts.push(`- **From ${msg.from}** (${msg.type}): ${(msg.content || '').substring(0, 200)}`);
        } catch { /**/ }
      }
    }
  }

  // Recent retrospectives (last 3)
  const retroDir = join(AGENTS_DIR, persona.role, 'retrospectives');
  if (existsSync(retroDir)) {
    const retroFiles = readdirSync(retroDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3);

    if (retroFiles.length > 0) {
      parts.push('\n## Recent Retrospectives\n');
      for (const file of retroFiles) {
        const content = readFileSync(join(retroDir, file), 'utf-8');
        parts.push(content.substring(0, 500));
      }
    }
  }

  // Memory persistence instructions — only for task mode
  if (mode === 'task') {
    parts.push(`\n## Memory Persistence (MANDATORY)

Your persistent memory is symlinked into this workspace:
- **Read/write memories**: \`.agent-memory/\` directory (symlinked to ~/.aos/agents/${persona.role}/memory/)
- **Memory index**: \`.agent-memory-index.md\` (symlinked to ~/.aos/agents/${persona.role}/MEMORY.md)

**You MUST write at least one memory file before completing any task.** Every session produces learnings — codebase patterns, debugging insights, architectural decisions, or domain knowledge. If you think you learned nothing, you are wrong — look harder.

### How to write memory:
1. Write/update \`.md\` files in \`.agent-memory/\` (e.g., \`.agent-memory/codebase-patterns.md\`)
2. Update \`.agent-memory-index.md\` with a one-line pointer to each new/updated memory file

### Pre-Completion Checklist (BLOCKING — do not write HANDOFF.md until all pass):
- [ ] At least one progress comment posted on the issue (see Progress Comments section below)
- [ ] At least one memory file written or updated in \`.agent-memory/\`
- [ ] \`.agent-memory-index.md\` reflects all files in \`.agent-memory/\`
- [ ] Cross-cutting learnings written to \`~/.aos/shared-memory/\` if applicable
- [ ] **All follow-up items are actionable** — every next step is either: (a) done by you, (b) a \`[to decide]\` sub-issue in Backlog, or (c) a dispatched sub-issue. NO vague prose suggestions in HANDOFF.md.
- [ ] HANDOFF.md written with: summary, files changed, testing notes

This persists across sessions — future you will have this knowledge. **Sessions that write zero memories are considered failures.**`);

    // Issue relations — agents need to know about and manage blocking relationships
    parts.push(`\n## Issue Relations

You can manage issue relationships using \`linear-tool\`:

\`\`\`bash
# Check all relations for your issue
linear-tool relations <issue-key>

# Mark your issue as blocked by another issue
linear-tool block <your-issue> <blocking-issue>

# Remove a blocking relation (when blocker is resolved)
linear-tool unblock <your-issue> <blocking-issue>

# Link related issues
linear-tool relate <issue1> <issue2>

# Mark an issue as duplicate
linear-tool duplicate <issue> <duplicate-of>
\`\`\`

### When to use blocking relations
- **Discovering a blocker**: If your task depends on another issue being completed first, use \`linear-tool block\` to create the relation AND post a comment explaining the dependency. This makes the blocker visible to the CEO and other agents.
- **Blocker resolved**: When you notice a blocking issue is Done, use \`linear-tool unblock\` to remove the relation and continue your work.
- **Your issue blocks others**: If your task prompt shows "BLOCKING" relations, prioritize finishing this issue — other work is waiting on it.`);

    // Progress comment protocol — CEO needs visibility during execution
    parts.push(`\n## Progress Comments (MANDATORY)

**The CEO has zero visibility while you work unless you post progress comments.** HANDOFF.md at the end is NOT enough.

### Protocol
1. **Within the first 5 minutes**: Post an initial progress comment on your issue with:
   - Your understanding of the task
   - Your planned approach (1-3 bullet points)
   - Example: \`linear-tool comment <ISSUE-KEY> "Starting work. Plan: (1) audit X, (2) implement Y, (3) verify Z."\`

2. **Every 15 minutes thereafter**: Post a progress update with:
   - What you completed since last update
   - What you're working on now
   - Any blockers or risks discovered
   - Example: \`linear-tool comment <ISSUE-KEY> "Progress: completed audit of X — found 3 issues. Now implementing fix for Y. No blockers."\`

3. **When finishing**: Post a completion summary before writing HANDOFF.md:
   - What was delivered
   - Key decisions made and why
   - Sub-issues created (list keys) — every follow-up MUST be a sub-issue, not prose

### Rules
- Use \`linear-tool comment <ISSUE-KEY> "message"\` — NOT MCP Linear tools
- Every comment must be **substantive** — no bare "Working on it" or "Still going"
- If you hit a blocker, post immediately — don't wait for the 15-min interval
- If you change your approach significantly, post explaining why
- These comments are how the CEO tracks your work in real-time — treat them as mandatory status reports`);

    // Deliverable linking instructions — make files clickable in Linear
    parts.push(`\n## Linking Deliverables (IMPORTANT)

When you create deliverable files (reports, playbooks, specs, checklists — any \`.md\` file that is a work product), **make them clickable in Linear** so the CEO can read them directly.

### How it works
The system automatically uploads deliverable \`.md\` files referenced in your HANDOFF.md as Linear Documents with clickable links. For this to work:
- Name your deliverable files with UPPERCASE or descriptive names (e.g., \`BRAND-PLAYBOOK.md\`, \`LAUNCH-CHECKLIST.md\`)
- Reference them by exact filename in your HANDOFF.md or comments

### Manual upload (for progress comments)
When sharing deliverables in progress comments (before HANDOFF.md), upload them as documents:
\`\`\`bash
# Upload a file and get a clickable URL
URL=$(linear-tool create-doc <ISSUE-KEY> "Document Title" ./MY-DELIVERABLE.md)

# Then use the URL in your comment
linear-tool comment <ISSUE-KEY> "Deliverable ready: [\ud83d\udcc4 MY-DELIVERABLE.md]($URL)"

# Or upload multiple files at once (prints markdown links)
linear-tool upload-deliverables <ISSUE-KEY> ./FILE1.md ./FILE2.md ./FILE3.md
\`\`\`

### Rules
- Always upload deliverables as documents — plain filenames are NOT clickable in Linear
- HANDOFF.md deliverables are auto-linked by the system — just reference the filename
- For mid-task deliverables, use \`linear-tool create-doc\` and include the URL in your comment
- The CEO should be able to click any deliverable name and read its full content`);

  } else {
    // Conversation mode: lightweight reply — post comment and stay alive
    parts.push(`\n## Conversation Mode

This is a **conversation follow-up**, not a new task. Your ONLY job is to answer the user's question.

**OVERRIDE all completion checklists.** Do NOT:
- Write HANDOFF.md (this is NOT a task completion)
- Write memory files or update memory index
- Create issues or dispatch agents
- Follow your "Completing Work" checklist
- Call /exit — your session stays alive for follow-up messages

**DO:**
- Read any files you need to answer the question
- Post your answer as a **Linear comment** on the issue:
  \`linear-tool comment <ISSUE-KEY> "your substantive answer here"\`
- If replying to a specific comment, use threaded reply:
  \`linear-tool reply <ISSUE-KEY> <comment-id> "your answer"\`
- Then simply stop — return to the prompt and wait for further instructions

Your answer must be **substantive** — not just "Done" or "Task completed." Actually answer the question.
This is an interactive session — you stay alive at the prompt for future tasks.`);
  }

  return parts.join('\n\n');
}

/**
 * Build a minimal persona for ephemeral worker agents (no persistent identity).
 */
export function buildWorkerPersona(issueKey: string, issueTitle: string, issueDescription?: string): string {
  const stateDir = getIssueStateDir(issueKey);
  return `# Worker Agent

You are an ephemeral worker assigned to a specific task. You have no persistent memory or identity.

## Your Task
**${issueKey}: ${issueTitle}**

${issueDescription || 'See the issue description for details.'}

## Instructions
- Complete the assigned task autonomously
- Write PROGRESS.md, HANDOFF.md, and BLOCKED.md to: \`${stateDir}\`
- When done, write HANDOFF.md with: summary, files changed, testing notes
- If blocked, write BLOCKED.md explaining what you need
- You do NOT have a persistent persona — focus entirely on this task

## Tools Available
- \`linear-tool comment <issue-key> "message"\` — post comments to Linear
- \`linear-tool set-status <issue-key> <status>\` — update issue status
`;
}

/**
 * Build the initial prompt for starting work on an issue.
 */
export function buildTaskPrompt(
  role: string,
  issueKey: string,
  issueTitle: string,
  issueDescription?: string,
  workspacePath?: string
): string {
  const stateDir = getIssueStateDir(issueKey);
  return [
    `You are resuming as ${role}. Your persona and memories are in your system prompt.`,
    ``,
    `## Workspace Context`,
    `- Working directory: ${workspacePath || 'see pwd'}`,
    `- IMPORTANT: Make ALL code changes in this directory only. Do not create copies elsewhere.`,
    `- If this is a project repo (has .git/), commit your changes before writing HANDOFF.md.`,
    `- If you need to edit files in a DIFFERENT repo, note the path explicitly in HANDOFF.md.`,
    ``,
    `## State Files (IMPORTANT)`,
    `- **State directory**: \`${stateDir}\``,
    `- Write HANDOFF.md, BLOCKED.md, and PROGRESS.md to the state directory above, NOT to the workspace.`,
    `- HANDOFF_TEMPLATE.md is at: \`${stateDir}/HANDOFF_TEMPLATE.md\``,
    `- This keeps issue state separate from shared code workspaces.`,
    ``,
    `Your current task:`,
    `**${issueKey}: ${issueTitle}**`,
    issueDescription ? `\n${issueDescription}` : '',
    ``,
    `Read your memory index above, then begin working on this task.`,
    `Remember to update your memory files if you learn something important.`,
    ``,
    `**IMPORTANT: Your first action should be to post a progress comment:**`,
    `\`linear-tool comment ${issueKey} "Starting work on ${issueKey}. [your plan here]"\``,
  ].join('\n');
}
