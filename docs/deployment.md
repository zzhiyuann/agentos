# AgentOS Deployment Guide

## Prerequisites

- Node.js 22+ (`node --version`)
- npm (`npm --version`)
- tmux (`brew install tmux`)
- Claude Code CLI (`claude --version`)
- cloudflared (`brew install cloudflare/cloudflare/cloudflared`)
- Ghostty terminal (for `aos jump`)

## Installation

### 1. Clone and Build
```bash
cd ~/projects/agentos
npm install
npm run build
npm link          # creates global `aos` command
```

### 2. Store Linear API Key
```bash
# Personal API key (for read operations)
aos setup --api-key <your-linear-api-key>
```

### 3. Create OAuth Application in Linear
1. Go to Linear Settings > API > Applications
2. Create application with Actor: Application
3. Scopes: read, write, app:assignable, app:mentionable
4. Authorize:
```bash
aos auth --client-id <id> --client-secret <secret>
```

### 4. Create Per-Agent OAuth Apps (Optional)
For each role (CTO, CPO, COO, Lead Engineer, Research Lead):
1. Create OAuth app in Linear (name = role name)
2. Same settings as above
3. Store credentials:
```bash
# The system stores tokens in ~/.aos/agents/{role}/config.json and .oauth-token
```

### 5. Start Webhook Server
```bash
# Terminal 1: webhook server
aos serve

# Terminal 2: cloudflared tunnel
cloudflared tunnel --url http://localhost:3848
# Note the public URL (https://xxx.trycloudflare.com)
```

### 6. Configure Webhook in Linear
1. Go to OAuth app settings
2. Set Webhook URL: `https://<tunnel-url>/webhook`
3. Enable: Agent session events, Issues, Comments
4. Save

## Operational Commands

### Start/Stop Agents
```bash
aos agent start cto RYA-42     # Start CTO on an issue
aos agent stop cto              # Graceful stop
aos agent talk cto "message"    # Send message
```

### Monitor
```bash
aos agent list                  # All agents + status
aos status --all                # All attempts
aos logs                        # Event history
tail -f ~/.aos/serve.stdout.log # Webhook server log
tmux list-sessions              # Active tmux sessions
tmux capture-pane -t aos-cto -p -S -30  # What agent is doing
```

### Troubleshooting
```bash
# Restart server
pkill -f "cli.js serve"; sleep 2
nohup node dist/cli.js serve > ~/.aos/serve.stdout.log 2>&1 &

# Refresh OAuth token
aos auth --client-id <id> --client-secret <secret>
```

## Persistent Tunnel (Production)

The quick tunnel URL changes on restart. For a stable URL:

```bash
# Login to Cloudflare
cloudflared login

# Create named tunnel
cloudflared tunnel create agentos

# Configure
cat > ~/.cloudflared/config.yml << EOF
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: agentos.yourdomain.com
    service: http://localhost:3848
  - service: http_status:404
EOF

# Run
cloudflared tunnel run agentos
```
