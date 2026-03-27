# RYA-60: CTO Technical Feasibility Assessment

## One-Person Company Ideas for Zhiyuan Wang

**Author**: CTO | **Date**: 2026-03-24
**Scope**: Technical feasibility, reusable assets, moat analysis, time-to-MVP

---

## CEO Technical Profile (Verified from Portfolio)

| Capability | Evidence | Depth |
|------------|----------|-------|
| AI/ML + Behavioral Science | PAA (9 sensor modalities), behavioral-sim (32 channels), BIR compiler (4-pass pipeline), PhD research | Expert |
| Agent Systems | AgentOS (8.5K LOC, 225 tests, 6 persistent agents, production-tested) | Expert |
| iOS (Swift/SwiftUI) | RyanHub (PersonalContext bus, hub-and-spoke), BookFactory iOS client | Strong |
| Full-stack TypeScript | AgentOS, BookFactory bridge server, Cortex, Fluent PWA | Strong |
| Python ML Pipeline | PAA feature extraction, behavioral-sim, BIR primitives | Strong |
| DevTools / CLI | claude-code-manager, RTK, linear-tool | Moderate |
| Infrastructure | tmux orchestration, SQLite state, OAuth, Tailscale networking | Moderate |

**Unique intersection**: Very few people combine Meta Reality Labs research credentials + production multi-agent systems + iOS + behavioral AI. This intersection IS the moat.

---

## Business Ideas: Technical Feasibility Assessment

### Idea 1: AI Agent Orchestration Platform (AgentOS Cloud)

**Concept**: Open-source AgentOS + managed hosting with per-seat/per-agent pricing.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | AgentOS (8.5K LOC, 225 tests), persona system, memory persistence, queue, routing — all production-tested |
| **Tech stack fit** | Perfect — TypeScript/Node.js/SQLite already built |
| **Time to MVP** | 4-5 weeks |
| **Technical moat** | HIGH — death & resurrection pattern, persistent agent memory, Linear-native orchestration are genuinely novel. No competitor does organizational persistence. |
| **Solo feasibility** | MEDIUM — multi-tenant isolation, hosted execution environments, and security sandboxing are significant solo-founder challenges |

**Key technical gaps for commercialization**:
1. Multi-tenancy: Currently single-tenant (one SQLite DB, one tmux server). Need tenant isolation.
2. Hosted execution: Agents run on local iMac via tmux. Cloud version needs sandboxed containers per tenant.
3. Billing integration: Budget system exists but cost tracking is non-functional (RYA-56).
4. Onboarding: `aos setup` requires local Linear API key + OAuth + tmux. Cloud version needs zero-setup flow.
5. Security: Agent sessions need sandboxing — currently agents can access full filesystem.

**Verdict**: Highest ceiling, but 4-5 weeks to MVP is optimistic for solo. Multi-tenancy alone is a 2-week effort. Better as a Phase 2 after establishing revenue through services.

---

### Idea 2: AI Agent Consulting + Education Bundle

**Concept**: Fractional CTO / AI agent implementation consulting + paid course/workshop on building production multi-agent systems.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | All projects serve as portfolio proof. AgentOS is the showcase. |
| **Tech stack fit** | N/A — services business, not product |
| **Time to MVP** | 0-1 week (landing page + first module/talk) |
| **Technical moat** | HIGH — very few people have built production multi-agent systems. PhD + Meta RL = extreme credibility. |
| **Solo feasibility** | HIGH — no infrastructure to maintain, scales with reputation |

**Why this is technically compelling**:
- AgentOS is a *running* multi-agent system (not a demo) — clients can see agents working in real-time
- Death & resurrection pattern, persistent memory, organizational hierarchy — these are solved problems with working code
- The combination of research (behavioral AI) + engineering (production systems) is rare
- Can monetize immediately: workshop ($500-2K), consulting ($200-400/hr), course ($100-500)

**Technical requirements**:
1. Landing page with portfolio showcase (1 day)
2. First workshop module: "Building Production AI Agents" (3-5 days to record)
3. AgentOS demo environment for live demonstrations (already exists)

**Verdict**: Fastest path to revenue. Zero technical risk. Builds brand while you decide which product to build.

---

### Idea 3: Developer Tools for AI Agent Workflows

**Concept**: Paid CLI tools / VS Code extensions for developers building AI agent systems. Think "Postman for agents" — debugging, testing, observing multi-agent interactions.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | claude-code-manager, linear-tool patterns, AgentOS observability (jump, watch, status) |
| **Tech stack fit** | Perfect — TypeScript CLI + VS Code extension API |
| **Time to MVP** | 2-3 weeks |
| **Technical moat** | MEDIUM — tooling moat comes from ecosystem, not technology. Early mover advantage matters. |
| **Solo feasibility** | HIGH — dev tools are the classic solo-founder product category |

