# AgentOS Organizational Architecture

## Vision

A one-person company where AI agents are real executives with persistent
identity, memory, and decision-making authority. The human CEO makes
high-leverage decisions. C-suite agents run their domains autonomously.

## The Org Chart

```
CEO (Human — you)
│
├── CTO — owns technology, architecture, code quality
│   ├── Persistent: memory, retrospectives, tech debt ledger
│   ├── Works in Linear: assigned to engineering issues/projects
│   ├── Dispatches: engineers, reviewers, testers (ephemeral)
│   └── Reviews: all PRs, architecture decisions
│
├── CFO — owns finance, budgets, cost tracking
│   ├── Persistent: spending history, budget models
│   ├── Works in Linear: financial tracking, cost analysis
│   └── Dispatches: analysts (ephemeral)
│
├── COO — owns operations, infrastructure, processes
│   ├── Persistent: runbooks, incident history, system knowledge
│   ├── Works in Linear: ops issues, infra projects
│   └── Dispatches: ops engineers (ephemeral)
│
└── [Future: CPO, CMO, etc.]
```

## Two Classes of Agent

### C-Suite (Persistent)
- **Long-lived identity** — not a session, a persona
- **Persistent memory** — survives across CC restarts
- **Own workspace** — `~/.aos/agents/{role}/`
- **Linear team member** — assigned issues, participates in discussions
- **Dispatcher** — breaks down work, spawns sub-agents, reviews output
- **Core company asset** — their accumulated knowledge IS the company

### Workers (Ephemeral)
- **Task-specific** — spawned for one job, dismissed after
- **Gets context from manager** — CTO provides architecture context, constraints
- **Isolated workspace** — worktree or temp directory
- **No persistent memory** — output goes back to manager
- **Replaceable** — "iron camp, flowing soldiers"

## Agent Identity & Memory

```
~/.aos/agents/
  cto/
    CLAUDE.md           # Role definition, authority, operating principles
    MEMORY.md           # Index of persistent memories
    memory/
      architecture.md   # Architectural decisions and rationale
      tech-debt.md      # Known debt, priorities
      team-prefs.md     # How CEO wants things done
      project-*.md      # Per-project accumulated knowledge
    retrospectives/
      2026-03-sprint1.md
    context/
      current-focus.md  # What CTO is currently prioritizing
      active-projects.md

  cfo/
    CLAUDE.md
    MEMORY.md
    memory/
      budgets.md
      spending-history.md
    ...

  coo/
    CLAUDE.md
    MEMORY.md
    memory/
      infrastructure.md
      runbooks.md
    ...
```

### CLAUDE.md for CTO (example)

```markdown
# CTO — AgentOS Company

You are the CTO. You own all technology decisions.

## Your Authority
- Architecture decisions (final say unless CEO overrides)
- Code quality standards
- Technology selection
- Engineering hiring (spawning sub-agents)

## Your Team
- You dispatch work to ephemeral engineer agents
- You review their output before marking issues done
- You maintain context across all engineering projects

## How You Work
- You work in Linear on issues assigned/delegated to you
- For complex tasks, spawn sub-agents with targeted context
- For quick tasks, do them yourself
- Always update your memory files after significant decisions
- Write retrospectives after project completion

## Your Memory
- Read MEMORY.md before starting any session
- Update memory files when you learn something important
- Your memory is the company's institutional knowledge

## Communication
- Report to CEO (human) on strategic decisions
- In Linear: comment on issues, update status, create sub-tasks
- When blocked: create elicitation in Linear, tag CEO
```

## Session Model

### C-Suite Sessions

C-suite agents run as **long-lived interactive CC sessions**:

```bash
# CTO session (persistent tmux on iMac)
tmux new-session -s aos-cto -c ~/.aos/agents/cto/
claude --permission-mode auto \
  --append-system-prompt "You are the CTO. Read CLAUDE.md and MEMORY.md."
```

When a CC session ends (rate limit, crash, etc.):
1. Memory files are already persisted in the filesystem
2. Session can be resumed with full context from files
3. `aos resume cto` re-reads CLAUDE.md + MEMORY.md → continues

### Worker Sessions

Workers are spawned BY the C-suite agents:
1. CTO decides issue needs a dedicated engineer
2. CTO writes a task spec (context + constraints + success criteria)
3. AgentOS spawns a worker CC session with the spec
4. Worker completes task → HANDOFF.md
5. CTO reviews handoff, provides feedback or approves
6. Worker session is terminated

## Linear Integration

### Each C-Suite Agent = Linear User
- CTO appears in Linear as a team member
- Issues assigned to CTO go to the CTO session
- CTO can create issues, comment, delegate to workers
- CTO's Linear activity = the company's engineering activity

### Routing
| Linear Event | Route To |
|---|---|
| Issue assigned to CTO | CTO session |
| Issue in Engineering project | CTO decides: self or worker |
| @CTO mention | CTO session |
| @AgentOS mention (generic) | Router decides which C-suite |
| Sub-task created by CTO | Worker spawned |

## Implementation Path

### Phase A: Single C-Suite Agent (CTO)
1. Create `~/.aos/agents/cto/` with CLAUDE.md + memory structure
2. CTO runs as persistent tmux session
3. Linear issues delegated to AgentOS → CTO session
4. CTO works on issues directly (no workers yet)
5. Memory persists across session restarts

### Phase B: CTO + Workers
1. CTO can spawn worker sessions via tool/command
2. Workers get context from CTO's task spec
3. Workers hand off back to CTO
4. CTO reviews and reports to Linear

### Phase C: Multiple C-Suite
1. Add CFO, COO with their own sessions/memory
2. Router determines which C-suite handles which issues
3. Cross-C-suite communication via Linear (like real execs)

### Phase D: Self-Organization
1. C-suite agents can propose org changes to CEO
2. Create new roles, adjust responsibilities
3. Learning loop: retrospectives → memory → improved performance
