#!/usr/bin/env bash
#
# Git post-commit hook for AgentOS.
# Rebuilds TypeScript when src/ files are committed.
# Warns on permission-sensitive file changes (RYA-203).
#
# Install: cp scripts/post-commit-hook.sh .git/hooks/post-commit
# Or run: scripts/install-hooks.sh

# Check if this commit touched src/
CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | grep '^src/')
if [ -z "$CHANGED" ]; then
  exit 0
fi

# Check for permission-sensitive files (RYA-203: auto-mode testing protocol)
PERMISSION_FILES=$(echo "$CHANGED" | grep -E '(adapters/claude-code\.ts|core/router\.ts)')
if [ -n "$PERMISSION_FILES" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ⛔ PERMISSION-SENSITIVE FILES CHANGED                      ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Auto-deploy is BLOCKED for these files.                    ║"
  echo "║  Auto-mode was reverted 3x from fleet-wide deploy (RYA-88) ║"
  echo "║                                                             ║"
  echo "║  REQUIRED before deploying:                                 ║"
  echo "║  1. Test on ONE agent manually                              ║"
  echo "║  2. Get COO approval                                        ║"
  echo "║  3. Deploy manually: npx tsc && restart serve               ║"
  echo "║                                                             ║"
  echo "║  See: ~/.aos/shared-memory/permission-model-protocol.md     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "[post-commit] Changed permission files:"
  echo "$PERMISSION_FILES" | sed 's/^/  • /'
  echo ""
  echo "[post-commit] Building TypeScript (but auto-deploy watcher will NOT restart serve)..."
fi

echo "[post-commit] src/ changed — rebuilding TypeScript..."

cd "$(git rev-parse --show-toplevel)" || exit 0

npx tsc 2>&1 | tail -5
if [ ${PIPESTATUS[0]} -eq 0 ]; then
  echo "[post-commit] Build succeeded. dist/ updated."
else
  echo "[post-commit] Build FAILED. dist/ may be stale."
fi

# If serve is running with auto-deploy watcher, the fs.watch will
# also detect the dist/ rebuild. The post-commit hook ensures the build
# happens even if serve isn't running with the watcher.
# NOTE: For permission-sensitive files, auto-deploy.ts will block the
# restart — manual deploy required after COO approval (RYA-203).
