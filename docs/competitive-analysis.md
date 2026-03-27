# AgentOS Competitive Analysis

> Prepared by Research Lead — March 2026
> Context: RYA-18 Public GitHub Launch

## Executive Summary

The AI agent orchestration market is projected at $8.5B by 2026 and $35B by 2030. MCP hit 97M monthly SDK downloads (Feb 2026). Both MCP and A2A are now under the Linux Foundation's AAIF, co-founded by OpenAI, Anthropic, Google, Microsoft, AWS, and Block.

**AgentOS occupies a unique niche**: organizational orchestration. No other framework treats agents as permanent team members with persistent identities, career-spanning memory, and native project management integration. The closest philosophical match is Letta/MemGPT (memory-first agents), but Letta focuses on individual agent statefulness while AgentOS focuses on organizational coordination — agents form a company, not a pipeline.

---

## Framework Comparison

### 1. AutoGen / AG2 (Microsoft) — 56K stars

**What it is:** Microsoft Research's multi-agent framework. Co-creators forked it as AG2 under community governance in late 2024. Microsoft merged concepts into the new Microsoft Agent Framework (AutoGen + Semantic Kernel), GA Q1 2026. AutoGen itself is in maintenance mode.

**Architecture:** GroupChat as primary coordination — multiple agents in shared conversation with selector-based turn management. AG2 v0.4 added event-driven core, async-first execution, pluggable orchestration. Brands itself as "AgentOS."

**Memory:** In-memory conversation history by default. AG2 added persistent state stores. Microsoft Agent Framework adds session-based state with database backing.

**Integration:** Native A2A protocol support. MCP via community adapters.

| Strength | Weakness |
|----------|----------|
| Largest community (56K stars) | Confusing split: AutoGen vs AG2 vs MS Agent Framework |
| Flexible conversation patterns | AutoGen in maintenance mode |
| Strong Microsoft ecosystem | GroupChat unpredictable with many agents |
| Native A2A support | Migration burden for existing users |

**vs AgentOS:** AutoGen agents are in-process conversation participants — ephemeral, no persistent identity, no PM integration. AgentOS agents are organizational roles with career-spanning memory and Linear-native workflow.

---

### 2. CrewAI — 47K stars

**What it is:** Python framework for orchestrating role-playing, autonomous AI agents. Built from scratch (no LangChain dependency). v1.10.1 as of March 2026. Claims 12M+ daily agent executions in production.

**Architecture:** Dual: Crews (autonomous agent teams with dynamic task delegation) + Flows (event-driven workflow orchestration). Role-based — each agent gets role, goal, backstory, and tools.

**Memory:** Four-tier: short-term (current task), long-term (cross-session), entity (knowledge about people/things), contextual (situational awareness).

**Integration:** Native MCP support. Native A2A for inter-framework communication.

| Strength | Weakness |
|----------|----------|
| Fastest prototyping of multi-agent workflows | Common case trivial, uncommon case harder |
| Role-based abstraction is intuitive | Medium production-readiness vs LangGraph |
| 2-3x faster execution (benchmarked) | Less fine-grained control than graph-based |
| Strong memory system out of the box | Limited fault tolerance vs LangGraph checkpointing |

**vs AgentOS:** CrewAI's role-based design is the closest conceptual parallel — but roles are ephemeral (redefined each run), have no persistent identity outside the process, and don't integrate with project management. AgentOS roles persist across sessions and issues.

---

### 3. LangGraph (LangChain) — 27K stars

**What it is:** Stateful, multi-actor applications as directed graphs. v1.0. Most production-deployed framework — used by Klarna, Uber, LinkedIn, Cisco, BlackRock, JPMorgan (~400 companies on LangGraph Platform).

**Architecture:** Graph-based: nodes (functions), edges (execution flow), conditional branching. Supports cyclical graphs — agents loop, retry, self-correct. Durable execution with automatic state persistence. Time-travel debugging.

**Memory:** Built-in checkpoint system (SQLite, Postgres). State persists across execution steps. Conversation memory across sessions.

**Integration:** MCP client integration. A2A emerging. Deep LangSmith integration for observability.

| Strength | Weakness |
|----------|----------|
| Most production-hardened (checkpointing, time-travel) | Steepest learning curve |
| Fine-grained control over execution | Graph definition verbose for simple cases |
| Excellent observability via LangSmith | LangChain ecosystem complexity |
| Strong enterprise adoption | Memory challenges in serverless |

