# CTO Technical Feasibility Assessment — RYA-60

**Date**: 2026-03-25
**Author**: CTO
**Input to**: One-Person Company Strategy (RYA-60)

---

## Purpose

Technical feasibility assessment of all 10 business ideas from the Research Lead's strategy document. For each idea: what exists today, what needs to be built, how long it takes, and whether one person can maintain it.

---

## Portfolio Technical Inventory (Current State)

| Asset | LOC | Tests | Maturity | Deployable Today? |
|-------|-----|-------|----------|-------------------|
| AgentOS | 9.7K | 213 | Production (single-tenant) | Yes (iMac) |
| BookFactory | ~16.8K files | Yes | Prototype | Self-hosted only |
| RyanHub | ~38.4K files | Yes | MVP | iOS + bridge server |
| Cortex | ~10K Python | Yes | Prototype | No (needs packaging) |
| Fluent | ~11.3K files | Yes | MVP | Yes (Vercel) |
| ccinit | 467 TS | 30 | Ready for npm | npm publish pending |
| Claude Code Manager | 8 PY | 8 | MVP | Yes (PyPI + GitHub Actions) |
| Behavioral-Sim | 42 PY | No | Research | No |
| Automaton | ~9.3K files | Yes | Research | Yes (GitHub Actions) |
| BIR Compiler | ~3K | 103 | Research | No (CLI only) |

---

## Technical Feasibility by Idea

### Idea 1: AI Agent Consulting — FEASIBILITY: HIGH (★★★★★)

**What exists**: AgentOS (production), State of AI Agents report (published), framework comparison research, ccinit CLI.

**Technical build required**:
- Landing page: 1 day (static site, Vercel)
- Portfolio site showing AgentOS architecture: 2 days
- "Agent Readiness Scorecard" template: 1 day
- Blog infrastructure: 1 day (Ghost, Substack, or Next.js + MDX)

**Solo maintainability**: Trivially maintainable. Consulting is human-delivered. The only tech is marketing infrastructure.

**Technical moat**: Not in the code — in the *experience* of running AgentOS. The moat is institutional knowledge of what breaks when you deploy multi-agent systems (rate limiting, memory staleness, dispatch race conditions, cost tracking). This is hard-won and not replicable by reading docs.

**Architecture risk**: None. This is services, not product.

**CTO verdict**: Zero technical blockers. Can start tomorrow.

---

### Idea 2: Proactive Wellness AI (iOS) — FEASIBILITY: HIGH (★★★★☆)

**What exists**:
- BIR Compiler: 8 primitive extractors, 4-pass pipeline, 103 tests
- PULSE/PAA research: uncertainty-aware scheduling, affect inference
- Apple Foundation Models (iOS 26): on-device 3B LLM, zero inference cost

**Technical build required**:

| Component | Effort | Complexity |
|-----------|--------|------------|
| Swift/SwiftUI iOS app shell | 1 week | Low |
| HealthKit integration (steps, sleep, heart rate) | 1 week | Medium |
| BIR compiler port to Swift (or on-device inference) | 2-3 weeks | High |
| Apple Foundation Models integration | 1 week | Medium (new API) |
| Notification system (proactive coaching) | 3 days | Low |
| Backend (user accounts, anonymized analytics) | 1 week | Medium |
| App Store submission + review | 1 week | Low (bureaucratic) |

**Total**: 6-8 weeks to MVP, consistent with Research Lead estimate.

**Key technical decisions**:

1. **BIR on-device vs cloud**: Port primitives to Swift for privacy story + zero marginal cost. Apple Foundation Models handles the "interpretation" pass. Cloud only for anonymized aggregates.

2. **Data pipeline**: HealthKit → BIR primitives (on-device) → Foundation Models narration (on-device) → proactive notification. Entire pipeline runs offline.

3. **Apple Foundation Models advantage**: Competitors using GPT-4/Claude API pay ~$0.01-0.10 per user per day. On-device = $0 marginal cost. At 10K users this saves $3-30K/month. Structural cost advantage.

**Solo maintainability**: Medium. iOS apps need regular updates for OS changes. HealthKit API is stable but Foundation Models is brand new (iOS 26 beta). Budget 4-8 hours/month for maintenance.

