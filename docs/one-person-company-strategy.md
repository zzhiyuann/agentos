# One-Person Company Strategy for Zhiyuan Wang

**Date**: 2026-03-24
**Author**: Research Lead (RYA-60)
**Status**: Strategy Document — CEO Review Required

---

## Executive Summary

Based on Zhiyuan's rare intersection of behavioral AI research (PhD + Meta Reality Labs), agent orchestration experience (AgentOS), iOS development (Swift/SwiftUI), and full-stack engineering — the highest-conviction path is a **staged approach**: start with AI Agent Consulting to generate cash flow immediately, build a personal brand through an AI agent education platform, then invest profits into a proactive wellness iOS app that leverages the deepest technical moat.

The AI agent market is projected at $10.9B in 2026 (45% CAGR), enterprise adoption is at 72% of Global 2000 companies, and 40%+ of agentic AI projects will fail — creating massive demand for expert guidance. Meanwhile, the wearable health market ($39B) is ripe for someone who uniquely understands both the behavioral science and the engineering.

---

## CEO Profile & Unfair Advantages

| Dimension | Strength | Rarity |
|-----------|----------|--------|
| Behavioral AI research | PhD-level, published, Meta Reality Labs | Top 1% — very few people have both the research depth AND production experience |
| Agent orchestration | Built AgentOS (6 persistent agents, Linear-native, 8.5K LOC) | Unique — no other solo builder has a working org-layer agent system |
| iOS development | Swift/SwiftUI, shipped RyanHub, HealthKit/sensor integration | Common-ish, but rare combined with ML/behavioral science |
| Full-stack engineering | TypeScript/React/Python, Claude API, MCP knowledge | Common, but deep MCP/protocol knowledge is rare |
| Research methodology | IMWUT/CHI-caliber papers (PULSE, BIR, PSI, BehaSim) | Academic credibility that most indie hackers lack |
| Multimodal sensing | Wearable data pipelines, passive sensing, behavioral compilation | Niche expert — maybe 200 people worldwide at this intersection |

**The moat**: The intersection of behavioral science + agent systems + iOS + shipping ability. No competitor has all four.

---

## Business Ideas (10)

### Idea 1: AI Agent Deployment Consulting ("Agent Architect")

**What**: Help enterprises design, deploy, and operationalize AI agent systems. Start as consulting, evolve into productized services (templates, playbooks, audits).

**Market size**: $10.9B AI agent market (2026), services segment growing at 46.3% CAGR. 40% of enterprise apps will embed agents by end of 2026. Gartner predicts 40%+ of agentic AI projects will fail — these companies need expert help.

**Competition**: Big 4 consulting firms (Deloitte, IBM) are entering but charge $300-500/hr. Boutique AI consultancies exist but few have built real agent orchestration systems. Most "AI consultants" are prompt engineers, not agent architects.

**Zhiyuan's unfair advantage**: Actually built and operated a multi-agent system (AgentOS) with persistent memory, delegation, quality gates. Researched every major framework (CrewAI, LangGraph, AutoGen, Google ADK, OpenAI Agents SDK). Can speak to real operational challenges, not just theory.

**Revenue model**:
- Phase 1: Hourly consulting ($200-400/hr) → $15-30K/month at 15-20 hrs/week
- Phase 2: Productized audits ($5K-15K per engagement)
- Phase 3: Agent deployment templates + ongoing retainers ($3K-10K/month)

**Time to MVP**: 1-2 weeks (website + first outreach). Revenue within 30 days.

**Risk**: Consulting doesn't scale easily. Mitigation: productize early, use consulting to build case studies.

---

### Idea 2: Proactive Wellness AI (iOS App — "Pulse" or "Sense")

**What**: An iOS app that uses Apple Watch/Health data + passive sensing to proactively coach users on stress, energy, and mood — before they ask. The app interprets behavioral patterns (sleep debt, activity shifts, circadian disruption) and sends contextual micro-interventions.

