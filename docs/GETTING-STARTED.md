# Getting Started with AgentOS

A step-by-step guide to go from zero to a running AI agent team in under 15 minutes.

## Prerequisites

| Requirement | Minimum Version | Check Command |
|-------------|----------------|---------------|
| Node.js | 22+ | `node --version` |
| npm | 10+ | `npm --version` |
| tmux | 3.0+ | `tmux -V` |
| macOS or Linux | macOS 13+ / Ubuntu 22+ | `uname -a` |
| Linear workspace | — | [linear.app](https://linear.app) |

**Optional (for automatic webhook routing):**
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) — tunnels Linear webhooks to your machine

## Step 1: Install AgentOS

### Option A: From source (recommended)

```bash
git clone https://github.com/zzhiyuann/agentos.git
cd agentos
npm install
npm run build
npm link    # Creates the global `aos` command
```

Verify the installation:

```bash
aos --help
```

### Option B: Docker

See [Docker Setup](#docker-setup) below for a containerized deployment.

## Step 2: Configure Environment

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with the following **required** variables:

```bash
# ──── Required ────

# Your Linear team UUID (Settings > Workspace > General > Workspace ID)
AOS_LINEAR_TEAM_ID=your-linear-team-uuid

# Your Linear team key prefix (e.g., "ENG", "PROD" — the prefix on your issue IDs)
AOS_LINEAR_TEAM_KEY=ENG

# Where agent sessions execute ("localhost" for local, or a remote host IP)
AOS_HOST=localhost

# Your system username (used for SSH when AOS_HOST is remote)
AOS_USER=your-username
```

**Optional variables:**

```bash
# Base directory for agent workspaces (default: ~/agent-workspaces)
AOS_WORKSPACE_BASE=~/agent-workspaces

# Organization name shown in agent prompts
AOS_ORG_NAME=My Company

# Webhook signature verification secret (recommended for production)
AOS_WEBHOOK_SECRET=

# Discord notifications
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
```

### Where to find your Linear team ID

1. Open [Linear](https://linear.app)
2. Go to **Settings** > **Workspace** > **General**
3. Copy the **Workspace ID** (UUID format)
4. Your **team key** is the prefix on your issue IDs (e.g., if issues are `ENG-42`, the key is `ENG`)

## Step 3: Run Setup

```bash
aos setup --api-key <YOUR_LINEAR_API_KEY>
```

This will:
1. Validate your environment variables
2. Store your Linear API key securely (macOS Keychain or file fallback)
3. Verify the Linear connection
4. Initialize the SQLite state database at `~/.aos/state.db`
5. Create agent routing labels in Linear

You should see:

```
Setup complete!
  Team:       ENG
  Host:       your-username@localhost
  Workspaces: ~/agent-workspaces
  State:      ~/.aos/

Next steps:
  1. Set up OAuth for agent identities: aos auth --client-id <ID> --client-secret <SECRET>
  2. Start the server: aos serve
  3. Create a Linear issue and watch it get routed!
```

### Get a Linear API key

1. Go to [Linear](https://linear.app) > **Settings** > **API** > **Personal API keys**
2. Click **Create key**
3. Give it a descriptive name (e.g., "AgentOS")
4. Copy the key — it's shown only once

## Step 4: Set Up Agent Identity (OAuth)

For agents to post comments and update issues as their own identity (not yours), set up OAuth:

### Create a Linear OAuth application

1. Go to **Linear** > **Settings** > **API** > **Applications**
2. Click **Create application**
3. Configure:
   - **Name**: AgentOS
   - **Actor**: Application (important — this makes the app act as itself)
   - **Scopes**: `read`, `write`, `app:assignable`, `app:mentionable`
   - **Redirect URI**: `http://localhost:3848/oauth/callback`
4. Copy the **Client ID** and **Client Secret**

### Run the OAuth flow

```bash
aos auth --client-id <OAUTH_CLIENT_ID> --client-secret <OAUTH_CLIENT_SECRET>
```

This opens a browser for authorization. After approving, agents will post to Linear with their own identity.

> **Note:** Without OAuth, agents still work — they just post as your personal identity. OAuth is recommended but not required to get started.

## Step 5: Set Up Your Agent Team

AgentOS uses agent personas stored at `~/.aos/agents/<role>/`. Each agent needs at minimum a `CLAUDE.md` file defining who they are.

### Create your first agent

```bash
mkdir -p ~/.aos/agents/engineer
```

Create `~/.aos/agents/engineer/CLAUDE.md`:

```markdown
# Engineer

You are the Engineer. You write clean, well-tested code.

## Responsibilities
- Implement features and fix bugs
- Write tests for all changes
- Follow project coding standards

## How You Work
1. Read the issue description carefully
2. Explore the relevant codebase
3. Implement the change with tests
4. Write HANDOFF.md summarizing what you did
```

Create `~/.aos/agents/engineer/config.json`:

```json
{
  "baseModel": "cc"
}
```

> **`baseModel` options:** `"cc"` for Claude Code, `"codex"` for Codex

### Set up routing rules

Create `~/.aos/routing.json` to control which agent handles which issues:

```json
{
  "rules": [
    { "label": "agent:engineer", "agent": "engineer" },
    { "default": true, "agent": "engineer" }
  ]
}
```

Rules are evaluated top-to-bottom. First match wins:
- **Label rules** — match when the Linear issue has a specific label
- **Project rules** — match when the issue is in a specific Linear project: `{ "project": "Backend", "agent": "engineer" }`
- **Default rule** — catches everything unmatched

### View your roster

```bash
aos agent list
```

## Step 6: Start Your First Agent

### Manual start (simplest way to test)

```bash
# Start the engineer on a Linear issue
aos agent start engineer ENG-42

# Watch it work in real-time
aos jump ENG-42
```

The agent spawns in a tmux session with its full persona and any accumulated memory loaded.

### Automatic routing (production mode)

Start the webhook server for automatic issue routing:

```bash
# Start the webhook server
aos serve
```

In a separate terminal, expose it to Linear via cloudflared:

```bash
cloudflared tunnel --url http://localhost:3848
```

Cloudflared outputs a temporary URL like `https://random-words.trycloudflare.com`. Configure this as a webhook in Linear:

1. Go to **Linear** > **Settings** > **API** > **Webhooks** (or configure in your OAuth app)
2. Add webhook URL: `https://<tunnel-url>/webhook`
3. Select events: **Agent sessions**, **Issues**, **Comments**

Now, adding a label like `agent:engineer` to any issue will automatically route it to your engineer agent.

### Polling mode (no webhook needed)

If you don't want to set up webhooks, use polling:

```bash
aos watch    # Polls Linear every 30 seconds for new assignments
```

## Step 7: Common Operations

```bash
# Agent management
aos agent list                    # View roster and status
aos agent start engineer ENG-42   # Start agent on issue
aos agent stop engineer           # Graceful stop
aos agent talk engineer "msg"     # Send message to running agent
aos agent memory engineer         # View accumulated knowledge

# Task operations
aos status                        # Active sessions
aos status --all                  # All sessions (including completed)
aos jump ENG-42                   # Attach to agent's terminal
aos kill ENG-42                   # Terminate session
aos kill ENG-42 --done            # Terminate and mark complete
aos resume ENG-42                 # Retry a failed attempt
aos queue                         # View spawn queue

# Batch operations
aos spawn ENG-42                  # Auto-route a single issue
aos batch ENG-1 ENG-2 ENG-3      # Spawn multiple at once

# Infrastructure
aos serve                         # Webhook server + monitor
aos watch                         # Polling mode (no webhooks)
```

## How Memory Works

When an agent completes a task, it writes memory files to `~/.aos/agents/<role>/memory/`. These persist across sessions:

```
~/.aos/agents/engineer/
  CLAUDE.md              # Persona (you maintain this)
  MEMORY.md              # Memory index (agent maintains)
  config.json            # Model configuration
  memory/
    architecture.md      # Decisions learned from past sessions
    codebase-patterns.md # Patterns discovered in the codebase
    ceo-preferences.md   # How the CEO likes things done
```

Each new session gets grounded with:
1. The agent's full `CLAUDE.md` persona
2. All accumulated memory files from `memory/`
3. The memory index from `MEMORY.md`

This is the **death and resurrection pattern** — sessions are disposable, but knowledge is permanent. An agent "dies" when its session ends and "resurrects" with everything it ever learned when spawned again.

## Docker Setup

For a containerized deployment:

```bash
git clone https://github.com/zzhiyuann/agentos.git
cd agentos
cp .env.example .env
# Edit .env with your Linear credentials (see Step 2)
```

### docker-compose.yml

The included `docker-compose.yml` starts the webhook server with persistent state:

```bash
docker compose up -d
```

Services:
- **agentos** — Webhook server on port 3848 with SQLite state persistence
- **tunnel** (optional) — Cloudflared tunnel exposing the webhook server

### Mount your agent personas

To use custom agent personas, uncomment the volume mount in `docker-compose.yml`:

```yaml
volumes:
  - ./agents:/root/.aos/agents    # Your agent persona definitions
```

Create an `agents/` directory in your project root with your persona files (see Step 5).

### Health check

```bash
curl http://localhost:3848/health
```

## Scaling: Add More Agents

Once your first agent is working, expand your team:

```bash
mkdir -p ~/.aos/agents/{architect,researcher,qa}
```

Create a `CLAUDE.md` and `config.json` for each role, then update `routing.json`:

```json
{
  "rules": [
    { "label": "agent:architect",  "agent": "architect" },
    { "label": "agent:researcher", "agent": "researcher" },
    { "label": "agent:qa",         "agent": "qa" },
    { "label": "agent:engineer",   "agent": "engineer" },
    { "default": true, "agent": "engineer" }
  ]
}
```

Agents can delegate work to each other using `linear-tool`:

```bash
# Inside an agent's CLAUDE.md, teach it to delegate:
# linear-tool dispatch engineer ENG-42 "Implement the feature per this spec"
# linear-tool handoff qa ENG-42 "Implementation complete, needs testing"
# linear-tool ask architect ENG-42 "Should we use a queue or direct calls?"
```

## Troubleshooting

### "No API key found"
```bash
aos setup --api-key <YOUR_KEY>
```

### Agent won't start
```bash
# Verify tmux is installed and working
tmux -V
tmux list-sessions

# Check if the agent persona directory exists
ls ~/.aos/agents/<role>/
```

### Webhook server not receiving events
```bash
# Verify the server is running
curl http://localhost:3848/health

# Check cloudflared tunnel is active
# The tunnel URL must be configured in Linear webhook settings

# Check routing config
cat ~/.aos/routing.json
```

### Agent stuck or not completing
```bash
# See what the agent is doing
aos jump ENG-42

# Check for errors in the session
aos status --all

# Force terminate and retry
aos kill ENG-42
aos resume ENG-42
```

### Database issues
```bash
# The state database is at ~/.aos/state.db
# Never delete while the server is running
# To reset: stop server, delete state.db, run aos setup again
```

## Next Steps

- **[Architecture](architecture.md)** — Deep dive into two-plane design, session lifecycle, and data model
- **[Agent Guide](agent-guide.md)** — Write effective agent personas
- **[Deployment](deployment.md)** — Production setup with persistent tunnels and remote execution
- **[Competitive Analysis](competitive-analysis.md)** — How AgentOS compares to other frameworks
- **[Contributing](../CONTRIBUTING.md)** — Help improve AgentOS