**What to build first (most validated pain point)**:
- **Agent session debugger**: Replay, inspect, and debug multi-agent conversations. No good tooling exists for this.
- **Agent memory inspector**: Visual interface for viewing/editing/comparing agent memory across sessions.
- **Multi-agent test harness**: Define scenarios, run agents, assert on outcomes. Currently everyone tests manually.

**Technical requirements**:
1. TypeScript CLI with rich terminal UI (ink or blessed)
2. Protocol-agnostic agent session format (support Claude Code, OpenAI, custom)
3. VS Code extension for inline session inspection

**Verdict**: Good solo-founder fit. Dev tools have proven distribution (open core, GitHub, ProductHunt). 2-3 weeks to a testable MVP.

---

### Idea 4: AI-Powered Book/Content Generation Platform

**Concept**: Productize BookFactory as a SaaS — users input topic/outline, get formatted book/course/guide.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | BookFactory (bridge server, AI pipeline, iOS client, JWT auth) |
| **Tech stack fit** | TypeScript backend, Swift iOS — already built |
| **Time to MVP** | 2-3 weeks (add web frontend + Stripe) |
| **Technical moat** | LOW — LLM API wrappers for content generation are commoditizing rapidly. Jasper, Copy.ai, Sudowrite, dozens of others. |
| **Solo feasibility** | HIGH — technically simple |

**Honest assessment**: The pipeline works, but there's no defensible technology here. Anyone with an OpenAI API key can build this. The differentiation would have to come from product design (workflow, templates, distribution format), not technology.

**Verdict**: Easy to build but hard to defend. Only viable if you find a niche with unique distribution (e.g., academic course material, technical documentation).

---

### Idea 5: Behavioral AI / Wellness Intelligence API

**Concept**: B2B API that transforms raw wearable/sensor data into structured behavioral insights using BIR (Behavioral Intermediate Representation).

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | BIR compiler (4-pass pipeline, 8 primitive extractors, 103 tests), PAA feature extraction (9 modalities), behavioral-sim |
| **Tech stack fit** | Python ML stack — research-grade, needs productionization |
| **Time to MVP** | 6-8 weeks |
| **Technical moat** | VERY HIGH — novel research (BIR schema), PhD expertise, IMWUT publication pipeline. This is genuinely hard to replicate. |
| **Solo feasibility** | LOW-MEDIUM — B2B enterprise sales cycle, compliance (health data), trust requirements |

**Technical maturity assessment**:
- BIR compiler: Week 1 complete, all 4 passes working, 103 tests passing
- Primitive extractors: 8 implemented (SleepDebt, ActivityBout, CircadianShift, Mobility, RoutineDeviation, ScreenEngagement, SocialProxy, TypingSentiment)
- PAA: Production-ready feature extraction for GPS, motion, screen, keyboard
- Gap: No REST API layer, no documentation, no self-serve onboarding, no compliance framework (HIPAA)

**Verdict**: Highest technical moat of all ideas. But 6-8 weeks to MVP, enterprise sales cycle, and HIPAA compliance make this a Phase 2/3 play. Start as consulting → productize when patterns emerge.

---

### Idea 6: iOS Productivity App with AI (PersonalContext Hub)

**Concept**: AI-powered personal productivity app that learns your behavior patterns and proactively helps. Built on RyanHub's PersonalContext bus architecture.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | RyanHub (PersonalContext bus, hub-and-spoke architecture, Swift/SwiftUI) |
| **Tech stack fit** | Swift/SwiftUI — strong capability |
| **Time to MVP** | 3-4 weeks |
| **Technical moat** | MEDIUM — PersonalContext bus is innovative (every module enriches every message), but App Store discovery is brutal |
| **Solo feasibility** | MEDIUM — iOS dev is solo-friendly, but marketing/distribution is the bottleneck |

**Technical considerations**:
- PersonalContext bus pattern is genuinely novel — contextual AI that improves across all app modules
- iOS on-device ML capabilities are strong (Core ML, Create ML) — can run behavioral models locally
- Privacy advantage: on-device processing = no cloud data storage = easier compliance
- Challenge: App Store review process, marketing spend, user acquisition cost

**Verdict**: Technically solid. The PersonalContext bus is a differentiator. But consumer apps require significant marketing investment that's hard to do solo. Better as a companion to a consulting/B2B business.

---

### Idea 7: AI Agent Workshop & Course Platform