**Market size**: $39B AI-powered wearables market (2026). $74B workplace wellness. 86.4M Americans use health wearables. Health coaching market growing rapidly.

**Competition**: ONVY (wearable health insights), Reflectly (AI journaling), Google Pixel Journal (free, basic), Apple Health+ AI Coach (launching 2026). Most competitors are reactive (user logs data) — almost none are truly proactive using passive sensing.

**Zhiyuan's unfair advantage**: Built PULSE (proactive affective agent) — the research prototype for exactly this product. BIR compiler turns raw sensor data into structured behavioral episodes. PhD in behavioral sensing means he understands what the data actually means, not just how to collect it. Has working code for: uncertainty-aware scheduling, passive affect inference, behavioral compilation.

**Revenue model**: Freemium subscription
- Free tier: basic insights, daily summary
- Pro ($9.99/mo): proactive coaching, behavioral patterns, trends
- Premium ($19.99/mo): advanced analytics, personalized intervention plans, API access

Target: 1,000 paying subscribers at $12 avg = $12K MRR within 12 months.

**Time to MVP**: 6-8 weeks (has the ML pipeline from PULSE research, needs iOS wrapper + HealthKit integration)

**Risk**: AI app retention is 30% worse than non-AI apps (RevenueCat 2026). Mitigation: behavioral science approach to habit formation is literally Zhiyuan's expertise. Also: passive sensing means the app works even when the user doesn't actively engage.

**NEW — Apple Foundation Models (iOS 26)**: Apple released a 3B-parameter on-device LLM accessible in 3 lines of Swift code. Zero inference cost, works offline, total privacy. This is a structural advantage: cloud-dependent competitors (ONVY, Reflectly) pay per-API-call; a Foundation Models-based app has zero marginal cost for AI features. Apple is actively featuring apps that use this framework, providing free App Store distribution. This dramatically improves the unit economics and privacy story.

---

### Idea 3: AI Agent Mastery (Course + Community)

**What**: A cohort-based course teaching engineers and technical leaders how to build, deploy, and operate multi-agent systems. Includes hands-on projects, framework comparisons, and real-world architecture patterns.

**Market size**: Online education ($350B+ global). AI education is the fastest-growing segment. Specific to agent systems: nascent but exploding (45% CAGR in agent market = massive demand for education).

**Competition**: DeepLearning.AI (Andrew Ng), fast.ai, various Udemy/Coursera courses on LangChain/CrewAI. Most teach individual framework usage, NOT agent orchestration architecture. Nobody teaches from the perspective of having built a production org-layer system.

**Zhiyuan's unfair advantage**: Built AgentOS (not a tutorial project — a real system with 6 agents, quality gates, priority queues). Researched and compared every major framework. Academic credibility (PhD, IMWUT papers). Can teach both theory (agent architectures, memory systems, coordination protocols) AND practice (debugging, operational challenges, cost management).

**Revenue model**:
- Cohort course: $499-799 per student, 20-30 students per cohort, 1 cohort/quarter = $10K-24K/cohort
- Community membership: $29-49/mo, target 100 members = $3K-5K MRR
- Premium content/templates: $19-99 one-time purchases

**Time to MVP**: 2-3 weeks (curriculum outline + landing page + first cohort waitlist)

**Risk**: Requires personal brand to fill cohorts. Mitigation: combine with open-source content marketing (AgentOS blog posts, framework comparisons).

---

### Idea 4: BookFactory Pro (AI Book Generation SaaS)

**What**: Productize the BookFactory project into a SaaS platform for non-fiction authors, content creators, and businesses to generate high-quality books and long-form content using AI.

**Market size**: $2.8B AI book writing market (2024) → $47.1B by 2034 (32.6% CAGR). Massive growth.

**Competition**: SidekickWriter, Sudowrite, BookAutoAI, Squibler, Automateed. Market is getting crowded with 15+ dedicated tools. However, most focus on fiction or simple non-fiction — few handle technical/research-backed content well.

