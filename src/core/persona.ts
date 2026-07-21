import { readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfig, getIssueStateDir, STATE_DIR } from './config.js';
import { getActiveAttempts } from './db.js';
import { syncMemories, syncSharedMemories, type RetrievedMemory } from './memory-store.js';

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
  return join(STATE_DIR, 'agents');
}

export function listAgents(): string[] {
  if (!existsSync(getAgentsDir())) return [];
  return readdirSync(getAgentsDir(), { withFileTypes: true })
    // Underscore-prefixed dirs are shared assets (e.g. _shared/chat-frontdesk.md), not roles
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
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
  return existsSync(join(getAgentsDir(), role, 'CLAUDE.md'));
}

export function loadAgentConfig(role: string): AgentConfig {
  const configPath = join(getAgentsDir(), role, 'config.json');
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  }
  return { baseModel: 'cc' };
}

/**
 * Return the system OAuth clientId if ~/.aos/oauth.json exists and is readable.
 * Used to detect shared-identity collisions (RYA-599): if an agent's config.json
 * declares the same linearClientId as the system, they are the same Linear OAuth
 * identity and must share one token — Linear's client_credentials grant invalidates
 * prior tokens per clientId, so maintaining two files for one identity ping-pongs.
 */
function getSystemOAuthClientId(): string | null {
  try {
    const oauthJsonPath = join(STATE_DIR, 'oauth.json');
    if (!existsSync(oauthJsonPath)) return null;
    const parsed = JSON.parse(readFileSync(oauthJsonPath, 'utf-8')) as { clientId?: string };
    return parsed.clientId ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns true when the given agent's OAuth clientId equals the system clientId —
 * i.e. they are the same Linear identity and must share one token file.
 */
export function sharesIdentityWithSystem(role: string): boolean {
  const config = loadAgentConfig(role);
  if (!config.linearClientId) return false;
  const systemClientId = getSystemOAuthClientId();
  return !!systemClientId && systemClientId === config.linearClientId;
}

export function getAgentLinearToken(role: string): string | null {
  // Shared-identity collision: read the system token so both callers see one source of truth (RYA-599).
  if (sharesIdentityWithSystem(role)) {
    const systemTokenPath = join(STATE_DIR, '.oauth-token');
    if (existsSync(systemTokenPath)) {
      const token = readFileSync(systemTokenPath, 'utf-8').trim();
      if (token) return token;
    }
    // Fall through to per-agent file only if system token is missing.
  }

  // Check for per-agent OAuth token
  const tokenPath = join(getAgentsDir(), role, '.oauth-token');
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, 'utf-8').trim();
    if (token) return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// A3.2: shared boilerplate template (templates/agent-common.md)
//
// The Linear Tools / Collaboration / Delegation Strategy boilerplate used to
// be copy-pasted into every ~/.aos/agents/{role}/CLAUDE.md (~8KB × 6 roles).
// The canonical copy now lives in templates/agent-common.md and is injected
// ONCE into the stable prefix of the grounding prompt. At persona load time,
// sections of the role CLAUDE.md whose headings exactly match a template
// heading are dropped (conservative: exact heading match only), so personas
// that still carry the boilerplate aren't double-injected.
// ---------------------------------------------------------------------------

/** Marker heading: only personas containing this are considered for dedup. */
export const COMMON_TEMPLATE_MARKER = '## Linear Tools';

let _commonTemplateCache: string | null | undefined;

/** Read templates/agent-common.md (cached). Returns null when missing. */
export function loadCommonTemplate(): string | null {
  if (_commonTemplateCache !== undefined) return _commonTemplateCache;
  try {
    const templatePath = join(dirname(fileURLToPath(import.meta.url)), '../../templates/agent-common.md');
    _commonTemplateCache = existsSync(templatePath) ? readFileSync(templatePath, 'utf-8') : null;
  } catch {
    _commonTemplateCache = null;
  }
  return _commonTemplateCache;
}

/** For tests: reset the template cache. */
export function _resetCommonTemplateCache(): void {
  _commonTemplateCache = undefined;
}

/**
 * Extract level-2/3 markdown headings, ignoring lines inside ``` fences.
 * (Persona files embed example markdown with headings inside code fences —
 * those must not be treated as section boundaries.)
 */
export function extractSectionHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/^#{2,3} \S/.test(line)) headings.push(line.trim());
  }
  return headings;
}

/**
 * Drop sections of a persona CLAUDE.md that duplicate the common template.
 * A section spans from a ##/### heading to the next ##/### heading (#### sub-
 * headings belong to their parent and are dropped with it). Only sections
 * whose heading EXACTLY matches a template heading are removed — role-specific
 * sections (even ones nested in the boilerplate region) are preserved.
 * No-op when the persona lacks the COMMON_TEMPLATE_MARKER heading.
 */
