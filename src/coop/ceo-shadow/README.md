# CEO Shadow Decision Corpus — `src/coop/ceo-shadow/`

> Local-only corpus of Ryan/Zhiyuan Wang's Linear decisions, used as
> training/few-shot data for the Shadow predictor (RYA-765). **Do not
> publish** — see "Sensitivity" below.

Tracking issue: **RYA-845**.
Consumer: **CTO predictor** under RYA-765.

---

## Output layout

```
~/.aos/ceo-shadow/
├── raw/                    # cached Linear GraphQL pages (resumable)
│   ├── issues-page-001.json
│   ├── issues-page-002.json
│   └── …
├── corpus.jsonl            # one DecisionEvent per line
└── AUDIT.md                # human-readable audit report
```

## Pipeline

```
fetch  →  raw/issues-page-NNN.json   (resumable, rate-limit-aware)
extract → corpus.jsonl
audit   → AUDIT.md
```

```bash
# All at once (run from $(pwd))
./node_modules/.bin/tsx src/coop/ceo-shadow/cli.ts all

# Or stepwise
./node_modules/.bin/tsx src/coop/ceo-shadow/cli.ts fetch [--since=2025-11-03T00:00:00Z]
./node_modules/.bin/tsx src/coop/ceo-shadow/cli.ts extract
./node_modules/.bin/tsx src/coop/ceo-shadow/cli.ts audit
```

`fetch` resumes from cached pages — re-running picks up at the last
`endCursor` and only fires fresh GraphQL calls if cache is incomplete.

## Schema (`DecisionEvent` — one per line of `corpus.jsonl`)

```jsonc
{
  "id": "evt_<sha1-prefix>",                    // stable, derived from source linear id
  "ts": "2026-04-23T15:17:31.231Z",             // ISO-8601 timestamp of the decision
  "decision_type": "status:In Review→Canceled", // canonical machine-readable decision string
  "category": "status-change",                  // approve | reject | dispatch | edit-priority | status-change | create | comment | no-action
  "is_ceo_decision": true,                      // false only for negative examples
  "is_high_stakes": true,                       // priority<=1 OR `[to decide]`/`[proactive]`/`[proposal]`/budget/security/launch/governance label-or-title
  "negative_example": false,                    // true for stalled `[to decide]` issues (silent decline)

  "issue": {
    "key": "RYA-709",
    "title": "[proactive] Reflect — Your AI Privacy Mirror",
    "description_excerpt": "<= 1200 chars",
    "creator_role": "cpo",                      // ceo | cto | cpo | coo | lead-engineer | research-lead | qa-engineer | engineer | ops | strategist | linear-bot | unknown
    "parent_key": "RYA-640",
    "labels": ["[proactive]"]
  },

  "context_at_decision": {
    "state": "In Review",                       // reconstructed by reverse-applying history past `ts`
    "priority": 2,
    "assignee_role": null,
    "n_prior_comments": 5,
    "prior_comments": [                         // <=8 most-recent comments before `ts`
      { "author_role": "cto", "ts": "...", "body_excerpt": "<= 300 chars" }
    ],
    "prior_proposal": "...up to 1500 chars..."  // most-recent proposal-shaped comment, else issue desc if proposal-shaped, else null
  },

  "decision": {
    "actor": "ceo",
    "kind": "status-change",
    "from": "In Review",                        // shape varies by kind
    "to": "Canceled",
    "comment_body": null,                       // populated when source_type=='comment'
    "reasoning_excerpt": null,
    "dispatch_target": null                     // role parsed from @-mention if kind=='dispatch'
  },

  "tags": ["governance-failure:RYA-640", "to-decide", "board-vote"],

  "source": {
    "linear_event_id": "<linear uuid>",
    "source_type": "history"                    // history | comment | issue_creation | to_decide_stall
  }
}
```

### Decision categories

| Category | Source | Trigger |
|----------|--------|---------|
| `approve` | comment | "approve", "ship it", "lgtm", "✅", "同意/批准/可以" + no contradiction |
| `reject` | comment | "reject", "no", "stop", "kill", "not now", "❌", "拒绝/不要/取消" |
| `dispatch` | comment | `@<role>` mention with imperative ("@cto fix this", "派给…") |
| `edit-priority` | history | priority delta authored by CEO |
| `status-change` | history | state delta authored by CEO (`In Review→Done`, `In Progress→Canceled`, etc.) |
| `create` | issue_creation | issue.creator == CEO |
| `comment` | comment | residual — informational, question, etc. |
| `no-action` | to_decide_stall | `[to decide]` issue ≥ 7d in Backlog/Todo with **zero** CEO touches → silent decline |

### Tags

- `governance-failure:RYA-640` / `governance-failure:RYA-722` / `governance-failure:RYA-773`
  — events under the proactive/exploration hubs that have repeatedly stalled (RYA-640 memory + RYA-709 board-vote-stall, called out in RYA-845).
- `governance-hub:RYA-XXX` — event on the hub issue itself.
- `board-vote` — title/desc references a board-vote process.
- `to-decide` / `proactive` / `proposal` — title prefix tags.
- `silent-decline` — applied to negative examples.

### High-stakes flag

`is_high_stakes = true` iff:

- priority is Urgent (1), **or**
- title or any label matches `[to decide]` / `[proactive]` / `[proposal]` / budget / security / launch / governance.

Otherwise routine.

## Stability contract (for the predictor)

- **Top-level keys are frozen.** Adding a new top-level key is a minor
  bump; renaming or removing one is a breaking change.
- **`category` enum is closed.** New categories require a corpus rebuild.
- **`tags` is open** — new tag values may appear without notice.
- `id` is deterministic — re-running `extract` on the same raw cache
  produces the same ids, safe for joining/dedup.
- All free text is **excerpted** (1200/1500/2000-char caps depending on
  field). The full bodies are **not** stored.

## Sensitivity

This corpus contains every CEO comment, every status nudge, every
silent decline over a 6-month window. It is a near-complete log of the
founder's daily judgment. Treat as **strictly local**:

- Lives only under `~/.aos/ceo-shadow/` (gitignored, outside repo).
- Never publish, never paste into a non-Anthropic external service.
- Never include in COOP public-site bundle.
- The Shadow predictor consumes it locally with prompt caching; its
  outputs (predictions) are public-safe, but the corpus itself is not.

## Files in this dir

| File | Role |
|------|------|
| `types.ts` | `DecisionEvent` + raw-shape interfaces |
| `users.ts` | Linear user-id → role mapping (CEO + agent OAuth identities) |
| `classify.ts` | EN+ZH heuristic classifier for CEO comment intent |
| `fetch.ts` | Paginated GraphQL fetcher with disk cache + rate-limit handling |
| `extract.ts` | Raw issues → `DecisionEvent[]`; reconstructs state at decision time |
| `audit.ts` | Stats + markdown report rendering |
| `cli.ts` | Entry point — `fetch | extract | audit | all` |
| `ceo-shadow.test.ts` | Unit tests over fixtures |

## Ground-truth references called out in RYA-845

- **RYA-640 memory**: "Zero votes are cast. CEO dispatches downstream
  work directly if compelling" — the proactive hub formal-vote
  protocol fails in practice. Every event under RYA-640 / RYA-722 /
  RYA-773 is a candidate governance-failure-exhaust example.
- **RYA-709**: Reflect proposal — board vote stalled at 3 of 5 votes;
  CEO Canceled it from In Review on 2026-05-03. The full timeline
  (CTO+COO+CPO votes, no quorum, eventual CEO unilateral cancel) is a
  canonical training example for "approval that should have been
  recorded but never was → CEO-action override".
