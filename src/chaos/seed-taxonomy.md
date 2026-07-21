---
schema_version: 1
seeded_by: cto
seeded_for: RYA-861
note: |
  Seed taxonomy for the chaos drill infrastructure. COO (sub-task 1 of RYA-766)
  will replace this file with the full taxonomy synthesized from the incident
  log and retros. The schema below — `failure_modes` array of FailureMode — is
  the contract; the generator and observer consume that shape.

  When swapping in the real taxonomy, keep the shape and ids stable so existing
  scenarios and labeled fixtures continue to resolve.
---

# Chaos drill taxonomy (seed)

This document is parsed by `src/chaos/taxonomy.ts`. Each `## failure-mode:<id>`
section becomes a `FailureMode`. The frontmatter is metadata only.

## failure-mode: silent-failure-swallow

```yaml
title: "Silent error swallow in catch block"
description: "A catch block logs nothing and re-throws nothing — error vanishes; downstream sees stale state but no alert."
surface: recovery
severity: critical
expectedRecovery: "Error appears in logs within 5s; circuit breaker increments failure count; agent does not silently mark itself completed."
incidentRefs: ["KFP-1", "RYA-353", "RYA-354"]
symptoms:
  - { channel: logs, pattern: "Error", required: true }
  - { channel: linear-status, pattern: "failed", required: false }
```

## failure-mode: oauth-refresh-race

```yaml
title: "OAuth refresh token race between concurrent agents"
description: "Two agents share a HOME dir and refresh OAuth tokens in parallel; one invalidates the other; subsequent Linear calls 401."
surface: auth
severity: critical
expectedRecovery: "Both agents detect 401, fall back to per-role token path, retry succeeds."
incidentRefs: ["KFP-2", "RYA-591"]
symptoms:
  - { channel: logs, pattern: "401", required: true }
  - { channel: logs, pattern: "Unauthorized", required: false }
  - { channel: linear-status, pattern: "blocked", required: false }
```

## failure-mode: dispatch-delegate-gap

```yaml
title: "Issue created but never dispatched"
description: "Sub-issue created without `linear-tool dispatch`; orphaned, never picked up."
surface: dispatch
severity: critical
expectedRecovery: "Heartbeat detects unowned Todo issue within one cycle (< 5 min); COO triages and dispatches."
incidentRefs: ["KFP-4", "RYA-657", "RYA-13"]
symptoms:
  - { channel: linear-status, pattern: "Todo", required: true }
  - { channel: linear-comments, pattern: "dispatch", required: false }
```

## failure-mode: zombie-spawn-loop

```yaml
title: "Zombie spawn loop: dead tmux but DB says running"
description: "Agent crashes; DB attempt stays in 'running'; monitor reconciliation must mark failed and possibly retry with backoff."
surface: state
severity: critical
expectedRecovery: "Monitor detects dead tmux + no HANDOFF within 15s; marks failed; circuit breaker counts failure; backoff before retry."
incidentRefs: ["KFP-5", "RYA-698", "RYA-360"]
symptoms:
  - { channel: session-state, pattern: "dead", required: true }
  - { channel: linear-status, pattern: "failed", required: false }
```

## failure-mode: rate-limit-cascade

```yaml
title: "Rate-limit cascade across agents"
description: "Linear API rate-limits one agent; retry storm cascades to other agents sharing identity; whole org stalls."
surface: rate-limit
severity: important
expectedRecovery: "Exponential backoff per role; circuit breaker trips after threshold; queue holds work, no data loss."
incidentRefs: ["KFP-6", "RYA-326"]
symptoms:
  - { channel: logs, pattern: "429", required: true }
  - { channel: logs, pattern: "rate", required: false }
  - { channel: metrics, pattern: "queue_depth", required: false }
```

## failure-mode: handoff-context-drop

```yaml
title: "Handoff loses context between agents"
description: "Agent A writes HANDOFF.md but agent B picks up without seeing it (race or wrong workspace)."
surface: handoff
severity: important
expectedRecovery: "Receiving agent reads HANDOFF.md before starting work; if missing, requests context via mailbox."
incidentRefs: ["KFP-1", "RYA-204"]
symptoms:
  - { channel: linear-comments, pattern: "HANDOFF", required: false }
  - { channel: linear-comments, pattern: "context", required: false }
  - { channel: logs, pattern: "no handoff", required: true }
```

## failure-mode: stale-memory-recall

```yaml
title: "Stale memory recall: agent acts on outdated facts"
description: "Memory file says X exists but X was renamed/removed; agent acts on stale info instead of verifying."
surface: memory
severity: important
expectedRecovery: "Agent's pre-recommendation check verifies referenced files/symbols exist before acting; updates or removes stale memory."
incidentRefs: ["KFP-8"]
symptoms:
  - { channel: logs, pattern: "ENOENT", required: false }
  - { channel: linear-comments, pattern: "no longer exists", required: false }
  - { channel: logs, pattern: "stale", required: true }
```