**Technical moat**: HIGH. The BIR compiler is novel (no competitor has a behavioral episode extraction pipeline). The combination of BIR + on-device LLM + HealthKit is architecturally unique. A competitor would need to:
1. Build their own behavioral extraction pipeline (6+ months of research)
2. Understand sensor semantics (PhD-level knowledge)
3. Integrate with Apple Foundation Models (available to all, but meaningless without behavioral understanding)

**Architecture risk**: Apple Foundation Models is brand new (iOS 26). API could change between beta and release. Mitigation: keep Foundation Models integration behind an abstraction layer. Fall back to rule-based narration if needed.

**CTO verdict**: Technically very strong. The on-device architecture is a genuine structural advantage. Main risk is iOS 26 API stability.

---

### Idea 3: AI Agent Mastery (Course) — FEASIBILITY: HIGH (★★★★★)

**What exists**: AgentOS (working system to demo), State of AI Agents report (curriculum source), framework comparison research.

**Technical build required**:
- Course platform: None (use Maven, Teachable, or Podia — $39-99/mo)
- Landing page + email capture: 1 day
- Recording setup: Screencast software (OBS/Loom), existing hardware
- Community platform: Discord or Circle ($89/mo)

**Solo maintainability**: Trivially maintainable. Course content is static once recorded. Community requires 2-4 hours/week moderation.

**Technical moat**: LOW for the platform itself, HIGH for the content. The course value is Zhiyuan's operational experience, not the course technology. Anyone can set up Teachable; nobody else can teach from the experience of running a 6-agent AI company.

**CTO verdict**: No technical build. The "product" is Zhiyuan's knowledge. Platform is commodity infrastructure.

---

### Idea 4: BookFactory Pro (SaaS) — FEASIBILITY: MEDIUM (★★★☆☆)

**What exists**: BookFactory codebase (iOS app + bridge server), working book generation pipeline.

**Technical build required**:

| Component | Effort | Notes |
|-----------|--------|-------|
| Web frontend (React/Next.js) | 2 weeks | Replace iOS-only interface |
| Auth + Stripe billing | 3 days | Standard SaaS boilerplate |
| Multi-tenant backend | 1 week | User isolation, API rate limiting |
| Content generation pipeline improvements | 1 week | Quality, citation handling |
| File export (PDF, EPUB, DOCX) | 3 days | Libraries exist |
| Hosting + CI/CD | 2 days | Vercel + Railway/Fly.io |

**Total**: 4-6 weeks to SaaS-ready MVP.

**Solo maintainability**: MEDIUM-HIGH. SaaS requires uptime monitoring, billing support, content quality moderation. Budget 8-12 hours/week for ops.

**Technical moat**: LOW. LLM-based content generation is commoditizing fast. Every major model can generate books. Differentiation must come from:
- Workflow (research → outline → draft → edit pipeline)
- Quality (citation handling, fact-checking, structured argumentation)
- Niche (research-backed non-fiction specifically)

**CTO verdict**: Technically straightforward but strategically questionable. The moat is dissolving as models improve. Would not invest 4-6 weeks here when consulting generates revenue immediately with zero build.

---

### Idea 5: AgentOS Cloud — FEASIBILITY: LOW (★★☆☆☆)

**What exists**: AgentOS 9.7K LOC, production single-tenant.

**What's missing for multi-tenant SaaS** (from audit):

| Blocker | Effort | Priority |
|---------|--------|----------|
| Webhook signature verification | 2 hours | P0 security |
| Multi-tenant data model (org_id in all tables) | 3 days | P0 isolation |
| Per-tenant Linear OAuth flow | 3 days | P0 auth |
| API authentication on all routes | 1 day | P0 security |
| Persistent dedup state (in-memory → SQLite) | 4 hours | P1 reliability |
| Queue completion lifecycle fix | 1 day | P1 metrics |
| Cost tracking integration | 3 days | P1 budget |
| SQLite → Postgres migration | 2 days | P1 scaling |
| Docker packaging | 2 days | P1 deployment |
| Kubernetes + auto-scaling | 2 weeks | P2 ops |
| Admin dashboard | 1 week | P2 management |
| Monitoring + alerting | 1 week | P2 ops |

**Total**: 8-12 weeks to beta, 4-6 months to production-grade.

**Solo maintainability**: LOW. Multi-tenant SaaS requires:
- 24/7 uptime (agents run anytime)
- Security response (webhook auth, data isolation)
- Billing + support
- Infrastructure ops (Kubernetes, database, monitoring)
- Per-customer Linear OAuth token management

