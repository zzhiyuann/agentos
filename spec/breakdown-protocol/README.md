# Breakdown Protocol

A typed runtime signal for *pragmatic* agent failure (failure that does not throw an exception), with a structured repair-turn format for orchestrators and a W3C-trace-compatible attribute schema for observability.

## Files

- [`v0.1.md`](./v0.1.md) — **Frozen v0.1 specification** (2026-05-03). Read this first.
- [`repair-turn.schema.json`](./repair-turn.schema.json) — JSON Schema (Draft 2020-12) for the repair-turn payload. Use this to validate detector output programmatically.

## Two-layer taxonomy

**Cognitive** (repair-turn injection):
- `drift` — agent is moving in the wrong direction
- `ambiguity` — request is underspecified; agent is guessing or looping on clarifications
- `dead_loop` — agent or system repeats no-progress action (`in_session` | `cross_session`)
- `misalignment` — agent produced an artifact answering a different question
- `context_collapse` — agent lost or contradicts established state (`within_conversation` | `substrate_state_loss` | `stale_durable_state`)

**Substrate** (halt + fix + resume; NOT repair-turn):
- `infrastructure_failure` — auth, env, network, OS subsystem
- `tool_error` — tool returned wrong / silent / empty output

The two-layer split is load-bearing: 32% of operational pain in the AgentOS retrospective corpus (RYA-770) is substrate-level. Routing substrate failures through the cognitive repair-turn path causes repair-turn storms — the exact failure mode the Protocol exists to prevent.

## Conformance

A v0.1-conformant *system* needs a detector + orchestrator covering BOTH layers. See spec §6 for partial conformance levels.

## Status

**v0.1 frozen** to unblock external adapter work. v0.2 triggers on first external adapter merge OR ConvFail-corpus revision OR ambiguity class corpus reaching n ≥ 20. See spec §7 for versioning.

## Lineage

- RYA-733 / RYA-745 — proposal (CTO)
- RYA-768 — initial spec draft (Lead Engineer / CTO)
- RYA-770 — taxonomy validation against AgentOS corpus, n=104 (COO)
- RYA-769 — v0.1 freeze (Research Lead, this directory)
