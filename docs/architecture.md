# AgentOS Architecture

> A deep dive into how AgentOS turns Linear into a control plane for AI agents.

## Design Principles

1. **Linear is the control plane** — intent, ownership, review. Don't rebuild project management.
2. **AgentOS is the execution plane** — who runs, where, how to stop/resume/handoff.
3. **Memory > sessions** — sessions are ephemeral, grounded with persona + memories each time.
4. **Agents are team members, not tools** — each has identity, authority, and accumulated knowledge.
5. **Model-flexible** — each agent can run on Claude Code or Codex, swappable at any time.

---

## System Overview

```mermaid
graph TB
    subgraph Control["Linear — Control Plane"]
        direction TB
        I[Issues & Projects]
        S[Agent Sessions]
        A[Activities & Plans]
        D[Documents]
    end

    subgraph Orchestration["AgentOS — Orchestration Layer"]
        direction TB
        WH["Webhook Server<br/>:3848 via cloudflared"]
        RE["Routing Engine<br/>routing.json"]
        PQ["Priority Queue<br/>configurable per-agent"]
        BG["Budget Gates<br/>per-agent, per-task, daily"]
        PL["Persona Loader<br/>CLAUDE.md + memory/*"]
        SM["Session Monitor<br/>15s artifact polling"]
        DB[("SQLite<br/>attempts + events")]
    end

    subgraph Runtime["Execution Plane — local or remote via SSH"]
        direction TB
        T1["tmux: aos-architect"]
        T2["tmux: aos-engineer"]
        T3["tmux: aos-researcher"]
        TN["tmux: aos-{issue}-{n}"]
        W1["Workspace<br/>HANDOFF.md · BLOCKED.md"]
    end

    subgraph Adapters["Runner Adapters"]
        CC["Claude Code<br/>claude --permission-mode auto"]
        CX["Codex<br/>isolated OAuth token pool"]
    end

    I -->|"webhook: created/prompted"| WH
    WH --> RE
    RE --> PQ
    PQ --> BG
    BG --> PL
    PL --> Adapters
    CC -->|SSH + tmux| T1 & T2 & TN
    CX -->|SSH + tmux| T3
    T1 & T2 & T3 & TN --> W1
    SM -->|"poll HANDOFF.md"| W1
    SM -->|"emit activity"| A
    A --> S
    RE --> DB
    SM --> DB
```

---

## Session Lifecycle

The core loop of AgentOS: from Linear issue to completed work with persistent memory.

```mermaid
sequenceDiagram
    participant L as Linear
    participant W as Webhook Server
    participant R as Router / Queue
    participant P as Persona Loader
    participant A as Adapter (CC/Codex)
    participant T as tmux Session
    participant M as Session Monitor

    L->>W: AgentSessionEvent:created
    activate W
    W->>W: Emit thought activity (within 10s)
    W->>R: Route to agent role
    R->>R: Check budget & queue priority
    R->>P: Load persona + memories
    P->>A: Spawn with grounding
    A->>T: SSH → create tmux session
    deactivate W

    loop Every 15 seconds
        M->>T: Check for artifacts
        alt HANDOFF.md found
            M->>L: Emit response activity
            M->>L: Close agent session
            M->>M: Mark attempt completed
        else BLOCKED.md found
            M->>L: Emit elicitation
        else tmux dead + no artifacts
            M->>L: Emit error activity
        end
    end

    Note over T: Agent writes memory files<br/>to ~/.aos/agents/{role}/memory/
    Note over T: Memory survives session death
```

---

## Death & Resurrection Pattern

The defining architectural pattern of AgentOS. Sessions are disposable; memory is permanent.