This is a full-time ops job. One person running multi-tenant agent orchestration infrastructure is a recipe for burnout.

**Technical moat**: HIGH. The "agents as team members" organizational metaphor is genuinely novel. Death-and-resurrection pattern, persistent memory, quality gates, priority queue — no competitor has this. But moat doesn't matter if you can't maintain the infrastructure.

**CTO verdict**: Technically the most interesting but operationally the riskiest for a solo founder. The right play is: (1) keep AgentOS open-source as credibility builder, (2) offer managed deployment via consulting, (3) only build SaaS if consulting revenue funds a small ops team.

---

### Idea 6: Behavioral Data API (B2B) — FEASIBILITY: MEDIUM (★★★☆☆)

**What exists**: BIR Compiler (3K LOC, 103 tests, 8 extractors, 4-pass pipeline). Research prototype only.

**Technical build required**:

| Component | Effort | Notes |
|-----------|--------|-------|
| REST API wrapper (FastAPI) | 3 days | Standard |
| Auth + API key management | 2 days | Standard |
| File upload + async processing | 1 week | Job queue for large datasets |
| Output format standardization | 3 days | JSON schema, versioning |
| HIPAA-compliant hosting | 2 weeks | AWS HIPAA BAA, encryption, audit logs |
| Documentation + SDK | 1 week | OpenAPI spec, Python/JS clients |
| Rate limiting + billing | 1 week | Usage-based metering |

**Total**: 6-8 weeks to API, +4-6 weeks for HIPAA compliance.

**Solo maintainability**: MEDIUM. API uptime is table stakes for B2B. HIPAA compliance requires ongoing security audits, penetration testing, documentation updates. Budget 12-16 hours/week.

**Technical moat**: VERY HIGH. Nobody else has a behavioral episode extraction pipeline. Terra API and Human API aggregate raw data; BIR interprets it. This is a genuine research moat that takes years to replicate.

