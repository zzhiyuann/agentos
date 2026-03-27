# Agent Creation & Management Guide

## Agent Hierarchy

| Tier | Roles | Persistence | Memory |
|------|-------|-------------|--------|
| C-Suite | CTO, CPO, COO | Permanent identity | Full memory system |
| Senior Staff | Lead Engineer, Research Lead | Permanent identity | Full memory system |
| Workers | Feature Engineer, Bug Fixer, etc. | Ephemeral | No persistent memory |

## Creating a New Agent

### 1. Create Directory Structure
```bash
mkdir -p ~/.aos/agents/new-role/{memory,retrospectives}
```

### 2. Write Persona (CLAUDE.md)
```markdown
# Role Name — Company Name

You are the [Role]. You own [domain].

## Identity
- Name: [Role]
- Reports to: [Manager]
- Org context: AI-native company where AI agents are real team members

## Authority
- [What decisions you can make]
- [What you own]

## Responsibilities
1. [Key responsibility]
2. [Key responsibility]

## How You Work
### Receiving Work
- You receive issues from Linear
- Check your memory files for context

### Memory Protocol
Your memory files are at ~/.aos/agents/[role]/memory/.

Before ending any session:
1. Update relevant memory files
2. Write HANDOFF.md
```

### 3. Create Memory Index
```bash
cat > ~/.aos/agents/new-role/MEMORY.md << 'EOF'
# Memory Index
No memories yet.
EOF
```

### 4. Create Config
```json
{
  "baseModel": "cc",
  "fallbackModel": "codex",
  "linearClientId": "",
  "linearClientSecret": ""
}
```

### 5. Register Linear Identity (Optional)
1. Create OAuth app in Linear (name = role name)
2. Get token: `client_credentials` grant
3. Store in `config.json` and `.oauth-token`

### 6. Deploy
```bash
rsync -az ~/.aos/agents/new-role/ $USER@$AOS_HOST:~/.aos/agents/new-role/
```

## Memory System

### How Memory Works
```
Session N:
  Agent reads: CLAUDE.md + MEMORY.md + memory/*.md
  Agent works on task
  Agent learns something important
  Agent writes to memory/architecture.md
  Session ends

Session N+1:
  Agent reads: CLAUDE.md + MEMORY.md + memory/*.md (now updated)
  Has full context from Session N's learning
  Fresh context window, no bloat
```

### Memory File Guidelines
- Each file should stay under 500 lines
- Use structured format: Date, Decision, Context, Rationale
- MEMORY.md is the index — one-line descriptions pointing to files
- When a file gets too long, summarize and archive old entries

### Memory Types
| File | Content |
|------|---------|
| `architecture.md` | Architecture decisions + rationale |
| `tech-debt.md` | Known debt, priorities |
| `ceo-preferences.md` | Learned preferences from CEO feedback |
| `project-{name}.md` | Per-project accumulated knowledge |
| `codebase-patterns.md` | Code patterns and gotchas |
| `debugging-notes.md` | Hard-won debugging insights |

## Model Configuration

### Supported Models
| Model ID | Runner | Best For |
|----------|--------|----------|
| `cc` | Claude Code | Architecture, review, complex reasoning |
| `codex` | OpenAI Codex | Fast implementation, boilerplate, refactoring |

### Changing an Agent's Model
```bash
# Edit config
cat ~/.aos/agents/lead-engineer/config.json
# Change "baseModel": "codex" to "cc" or vice versa

# Or override at runtime
aos agent start lead-engineer ENG-42 --model cc
```

## Routing

### How Issues Get Routed to Agents

Configured in `~/.aos/routing.json`:
```json
{
  "rules": [
    { "project": "AgentOS", "agent": "cto" },
    { "label": "ops", "agent": "coo" },
    { "label": "product", "agent": "cpo" },
    { "label": "research", "agent": "research-lead" },
    { "default": "lead-engineer" }
  ]
}
```

Rules are evaluated in order. First match wins.

### Manual Assignment
```bash
# Override routing — assign specific agent
aos agent start cpo ENG-42
```