**Zhiyuan's unfair advantage**: Already has BookFactory codebase. Research background means he can differentiate on content quality (citation handling, fact-checking, structured argumentation). Full-stack skills for rapid SaaS development.

**Revenue model**: SaaS subscription $29-99/mo. Target: 200-500 subscribers = $6K-50K MRR.

**Time to MVP**: 2-4 weeks (productize existing code, add Stripe, landing page)

**Risk**: Crowded market, commoditizing fast as LLMs improve. Differentiation must be sharp (niche: research-backed non-fiction, technical documentation, thought leadership content).

---

### Idea 5: AgentOS Cloud (Managed Agent Orchestration)

**What**: Offer AgentOS as a managed service for small AI-native teams. Linear integration, persistent agent memory, autonomous delegation — all hosted.

**Market size**: $8.5B agent orchestration market. SMB segment underserved — most platforms target enterprise.

**Competition**: CrewAI Enterprise ($6K/yr), LangGraph Cloud ($39/user/mo), Dify (open-source). None offer the "agents as team members" organizational metaphor.

**Zhiyuan's unfair advantage**: AgentOS is the only system treating agents as permanent organizational members. Unique product angle.

**Revenue model**: $99-499/mo per team. Target: 50-100 teams = $5K-50K MRR.

**Time to MVP**: 8-12 weeks (needs multi-tenancy, auth, hosting infrastructure)

**Risk**: Competing with well-funded companies (CrewAI raised $24.5M, LangChain has LangGraph Cloud). Single-person maintenance of infrastructure is challenging. MCP/A2A protocol adoption could commoditize the coordination layer.

---

### Idea 6: Behavioral Data API (B2B Platform)

**What**: Offer the BIR (Behavioral Intermediate Representation) compiler as an API service for digital health companies. Raw wearable data in → structured behavioral episodes out.

**Market size**: Digital health market growing at 21% CAGR. Health sensors market heading to $65.3B by 2032.

**Competition**: No direct competitor offers a "behavioral compiler" service. Closest: raw data platforms (Terra API, Human API) that just aggregate sensor data without interpretation.

**Zhiyuan's unfair advantage**: Invented the BIR concept. Has working compiler code (8 extractors, 4-pass pipeline). Published research backing the approach.

**Revenue model**: API usage-based pricing ($0.01-0.05 per processed day of data) + B2B SaaS ($5K-50K/year per client).

**Time to MVP**: 8-12 weeks (needs API wrapper, auth, documentation, reliability engineering)

**Risk**: Long B2B sales cycle. HIPAA compliance requirements. Need early design partners.

---

### Idea 7: MCP Server Builder / Marketplace

**What**: Build a platform for creating, hosting, and selling MCP (Model Context Protocol) servers. Help businesses connect their tools to AI agents.

**Market size**: MCP market at $1.8B (2025), thousands of servers already. Enterprise MCP adoption accelerating in 2026.

**Competition**: Smithery, Mintlify's mcpt, OpenTools, MCP.so, Cloudflare (hosting). Growing fast but no clear market leader yet.

**Zhiyuan's unfair advantage**: Deep understanding of MCP from AgentOS research. Full-stack skills for marketplace development. Understanding of what enterprises actually need (auth, compliance, reliability).

**Revenue model**: Marketplace fees (15-30% commission), premium server hosting ($10-50/mo per server), enterprise plans.

**Time to MVP**: 4-6 weeks

**Risk**: Protocol-dependent — if MCP gets superseded, the business dies. Large players (Cloudflare) may dominate hosting.

---

### Idea 8: AI Research-as-a-Service

**What**: Offer systematic AI research services to companies evaluating or adopting AI. Deliverables: landscape reports, framework comparisons, build-vs-buy analyses, technology audits.

**Market size**: Subset of $10.9B agent market. Companies spend $50K-500K on technology evaluation.