**Concept**: Premium online course teaching how to build production multi-agent systems, using AgentOS as the reference implementation.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | AgentOS (living example), all documentation, architecture decisions, memory system design |
| **Tech stack fit** | Content creation, not engineering |
| **Time to MVP** | 1-2 weeks (first module) |
| **Technical moat** | HIGH — the course IS the moat. Very few people have production multi-agent experience to teach from. |
| **Solo feasibility** | HIGH — platforms like Podia, Teachable handle infrastructure |

**Course outline potential**:
1. From chatbot to agent: persistent identity and memory
2. Multi-agent orchestration: routing, dispatch, delegation
3. Agent communication protocols (Linear-native, MCP)
4. Quality gates and observability
5. Death & resurrection: making ephemeral sessions feel permanent
6. Production deployment: tmux, monitoring, error recovery

**Verdict**: Low technical risk, high leverage. Content compounds — one course recording serves thousands. Builds thought leadership directly.

---

### Idea 8: Proactive AI Assistant SDK

**Concept**: SDK/framework for building AI assistants that act proactively (not just reactively). Based on the proactive-affective-agent research.

| Dimension | Assessment |
|-----------|------------|
| **Reusable assets** | PAA research, AskLess uncertainty-aware query policy, behavioral-sim director architecture |
| **Tech stack fit** | Python SDK + JavaScript SDK |
| **Time to MVP** | 4-6 weeks |
| **Technical moat** | HIGH — proactive AI is an emerging paradigm. Research credentials + working prototypes = strong position. |
| **Solo feasibility** | MEDIUM — SDK requires documentation, examples, community building |

**What makes this technically distinct**:
- Most AI SDKs are reactive (user asks → AI responds). This SDK enables AI that initiates actions based on behavioral context.
- AskLess query policy: decide WHEN to interrupt the user (not just HOW to respond)
- Uncertainty-aware: only interrupt when the model is genuinely uncertain and needs user input
- Cross-modal: combine sensor data, calendar, communication patterns for context

**Verdict**: Technically exciting, academically rigorous, but needs the research papers published first to establish credibility. Best launched alongside IMWUT publications.

---

## Top 3 Ranked Recommendations (CTO Perspective)

### Ranking Criteria
- **Technical Moat**: How defensible is the technology?
- **Time to Revenue**: How quickly can this generate cash?
- **Solo Viability**: Can one person build AND sell this?
- **Leverage**: Does early work compound into later value?

### #1: AI Agent Consulting + Education (Ideas 2 + 7 combined)

**Why #1**: Zero technical risk, immediate revenue, builds the brand that makes every other idea easier to launch. The portfolio IS the product.

| Factor | Score |
|--------|-------|
| Technical Moat | HIGH (credentials + working system) |
| Time to Revenue | 1-2 weeks |
| Solo Viability | HIGH |
| Leverage | VERY HIGH (brand compounds) |

**The flywheel**: Consulting → discover real pain points → build targeted product → course teaches the approach → more consulting leads. Every activity feeds the others.

**Technical investment**: Minimal. Polish AgentOS demo, record workshop content, create live demo environment. Everything already exists.

### #2: Developer Tools for AI Agent Workflows (Idea 3)

**Why #2**: Classic solo-founder category. Dev tools have proven distribution. Quick to MVP. And the pain is real — everyone building multi-agent systems is debugging manually.

| Factor | Score |
|--------|-------|
| Technical Moat | MEDIUM (early mover + ecosystem) |
| Time to Revenue | 3-4 weeks |
| Solo Viability | HIGH |
| Leverage | HIGH (open core → enterprise) |

**First product**: Agent session debugger/inspector. Think "Chrome DevTools for agent conversations." This is validated by our own experience — `aos jump` exists because we needed it.

### #3: AgentOS Open Source + Managed Cloud (Idea 1)

**Why #3**: Highest ceiling of all ideas. Genuinely novel technology. But multi-tenancy + hosted execution + security sandboxing is a significant engineering investment for a solo founder. Better as Phase 2 after consulting revenue funds development.

| Factor | Score |
|--------|-------|
| Technical Moat | VERY HIGH (novel architecture) |
| Time to Revenue | 6-8 weeks |
| Solo Viability | MEDIUM |
| Leverage | VERY HIGH (platform effects) |

**Phase approach**: Open-source first (builds community + credibility) → managed hosting as the monetization layer → enterprise features (SSO, audit logs, compliance).

---

## #1 Idea: 7-14 Day Validation Plan

### "AI Agent Consulting + Education" — Technical Validation Plan

**Goal**: Validate demand and price point before investing in product development.

