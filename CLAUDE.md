# AgentOS

AI company operating system — Linear-native agent orchestration with persistent identities.

## Build & Run

```bash
npm install && npm run build && npm link
aos setup            # init DB, verify Linear API key
aos auth --client-id <id> --client-secret <secret>  # OAuth
aos serve            # webhook server + monitor loop
```

## Dev

```bash
npx tsx src/cli.ts   # run without building
npx vitest run       # run tests (225 tests)
```

## Architecture

- `src/core/` — Linear API, SQLite DB, tmux, OAuth, persona loader, routing, queue, memory-validation
- `src/commands/` — CLI: agent, spawn, status, jump, kill, watch, serve, auth, setup
- `src/adapters/` — Runner backends: Claude Code (cc)
- `src/core/discord.ts` — Discord webhook with content dedup + truncation
- `src/core/queue.ts` — Priority queue with per-role dedup, delay, and cooldown
- `docs/` — Architecture, deployment, agent guide
- `scripts/linear-tool.sh` — CLI for agents to interact with Linear (comment, dispatch, search, update-title, reply)
- `hooks/` — Claude Code hooks (Stop hook, memory validation)

## Key Constraints

- All agents run locally via tmux (no SSH — direct local execution)
- OAuth tokens in macOS Keychain + fallback files at ~/.aos/
- SQLite state at ~/.aos/state.db — **never delete while server is running**
- Persona files at ~/.aos/agents/{role}/ (CLAUDE.md + memory/ + config.json)
- tmux sessions named `aos-{role}` (one per agent role)
- **No external publishing** — all work stays local, CEO reviews before push

## Agent Roster

| Role | Model | Owns |
|------|-------|------|
| CTO | cc | Architecture, code quality, technical direction |
| CPO | cc | Product strategy, features, UX |
| COO | cc | Ops, infra, proactive monitoring, triage |
| Lead Engineer | cc | Implementation, debugging, refactoring |
| Research Lead | cc | Research, papers, technical exploration |

## Event System (serve.ts)

Webhook events are classified into 3 tiers:

| Tier | Events | Action |
|------|--------|--------|
| **SPAWN** | AgentSession (formal delegation), explicit dispatch, agent label on issue | Create tmux session, start agent |
| **PIPE** | @mention comment on issue with running agent | Send message to existing session |
| **LOG** | Status changes, label changes, all other events | Log only, no spawn |

## Monitor Loop (every 15s)

1. `monitorSessions` — detect HANDOFF.md, quality gate, completion notification
2. `drainQueue` — process queued dispatches
3. `autoDispatchFromBacklog` — idle agent + assigned Todo issue → spawn (only for issues with assignee)
4. `heartbeatAssignUnowned` (every 5 min) — find unassigned Todo issues → wake COO to triage
5. Trust prompt detection — auto-approve for sessions < 120s old

## Work Lifecycle

```
Issue created → auto-assign (routing) or COO triage (heartbeat)
    → queue (priority) → spawn when agent idle
    → agent works → HANDOFF.md → quality gate → Done
    → auto-dispatch next queued issue
```

## Agent Communication

Agents communicate via Linear comments (NOT AgentSession activities):
- `linear-tool comment <key> "message"` — post comment
- `linear-tool reply <key> <comment-id> "reply"` — threaded reply
- `linear-tool update-title <key> "[Solved] title"` — status in title
- `linear-tool dispatch <role> <key> "context"` — assign work to another agent
- `linear-tool search "query"` — find issues

## Quality Gates

When HANDOFF.md is detected:
1. Memory check — did agent write to .agent-memory/?
2. Verification check — does HANDOFF mention testing/verification?
3. Audit check — for research/audit issues, were follow-up issues created?
4. Discord notification — post completion summary with HANDOFF excerpt

## Common Operations

```bash
aos agent list                    # roster + status
aos agent start cto ENG-42       # start agent on issue
aos agent stop cto                # graceful stop
aos agent talk cto "message"      # send message
aos agent memory cto              # view memories
aos status --all                  # all attempts
aos serve                         # webhook server + monitor
```
