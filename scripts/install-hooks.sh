#!/usr/bin/env bash
#
# Install AgentOS git hooks.
# Run from project root: scripts/install-hooks.sh
#
# RYA-1074: The hardened pre-commit hook now validates an ISOLATED staged tree
# (not the working tree). Prerequisite: HEAD must compile cleanly via
# `git archive HEAD | tar -x | tsc --noEmit`. If RYA-1075 (phantom-imports
# cleanup) has not landed yet, the hardened hook will reject ALL commits
# until those imports are resolved. Preflight check below detects this and
# refuses to install, with a pointer to RYA-1075.

set -euo pipefail
cd "$(dirname "$0")/.."

HOOKS_DIR=".git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: not a git repo (no .git/hooks/)"
  exit 1
fi

# RYA-1074 preflight: verify HEAD compiles cleanly under the new isolated-tree
# logic. If it doesn't, installing would lock the fleet out of all commits.
echo "[install-hooks] Preflight: testing isolated-tree tsc against HEAD (RYA-1074)..."
PREFLIGHT_WORK=$(mktemp -d -t agentos-install-preflight.XXXX) || {
  echo "[install-hooks] ⚠️  mktemp failed; skipping preflight."
  PREFLIGHT_WORK=""
}
if [ -n "$PREFLIGHT_WORK" ]; then
  trap 'rm -rf "$PREFLIGHT_WORK"' EXIT
  if git archive HEAD | tar -x -C "$PREFLIGHT_WORK"; then
    ln -sf "$(pwd)/node_modules" "$PREFLIGHT_WORK/node_modules"
    if ! ( cd "$PREFLIGHT_WORK" && ./node_modules/.bin/tsc --noEmit ) 2>&1 | tee "$PREFLIGHT_WORK/.tsc.log" | tail -20; then
      echo ""
      echo "[install-hooks] ❌ HEAD does not compile under isolated-tree tsc."
      echo "[install-hooks]    Installing the hardened hook would block ALL future commits"
      echo "[install-hooks]    until the underlying phantom imports are resolved."
      echo "[install-hooks]    See RYA-1075 for the existing cleanup task."
      echo "[install-hooks]    To install anyway (e.g., during the cleanup itself), set:"
      echo "[install-hooks]      AGENTOS_SKIP_PRECOMMIT_PREFLIGHT=1 scripts/install-hooks.sh"
      if [ "${AGENTOS_SKIP_PRECOMMIT_PREFLIGHT:-0}" != "1" ]; then
        exit 1
      fi
      echo "[install-hooks] ⚠️  AGENTOS_SKIP_PRECOMMIT_PREFLIGHT=1 set — installing anyway."
    fi
  else
    echo "[install-hooks] ⚠️  git archive failed; skipping preflight."
  fi
fi

# Install pre-commit hook (RYA-619: block broken commits from hitting local main)
cp scripts/pre-commit-hook.sh "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"
echo "Installed: pre-commit hook (tsc + lint + vitest + build — matches CI)"

# Install post-commit hook
cp scripts/post-commit-hook.sh "$HOOKS_DIR/post-commit"
chmod +x "$HOOKS_DIR/post-commit"
echo "Installed: post-commit hook (auto-rebuild on src/ changes)"

echo "Done."
