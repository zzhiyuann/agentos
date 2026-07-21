#!/usr/bin/env bash
#
# distill-loop.sh — Memory maintenance runs.
#
# Default (no flags): weekly memory-distill propose run.
#   Triggered by com.agentos.distill launchd plist (Sunday 03:00 local).
#   Generates proposals across all roles (no auto-apply); curators review
#   Monday morning via `aos memory distill apply <run-id>`.
#
# --dream-only: nightly reflection run (A3.5).
#   Triggered by com.agentos.dream launchd plist (daily 04:00 local).
#   Writes reflections-YYYY-MM-DD.md per active role. No proposals applied.
#
# Manual fire: launchctl start com.agentos.distill
#              launchctl start com.agentos.dream
#
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
distill-loop.sh — Memory maintenance runs.

Usage: scripts/distill-loop.sh [--dream-only]

Modes:
  (no flags)    Weekly memory-distill propose run. Generates proposals
                across all roles (no auto-apply). Curators review Monday
                morning via: aos memory distill apply <run-id>
                Triggered by launchd Sunday 03:00 local (com.agentos.distill).

  --dream-only  Nightly reflection run. Writes reflections-YYYY-MM-DD.md
                per active role. No proposals applied.
                Triggered by launchd daily 04:00 local (com.agentos.dream).

Manual fire:
  launchctl start com.agentos.distill
  launchctl start com.agentos.dream
HELP
    exit 0
    ;;
esac

LOG_DIR="$HOME/.aos/logs"
mkdir -p "$LOG_DIR"

MODE="distill"
if [[ "${1:-}" == "--dream-only" ]]; then
    MODE="dream"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  AgentOS $MODE starting ($(date '+%Y-%m-%d %H:%M:%S'))"
echo "═══════════════════════════════════════════════"
echo ""

if [[ "$MODE" == "dream" ]]; then
    # nightly reflection — writes memories only, never applies proposals
    node dist/cli.js memory dream
    EXIT_CODE=${PIPESTATUS[0]:-$?}
else
    # propose-only — humans curate via apply afterwards
    node dist/cli.js memory distill propose --all-roles --notify
    EXIT_CODE=${PIPESTATUS[0]:-$?}
fi

echo ""
echo "[distill-loop] ($MODE) Exit $EXIT_CODE at $(date '+%H:%M:%S')"
exit $EXIT_CODE

# Nightly memory backup: commit + push ~/.aos to the private offsite repo
# (zzhiyuann/aos-memory). Best-effort — backup failure must not fail distill.
(
  cd "$HOME/.aos" || exit 0
  git add -A 2>/dev/null
  git commit -q -m "nightly memory snapshot $(date '+%Y-%m-%d')" 2>/dev/null
  git push -q origin main 2>/dev/null && echo "[backup] ~/.aos pushed to offsite" || echo "[backup] push skipped/failed (non-fatal)"
) || true

# Monthly strategy refresh (first Sunday of the month): create + dispatch the
# standing CEO-approved strategy issue. research-lead refreshes the landscape,
# CPO re-ranks the portfolio, deliverable is ONE plain-Chinese Discord pitch
# ("本月赌注") for the CEO to approve. Replaces the retired weekly research scan.
if [ "$(date +%u)" = "7" ] && [ "$(date +%d)" -le 7 ]; then
  KEY=$("$HOME/projects/agentos/scripts/linear-tool.sh" create-issue     "[monthly] Strategy refresh $(date '+%Y-%m')"     "Standing CEO-approved monthly process. research-lead: refresh the market/competitor landscape since last month. Then hand off to cpo to re-rank the portfolio against the strategy memos. Final deliverable: ONE Discord pitch in plain Chinese — 本月赌注 (what we bet on this month, why, what done looks like) — for CEO approval. Do NOT start execution work; the pitch is the deliverable." 2 2>/dev/null | grep -oE 'RYA-[0-9]+' | head -1)
  if [ -n "$KEY" ]; then
    "$HOME/projects/agentos/scripts/linear-tool.sh" dispatch research-lead "$KEY" "Monthly strategy refresh — see issue description" 2>/dev/null
    echo "[strategy] Monthly refresh dispatched: $KEY"
  fi
fi