**Competition**: Gartner, Forrester (expensive, slow). Boutique firms exist but few combine hands-on building experience with academic rigor.

**Zhiyuan's unfair advantage**: Has already produced research-grade analyses (15+ framework deep dives, competitive comparison tables, protocol maturity assessments). PhD-level methodology. Can deliver faster than traditional analysts because he actually builds with these tools.

**Revenue model**:
- Individual reports: $500-2,000
- Monthly retainer: $3K-10K/month
- Enterprise workshops: $5K-15K per day

**Time to MVP**: 1 week (portfolio of existing research + outreach)

**Risk**: Small addressable market for research alone. Better as complement to consulting (Idea 1).

---

### Idea 9: Personal AI OS (Consumer iOS App)

**What**: An iOS app that acts as a personal operating system — manages tasks, schedules, habits, and goals using AI agents. Each agent handles a life domain (health, work, finance, learning).

**Market size**: Personal productivity ($100B+ market). AI productivity tools growing rapidly.

**Competition**: Notion AI, Todoist AI, Motion, Reclaim.ai, various AI planners. Crowded but none use multi-agent architecture.

**Zhiyuan's unfair advantage**: AgentOS architecture adapted for personal use. iOS skills. Behavioral AI for habit tracking.

**Revenue model**: Subscription $9.99-19.99/mo. Target: 2,000 subscribers = $20K-40K MRR.

**Time to MVP**: 8-12 weeks

**Risk**: Very crowded space. Hard to differentiate. Retention challenges.

---

### Idea 10: AI-Augmented Academic Writing Tool

**What**: A specialized writing tool for researchers and PhD students that understands academic conventions, handles citations, and helps with the research-to-paper pipeline.

**Market size**: Academic publishing ($28B market). 2.8M researchers in the US.

**Competition**: Overleaf (editing only), Elicit (research only), Semantic Scholar, Scite. No end-to-end research → writing tool.

**Zhiyuan's unfair advantage**: Is a researcher himself. Understands the pain points (literature review, citation management, methodology writing). Has built research tools (PULSE, BIR papers).

**Revenue model**: $19-49/mo subscription for individual researchers. $99-299/mo for labs/institutions.

**Time to MVP**: 6-8 weeks

**Risk**: Academics are notoriously price-sensitive. Institutional sales require long cycles.

---

## Top 3 Ranked Recommendations

### #1: AI Agent Consulting → Productized Service ("Agent Architect")

**Why this is #1:**
- **Fastest time to revenue**: Can start earning within 30 days with zero product development
- **Highest leverage on existing knowledge**: Already researched every major framework, built a real agent system, understands operational challenges
- **Market timing is perfect**: 72% of Global 2000 have agent systems, 40% will fail, massive skill gap
- **Natural evolution**: Consulting → productized audits → templates/frameworks → SaaS
- **Builds deal flow for all other ideas**: Every consulting engagement = market research for future products
- **"Freelance Agentics" trend**: Solo consultants augmented by AI agents deliver enterprise-grade work at fraction of cost

**Revenue projection**:
- Month 1-3: $10K-20K/month (5-10 consulting engagements)
- Month 4-6: $20K-40K/month (retainers + productized services)
- Month 7-12: $30K-60K/month (templates + community + retainers)

**Key risk**: Consulting is time-bound. Mitigate by productizing aggressively from month 3.

---

### #2: Proactive Wellness AI (iOS App — "Pulse")

**Why this is #2:**
- **Deepest technical moat**: PhD-level behavioral AI + PULSE research + BIR compiler. Nobody else has this combination.
- **Massive market**: $39B wearable health, 86M Americans using health wearables
- **Unique angle**: Proactive (senses and intervenes) vs reactive (user logs data). Passive sensing means no user effort required.
- **Research-backed**: Not a toy — built on published IMWUT-caliber methodology
- **Apple ecosystem play**: HealthKit + Apple Watch + Apple Intelligence = native integration advantage