**CTO verdict**: Technically solid but commercially premature. BIR evaluation showed downstream prediction kill criteria were met (doesn't improve affect prediction over raw sensors). The interpretability story is strong but the prediction story is weak. Need published papers establishing BIR's value before B2B customers will pay. Sequence: papers → design partners → API → product.

---

### Idea 7: MCP Server Marketplace — FEASIBILITY: MEDIUM (★★★☆☆)

**What exists**: MCP knowledge from AgentOS research. No marketplace code.

**Technical build required**:

| Component | Effort | Notes |
|-----------|--------|-------|
| Next.js marketplace frontend | 2 weeks | Search, categories, detail pages |
| MCP server registry backend | 1 week | Metadata, versioning, search |
| MCP server hosting (sandboxed) | 3 weeks | Security isolation is hard |
| Payment integration | 1 week | Stripe Connect for creators |
| Review + quality system | 1 week | Automated testing, manual review |

**Total**: 6-8 weeks. Server hosting is the hard part (sandboxed execution of arbitrary MCP servers requires container isolation, resource limits, monitoring).

**Solo maintainability**: LOW. Marketplace = two-sided platform. Need supply (server creators) AND demand (users). Moderation, security scanning, dispute resolution. Plus hosting arbitrary code has serious security implications.

**Technical moat**: LOW. MCP.so already has 18,900 servers cataloged. Cloudflare entering hosting. Protocol could change (MCP is pre-1.0 in some areas). Platform risk.

**CTO verdict**: Do not build. Marketplace businesses need liquidity to work. One person cannot build supply, demand, and infrastructure simultaneously. The hosting security surface area alone is a full-time job.

---

### Idea 8: AI Research-as-a-Service — FEASIBILITY: HIGH (★★★★★)

**What exists**: State of AI Agents report (published), framework comparison research, landscape scans.

**Technical build required**: Same as consulting (Idea 1) — minimal marketing infrastructure.

**Solo maintainability**: Trivially maintainable. Reports are one-time deliverables.

**CTO verdict**: Bundle with consulting (Idea 1). Same client relationships, same skills, different deliverable format. Not a standalone business.

---

### Idea 9: Personal AI OS (iOS) — FEASIBILITY: MEDIUM (★★★☆☆)

**What exists**: RyanHub (iOS app with PersonalContext bus), AgentOS (agent orchestration).

**Technical build required**: Full iOS app rewrite targeting consumer UX (RyanHub is personal/internal). 8-12 weeks.

**Solo maintainability**: MEDIUM. iOS app maintenance + cloud backend.

**CTO verdict**: Crowded market (Notion AI, Motion, Reclaim.ai all have AI features). The multi-agent angle is novel but unclear if consumers want "agents managing my life" vs simpler AI assistants. High effort, uncertain demand. Skip.

---

### Idea 10: Academic Writing Tool — FEASIBILITY: MEDIUM (★★★☆☆)

**What exists**: No existing code. Research experience (pain points understood).

**Technical build required**: Full build from scratch. Web app + LLM pipeline + citation management + collaboration features. 8-12 weeks.

**Solo maintainability**: MEDIUM. Standard SaaS ops.

**CTO verdict**: Technically achievable but market is price-sensitive (academics) and dominated by well-funded players entering the space (Elicit, Semantic Scholar adding writing features). Skip.

---

## CTO Rankings: Technical Feasibility × Commercial Viability

| Rank | Idea | Tech Feasibility | Moat | Time to Revenue | Solo Viable? | Score |
|------|------|------------------|------|-----------------|-------------|-------|
| **1** | Agent Consulting | ★★★★★ | Knowledge | 2 weeks | Yes | **10** |
| **2** | Wellness iOS App | ★★★★☆ | BIR + on-device AI | 8 weeks | Yes | **9** |
| **3** | Course + Community | ★★★★★ | Content | 3 weeks | Yes | **8** |
| **4** | Research-as-a-Service | ★★★★★ | Knowledge | 1 week | Yes (bundle w/ #1) | **7** |
| **5** | BookFactory SaaS | ★★★☆☆ | Low (commoditizing) | 6 weeks | Marginal | **5** |
| **6** | Behavioral Data API | ★★★☆☆ | Very High | 12+ weeks | Marginal | **5** |
| **7** | AgentOS Cloud | ★★☆☆☆ | High | 12+ weeks | No | **4** |
| **8** | MCP Marketplace | ★★★☆☆ | Low | 8+ weeks | No | **3** |
| **9** | Personal AI OS | ★★★☆☆ | Low | 12+ weeks | Marginal | **3** |
| **10** | Academic Writing | ★★★☆☆ | Low | 10+ weeks | Marginal | **2** |

---

## Key Technical Insight: The "Build Less" Strategy

The highest-scoring ideas (consulting, course, research) require the **least** new code. The most technically ambitious ideas (AgentOS Cloud, MCP Marketplace) are the **riskiest** for a solo founder.

This is not a coincidence. For a one-person company:
- **Infrastructure is the enemy.** Every server you run is a pager you carry.
- **Code is liability.** Every feature is a maintenance burden.
- **Knowledge is the product.** Zhiyuan's years of building and researching are the moat — not the code itself.

The optimal technical strategy is:
1. **Sell knowledge, not software** (consulting + course)
2. **Build one product** (wellness iOS app — on-device, no server costs, App Store handles distribution)
3. **Open-source everything else** (AgentOS, BIR, ccinit — credibility builders, not revenue sources)

---

## Architecture Sketch: Proactive Wellness iOS App (Top Product Idea)

```
┌─────────────────────────────────────────────────┐
│                    iOS App                       │
│                                                  │
│  ┌───────────┐   ┌──────────────┐   ┌────────┐ │
│  │ HealthKit │   │ BIR Engine   │   │ Apple  │ │
│  │ Adapter   │──▶│ (Swift port) │──▶│ Found. │ │
│  │           │   │              │   │ Models │ │
│  │ • Steps   │   │ • Primitives │   │        │ │
│  │ • Sleep   │   │ • Episodes   │   │ • Coach│ │
│  │ • HR/HRV  │   │ • Baselines  │   │ • Narr.│ │
│  │ • Screen  │   │              │   │        │ │
│  └───────────┘   └──────────────┘   └────┬───┘ │
│                                          │      │
│  ┌───────────────────────────────────────▼────┐ │
│  │          Proactive Notification Engine      │ │
│  │  • Uncertainty-aware scheduling (AskLess)   │ │
│  │  • Context-appropriate timing               │ │
│  │  • Behavioral micro-interventions           │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │          SwiftUI Dashboard                  │ │
│  │  • Today's behavioral episodes              │ │
│  │  • 7-day trends                             │ │
│  │  • Personal baseline deviations             │ │
│  │  • AI coaching insights                     │ │
│  └────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────┘
                           │ (anonymized, opt-in)
                    ┌──────▼──────┐
                    │ Cloud Sync  │
                    │ (optional)  │
                    │ • Backup    │
                    │ • Analytics │
                    │ • A/B tests │
                    └─────────────┘
```

**Key property**: Entire AI pipeline runs on-device. No API costs. No latency. Full privacy. Cloud is optional for backup and anonymized analytics only.

**BIR Swift Port Scope** (biggest technical effort):
- Port 4 primitives initially: sleep_debt, activity_bout, circadian_shift, screen_engagement
- Defer: mobility, social_proxy, typing_sentiment (need data sources not in HealthKit)
- Port personal baseline engine (14-day rolling z-scores)
- Skip semantic typing pass (Foundation Models handles interpretation)

**Apple Foundation Models Integration**:
```swift
// Pseudo-architecture
let episodes = birEngine.extractEpisodes(from: healthKitData)
let deviations = birEngine.computeDeviations(episodes, baseline: userBaseline)

// Foundation Models interprets behavioral state
let coaching = try await FoundationModel.generate(
    prompt: "Given these behavioral episodes: \(episodes.summary), " +
            "and deviations from baseline: \(deviations), " +
            "provide a brief, actionable coaching insight.",
    schema: CoachingInsight.self  // @Generable struct
)

// Schedule proactive notification
if coaching.urgency > threshold && askLessPolicy.shouldQuery(budget: remaining) {
    NotificationCenter.schedule(coaching.message, at: optimalTime)
}
```

---

## Architecture Sketch: Consulting Technical Infrastructure

```
┌──────────────────────────────────────────────┐
│              Marketing Stack                  │
│                                               │
│  Landing Page (Vercel)                        │
│  ├── Service descriptions                    │
│  ├── Case studies (AgentOS, framework report) │
│  ├── Calendly embed (discovery calls)        │
│  └── Email capture (ConvertKit/Buttondown)   │
│                                               │
│  Blog (Next.js + MDX or Substack)            │
│  ├── Agent architecture deep-dives           │
│  ├── Framework comparisons                   │
│  └── Build-in-public updates                 │
│                                               │
│  Open Source (GitHub)                         │
│  ├── AgentOS (credibility, stars)            │
│  ├── ccinit (dev tool, distribution)         │
│  └── State of AI Agents (thought leadership) │
└──────────────────────────────────────────────┘

Consulting Delivery:
  - Agent Architecture Audit → written report + presentation
  - Framework Selection → comparison matrix + recommendation
  - Implementation Review → code review + architecture guidance
  - Ongoing Advisory → monthly retainer, Slack/Linear access
```

**Total infrastructure cost**: ~$50/month (Vercel free, Calendly $8/mo, email tool $29/mo, domain $12/yr).

---

## Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Apple Foundation Models API changes (iOS 26 beta) | Medium | High | Abstraction layer, rule-based fallback |
| Consulting market saturation | Low | Medium | Differentiate on operational experience, not theory |
| BIR Swift port takes longer than estimated | Medium | Medium | Ship with 4 primitives, add more incrementally |
| Course doesn't fill (no audience) | Medium | Low | Blog-first to build audience before launching course |
| AgentOS gets cloned by competitor | Low | Low | Knowledge moat, not code moat. Open-source proactively. |
| HIPAA requirements for wellness app | Low | High | Stay consumer-only (no clinical claims), avoid PHI storage |

---

## Final CTO Recommendation

**Phase 1 (Weeks 1-4)**: Consulting + blog. Zero technical build. Revenue from day 30.

**Phase 2 (Weeks 4-12)**: Wellness iOS app development in parallel with consulting. Use Apple Foundation Models for on-device AI. Port BIR primitives to Swift. Target TestFlight beta by week 10.

**Phase 3 (Months 3-6)**: Course launch using consulting insights + blog audience. Continue wellness app iteration based on beta feedback.

**What to open-source** (brand building, not revenue):
- AgentOS (already on GitHub)
- ccinit (publish to npm)
- State of AI Agents report (already published)
- BIR Compiler (after paper submission)

**What NOT to build**:
- AgentOS Cloud (too much ops for one person)
- MCP Marketplace (two-sided platform problem)
- BookFactory SaaS (commoditizing market)
- Academic Writing Tool (price-sensitive niche)

The gap is distribution, not engineering. Every hour spent coding a new product is an hour not spent building audience and generating consulting revenue. Build less, sell more.
