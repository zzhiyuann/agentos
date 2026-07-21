# AgentOS Starter Template — Contract

This directory is the starter template consumed by the `create-agentos-company` CLI (RYA-620).
It packages the **operational glue** — config, scripts, and launchers — needed to run an AgentOS
company in production. The runtime code itself lives in the installed `agentos` npm package
(provides the global `aos` command).

## Directory layout

```
templates/agentos-starter/
├── .env.example                        # env vars, placeholders for install-time subst
├── .gitignore                          # excludes state, logs, secrets
├── HANDOFF_TEMPLATE.md                 # reference for agents completing tasks
├── README.md.tmpl                      # rendered into user's new repo
├── package.json.tmpl                   # declares `agentos` as dep; scripts for ops
├── tsconfig.json                       # present but optional — user customization
├── config/
│   ├── routing.json                    # label/project → agent role rules
│   ├── agents.json                     # adapter registry (cc, codex, …)
│   ├── budget.json                     # per-role budget caps (forward-compatible)
│   └── workspace-map.json              # project → workspace directory
├── scripts/
│   ├── serve-loop.sh                   # auto-restart wrapper, no personal paths
│   ├── install-serve-launchd.sh.tmpl   # installs launchd plist
│   ├── uninstall-serve-launchd.sh
│   ├── com.agentos.serve.plist.tmpl    # launchd plist, placeholders
│   ├── tunnel-quick.sh                 # one-off trycloudflare tunnel
│   ├── tunnel-install-launchd.sh.tmpl  # named tunnel as daemon
│   ├── com.agentos.tunnel.plist.tmpl
│   └── refresh-claude-auth.sh          # OAuth token rotation helper
└── docs/
    ├── RUNBOOK.md                      # day-two ops playbook
    └── TUNED-CONSTANTS.md              # monitor/idle tuning, why these numbers
```

## Install-time substitution

Files ending in `.tmpl` contain **mustache-style placeholders** (`{{VAR}}`). The CLI walks this
tree, substitutes, strips the `.tmpl` suffix, and writes to the destination. Files without
`.tmpl` are copied verbatim (no substitution).

**Placeholders (all required from the CLI wizard):**

| Variable | Example | Used in |
|---|---|---|
| `{{PROJECT_NAME}}` | `ryanhub` | package.json, launchd labels, tunnel name |
| `{{PROJECT_DIR}}` | `/Users/foo/projects/ryanhub` | launchd `WorkingDirectory`, script paths |
| `{{USER}}` | `foo` | launchd `UserName`, env |
| `{{HOME}}` | `/Users/foo` | launchd env, log paths |
| `{{ORG_NAME}}` | `YourOrg` | env `AOS_ORG_NAME`, agent prompts |
| `{{LINEAR_TEAM_KEY}}` | `RYA` | .env `AOS_LINEAR_TEAM_KEY` |
| `{{LINEAR_TEAM_ID}}` | UUID | .env `AOS_LINEAR_TEAM_ID` |
| `{{SERVE_PORT}}` | `3848` | launchd plist, scripts |
| `{{TUNNEL_HOSTNAME}}` | `agentos.example.com` or empty | named tunnel config |

**Optional placeholders (CLI may default):**

| Variable | Default |
|---|---|
| `{{POLL_INTERVAL_MS}}` | `30000` |
| `{{WORKSPACE_BASE}}` | `{{HOME}}/agent-workspaces` |
| `{{DISCORD_BOT_TOKEN}}` | (empty, opt-in) |
| `{{DISCORD_CHANNEL_ID}}` | (empty, opt-in) |

**Rule:** every `{{VAR}}` in a `.tmpl` file MUST appear in the table above. If the CLI walks
the tree and finds an unknown placeholder, it must fail fast.

## File naming conventions

| Pattern | Treatment |
|---|---|
| `*.tmpl` | Substituted → `.tmpl` stripped on output |
| `*` (no `.tmpl`) | Copied verbatim; no substitution |
| `_dot_*` prefix | (reserved — not used today) If added, rename to `.*` on output. This lets us ship `.gitignore` / `.env.example` under a different name if npm/pnpm ever strips dotfiles in tarballs. Today, `.gitignore` is shipped directly. |

## Post-install steps (CLI or user)

After substitution and copy, the CLI should run:
1. `npm install` (installs `agentos` from npm)
2. `aos setup --api-key <KEY>` (prompts if missing)
3. `aos auth --client-id <ID> --client-secret <SECRET>` (prompts if missing)
4. Copy per-role persona pack from RYA-622 → `~/.aos/agents/`
5. Copy config/routing.json, config/agents.json, etc. → `~/.aos/`
6. Print: "Run `scripts/tunnel-quick.sh` in one terminal and `aos serve` in another."

`aos serve` must start without any additional personal env vars. Only the values the user
provided in the wizard (written to `.env`) are needed.

## Versioning

This template version: **0.1.0**. Bump when the contract changes (new placeholder, new required
config file). The CLI records the template version in the generated repo's package.json so it
can warn on upstream upgrades.