```mermaid
graph LR
    subgraph Session1["Session 1 (ephemeral)"]
        S1["Spawns with<br/>persona + memory"]
        W1["Works on task"]
        M1["Writes memory/<br/>decisions.md"]
        H1["Writes HANDOFF.md"]
        D1["Session dies ☠️"]
    end

    subgraph Memory["Persistent Memory Layer"]
        PM["~/.aos/agents/{role}/memory/"]
        P1["architecture.md"]
        P2["decisions.md"]
        P3["ceo-preferences.md"]
        PN["...accumulated<br/>across all sessions"]
    end

    subgraph Session2["Session 2 (ephemeral)"]
        S2["Spawns with<br/>persona + ALL memory"]
        W2["Has full institutional<br/>knowledge"]
    end

    S1 --> W1 --> M1 --> H1 --> D1
    M1 -.->|persists| PM
    PM --> P1 & P2 & P3 & PN
    P1 & P2 & P3 & PN -.->|compiled into| S2
    S2 --> W2

    style D1 fill:#ff6b6b,color:#fff
    style PM fill:#51cf66,color:#fff
    style S2 fill:#339af0,color:#fff
```

**Why this matters:**
- No context window limits — memory is compiled fresh, not accumulated in a growing conversation
- No state corruption — each session starts clean
- Graceful failure — if a session crashes, institutional knowledge is intact
- Scalable knowledge — agents get smarter over time without getting slower

---

## Agent Delegation Flow

Agents collaborate through Linear, not direct process communication.

```mermaid
sequenceDiagram
    participant You as You (Human)
    participant Arch as Architect Agent
    participant Eng as Engineer
    participant QA as QA Agent

    You->>Arch: Create issue: "Refactor auth module"
    activate Arch
    Arch->>Arch: Analyze architecture
    Arch->>Arch: Write technical spec
    Arch->>Eng: dispatch: "Implement per spec"
    activate Eng
    Arch->>QA: ask: "Any test coverage gaps?"
    activate QA
    QA-->>Arch: "Yes — session token refresh path untested"
    deactivate QA
    Arch->>Arch: Update spec with test notes
    Eng->>Eng: Implement changes
    Eng->>Eng: Write tests
    Eng->>Arch: handoff: "Implementation complete"
    deactivate Eng
    Arch->>Arch: Review + verify
    Arch->>You: HANDOFF.md: "Auth refactored, 42 tests pass"
    deactivate Arch
```

**Three delegation modes:**

| Mode | When to use | What happens |
|------|------------|--------------|
| **dispatch** | Start another agent on work | Target agent spawns on the issue immediately |
| **handoff** | You're done, they continue | Target picks up your workspace + HANDOFF.md |
| **ask** | Need input, don't block | Async question — they respond when available |

---

## Data Model

### SQLite Schema

```sql
-- Core state tracking
CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,           -- Linear issue UUID
    issue_key TEXT NOT NULL,          -- e.g., "ENG-42"
    agent_session_id TEXT,            -- Linear AgentSession UUID
    agent_type TEXT NOT NULL,         -- cto, cpo, lead-engineer, etc.
    runner_session_id TEXT,           -- CC session / Codex thread ID
    tmux_session TEXT,                -- tmux handle for jump/kill
    attempt_number INTEGER,
    status TEXT DEFAULT 'pending',    -- pending → running → completed/failed/blocked
    host TEXT NOT NULL,
    workspace_path TEXT,
    budget_usd REAL,
    cost_usd REAL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT,
    completed_at TEXT,
    error_log TEXT
);

-- Event audit trail
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id TEXT REFERENCES attempts(id),
    event_type TEXT NOT NULL,
    payload TEXT,                     -- JSON
    created_at TEXT DEFAULT (datetime('now'))
);
```

### Agent Identity Model

```
~/.aos/agents/{role}/
├── CLAUDE.md              # Persona: role, authority, communication standards
├── MEMORY.md              # Index of all memory files
├── config.json            # { baseModel: "cc", linearClientId: "..." }
├── .oauth-token           # Linear OAuth bearer token
└── memory/
    ├── architecture.md    # Technical decisions + rationale
    ├── preferences.md    # How the team likes to work
    ├── tech-debt.md       # Known issues, priorities
    └── ...                # Grows across sessions
```

---

## Linear Integration

### Webhook Events

