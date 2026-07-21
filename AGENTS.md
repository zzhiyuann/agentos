# AgentOS

AI company operating system — Linear-native agent orchestration with persistent identities.

## Build & Run

```bash
npm install && npm run build && npm link
aos setup            # init DB, verify Linear API key
aos auth --client-id <id> --client-secret <secret>  # OAuth
aos serve            # webhook server + monitor
```

## Dev

```bash
npx tsx src/cli.ts   # run without building
```

## Architecture

- `src/core/` — Linear API, SQLite DB, SSH+tmux, OAuth, persona loader, routing, budget
- `src/commands/` — CLI: agent, spawn, status, jump, kill, watch, serve, auth, setup
- `src/adapters/` — Runner backends: Claude Code, Codex
- `docs/` — Architecture, deployment, agent guide, session history
- `url-scheme/` — macOS URL scheme handler (agentos://)
- `hooks/` — Codex Stop hook for iMac
- `raycast/` — Raycast Quicklink scripts

## Key Constraints

- OAuth tokens in macOS Keychain + fallback files at ~/.aos/
- Agent sessions run on iMac ($AOS_HOST) via SSH + tmux
- SQLite state at ~/.aos/state.db — **never delete while server is running**
- Persona files at ~/.aos/agents/{role}/
- tmux sessions named `aos-{role}` (agents) or `aos-{issue-key}-{n}` (tasks)

## Agent Roster

| Role | Model | Owns |
|------|-------|------|
| CTO | cc | Architecture, code quality |
| CPO | cc | Product, features |
| COO | cc | Ops, infra |
| Lead Engineer | codex | Implementation |
| Research Lead | cc | Research, content |

## Common Operations

```bash
aos agent list                    # roster + status
aos agent start cto RYA-42       # start agent on issue
aos agent stop cto                # graceful stop
aos agent talk cto "message"      # send message
aos agent memory cto              # view memories
aos status --all                  # all attempts
```

## Agent Delegation Architecture

Agents have three delegation levels:

1. **Subagents** (Agent tool) — quick research/exploration within a session
2. **Agent Teams** (experimental) — multi-agent parallel collaboration within a session. Team lead coordinates 3-5 teammates with shared task list and direct messaging.
3. **AgentOS Dispatch** — cross-agent delegation via Linear issues (`linear-tool dispatch/handoff/ask`)

Agent Teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the agent's environment.
