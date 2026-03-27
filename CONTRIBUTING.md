# Contributing to AgentOS

Thanks for your interest in contributing to AgentOS! This document covers the essentials for getting started.

## Development Setup

### Prerequisites

- **Node.js 22+**
- **macOS** (Keychain integration for token storage) or **Linux** (file-based fallback)
- **Linear workspace** with API access
- **tmux** installed on the execution host

### Getting Started

```bash
git clone https://github.com/agentos-sh/agentos.git
cd agentos
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your Linear team ID, team key, host, and username

# Run tests to verify setup
npm test

# Build
npm run build
```

### Environment Variables

Required environment variables (see `.env.example` for the full list with descriptions):

| Variable | Description |
|----------|-------------|
| `AOS_LINEAR_TEAM_ID` | Your Linear team UUID |
| `AOS_LINEAR_TEAM_KEY` | Your Linear team key (e.g., `ENG`) |
| `AOS_HOST` | Execution host address (`localhost` for local) |
| `AOS_USER` | SSH username on the execution host |

## Project Structure

```
src/
  cli.ts              # CLI entry point (Commander)
  types.ts            # Shared type definitions
  core/               # Infrastructure: Linear API, DB, tmux, OAuth, routing
  commands/            # CLI commands: serve, agent, spawn, setup, etc.
  serve/              # Webhook handlers, monitor, scheduler, dispatch
  adapters/           # Runner backends (Claude Code, Codex)
```

Key files:
- `src/commands/serve.ts` — Webhook server + monitor loop orchestrator
- `src/serve/webhook.ts` — Linear webhook event dispatcher
- `src/serve/monitor.ts` — Session monitor (polls for HANDOFF.md every 15s)
- `src/core/persona.ts` — Agent identity and memory loader
- `src/core/router.ts` — Issue-to-agent routing

## Development Workflow

### Running Without Building

```bash
npx tsx src/cli.ts <command>
# Example:
npx tsx src/cli.ts agent list
npx tsx src/cli.ts status --all
```

### Testing

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

All new code should include tests. Test files are co-located with source files (`foo.ts` + `foo.test.ts`).

### Building

```bash
npm run build           # TypeScript compilation to dist/
```

## Making Changes

### Pull Request Process

1. **Fork** the repository and create a feature branch
2. **Make changes** — keep PRs focused on a single concern
3. **Add tests** — for any new functionality or bug fixes
4. **Run the test suite** — `npm test` must pass
5. **Submit a PR** — describe the problem, your approach, and how to test it

### Code Style

- TypeScript strict mode
- ES modules (`import`/`export`, `.js` extensions in imports)
- Co-located tests (`*.test.ts` alongside source)
- Prefer simple, readable code over clever abstractions

### Commit Messages

- Use imperative mood: "Add feature" not "Added feature"
- First line under 72 characters
- Reference issue numbers when applicable: "Fix routing bug (#42)"

## Where to Contribute

Areas where contributions are especially valuable:

### New Runner Adapters
The `RunnerAdapter` interface (`src/adapters/types.ts`) abstracts how agent sessions are spawned. Adding support for new AI models/runtimes:
- Gemini, local models, or other LLM providers
- Implement the `spawn`, `isAlive`, `kill`, `captureOutput` methods

### MCP Integration
Tool interoperability via the Model Context Protocol — agent tool discovery and sharing.

### Memory Strategies
Smarter memory management for agents:
- Pruning strategies (what to forget)
- Summarization (compress old memories)
- Retrieval improvements (what to recall for a given task)

### Cross-Platform Support
AgentOS currently uses macOS Keychain for token storage with a file-based fallback for Linux. Contributions to improve Linux support or add Windows compatibility are welcome.

### Documentation
- Tutorials and guides
- Architecture deep-dives
- Video walkthroughs

## Questions?

Open an issue or start a discussion. We're happy to help you find a good first contribution.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