```mermaid
graph TD
    WH["Incoming Webhook"]

    WH -->|"AgentSessionEvent:created"| C1["SPAWN<br/>Route to agent, spawn session"]
    WH -->|"AgentSessionEvent:prompted<br/>(session alive)"| C2["PIPE<br/>Send message to running agent"]
    WH -->|"AgentSessionEvent:prompted<br/>(session dead)"| C3["SPAWN<br/>New attempt with context"]
    WH -->|"AgentSessionEvent:prompted<br/>(signal=stop)"| C4["KILL<br/>Terminate session"]
    WH -->|"Other events"| C5["LOG<br/>Record for audit"]

    style C1 fill:#339af0,color:#fff
    style C2 fill:#51cf66,color:#fff
    style C3 fill:#339af0,color:#fff
    style C4 fill:#ff6b6b,color:#fff
    style C5 fill:#868e96,color:#fff
```

### Agent Platform APIs Used

| API | Purpose |
|-----|---------|
| `agentSessionCreateOnIssue` | Create session for proactive work |
| `agentActivityCreate (thought)` | Status updates, reasoning |
| `agentActivityCreate (response)` | Completion with results |
| `agentActivityCreate (error)` | Failure reporting |
| `agentActivityCreate (elicitation)` | Ask human for input |
| `agentSessionUpdate (plan)` | Step-by-step progress tracking |
| `documentCreate` | Attach handoff documents to issues |

---

## Adapter System

Both Claude Code and Codex implement a unified interface:

```typescript
interface RunnerAdapter {
  spawn(opts: SpawnOptions): Promise<SpawnResult>;
  resume?(sessionId: string): Promise<void>;
  fork?(sessionId: string): Promise<SpawnResult>;
  isAlive(sessionId: string): boolean;
  kill(sessionId: string): void;
  captureOutput(sessionId: string, lines?: number): string;
}
```

**Claude Code Adapter:**
- Spawns tmux sessions named `aos-{role}` or `aos-{issueKey}-{n}`
- Writes persona to workspace `.claude/CLAUDE.md`
- Pre-trusts workspace via `settings.local.json`
- Runs `claude --permission-mode auto` in tmux

**Codex Adapter:**
- Isolated HOME directories per role (`~/.codex-agents/{role}/`)
- Prevents concurrent OAuth token refresh race conditions
- Falls back through role-specific home → worker pool

---

## Routing Engine

Issues flow through a configurable rule set:

```json
{
  "rules": [
    { "label": "agent:architect",  "agent": "architect" },
    { "label": "agent:engineer",  "agent": "engineer" },
    { "project": "Feature Roadmap", "agent": "engineer" },
    { "default": true, "agent": "engineer" }
  ]
}
```

Rules are evaluated top-to-bottom. First match wins. Labels take priority over project rules. Default catches unmatched issues.

---

## Infrastructure

AgentOS supports both single-machine and split-machine deployments.

### Single Machine (simplest)

```
┌────────────────────────────────┐
│   Your Machine                  │
│                                 │
│  AgentOS server (:3848)         │
│  SQLite state (~/.aos/state.db) │
│  cloudflared tunnel             │
│  tmux sessions (local)          │
│  Agent workspaces               │
│  Claude Code / Codex            │
└────────────────────────────────┘
         ▲
         │ webhook
┌────────┴──────────┐
│  Linear Cloud      │
│  (control plane)   │
└───────────────────┘
```

### Split Machine (remote execution)

```
┌─────────────────────┐        ┌──────────────────────┐
│  Control Machine     │        │  Execution Host       │
│                      │  SSH   │                       │
│  AgentOS server      │───────▶│  tmux sessions        │
│  SQLite state        │        │  Agent workspaces     │
│  cloudflared tunnel  │        │  Claude Code / Codex  │
│  Agent personas      │        │                       │
└─────────────────────┘        └──────────────────────┘
         ▲                              │
         │ webhook                      │ (artifacts)
         │                              │
┌────────┴──────────┐                   │
│  Linear Cloud      │◀────────────────┘
│  (control plane)   │   API (activities, sessions)
└───────────────────┘
```

**Network:** Any SSH-accessible network between control and execution hosts. Cloudflare tunnel exposes webhook server to Linear.

---

## Future Roadmap

- **MCP integration** — tool interoperability across agents
- **Additional adapters** — Gemini, local models
- **Smarter memory** — pruning, summarization, semantic retrieval
- **Multi-tenant** — support for teams beyond solo founder
- **A2A protocol** — agent-to-agent interop with external systems