**Revenue projection**:
- Month 3-6: Beta launch, 100-200 free users
- Month 6-9: $3K-8K/month (300-600 paid subscribers)
- Month 9-12: $8K-15K/month (800-1500 paid subscribers)
- Year 2: $20K-40K/month at 2,000-4,000 subscribers

**Key risk**: AI app retention is 30% worse than non-AI. Mitigate with behavioral science design (habit hooks, progressive engagement, passive sensing reducing required effort).

---

### #3: AI Agent Mastery (Course + Community)

**Why this is #3:**
- **Builds personal brand**: The single most valuable long-term asset for a one-person company
- **Validates demand**: Course students = early adopters for any future product
- **Cash flow positive from day 1**: Pre-sell cohorts before creating content
- **Compounds**: Content → SEO → audience → more students → more products
- **Low risk**: If cohort doesn't fill, lose only time spent on curriculum (which doubles as blog content)

**Revenue projection**:
- Month 1-2: Build curriculum + waitlist
- Month 3: First cohort ($10K-15K)
- Month 4-6: Community launch ($3K-5K/month recurring)
- Month 7-12: $8K-15K/month (cohorts + community + templates)

**Key risk**: Requires personal brand. Mitigate by publishing AgentOS insights, framework comparisons, and research findings as free content to build audience first.

---

## Recommended Combined Strategy

The three ideas are **complementary, not competing**:

```
Month 1-3:  [CONSULTING]  Start agent consulting → cash flow
            [BRAND]       Publish 2 blog posts/week on agent systems

Month 3-6:  [CONSULTING]  Productize into audits + templates
            [COURSE]      Launch first cohort (from blog audience)
            [APP]         Start building Pulse iOS app (evenings/weekends)

Month 6-9:  [CONSULTING]  Recurring retainers (reduced hours)
            [COURSE]      Community growing, second cohort
            [APP]         Pulse beta launch

Month 9-12: [CONSULTING]  10 hrs/week max (highest-value only)
            [COURSE]      Community at 100+ members
            [APP]         Pulse public launch
```

**Combined revenue projection**:
- Month 3: $15K-25K
- Month 6: $25K-45K
- Month 12: $40K-80K

---

## #1 Idea: 14-Day Validation Plan — "Agent Architect" Consulting

### Day 1-2: Positioning & Assets
- [ ] Write a 1-page "Agent Architecture Audit" service description
- [ ] Create a landing page (Carrd or simple Next.js) with: credentials, services, booking link
- [ ] Write first blog post: "I Built a 6-Agent AI Company. Here's What I Learned." (based on AgentOS)
- [ ] Set up Calendly for discovery calls (30-min free consultation)

### Day 3-4: Portfolio Case Study
- [ ] Write a detailed AgentOS case study: problem → architecture → results → lessons
- [ ] Include specific metrics: 225 tests, 6 agents, delegation chains, memory system
- [ ] Create a 2-page "Agent Readiness Scorecard" (free lead magnet)
- [ ] Post case study on LinkedIn + Twitter/X

### Day 5-7: Outreach Sprint
- [ ] Identify 50 companies actively hiring for "AI agent" roles (LinkedIn Jobs)
- [ ] Identify 30 companies that announced agent initiatives (press releases, blog posts)
- [ ] Send 20 personalized outreach messages: "I noticed you're building X. I built a system that manages 6 AI agents autonomously. Here's what I learned — happy to share over a 30-min call."
- [ ] Post in relevant communities: Indie Hackers, Hacker News, r/artificial, LangChain Discord, CrewAI Discord
- [ ] Reach out to 5 AI agent framework founders for potential partnerships/referrals

