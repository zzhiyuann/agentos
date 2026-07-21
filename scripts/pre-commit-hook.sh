#!/usr/bin/env bash
#
# Git pre-commit hook for AgentOS.
# Runs the same checks CI does, so broken state never gets committed locally
# (RYA-619: unpushed commits can otherwise accumulate bad state and bypass CI).
#
# RYA-1074: tsc runs against an ISOLATED staged tree (git checkout-index into
# a tempdir), not the working tree. This catches phantom imports of untracked
# files and stale-symbol references that a parallel agent has uncommitted in
# the working tree. Without isolation, the old hook compiled against a tree
# that included the working-tree leftovers — green here, broken on HEAD.
# See ~/.aos/shared-memory/precommit-tsc-stagedset-gap.md for the full story.
#
# Runs: tsc --noEmit (isolated tree), eslint, vitest, build.
# Skippable with `git commit --no-verify` — only when CEO has explicitly approved
# (see CLAUDE.md: "Never skip hooks unless the user has explicitly asked for it").
#
# Install: scripts/install-hooks.sh

set -eo pipefail

# RYA-1199: when committing from a linked worktree (git worktree add), git
# exports GIT_DIR (→ .git/worktrees/<name>) to this hook. Child processes
# that run git in a different cwd — vitest tests that `git init` temp
# fixtures — then operate on the MAIN repo instead of their fixture: 11
# tests fail, and a fixture `git init` re-initializes the main repo with
# core.bare=true (reproduced; this is what corrupted the repo during
# RYA-1196). Unset so git rediscovers the repo from cwd — hooks run at the
# worktree toplevel, where the .git gitfile resolves correctly.
# GIT_INDEX_FILE is intentionally KEPT for this hook's own git commands:
# for partial commits (git commit <paths>) it points at the temp index
# holding exactly what's being committed. It is stripped from the vitest
# child env below for the same fixture-safety reason.
unset GIT_DIR GIT_WORK_TREE

cd "$(git rev-parse --show-toplevel)" || exit 1

# Only check src/ and top-level config changes. If nothing relevant is staged, skip.
STAGED=$(git diff --cached --name-only --diff-filter=ACMR)
if [ -z "$STAGED" ]; then
  exit 0
fi
RELEVANT=$(echo "$STAGED" | grep -E '^(src/|package\.json|package-lock\.json|tsconfig\.json|vitest\.config\.ts|vitest\.setup\.ts|eslint\.config\.js)' || true)
if [ -z "$RELEVANT" ]; then
  exit 0
fi

START=$(date +%s)
echo "[pre-commit] Running CI-equivalent checks (RYA-619). Bypass with --no-verify only if CEO approved."

# Parallel-agent collision advisory (RYA-1042). Non-blocking: many legitimate
# commits (large refactors, big-bang migrations) cross 10 files. The advisory
# nudges the human/agent to eyeball the staged set, not gate the commit.
STAGED_COUNT=$(echo "$STAGED" | wc -l | tr -d ' ')
PRECOMMIT_FILE_WARN_THRESHOLD=${PRECOMMIT_FILE_WARN_THRESHOLD:-10}
if [ "$STAGED_COUNT" -gt "$PRECOMMIT_FILE_WARN_THRESHOLD" ]; then
  echo "[pre-commit] ⚠️  ADVISORY: $STAGED_COUNT files staged (threshold: $PRECOMMIT_FILE_WARN_THRESHOLD)."
  echo "[pre-commit]    If this is more than your session intended, another agent may have"
  echo "[pre-commit]    staged files concurrently. Run: git diff --cached --stat"
  echo "[pre-commit]    See ~/.aos/shared-memory/git-diff-stat-precommit-audit.md for recovery."
fi

