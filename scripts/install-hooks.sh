#!/usr/bin/env bash
#
# Install AgentOS git hooks.
# Run from project root: scripts/install-hooks.sh

set -euo pipefail
cd "$(dirname "$0")/.."

HOOKS_DIR=".git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "Error: not a git repo (no .git/hooks/)"
  exit 1
fi

# Install post-commit hook
cp scripts/post-commit-hook.sh "$HOOKS_DIR/post-commit"
chmod +x "$HOOKS_DIR/post-commit"
echo "Installed: post-commit hook (auto-rebuild on src/ changes)"

echo "Done."