### Day 8-10: Content + Authority
- [ ] Write second blog post: "The 5 Mistakes Every Enterprise Makes Deploying AI Agents" (from AgentOS operational experience)
- [ ] Create a comparison chart: "Choosing Your Agent Framework: LangGraph vs CrewAI vs AutoGen vs AgentOS" (leverage existing research)
- [ ] Record a 10-min Loom video walking through an agent system architecture
- [ ] Cross-post content to Dev.to, Medium, LinkedIn

### Day 11-12: First Engagement
- [ ] Conduct 3-5 free discovery calls
- [ ] For most promising lead: offer a discounted "Agent Architecture Audit" ($2,500 instead of $5,000)
- [ ] Deliver the audit as a detailed written report + 60-min presentation
- [ ] Ask for testimonial + referral

### Day 13-14: Evaluate & Iterate
- [ ] Metrics check: discovery calls booked, conversion rate, content engagement
- [ ] Kill criteria: If < 3 discovery calls booked → pivot outreach strategy
- [ ] If 0 paid interest after 20+ conversations → this market may not be ready for solo consulting (consider pivoting to course-first)
- [ ] Document learnings for next sprint

### Success Criteria (14-day)
- **Green**: 1+ paid engagement ($2,500+)
- **Yellow**: 5+ discovery calls, strong interest but no close
- **Red**: < 3 discovery calls despite 50+ outreach attempts

---

## Personal Brand Strategy

### Platform Priority (ordered)
1. **LinkedIn**: Primary. Technical AI content performs well. Target audience (engineering leaders, CTOs) lives here.
2. **Twitter/X**: Secondary. AI community is active. Good for building developer audience.
3. **Personal blog**: Long-form SEO content. Drives organic discovery.
4. **YouTube/Loom**: Video walkthroughs of agent architectures. Low competition for technical AI content.
5. **GitHub**: AgentOS open-source presence. Stars = credibility.

### Content Pillars (weekly cadence)
1. **Agent Architecture Insights** (Tue): Deep dives into agent patterns, framework comparisons, operational learnings
2. **Behavioral AI Perspectives** (Thu): Intersection of behavioral science and AI — unique angle nobody else has
3. **Build in Public Updates** (Sat): AgentOS progress, consulting learnings, honest metrics

### Audience Growth Tactics
- **Open-source AgentOS**: Clean up repo, write great README, seek GitHub stars. Every star = potential customer/student.
- **Framework comparison content**: Create the definitive "choosing an agent framework" resource. SEO goldmine.
- **Conference talks**: Apply to AI/ML conferences (local meetups first, then NeurIPS workshops, AI Engineer Summit)
- **Guest appearances**: Podcast interviews on AI engineering podcasts (Latent Space, Gradient Dissent, AI Engineering)
- **Research-to-content pipeline**: Turn IMWUT/CHI papers into accessible blog posts (unique content moat)

### Timeline
- Month 1: 500 LinkedIn followers, 200 Twitter followers, 2 blog posts
- Month 3: 2,000 LinkedIn, 1,000 Twitter, 8 blog posts, 1 podcast appearance
- Month 6: 5,000 LinkedIn, 3,000 Twitter, 20+ blog posts, email list of 500
- Month 12: 10,000+ LinkedIn, 5,000+ Twitter, email list of 2,000, recognized voice in agent systems

---

## Market Data Sources

| Data Point | Value | Source |
|-----------|-------|--------|
| AI agent market 2026 | $10.9B | DemandSage, Warmly, Master of Code |
| Agent market CAGR | 45-46.3% | Multiple sources |
| Enterprise agent adoption | 72% of Global 2000 | Reinventing AI |
| Agent project failure rate | 40%+ by 2027 | Gartner |
| MCP market 2025 | $1.8B | CData |
| Wearable AI market 2026 | $39B+ | PharmiWeb, TowardsHealthcare |
| AI book generation market | $2.8B → $47.1B by 2034 | Skywork AI |
| Micro SaaS avg revenue | $5K-50K MRR | Multiple indie hacker sources |
| AI app trial-to-paid conversion | 52% better than non-AI | RevenueCat 2026 |
| AI app annual retention | 21.1% (vs 30.7% non-AI) | RevenueCat 2026 |
| Solopreneur AI revenue boost | 340% avg increase | Indie Hackers 2026 survey |
| US health wearable users | 86.4M | eMarketer |