**vs AgentOS:** LangGraph excels at workflow orchestration within a single application. AgentOS orchestrates across applications — agents run in separate processes (tmux sessions) on remote machines, using real development tools. LangGraph has no concept of agent identity or organizational hierarchy.

---

### 4. OpenAI Agents SDK — 20K stars

**What it is:** OpenAI's production-ready agent framework (successor to Swarm, March 2025). Python and TypeScript. Deliberately minimal.

**Architecture:** Three primitives: Agents (LLMs + instructions + tools), Handoffs (agent-to-agent delegation), Guardrails (validation). Built-in tracing. Voice agent support.

**Memory:** Sessions for working context within an agent loop. No built-in cross-session persistence.

**Integration:** Built-in MCP server tool integration. Model-agnostic (100+ LLMs despite being OpenAI).

| Strength | Weakness |
|----------|----------|
| Extreme simplicity — fewest abstractions | No built-in multi-agent coordination beyond handoffs |
| High production readiness | No persistent memory across sessions |
| Model-agnostic | "Bring your own memory" burden |
| Voice agent capabilities | Limited orchestration complexity |

**vs AgentOS:** OpenAI SDK's handoff model is similar in spirit to AgentOS's dispatch/handoff, but operates within a single process with no persistent identity. AgentOS adds organizational structure, memory, and PM integration on top.

---

### 5. Claude Agent SDK (Anthropic) — 5.7K stars

**What it is:** Same runtime infrastructure that powers Claude Code, packaged as a library. Python and TypeScript. Apple integrated it into Xcode 26.3.

**Architecture:** Single-agent-centric with subagent spawning. Built-in file operations, shell commands, web search, MCP. Computer use (GUI interaction). Experimental Agent Teams feature.

**Memory:** Long-term Project Memory (2026) — remembers architectural decisions and style preferences across sessions. File-based.

**Integration:** Deepest MCP integration of any framework. Computer use as unique integration surface.

| Strength | Weakness |
|----------|----------|
| Battle-tested (powers Claude Code) | Claude-only (locked to Anthropic models) |
| Best-in-class computer use / GUI | Smallest community |
| Deepest MCP integration | Multi-agent still experimental |
| Apple/Xcode trust signal | Primarily single-agent workflows |

**vs AgentOS:** AgentOS uses Claude Code as an execution backend. The Claude Agent SDK is the engine; AgentOS is the fleet management layer. AgentOS adds persistent organizational identity, multi-model support, and Linear integration.

---

### 6. Google ADK — 18.5K stars

**What it is:** Google's code-first agent framework. Model-agnostic despite being optimized for Gemini. Python 2.0 Alpha added graph-based workflows.

**Architecture:** Event-driven runtime. Three agent types: LLM Agents, Workflow Agents, Custom Agents. Modular multi-agent hierarchies.

**Memory:** Session/State for immediate conversation. Vertex AI Memory Bank for long-term recall. Agents learn and persist preferences.

**Integration:** Native A2A (Google co-created A2A) + native MCP. Best dual-protocol support.

| Strength | Weakness |
|----------|----------|
| Best A2A + MCP dual-protocol | Best experience requires GCP |
| Model-agnostic | Less battle-tested than LangGraph |
| Strong cloud deployment (Vertex AI) | Smaller community |
| Good developer tooling | Documentation still catching up |

**vs AgentOS:** Google ADK's hierarchical agents resemble AgentOS's org structure conceptually, but ADK agents exist within a single runtime, are ephemeral per-session, and have no PM integration or persistent organizational identity.

---

### 7. Composio — 27.5K stars

**What it is:** Developer-first integration platform: 850+ pre-built connectors with unified API. Also open-sourced an Agent Orchestrator for parallel coding agents.

**Architecture:** Not a full agent framework — a tool/integration layer that plugs into other frameworks. Dynamic Tool Routing feeds only relevant tools to LLM. Agent Orchestrator coordinates parallel coding agents.

**Memory:** Relies on host framework. Tool state and auth tokens managed centrally.

**Integration:** MCP-native (tools available as MCP servers). Framework-agnostic with all major agent SDKs.

