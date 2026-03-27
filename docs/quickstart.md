# AgentOS Quick Start Guide

Get from zero to running AI agents in under 10 minutes.

## Prerequisites

| Requirement | Check |
|-------------|-------|
| Node.js 22+ | `node --version` |
| macOS | Keychain + tmux integration |
| tmux | `tmux -V` |
| Linear workspace | [linear.app](https://linear.app) |
| cloudflared (optional) | `brew install cloudflare/cloudflare/cloudflared` |

## Step 1: Install

```bash
git clone https://github.com/agentos-sh/agentos.git
cd agentos
npm install && npm run build && npm link
```

This creates the global `aos` command.

## Step 2: Configure Linear

### Get a Linear API key
1. Go to **Linear** → **Settings** → **API** → **Personal API keys**
2. Create a key with read/write access

### Run setup
```bash
aos setup --api-key <YOUR_LINEAR_API_KEY>
```

This will:
- Store the API key in macOS Keychain
- Verify the Linear connection
- Initialize the SQLite database at `~/.aos/state.db`
- Create agent routing labels in Linear

### Set up OAuth (for agent identities)
```bash
aos auth --client-id <OAUTH_CLIENT_ID> --client-secret <OAUTH_SECRET>
```

To create OAuth credentials:
1. Go to **Linear** → **Settings** → **API** → **Applications**
2. Create an application with **Actor: Application**
3. Scopes: `read`, `write`, `app:assignable`, `app:mentionable`

## Step 3: Meet Your Team

AgentOS comes with a default executive team:

| Role | Model | Domain |
|------|-------|--------|
| CTO | Claude Code | Architecture, code quality |
| CPO | Claude Code | Product, features, user experience |
| COO | Claude Code | Ops, infrastructure |
| Lead Engineer | Claude Code | Implementation |
| Research Lead | Claude Code | Research, analysis |

View the roster:
```bash
aos agent list
```

Agent personas and memory live at `~/.aos/agents/{role}/`:
```
~/.aos/agents/cto/
├── CLAUDE.md        # Persona definition (role, authority, how to work)
├── MEMORY.md        # Index of accumulated knowledge
├── config.json      # Model, OAuth credentials
└── memory/          # Persistent knowledge files
```

## Step 4: Start an Agent

Assign an agent to a Linear issue:

```bash
# Start the CTO on issue ENG-42
aos agent start cto ENG-42

# Override the model if needed
aos agent start cto ENG-42 --model codex
```

The agent spawns in a local tmux session with its full persona and memory loaded.

### Watch it work

```bash
# Attach to the agent's terminal
aos jump ENG-42

# Send a message to a running agent
aos agent talk cto "Focus on the auth module first"

# Check agent status
aos status
```

## Step 5: Start the Server (Automatic Routing)

For automatic issue routing via webhooks:

```bash
# Start webhook server + session monitor
aos serve

# In another terminal, expose via cloudflared
cloudflared tunnel --url http://localhost:3848
```

Then configure the webhook URL in your Linear OAuth app settings:
- URL: `https://<tunnel-url>/webhook`
- Events: Agent sessions, Issues, Comments

With the server running, assigning an `agent:cto` label to any issue will automatically route it to the CTO agent.

### Polling mode (no webhook needed)

```bash
aos watch
```

This polls Linear for new assignments every 30 seconds.

## Step 6: Common Operations

### Agent management
```bash
aos agent list                    # Roster + status
aos agent start cto ENG-42       # Start agent on issue
aos agent stop cto                # Graceful stop
aos agent talk cto "message"      # Send message
aos agent memory cto              # View memories
```

### Task operations
```bash
aos spawn ENG-42                  # Spawn agent on issue (auto-routes)
aos batch ENG-1 ENG-2 ENG-3      # Batch spawn multiple
aos status --all                  # All attempts (incl. completed/failed)
aos jump ENG-42                   # Attach to agent terminal
aos kill ENG-42                   # Terminate session
aos kill ENG-42 --done            # Terminate + mark done
aos resume ENG-42                 # Re-attempt failed issue
```

### Monitoring
```bash
aos queue                         # View spawn queue
aos logs                          # Event history
aos logs ENG-42                   # Events for specific issue
```

## How It All Fits Together

```
You create Linear issue → Label triggers routing → Agent spawns in tmux
                                                        │
                                    ┌───────────────────┤
                                    │                   │
                              Agent works          Agent delegates
                              (with memory)        to other agents
                                    │                   │
                                    └───────────────────┤
                                                        │
                                              Writes HANDOFF.md
                                              Linear updates
                                              Memory persists
```

1. **Issues drive intent** — You create work in Linear like normal
2. **AgentOS routes execution** — Labels or `aos agent start` assigns work
3. **Agents carry context** — Each session loads persona + accumulated memory
4. **Agents collaborate** — CTO can dispatch Lead Engineer, CPO can ask Research
5. **Memory outlives sessions** — What agents learn persists across sessions
6. **You observe everything** — `aos jump` attaches to any agent's terminal

## Troubleshooting

### "No API key found"
```bash
aos setup --api-key <key>
```

### Agent won't start
```bash
# Check tmux is installed
tmux -V

# Check existing tmux sessions
tmux list-sessions
```

### Server not routing issues
```bash
# Check routing config
cat ~/.aos/routing.json

# Check recent event history
aos logs
```

### Agent stuck / not completing
```bash
# Check what the agent is doing
aos jump ENG-42

# Force terminate and retry
aos kill ENG-42
aos resume ENG-42
```

## Next Steps

- **[Agent Guide](agent-guide.md)** — Create custom agents with their own personas
- **[Deployment Guide](deployment.md)** — Production setup with persistent tunnels
- **[Architecture](architecture.md)** — How AgentOS works under the hood