---

## Appendix: Why NOT These Ideas

| Rejected Idea | Reason |
|--------------|--------|
| AgentOS Cloud (managed hosting) | Competing with well-funded players (CrewAI $24.5M, LangGraph Cloud). Infra maintenance is brutal for one person. |
| Behavioral Data API (B2B) | Long sales cycles, HIPAA compliance overhead, needs design partners. Better as Year 2 play after consulting establishes relationships. |
| MCP Server Marketplace | Protocol-dependent, large players (Cloudflare) entering. "Marketplace" businesses need liquidity to work. |
| Personal AI OS | Extremely crowded (Notion, Motion, Todoist all adding AI). No defensible moat for a solo builder. |
| Academic Writing Tool | Academics are price-sensitive, institutional sales are slow. Niche too small for primary business. |

---

## Appendix B: Supplementary Research Findings

### Apple Foundation Models Framework (Critical for Idea #2)
- iOS 26 introduces 3B-parameter on-device LLM accessible via Swift
- Zero inference cost — no API bills, works completely offline
- `@Generable` macro for structured output, built-in tool calling
- Apple actively featuring apps that use Foundation Models (free distribution)
- 340+ SiriKit intent categories now open to third-party developers
- **Implication**: The wellness iOS app can run AI completely on-device with zero marginal cost and a compelling privacy story that cloud-dependent competitors cannot match

### Solo Founder Revenue Benchmarks (from agent research)
| Founder/Product | Revenue | Model |
|----------------|---------|-------|
| Pieter Levels (PhotoAI, etc.) | $3-4M/yr | Multiple AI micro-products, solo |
| Danny Postma (HeadshotPro) | $3.6M ARR | AI headshots, solo |
| PDF.ai | $3.6M ARR | Document chat, solo, SEO-driven |
| Taplio | $1.8M ARR | LinkedIn AI tool, solo, 80%+ margins |
| Jenni AI | $10M ARR | Academic writing, small team |
| AskYourPDF | $2.4M ARR | ChatGPT plugin, 500K MAU |
| Typingmind (Tony Dinh) | $500K+ ARR | ChatGPT wrapper, solo |

### AI Wrapper Survival Rate
- 80-95% of AI wrappers fail within first year
- Survivors share 3 traits: extreme niche focus, SEO dominance, deep workflow integration
- "Deployment speed is the new 2026 moat" — winners iterate in real-time

### Mental Health App Market (for Idea #2)
- Mental health apps: $9.61B (2025) → $45.12B by 2035, 16.73% CAGR
- iOS captures 52.34% of wellness app revenue (users pay more for health subscriptions)
- Apple Health+ launching AI coaching in 2026 — validates the category
- Emerging B2B2C channel: employers buying subscriptions for employee wellness

### MCP Tooling Opportunity (considered but not in top 3)
- 10,000+ active MCP servers (up from ~1,000 in early 2025)
- "Skill economy" emerging — packaged MCP servers + configurations replacing "mega-prompts"
- Premium enterprise MCP servers (ERP, CRM integrations): $50-500/mo per customer
- Could be a strong secondary revenue stream alongside consulting

### PhD-to-Founder Brand Strategy
- "Translator" positioning: make hard research accessible to practitioners (underserved niche)
- Research credibility + builder credibility = rare and powerful combination
- Paper → blog post pipeline: unique content moat (nobody else has your papers)
- Conference talks → podcast appearances → consulting pipeline (12-24 month flywheel)
- Revenue timeline: Month 0-3 blog posts from research → Month 3-6 first consulting inbound → Month 6-12 $5-15K/mo from content + consulting
