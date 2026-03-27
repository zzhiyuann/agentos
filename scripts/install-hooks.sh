#!/usr/bin/env bash
#
# Install AgentOS Claude Code hooks on the execution host.
# Run from project root: scripts/install-hooks.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "Installing AgentOS hooks..."

# Ensure hooks directory exists
mkdir -p ~/.aos/hooks

# Install session reporter hook
cp hooks/aos-report.sh ~/.aos/hooks/
chmod +x ~/.aos/hooks/aos-report.sh
echo "Installed: aos-report.sh (session completion reporter)"

# Install progress reporter hook
cp hooks/progress-report.sh ~/.aos/hooks/
chmod +x ~/.aos/hooks/progress-report.sh
echo "Installed: progress-report.sh (progress reporter)"

echo ""
echo "Add these hooks to ~/.claude/settings.json under \"hooks\"."
echo "See hooks/README.md for details."
echo ""
echo "Done."
