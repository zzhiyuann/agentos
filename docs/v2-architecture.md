# AgentOS v2 Architecture

## Vision

**AgentOS is the runtime supervisor for autonomous AI agents who are real team members.**

Unlike traditional tools where humans own all responsibility, AgentOS enables a structure where:
- AI agents operate as independent executives (CTO, Lead Engineer, etc.)
- Each agent owns their domain and outcomes
- The human is the CEO making high-leverage decisions
- Agents delegate to other agents, creating org hierarchy

**Linear = control plane** (intent, ownership, review)
**AgentOS = execution plane + orchestration kernel** (who runs, where, how to stop/resume/handoff)

## Core Model

### Entity Hierarchy

```
Issue (Linear)
  = Intent + ownership + review
  └── ExecutionAttempt (AgentOS DB)
        = One attempt by one agent to complete the issue
        ├── AgentSession (Linear native)
        │     = User-visible session with activities, plan, status
        ├── RunnerSession (agent-specific)
        │     = CC session ID / Codex thread ID / tmux handle
        └── Artifacts
              = PR, diff, handoff doc, test results, cost summary
```

### Key Principle: One Issue → Many Attempts

An issue may go through multiple execution attempts:
- First CC attempt fails → blocked → human reviews → second attempt
- CC writes code → Codex reviews → separate sessions, same issue
- Agent forks approach → parallel attempts

### Agent Identity

Each agent type gets its own identity in Linear via OAuth:
- **AgentOS** (orchestrator) — routes, monitors, reports
- Future: individual agent apps per role (CTO-agent, QA-agent, etc.)

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Linear (Control Plane)          │
│  Issues · Delegation · Sessions · Activities     │
│  Plans · Documents · Views · Insights            │
└──────────────┬───────────────────┬───────────────┘
               │ AgentSessionEvent │ GraphQL API
               │ (future webhook)  │ (current: polling)
┌──────────────▼───────────────────▼───────────────┐
│              AgentOS (Execution Plane)            │
│                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ Orchestrator │  │ Gate/Budget  │  │ Router   │ │
│  │ (poll/wh)    │  │ Manager      │  │          │ │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘ │
│         │                 │               │       │
│  ┌──────▼─────────────────▼───────────────▼─────┐ │
│  │           Attempt Manager (SQLite)            │ │
│  └──────┬──────────────┬──────────────┬──────────┘ │
│         │              │              │           │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼────────┐  │
│  │ CC Adapter  │ │Codex Adapter│ │Generic Adapter│ │
│  │ tmux+claude │ │SDK/app-srv │ │  (future)    │  │
│  └─────────────┘ └────────────┘ └──────────────┘  │
└───────────────────────────────────────────────────┘
```

## Data Model

### ExecutionAttempt (SQLite: ~/.aos/state.db)

```sql
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,          -- Linear issue UUID
  issue_key TEXT NOT NULL,         -- e.g., "RYA-42"
  agent_session_id TEXT,           -- Linear AgentSession UUID
  agent_type TEXT NOT NULL,        -- cc | codex | gemini
  runner_session_id TEXT,          -- CC session / Codex thread ID
  tmux_session TEXT,               -- tmux handle (for CC)
  attempt_number INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',   -- pending|running|completed|failed|blocked
  host TEXT NOT NULL,
  workspace_path TEXT,
  budget_usd REAL,                 -- max allowed spend
  cost_usd REAL DEFAULT 0,        -- actual spent
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  error_log TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Linear Integration (via OAuth Agent App)

### What AgentOS uses from Linear's Agent Platform:

