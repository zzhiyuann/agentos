#!/usr/bin/env bash
# record-demo.sh — Demo script for AgentOS
#
# This script walks through the key AgentOS workflow for recording a demo GIF/video.
# It shows: agent roster, starting an agent, watching it work, and checking results.
#
# Prerequisites:
#   - AgentOS installed and configured (aos setup complete)
#   - At least one agent persona at ~/.aos/agents/<role>/
#   - A Linear issue to work on
#
# Recording tools (pick one):
#   - asciinema: brew install asciinema && asciinema rec demo.cast
#   - vhs: brew install vhs (https://github.com/charmbracelet/vhs)
#   - Screen recording: macOS Cmd+Shift+5 or OBS
#
# Usage:
#   # Record with asciinema:
#   asciinema rec -t "AgentOS Demo" demo.cast
#   bash scripts/record-demo.sh <ISSUE-KEY>
#   # Press Ctrl-D to stop recording
#   # Convert: agg demo.cast docs/assets/demo.gif
#
#   # Or just run to see the flow:
#   bash scripts/record-demo.sh <ISSUE-KEY>

set -euo pipefail

ISSUE_KEY="${1:-}"
ROLE="${2:-engineer}"

if [ -z "$ISSUE_KEY" ]; then
    echo "Usage: $0 <ISSUE-KEY> [ROLE]"
    echo "Example: $0 ENG-42 engineer"
    exit 1
fi

# Colors
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
CYAN='\033[36m'
RESET='\033[0m'

pause() {
    sleep "${1:-2}"
}

section() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━ $1 ━━━${RESET}"
    echo ""
    pause
}

run() {
    echo -e "${DIM}\$ ${RESET}${BOLD}$*${RESET}"
    pause 1
    eval "$@"
    pause
}

# ── Demo Flow ──

clear
echo -e "${BOLD}AgentOS — An operating system for AI-native companies${RESET}"
echo ""
echo "Turn Linear into the control plane for a team of AI agents,"
echo "each with persistent identity and institutional memory."
echo ""
pause 3

section "1. Meet Your Agent Team"
run aos agent list

section "2. Start an Agent on a Linear Issue"
echo -e "Starting ${BOLD}${ROLE}${RESET} on ${BOLD}${ISSUE_KEY}${RESET}..."
echo ""
run aos agent start "$ROLE" "$ISSUE_KEY"

section "3. Check What's Running"
run aos status

section "4. Watch the Agent Work"
echo -e "Attaching to the agent's terminal (press ${BOLD}Ctrl-B D${RESET} to detach)..."
echo ""
echo -e "${DIM}\$ aos jump ${ISSUE_KEY}${RESET}"
pause 2
echo ""
echo -e "${DIM}(Skipping live attach for recording — in practice, run: aos jump ${ISSUE_KEY})${RESET}"
pause 2

section "5. Check Agent Memory"
run aos agent memory "$ROLE"

section "6. View Agent's Accumulated Knowledge"
echo -e "After the agent completes, its knowledge persists at:"
echo -e "  ${BOLD}~/.aos/agents/${ROLE}/memory/${RESET}"
echo ""
run ls -la ~/.aos/agents/"$ROLE"/memory/ 2>/dev/null || echo "(No memories yet — agent is still working)"

echo ""
echo -e "${BOLD}${GREEN}Demo complete.${RESET}"
echo ""
echo "Key commands:"
echo "  aos agent start <role> <issue>  — Start agent on issue"
echo "  aos jump <issue>                — Attach to agent's terminal"
echo "  aos status                      — See what's running"
echo "  aos agent memory <role>         — View accumulated knowledge"
echo "  aos serve                       — Auto-route issues via webhooks"
echo ""