export function stripTemplateSections(
  claudeMd: string,
  template: string,
): { stripped: string; removed: string[] } {
  if (!claudeMd.includes(COMMON_TEMPLATE_MARKER)) return { stripped: claudeMd, removed: [] };
  const templateHeadings = new Set(extractSectionHeadings(template));
  if (templateHeadings.size === 0) return { stripped: claudeMd, removed: [] };

  const out: string[] = [];
  const removed: string[] = [];
  let inFence = false;
  let skipping = false;

  for (const line of claudeMd.split('\n')) {
    const isFenceDelimiter = /^\s*```/.test(line);
    if (!inFence && !isFenceDelimiter && /^#{2,3} \S/.test(line)) {
      const heading = line.trim();
      if (templateHeadings.has(heading)) {
        skipping = true;
        removed.push(heading);
      } else {
        skipping = false;
      }
    }
    if (isFenceDelimiter) inFence = !inFence;
    if (!skipping) out.push(line);
  }

  const stripped = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  return { stripped, removed };
}

export function loadPersona(role: string): AgentPersona {
  const dir = join(getAgentsDir(), role);
  if (!existsSync(dir)) {
    throw new Error(`Agent "${role}" not found at ${dir}`);
  }

  let claudeMd = existsSync(join(dir, 'CLAUDE.md'))
    ? readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')
    : '';

  // A3.2: drop boilerplate sections duplicated by templates/agent-common.md
  // (the template itself is injected once by buildGroundingPrompt).
  const commonTemplate = loadCommonTemplate();
  if (claudeMd && commonTemplate) {
    claudeMd = stripTemplateSections(claudeMd, commonTemplate).stripped;
  }

  const memoryIndex = existsSync(join(dir, 'MEMORY.md'))
    ? readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
    : '';

  // Count memory files (for logging) but don't read full content — DB handles retrieval
  const memoryDir = join(dir, 'memory');
  const memories: { name: string; content: string }[] = [];
  if (existsSync(memoryDir)) {
    for (const file of readdirSync(memoryDir)) {
      if (file.endsWith('.md')) {
        memories.push({ name: file.replace('.md', ''), content: '' }); // content loaded via DB
      }
    }
  }

  // Sync memory files to database for search/retrieval
  try {
    syncMemories(role);
    syncSharedMemories();
  } catch (err: unknown) {
    console.debug(`[persona] memory sync skipped:`, (err as Error).message);
  }

  const config = loadAgentConfig(role);

  return { role, claudeMd, memoryIndex, memories, config };
}

// ---------------------------------------------------------------------------
// A3.0: context-size instrumentation
// ---------------------------------------------------------------------------

/** Per-section character counts for the last grounding prompt built. */
export interface GroundingStats {
  role: string;
  mode: string;
  identity: number;
  claudeMd: number;
  /** Shared boilerplate template (templates/agent-common.md). 0 until injected. */
  common: number;
  /** Static instruction blocks (memory persistence, status intent, etc.). */
  instructions: number;
  /** Core Knowledge (system-memory.md) + memory-system overview blurb. */
  systemMemory: number;
  retrieved: number;
  team: number;
  mailbox: number;
  retros: number;
  total: number;
  timestamp: string;
}

export type GroundingSection =
  | 'identity' | 'claudeMd' | 'common' | 'instructions'
  | 'systemMemory' | 'retrieved' | 'team' | 'mailbox' | 'retros';

let lastGroundingStats: GroundingStats | null = null;

/** Stats for the most recent buildGroundingPrompt call (null before first call). */
export function getLastGroundingStats(): GroundingStats | null {
  return lastGroundingStats;
}

/** Append the stats line to ~/.aos/logs/context-size.jsonl (best-effort). */
function recordGroundingStats(stats: GroundingStats): void {
  lastGroundingStats = stats;
  console.debug(
    `[persona] context-size role=${stats.role} mode=${stats.mode} total=${stats.total} ` +
    `identity=${stats.identity} claudeMd=${stats.claudeMd} common=${stats.common} ` +
    `instructions=${stats.instructions} systemMemory=${stats.systemMemory} retrieved=${stats.retrieved} ` +
    `team=${stats.team} mailbox=${stats.mailbox} retros=${stats.retros}`
  );
  try {
    const logDir = join(STATE_DIR, 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'context-size.jsonl'), JSON.stringify(stats) + '\n', 'utf-8');
  } catch (err: unknown) {
    console.debug('[persona] context-size log write failed:', (err as Error).message);
  }
}

/** Env-tunable char budget (AOS_CTX_* knobs, read at call time). */
function envBudget(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the full system prompt for grounding a session as this agent.
 *
 * Layout (A3.3): stable prefix first (identity → persona CLAUDE.md → common
 * template → static instruction blocks), then volatile per-session sections
 * (system memory, retrieved memories, team activity, mailbox, retros) — so
 * provider prompt caching covers the large static prefix.
 *
 * Budgets (A3.2, chars, env knobs read at call time):
 *   AOS_CTX_SYSTEM_MEMORY_BUDGET (default 8000) — hard truncate with pointer
 *   AOS_CTX_RETRIEVED_BUDGET     (default 12000) — degrade to index when over;
 *     memories matching `issueKey` keep full content
 *   AOS_CTX_RETRO_BUDGET         (default 1500) — total retro excerpt chars
 *
 * @param mode 'task' (default) includes full completion checklist + memory requirements.
 *             'conversation' skips bureaucratic requirements — agent just answers.
 * @param retrievedMemories Contextual long-term memories retrieved from DB for this task.
 * @param issueKey Current issue key — memories naming it stay full-content under budget pressure.
 */
export function buildGroundingPrompt(
  persona: AgentPersona,
  mode: 'task' | 'conversation' = 'task',
  retrievedMemories?: RetrievedMemory[],
  issueKey?: string,
): string {
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
  const parts: string[] = [];
  const counts: Record<GroundingSection, number> = {
    identity: 0, claudeMd: 0, common: 0, instructions: 0,
    systemMemory: 0, retrieved: 0, team: 0, mailbox: 0, retros: 0,
  };
  const push = (section: GroundingSection, text: string): void => {
    parts.push(text);
    counts[section] += text.length;
  };

  // ── STABLE PREFIX (A3.3: cache-friendly — identical across sessions of a
  // role) — identity → persona CLAUDE.md → common template → static
  // instruction blocks. Volatile, per-session content comes after.
  push('identity', identityWarning);
  push('claudeMd', persona.claudeMd);

  // Shared boilerplate (templates/agent-common.md), injected once. Matching
  // sections were stripped from persona.claudeMd at load time (A3.2).
  const commonTemplate = loadCommonTemplate();
  if (commonTemplate) {
    push('common', '\n' + commonTemplate.split('{role}').join(persona.role).trimEnd());
  }

  // Memory persistence instructions — only for task mode
  if (mode === 'task') {
    push('instructions', `\n## Memory Persistence (MANDATORY)

Your memory has TWO layers:
- **System Memory** (\`~/.aos/agents/${persona.role}/system-memory.md\`): Core rules and hard-won wisdom. Always loaded.
- **Long-term Memory** (\`.agent-memory/\` → \`~/.aos/agents/${persona.role}/memory/\`): Project details, issue-specific findings. Retrieved by relevance.

### Writing memories (write to .agent-memory/ as usual):
1. Write/update \`.md\` files in \`.agent-memory/\` (e.g., \`.agent-memory/rya-123-findings.md\`)
2. Update \`.agent-memory-index.md\` with a one-line pointer to each new/updated file
3. Files auto-sync to the database on next session start

### Auto-promoting to System Memory:
To make a memory always-loaded (system layer), use YAML frontmatter:
\`\`\`
---
type: feedback
---
\`\`\`
Memories with \`type: feedback\` or \`layer: system\` in frontmatter are automatically promoted to system-memory.md on next sync. Use this for universal rules, CEO directives, and behavioral patterns — NOT for project-specific details.

### Searching past memories mid-session:
\`linear-tool recall "search query"\` — searches your full memory database and returns relevant results.

### Pre-Completion Checklist (BLOCKING):
- [ ] Posted milestone comments along the way (see Progress Comments below)
- [ ] At least one memory file written or updated in \`.agent-memory/\`
- [ ] \`.agent-memory-index.md\` reflects all files in \`.agent-memory/\`
- [ ] Cross-cutting learnings written to \`~/.aos/shared-memory/\` if applicable
- [ ] **Ran infrastructure evals**: \`cd $(pwd) && npx vitest run src/evals/\` — all must pass; fix regressions before completing
- [ ] Every follow-up is a dispatched or \`[to decide]\` sub-issue, not prose
- [ ] **Before any \`git commit\`**: ran \`git diff --cached --stat\` and verified the staged file count matches your session's scope — parallel-agent collisions get bundled if you skip this (RYA-1042)
- [ ] HANDOFF.md written with \`status_intent\` + 1–3 sentence Summary (Files Changed and Verification are auto-derived from session log + git diff — RYA-902)

**Sessions that write zero memories are considered failures.**`);

    // Status Intent — agents declare what status the issue should transition to
    push('instructions', `\n## Status Intent (HANDOFF.md Front Matter)

When writing HANDOFF.md, include YAML front matter with your status decision:

\`\`\`
---
status_intent: in-review
reason: "Brief explanation"
---
# HANDOFF — ISSUE-KEY
...
\`\`\`

### Values
- **done** — Fully complete, verified. Skip CEO review. Use for trivial tasks (typo, config, test fix).
- **in-review** — Standard completion, needs CEO review. **This is the default.**
- **in-progress** — You dispatched work to another agent or this is partial. Keep issue active.
- **todo** — You hit a blocker requiring human decision. Move back to Todo.
- **no-change** — You only answered a question or did analysis. Don't change the issue status.

### Guidelines
- Default to \`in-review\` if unsure
- Use \`done\` only when you verified the result (tests pass, fix confirmed)
- Use \`in-progress\` when you used \`linear-tool dispatch\` and another agent continues
- Use \`no-change\` for pure Q&A, investigation, or analysis tasks

### Structured Actions (optional, powerful)

Beyond status, you can declare actions the system executes automatically when you complete:

**Dispatch work to other agents:**
\`\`\`yaml
dispatches:
  - role: lead-engineer
    issue: RYA-42
    context: "Implement the design from ARCHITECTURE.md"
  - role: coo
    new_issue:
      title: "Deploy auth changes to staging"
      description: "Verify deployment after implementation"
      priority: 2
      parent: RYA-42
    context: "Deploy after lead-engineer finishes"
\`\`\`

**Auto-dispatch a reviewer when you complete:**
\`\`\`yaml
review_dispatch: cto  # or cpo, lead-engineer, etc.
\`\`\`
When your issue moves to In Review, the system auto-dispatches this agent to review your work. Use this when your issue has a designated cross-reviewer. The system also auto-detects reviewers from the issue description (\`Reviewer: CTO\`).

**Transfer ownership:**
\`\`\`yaml
delegate: lead-engineer
\`\`\`

**Propagate status to parent issue:**
\`\`\`yaml
parent_status: in-review
\`\`\`

### Rules
- All action fields are optional. Missing = no action.
- \`new_issue.parent\` defaults to the current issue if omitted.
- Use \`linear-tool dispatch\` mid-session for urgent handoffs; use front matter actions at completion.
- Dispatch failures don't block your status transition.
- You can dispatch to multiple agents simultaneously.`);

    // Issue relations — agents need to know about and manage blocking relationships
    push('instructions', `\n## Issue Relations

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
    push('instructions', `\n## Progress Comments (MANDATORY)

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
    push('instructions', `\n## Linking Deliverables (IMPORTANT)

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
    push('instructions', `\n## Conversation Mode

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

  // ── VOLATILE SECTIONS (A3.3: change per session — kept after the stable
  // prefix so prompt-cache hits cover the expensive static content above).

  // --- LAYER 1: System Memory (always loaded, budgeted — A3.2) ---
  const systemMemoryBudget = envBudget('AOS_CTX_SYSTEM_MEMORY_BUDGET', 8000);
  const systemMemoryPath = join(getAgentsDir(), persona.role, 'system-memory.md');
  if (existsSync(systemMemoryPath)) {
    let systemMemory = readFileSync(systemMemoryPath, 'utf-8');
    if (systemMemory.trim()) {
      if (systemMemory.length > systemMemoryBudget) {
        systemMemory = systemMemory.slice(0, systemMemoryBudget) +
          `\n…(truncated — read ~/.aos/agents/${persona.role}/system-memory.md for the full content)`;
      }
      push('systemMemory', `\n## Core Knowledge (System Memory)\n\n${systemMemory}`);
    }
  }

  // Brief memory overview (replaces full MEMORY.md dump)
  push('systemMemory', `\n## Memory System\n\nYou have ${persona.memories.length} long-term memories in the database. ` +
    `Relevant memories for your current task are loaded below. ` +
    `To search all memories mid-session: \`linear-tool recall "query"\``);

  // --- LAYER 2: Retrieved Long-term Memories (contextual, budgeted — A3.2) ---
  if (retrievedMemories && retrievedMemories.length > 0) {
    const retrievedBudget = envBudget('AOS_CTX_RETRIEVED_BUDGET', 12000);
    const totalRetrievedChars = retrievedMemories.reduce((s, m) => s + m.content.length, 0);
    push('retrieved', '\n## Retrieved Memories (relevant to current task)\n');

    if (totalRetrievedChars <= retrievedBudget) {
      for (const mem of retrievedMemories) {
        push('retrieved', `### ${mem.name}\n\n${mem.content}`);
      }
    } else {
      // Over budget: degrade to an index. Memories tied to the current issue
      // key keep full content; everything else becomes a one-line pointer.
      const keyLc = (issueKey || '').toLowerCase();
      const matchesIssue = (m: RetrievedMemory): boolean =>
        !!keyLc && (m.name.toLowerCase().includes(keyLc) || (m.source_file || '').toLowerCase().includes(keyLc));

      const indexLines: string[] = [];
      for (const mem of retrievedMemories) {
        if (matchesIssue(mem)) {
          push('retrieved', `### ${mem.name}\n\n${mem.content}`);
        } else {
          const path = mem.source_file
            ? `~/.aos/agents/${persona.role}/memory/${mem.source_file}`
            : mem.name;
          indexLines.push(`- ${mem.name} — ${mem.description || 'no description'} (${path})`);
        }
      }
      if (indexLines.length > 0) {
        push('retrieved',
          `### Additional relevant memories (index — over context budget)\n\n` +
          indexLines.join('\n') +
          `\n\nThese memories were retrieved as relevant but exceed the context budget. ` +
          `Read them on demand with the Read tool at the paths above, or search with \`linear-tool recall "query"\`.`);
      }
    }
  }

  // Team status awareness — what other agents are doing right now
  try {
    const active = getActiveAttempts();
    if (active.length > 0) {
      const others = active.filter((a) => a.agent_type !== persona.role);
      if (others.length > 0) {
        push('team', '\n## Team Activity (right now)\n');
        for (const a of others) {
          push('team', `- **${a.agent_type}** is working on ${a.issue_key}`);
        }
      }
    }
  } catch (err: unknown) {
    console.debug(`[persona] team status lookup failed:`, (err as Error).message);
  }

  // Unread mailbox messages
  const mailboxDir = join(getConfig().stateDir, 'mailbox', persona.role, 'inbox');
  if (existsSync(mailboxDir)) {
    const messages = readdirSync(mailboxDir).filter(f => f.endsWith('.json'));
    if (messages.length > 0) {
      push('mailbox', `\n## Unread Messages (${messages.length})\n`);
      for (const file of messages.slice(0, 3)) {
        try {
          const msg = JSON.parse(readFileSync(join(mailboxDir, file), 'utf-8'));
          push('mailbox', `- **From ${msg.from}** (${msg.type}): ${(msg.content || '').substring(0, 200)}`);
        } catch (err: unknown) {
          console.debug(`[persona] failed to parse mailbox message ${file}:`, (err as Error).message);
        }
      }
    }
  }

  // Recent retrospectives (last 3, budgeted — A3.2)
  const retroDir = join(getAgentsDir(), persona.role, 'retrospectives');
  if (existsSync(retroDir)) {
    const retroBudget = envBudget('AOS_CTX_RETRO_BUDGET', 1500);
    const retroFiles = readdirSync(retroDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3);

    if (retroFiles.length > 0) {
      push('retros', '\n## Recent Retrospectives\n');
      let retroUsed = 0;
      for (const file of retroFiles) {
        const remaining = retroBudget - retroUsed;
        if (remaining <= 0) break;
        const content = readFileSync(join(retroDir, file), 'utf-8');
        const excerpt = content.substring(0, Math.min(500, remaining));
        if (!excerpt) continue;
        push('retros', excerpt);
        retroUsed += excerpt.length;
      }
    }
  }

  const result = parts.join('\n\n');
  recordGroundingStats({
    role: persona.role,
    mode,
    ...counts,
    total: result.length,
    timestamp: new Date().toISOString(),
  });
  return result;
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
  workspacePath?: string,
  issueStatus?: string,
  enrichedSpec?: string,
  teamContext?: string,
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
    teamContext || '',
    `Your current task:`,
    `**${issueKey}: ${issueTitle}**`,
    issueStatus ? `**Current status**: ${issueStatus}` : '',
    issueDescription ? `\n${issueDescription}` : '',
    enrichedSpec || '',
    ``,
    `Read your memory index above, then begin working on this task.`,
    `Remember to update your memory files if you learn something important.`,
    ``,
    `**IMPORTANT: Your first action should be to post a progress comment:**`,
    `\`linear-tool comment ${issueKey} "Starting work on ${issueKey}. [your plan here]"\``,
  ].join('\n');
}