| Strength | Weakness |
|----------|----------|
| Solves auth management at scale (850+ services) | Not a full framework — must pair with one |
| Framework-agnostic | Third-party dependency risk |
| Dynamic tool routing prevents LLM confusion | Tool quality varies |
| Largest tool ecosystem | Agent Orchestrator less proven |

**vs AgentOS:** Composio is complementary, not competitive. Could serve as AgentOS's integration layer for external services if MCP support is added.

---

### Notable Mentions

**Mastra (22K stars)** — TypeScript-native from the Gatsby team (YC W25, $13M). Fills the JS/TS gap. Agents, workflows, RAG, memory, evals, MCP — one cohesive package. Growing extremely fast.

**Letta/MemGPT (21.7K stars)** — Memory-first architecture from UC Berkeley. LLM-as-OS paradigm where agents self-edit their own memory. Tiered memory (core in-context, archival out-of-context). Most sophisticated memory system of any framework. **Philosophically closest to AgentOS** in treating agents as persistent entities, but focused on individual agent statefulness vs organizational orchestration.

---

## Positioning Matrix

| Dimension | AutoGen | CrewAI | LangGraph | OpenAI SDK | Claude SDK | Google ADK | Composio | **AgentOS** |
|-----------|---------|--------|-----------|------------|------------|------------|----------|-------------|
| Primary paradigm | Conversation | Role-based crews | State graphs | Minimal handoffs | Computer use | Event hierarchy | Tool layer | **Org orchestration** |
| Multi-agent | GroupChat | Crews + Flows | Graph nodes | Handoffs | Experimental | Hierarchical | Via frameworks | **Permanent team** |
| Memory | Session | 4-tier built-in | Checkpoint | External | Long-term project | Vertex Memory | Via frameworks | **Career-spanning** |
| MCP | Via adapters | Native | Client | Native | Deepest | Native | Native (IS MCP) | Not yet |
| A2A | Native | Native | Emerging | No | No | Native | Via MCP | Not yet |
| Agent identity | Transient | Role-defined | None | None | Project memory | None | N/A | **Permanent personas** |
| PM integration | None | None | None | None | None | None | GitHub/Jira tools | **Native Linear** |
| Production readiness | Medium | Medium | High | High | High | Medium-High | High (tools) | Early |

---

## AgentOS Differentiators

### What no one else does

1. **Permanent agent identity** — Named roles (CTO, CPO, COO) that persist across sessions and accumulate institutional knowledge. No framework treats agents as org-chart members.

2. **Career-spanning curated memory** — File-based memory per agent role that compounds over time. Not conversation history, not embeddings — curated knowledge that agents read and write.

3. **Native project management** — Linear issues are the interface. No separate task system, no chat-based commands. Work flows through Linear, agents execute through AgentOS.

4. **Organizational hierarchy** — Reporting lines, authority boundaries, delegation chains. CTO dispatches Lead Engineer. CPO dispatches Research Lead. This mirrors how companies actually work.

5. **Observable remote execution** — SSH + tmux sessions on remote machines. `aos jump` drops you into an agent's terminal. Full transparency, zero abstraction between you and the agent's work.

### Gaps to address

1. **MCP support** — Table stakes. Every competitor has it. Required for tool interoperability.
2. **A2A protocol** — Enables interoperability with external agent systems. Google and Microsoft are pushing hard.
3. **Memory pruning/summarization** — Letta's self-editing memory and CrewAI's tiered system are more sophisticated than flat files. Needed as agent memory grows.
4. **Observability/tracing** — LangGraph (LangSmith) and OpenAI SDK have built-in debugging. AgentOS has event logs but no structured tracing.
5. **Evaluation framework** — Mastra and LangGraph include evals. Needed for measuring agent quality over time.

---

## Strategic Recommendation

AgentOS should position as **the operating system layer above agent frameworks** — not competing with CrewAI or LangGraph, but sitting on top of them. The tagline "AI executives, not AI tools" is the right framing.

**Short-term (launch):** Emphasize the organizational model, persistent memory, and Linear integration. These are unique and defensible.

**Medium-term:** Add MCP support to use Composio/other tool ecosystems. Add A2A to interoperate with AutoGen/CrewAI agents. Implement memory pruning inspired by Letta.

**Long-term:** Become the standard for how AI teams are organized — the "Kubernetes for AI agents" where the agents are workers, not containers.

---

*Sources: GitHub repositories, official documentation, framework comparison articles (Turing, Shakudo, 47Billion), and web research as of March 2026.*