echo "[pre-commit] (1/4) tsc --noEmit (isolated staged tree — RYA-1074)"
# Materialize the staged tree (exactly what HEAD will look like after this
# commit) into a tempdir and run tsc there. ~1-2s extra vs. tsc-on-working-tree
# on this repo; well under the 5s budget set by RYA-1074.
#
# Why this matters: with 6 agents potentially editing the same repo at once,
# Agent A's tsc on the working tree could see Agent B's uncommitted export and
# pass, then ship a broken HEAD when only A's import lands. The isolated tree
# is the only thing that exactly equals what `git archive HEAD` produces after
# the commit.
TSC_WORK=$(mktemp -d -t agentos-precommit-tsc.XXXX) || {
  echo "[pre-commit] ❌ mktemp failed; cannot create isolated tsc tree."
  exit 1
}
# Cleanup on any exit (normal, error, or signal). The hook stays in $TSC_WORK
# for the tsc step only; later steps run from $(pwd) as before.
trap 'rm -rf "$TSC_WORK"' EXIT
if ! git checkout-index --prefix="$TSC_WORK/" -a; then
  echo "[pre-commit] ❌ Failed to extract staged tree (git checkout-index). Aborting."
  exit 1
fi
# Link the working tree's node_modules so tsc can resolve packages. package-lock
# changes are caught by the relevance check above; any drift surfaces as a real
# tsc error in the isolated tree.
ln -sf "$(pwd)/node_modules" "$TSC_WORK/node_modules"
if ! ( cd "$TSC_WORK" && ./node_modules/.bin/tsc --noEmit ); then
  echo "[pre-commit] ❌ Type check failed on STAGED tree (RYA-1074)."
  echo "[pre-commit]    This runs against what your commit will actually contain — not"
  echo "[pre-commit]    your working tree. If a needed symbol exists locally but isn't"
  echo "[pre-commit]    staged, stage it. If the error references a pre-existing phantom"
  echo "[pre-commit]    import in HEAD, see RYA-1075."
  echo "[pre-commit]    Emergency bypass: git commit --no-verify"
  exit 1
fi

echo "[pre-commit] (2/4) eslint src/"
if ! npm run --silent lint; then
  echo "[pre-commit] ❌ Lint failed. Fix lint errors before committing."
  exit 1
fi

# Fast-feedback chaos-regression check (RYA-873). Sub-second; runs before the
# full vitest suite so a re-introduced known failure mode shows up immediately
# with the post-mortem reference, not buried in a long vitest log.
echo "[pre-commit] (3/4) chaos-regression fixtures"
if ! npm run --silent chaos:check; then
  echo "[pre-commit] ❌ Chaos regression: a known failure-mode signature reappeared."
  echo "[pre-commit]    See src/chaos/README.md for fixture context and post-mortem refs."
  echo "[pre-commit]    Either fix the regression or update the fixture if behavior intentionally changed."
  exit 1
fi

echo "[pre-commit] (4/4) vitest run (with retry for flaky sqlite tests)"
# RYA-1120: scope vitest to TRACKED + STAGED test files only. Untracked
# *.test.ts files (parallel-agent WIP, abandoned scaffolding, etc.) would
# otherwise be picked up by the `src/**/*.test.ts` glob in vitest.config.ts
# and fail on missing deps that aren't yet in package.json — forcing
# --no-verify on commits that have nothing to do with the WIP.
#
# Same architectural principle as the isolated-tree tsc step (RYA-1074):
# the hook validates the post-commit state, not the working-tree mess.
# We use git ls-files (lists index = tracked + staged) instead of a
# checkout-index isolated tree because some tests rely on process.cwd()
# / __dirname / load fixtures from src/**; remapping cwd risks subtle
# false negatives. Explicit path filtering is the lower-risk variant.
TRACKED_TESTS=$(git ls-files -- '*.test.ts' || true)
if [ -z "$TRACKED_TESTS" ]; then
  echo "[pre-commit]    No tracked test files; skipping vitest."
else
  # shellcheck disable=SC2086  # word-splitting intentional for path list
  # env -u GIT_INDEX_FILE: see RYA-1199 comment at top — a leaked index path
  # would let test fixtures' `git add` write the real index being committed.
  if ! env -u GIT_INDEX_FILE npx vitest run --retry=2 $TRACKED_TESTS; then
    echo "[pre-commit] ❌ Tests failed. Fix before committing."
    echo "[pre-commit]    If this is a flaky test unrelated to your change, bypass with:"
    echo "[pre-commit]      git commit --no-verify"
    echo "[pre-commit]    and file a follow-up issue for the flake."
    exit 1
  fi
fi

END=$(date +%s)
echo "[pre-commit] ✅ All checks passed in $((END - START))s."
