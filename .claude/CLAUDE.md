# AgentOS — Claude Code Configuration

## Build & Run

```bash
npm install && npm run build && npm link
aos setup            # init DB, verify env vars
aos auth --client-id <id> --client-secret <secret>  # OAuth setup
aos serve            # webhook server + monitor loop
```

## Dev

```bash
npx tsx src/cli.ts   # run without building
npx vitest run       # run tests
```

## Architecture

- `src/core/` — Linear API, SQLite DB, tmux, OAuth, persona loader, routing, queue
- `src/commands/` — CLI: agent, spawn, status, jump, kill, watch, serve, auth, setup
- `src/adapters/` — Runner backends: Claude Code (cc)
- `src/serve/` — Webhook server, monitor loop, scheduler tasks
- `docs/` — Architecture, deployment, agent guide
- `scripts/linear-tool.sh` — CLI for agents to interact with Linear
- `hooks/` — Claude Code hooks (progress reporting, memory validation)

## Key Constraints

- All agents run via tmux sessions on the execution host
- OAuth tokens stored in macOS Keychain + fallback files at ~/.aos/
- SQLite state at ~/.aos/state.db — never delete while server is running
- Persona files at ~/.aos/agents/{role}/ (CLAUDE.md + memory/ + config.json)
- tmux sessions named `aos-{role}` (one per agent role)

## Environment Variables

All required env vars use `requireEnv()` — see `.env.example` for the full list.