| Linear Feature | AgentOS Usage |
|----------------|---------------|
| AgentSession | Created per execution attempt, tracks lifecycle |
| AgentActivity (thought) | Agent reasoning, status updates |
| AgentActivity (action) | Tool invocations, file changes |
| AgentActivity (response) | Final output, summary |
| AgentActivity (error) | Failure reporting |
| AgentActivity (elicitation) | Ask human for input |
| Agent Plan | Step-by-step progress checklist |
| Issue Document | Handoff document (for humans) |
| External Links | One-click terminal access (agentos://) |
| Delegation | Issue → agent assignment |

### What AgentOS does NOT do in Linear:
- Comment spam (replaced by structured activities)
- Label-based routing (replaced by delegation)
- Custom fields (operational data in local DB)

## Runner Adapters

### Claude Code Adapter

```
Spawn:
  claude --permission-mode auto \
    --append-system-prompt "{context}" \
    --name "aos-{issue-key}-{attempt}" \
    "Begin working on the task."

Resume:
  claude --resume "{session-id}"

Events (via CC hooks):
  PreToolUse  → AgentActivity(action)
  PostToolUse → AgentActivity(action) with result
  Stop        → AgentActivity(response) + plan update

Workspace:
  ~/agent-workspaces/{issue-key}/ on iMac
  HANDOFF.md → Linear Issue Document
```

### Codex Adapter

```
Spawn:
  codex exec --json --full-auto "{prompt}"
  OR via SDK: codex.startThread() → thread.run()

Resume:
  codex resume "{thread-id}"

Fork:
  codex fork "{thread-id}" "{new-prompt}"

Events (via JSONL stream / app-server):
  item.started  → AgentActivity(action)
  item.completed → AgentActivity(action) with result
  turn.completed → AgentActivity(response) + cost update

Workspace:
  Codex worktree (managed by Codex)
```

## Budget & Gate System

### Ready-to-Run Gate

Before spawning, verify:
1. **Repo identified** — workspace path or repo URL known
2. **Success criteria** — issue description has clear objective
3. **Budget available** — not exceeding per-issue or daily limit
4. **No active attempt** — avoid duplicate work
5. **Concurrency** — within max parallel agents

### Budget Controls

```typescript
interface BudgetConfig {
  maxPerAttempt: number;     // e.g., $5.00
  maxPerDay: number;         // e.g., $50.00
  maxConcurrent: number;     // e.g., 4 total
  warnThreshold: number;     // e.g., 0.8 (80%)
}
```

## CLI Commands (v2)

| Command | Description |
|---------|-------------|
| `aos auth` | OAuth flow — authorize AgentOS in Linear |
| `aos setup` | Verify auth, init DB, configure |
| `aos spawn <issue>` | Create attempt → AgentSession → runner |
| `aos batch <issues...>` | Spawn multiple |
| `aos status` | Active attempts + health |
| `aos jump <issue>` | Ghostty → tmux/Codex |
| `aos kill <issue>` | Stop attempt, emit response activity |
| `aos resume <issue>` | Resume last attempt or create new one |
| `aos fork <issue>` | Fork current attempt (new approach) |
| `aos watch` | Poll for delegated issues, auto-spawn |
| `aos logs [issue]` | Event history |
| `aos budget` | Show spending dashboard |

## Handoff Model (Two Layers)

### Agent Layer (HANDOFF.md in repo)
- For the next agent or resume session
- Technical: files changed, approach taken, blockers hit
- Generated by the agent on completion

### Human Layer (Linear Issue Document)
- For the human owner/reviewer
- Summary, testing instructions, known issues
- Created via `documentCreate` mutation on the issue
- Links to PR if applicable

## Migration from v1

1. Keep existing CLI commands working
2. Add `aos auth` for OAuth setup
3. Refactor `spawn` to create AgentSession + emit activities
4. Replace comment-based reporting with activities
5. Add `resume` and `fork` commands
6. Update `watch` to poll for delegations
7. Add budget gate

## Future: Webhook-Driven

When productizing:
1. Set webhook URL in OAuth app settings
2. Receive `AgentSessionEvent` (created/prompted)
3. Acknowledge within 5s, emit thought within 10s
4. Replace polling with event-driven flow
5. Handle stop signals from users