#### Days 1-2: Foundation
- [ ] Create landing page with portfolio showcase (AgentOS, BIR, PAA)
- [ ] Write 3 positioning statements: "I help companies build production AI agent systems"
- [ ] Set up Calendly with $200/hr consulting slot (introductory rate)
- [ ] Create AgentOS live demo script (5-minute walkthrough showing agents working)

#### Days 3-5: Content Seeding
- [ ] Write and publish 2 technical blog posts:
  1. "Death & Resurrection: How We Made AI Agents Remember" (based on AgentOS memory architecture)
  2. "6 AI Agents, One Engineer: Running an AI Company with AgentOS" (the organizational metaphor)
- [ ] Post on HackerNews, Twitter/X, LinkedIn with live demo video
- [ ] Record first 15-minute workshop module: "From Chatbot to Agent: Adding Persistent Memory"

#### Days 6-8: Outreach
- [ ] Identify 20 companies actively hiring for "AI agent" roles (these are the ones struggling to build)
- [ ] Cold-email 10 CTOs/VPEs with portfolio link + offer: "Free 30-min architecture review"
- [ ] Engage in 5 relevant Discord/Slack communities (LangChain, AutoGen, CrewAI)
- [ ] Reach out to 3 AI-focused podcasts/newsletters for guest appearance

#### Days 9-11: Workshop MVP
- [ ] Record full 2-hour workshop: "Building Production Multi-Agent Systems"
- [ ] Modules: Agent identity, memory, orchestration, delegation, quality gates, observability
- [ ] Host on Podia/Teachable with $149 early-bird price
- [ ] Create follow-up email sequence for workshop attendees → consulting pipeline

#### Days 12-14: Validate & Decide
- [ ] Analyze: Landing page visitors, Calendly bookings, workshop sign-ups
- [ ] Conduct at least 2 free architecture review calls — learn pain points
- [ ] Decision gate:
  - **≥3 paid bookings**: Scale consulting, build course
  - **≥50 workshop sign-ups**: Double down on education
  - **Strong interest in hosted AgentOS**: Pivot to Idea #3 (AgentOS Cloud)
  - **Strong interest in dev tools**: Pivot to Idea #2 (Agent DevTools)

**Technical requirements for validation period**: Landing page (Framer/Vercel, 1 day), blog platform (Substack, free), workshop recording (OBS + slides, free), demo environment (existing AgentOS on iMac).

---

## Personal Brand Strategy (Technical Perspective)

### Content Pillars (in order of technical differentiation)

1. **"AI agents as team members"** — organizational metaphor, persistent identity, memory
2. **"Behavioral AI"** — proactive assistance, uncertainty-aware systems, sensor fusion
3. **"Solo founder × AI"** — building with AI agents, force multiplication, what works and what doesn't

### Technical Content Cadence
- Weekly: One technical post (architecture decision, debugging story, research insight)
- Monthly: One live demo / workshop recording
- Quarterly: One open-source release or research paper

### Platforms (leverage technical credibility)
- **Twitter/X**: Short takes, demo videos, architecture diagrams
- **GitHub**: Open-source AgentOS (star count = social proof)
- **Substack/Blog**: Deep technical writing (2000+ words)
- **YouTube**: Workshop recordings, live coding sessions
- **HackerNews**: Launch posts, Show HN

### Brand Positioning
**"The person who actually runs a company with AI agents"** — not theoretical, not a demo, not a weekend project. A real operating system with real agents doing real work. This is extremely rare and extremely compelling.

---

## Technical Moat Summary

| Idea | Technical Moat | Speed | Solo Viability | Recommendation |
|------|---------------|-------|----------------|----------------|
| AgentOS Cloud | ★★★★★ | ★★☆☆☆ | ★★★☆☆ | Phase 2 |
| Consulting + Education | ★★★★☆ | ★★★★★ | ★★★★★ | **START HERE** |
| Agent Dev Tools | ★★★☆☆ | ★★★★☆ | ★★★★★ | Phase 1B |
| BookFactory SaaS | ★☆☆☆☆ | ★★★★☆ | ★★★★★ | Skip |
| Behavioral AI API | ★★★★★ | ★★☆☆☆ | ★★☆☆☆ | Phase 3 |
| iOS Productivity | ★★★☆☆ | ★★★☆☆ | ★★★☆☆ | Optional |
| Course Platform | ★★★★☆ | ★★★★★ | ★★★★★ | Bundled with #1 |
| Proactive AI SDK | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ | After papers |

**Bottom line**: Start with consulting + education (immediate revenue, brand building, zero technical risk). Use consulting conversations to discover which product to build. The technical portfolio already exists — the gap is distribution, not engineering.
