# Chaos regression gate

A CI gate (RYA-873, sub-task of RYA-766 Chaos Drills) that fails the build
when a known failure-mode signature reappears.

## What's gated

Each file in `fixtures/` encodes one regression fixture: a synthetic input +
the expected non-failure behavior. The fixture corresponds to a real
post-mortem — re-introducing the failure pattern flips the gate to red.

Current registry — see `fixtures/index.ts` for the live list.

| Fixture id | Failure mode | Severity | Post-mortem refs |
|---|---|---|---|
| `kfp-1-silent-failure-swallow` | `silent-failure-swallow` | critical | RYA-595, RYA-742, commits 4e9cea4 / 1672057 |
| `kfp-5-zombie-spawn-loop` | `zombie-spawn-loop` | critical | RYA-360, RYA-344, RYA-698 |

## How it runs

| Stage | Command | Purpose |
|---|---|---|
| Pre-commit hook | `npm run chaos:check` | Sub-second contributor feedback, runs before full vitest. |
| CI `chaos-regression` job | `npx vitest run src/chaos/regression.test.ts` | Authoritative gate; merge-blocking on PR. |
| CI `test` job | `npm test` | Full vitest suite still includes `src/chaos/` so unrelated changes catch chaos failures too. |

Fixtures are fast-by-design: each `check()` reproduces the failure-prone
code path in isolation (no real Linear, tmux, DB). The total suite must
stay <1s wall-clock so the pre-commit hook does not become aversive.

## Adding a fixture

When sub-task 3 (post-mortem framework) produces a new known-good signature,
add it as follows:

1. Confirm the failure mode is in `src/chaos/seed-taxonomy.md` (or add it
   there first — the `failureModeId` must resolve).
2. Create `fixtures/<id>.ts` exporting a `RegressionFixture` (see
   `fixtures/types.ts` for the shape).
   - `id`: kebab-case, prefixed with the KFP number when applicable.
   - `failureModeId`: matches the seed-taxonomy id.
   - `postMortemRefs`: at least one Linear key, retro path, or commit sha.
   - `check()`: deterministic, <200ms, returns `{ ok, reason, observed? }`.
3. Register the fixture in `fixtures/index.ts`.
4. Run `npm run chaos:check` locally — must pass.
5. Run `npx vitest run src/chaos/regression.test.ts` — must pass.

The CI gate auto-picks up the new fixture; no workflow change needed.

## Why this is its own gate

The full test suite already executes `src/chaos/regression.test.ts`, so
chaos failures fail `npm test` regardless. The dedicated `chaos-regression`
CI job exists to:

1. **Surface the failure class clearly.** A failed `chaos-regression` job
   on a PR tells the reviewer: "this PR re-introduces a known failure mode"
   — different from a generic test failure.
2. **Keep the merge-block tight.** The job is small and runs in parallel
   with `test`; if a flake elsewhere causes `test` to fail, `chaos-regression`
   still surfaces the regression cleanly.
3. **Provide a stable target for sub-task 3 deliverables.** Each post-mortem
   produces exactly one fixture, slotted into a registry the CI consumes
   without further plumbing.

## Relation to existing infrastructure

- `src/chaos/types.ts` — taxonomy contract (sub-task 2 / RYA-861).
- `src/chaos/seed-taxonomy.md` — seven seed failure modes with incident refs.
- `src/evals/known-failures.test.ts` — broader behavioral evals across all
  10 KFPs; complements but does not replace this gate. The chaos gate is
  the *narrow, fixture-driven* check; evals are the *broad, exploratory*
  check.
- `src/evals/chaos-tmux-kill.test.ts` — deeper KFP-5 chaos eval (22 tests);
  the regression fixture here is the *signature*, that file is the
  *exploration*.
