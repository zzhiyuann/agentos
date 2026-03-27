# AgentOS Development Session History

## Session: 2026-03-23 (Initial Build)

### Duration
~4 hours, single session from concept to working system.

### What Was Built

#### Phase 0: Foundation
- Project scaffolded: TypeScript, @linear/sdk, commander, better-sqlite3
- Linear API key stored in macOS Keychain
- Agent labels created: `agent:cc`, `agent:codex`, `agent:blocked`, `agent:done`
- SQLite state DB at `~/.aos/state.db`

#### Phase 1: CLI MVP (v1)
- `aos spawn` — fetch Linear issue → create workspace on iMac → launch CC in tmux → post comment → move to In Progress
- `aos status` — table of active sessions with health checks
- `aos jump` — open Ghostty terminal attached to tmux session
- `aos kill` — terminate session, update Linear
- `aos watch` — poll for agent:cc labeled issues, auto-spawn
- First successful E2E: create issue → spawn → CC works → kill → Linear updated

#### Phase 2: Execution Plane (v2)
Prompted by GPT's feedback that we were rebuilding what Linear already does.

**Key architectural shift**: Linear = control plane, AgentOS = execution plane.

- OAuth agent identity: "AgentOS" as a real Linear team member
- `client_credentials` grant (no browser redirect needed)
- AgentSession + AgentActivity APIs (structured events, not comment spam)
- Execution attempt model: 1 issue → many attempts
- Runner adapters: abstract CC and Codex behind unified interface
- `aos auth`, `aos resume`, `aos serve` commands
- Webhook server receiving `AgentSessionEvent` from Linear
- cloudflared tunnel for public webhook URL
- Session monitor: HANDOFF.md detection → auto-report to Linear

#### Phase 3: Agent Personas (v3)
**Key insight from user**: Agents should be real team members with persistent memory, not ephemeral task runners.

**Key insight**: Memory is the persistent layer, not sessions. Sessions are ephemeral, grounded with persona + memories each time.

- 5 agent personas created: CTO, CPO, COO, Lead Engineer, Research Lead
- Each with CLAUDE.md (persona), MEMORY.md (index), memory/ (knowledge)
- `aos agent list/start/stop/talk/memory` commands
- Persona loading + grounding prompt builder

#### Phase 4: Multi-Model + Individual Identities
- Agent config (config.json per role) specifying base model
- Codex adapter: full implementation
- Lead Engineer defaults to Codex, others to CC
- Per-agent OAuth apps: each agent is a distinct Linear user
- Per-agent tokens: CTO posts as "CTO", CPO as "CPO", etc.
- Webhook routing by role (routing.json)
- Budget gates (budget.json)

#### Infrastructure
- macOS URL scheme: `agentos://` handler (AppleScript app)
- Raycast Quicklinks for all commands
- Deployed to both MacBook and iMac
- Linear project "AgentOS" with Architecture, Decision Log, Roadmap docs

### Key Decisions Made

1. **Linear as control plane, AgentOS as execution plane** — don't fight the platform
2. **OAuth agent identity per role** — each C-suite is a distinct Linear user
3. **Memory as persistent layer** — sessions are ephemeral, grounded each time
4. **Agents as team members, not tools** — CEO model with AI executives
5. **Model-flexible adapters** — each agent can run CC or Codex
6. **SCP for file upload** — heredoc over SSH fails with complex content
7. **HANDOFF.md-based completion** — monitor detects artifacts, not session death
8. **Interactive mode** — human can observe/steer agents via `aos jump`

### Bugs Encountered & Fixed

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| AgentSession API 403 | Personal API key, not OAuth | Switch to OAuth `client_credentials` |
| OAuth token = "undefined" | `access_token` vs `accessToken` in response | Check both field names |
| "Did not respond" in Linear | Old HANDOFF.md from previous run detected immediately | Clean artifacts before new attempt |
| "Working" forever after CC finishes | CC stays idle in tmux, monitor thinks it's alive | HANDOFF.md detection (not session death) |
| Shell escaping explosion | Long CLAUDE.md in `--append-system-prompt` via SSH | Write to workspace file, short shell prompt |
| SQLite disk I/O error | Deleted DB while server was running | Stop server before cleaning DB |
| Ghostty flash-close | `-e` arg parsing on macOS | Wrapper script with `--command` |
| `aos` not found from URL scheme | Hardcoded `/usr/local/bin/` path | Changed to `/opt/homebrew/bin/` |

### Linear Workspace State

- Organization: RyanHub
- Team: RYA
- Projects: AgentOS, Integration Test
- Agent users: AgentOS, CTO, CPO, COO, Lead Engineer, Research Lead
- Webhook: configured on AgentOS app

### Files Created

```
~/projects/agentos/
  README.md
  CLAUDE.md
  package.json, tsconfig.json
  src/
    cli.ts (entry point, 85 lines)
    types.ts (type definitions)
    core/
      config.ts, db.ts, keychain.ts, linear.ts,
      oauth.ts, persona.ts, router.ts, tmux.ts, budget.ts
    commands/
      agent.ts, auth.ts, batch.ts, jump.ts, kill.ts,
      logs.ts, resume.ts, serve.ts, setup.ts, spawn.ts,
      status.ts, watch.ts
    adapters/
      types.ts, index.ts, claude-code.ts, codex.ts
  docs/
    architecture.md, deployment.md, agent-guide.md,
    session-history.md, org-architecture.md,
    v2-architecture.md, session-routing-design.md
  hooks/
    aos-report.sh, install-imac-hook.sh
  url-scheme/
    Info.plist, handler.sh, build-app.sh
  raycast/
    aos-status.sh, aos-jump.sh, aos-spawn.sh

~/.aos/
  agents/
    cto/, cpo/, coo/, lead-engineer/, research-lead/
    (each with CLAUDE.md, MEMORY.md, config.json, .oauth-token, memory/)
  state.db
  routing.json
  budget.json
  oauth.json, .oauth-token
  serve.log, tunnel.log
```
