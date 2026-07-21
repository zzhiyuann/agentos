#!/usr/bin/env bash
#
# serve-watchdog.sh — Dead-man liveness check for aos-serve (RYA-1180).
#
# Runs as a STANDALONE launchd job (com.agentos.serve-watchdog) every 15 min,
# deliberately outside serve so it survives serve's death. Logic:
#
#   - serve writes ~/.aos/serve-heartbeat.json every monitor tick (15s)
#   - serve writes ~/.aos/serve-stopped.json on graceful shutdown (SIGINT/SIGTERM)
#   - heartbeat stale > 30 min:
#       stop marker NEWER than heartbeat  -> intentional CEO pause:
#           outage marker written, Discord reminder only after 24h paused
#       stop marker OLDER (or absent)     -> crash/silent death:
#           outage marker written, Discord alert immediately
#   - alerts re-fire every 24h while the outage persists
#   - on recovery: Discord recovery note + outage-end marker
#
# Additionally runs a node restartability canary (RYA-1196): a live serve says
# nothing about whether a NEW node can spawn — a brew upgrade can break
# /opt/homebrew/bin/node's dylib links (or a node major bump can invalidate
# better-sqlite3's ABI) while the running daemon survives on memory-mapped
# copies of the old libs. Each tick spawns a fresh node that loads
# better-sqlite3; on failure it alerts BEFORE anyone needs a restart.
#
# Also runs a brew-python pyexpat canary (RYA-1203): python@3.14 3.14.5's
# pyexpat.so links a newer libexpat than Darwin ships; RYA-1200 re-pointed it
# at brew expat via install_name_tool. Any `brew reinstall/upgrade python@3.14`
# silently reverts that patch, and a still-broken bottle re-breaks node-gyp
# native builds (node-gyp's generator imports pyexpat). Deliberately separate
# state file + alert text from the node canary: pyexpat breakage does NOT
# brick serve restarts — it only breaks future native-module builds.
#
# Outage markers append to ~/.aos/outages.jsonl so future collab audits can
# distinguish crash vs intentional pause (context: serve was silently down
# 2026-05-18 -> 2026-06-09 with no alert and no audit trail).
#
# All paths/thresholds are env-overridable for tests.

set -euo pipefail

case "${1:-}" in
  --help|-h)
    cat <<'HELP'
serve-watchdog.sh — Dead-man liveness check for aos-serve.

Usage: scripts/serve-watchdog.sh

Runs as a standalone launchd job (com.agentos.serve-watchdog) every 15 min.
Takes no arguments — all configuration is via environment variables:

  AOS_WD_DIR                     State directory (default: ~/.aos)
  AOS_WD_STALE_SECS              Heartbeat age threshold for outage (default: 1800)
  AOS_WD_REALERT_SECS            Re-alert cadence during an outage (default: 86400)
  AOS_WD_INTENTIONAL_DELAY_SECS  Grace period before paused-serve reminder (default: 86400)
  AOS_WD_CANARY_REALERT_SECS     Node canary re-alert cadence (default: 21600)
  AOS_WD_PYEXPAT_REALERT_SECS    Pyexpat canary re-alert cadence (default: 21600)

Checks performed each run:
  1. Node restartability canary: fresh node spawn + better-sqlite3 load
  2. Brew-python pyexpat canary: python@3.14 import pyexpat
  3. Serve heartbeat freshness: stale > STALE_SECS → Discord alert

Alert types:
  crash           Heartbeat stale, no clean-shutdown marker → immediate alert
  intentional-stop  Heartbeat stale, clean-shutdown marker newer → delayed reminder
HELP
    exit 0
    ;;
esac

AOS_DIR="${AOS_WD_DIR:-$HOME/.aos}"
HB_FILE="${AOS_WD_HB_FILE:-$AOS_DIR/serve-heartbeat.json}"
STOP_FILE="${AOS_WD_STOP_FILE:-$AOS_DIR/serve-stopped.json}"
STATE_FILE="${AOS_WD_STATE_FILE:-$AOS_DIR/serve-watchdog-state.json}"
OUTAGE_LOG="${AOS_WD_OUTAGE_LOG:-$AOS_DIR/outages.jsonl}"
DISCORD_JSON="${AOS_WD_DISCORD_JSON:-$AOS_DIR/discord.json}"
STALE_SECS="${AOS_WD_STALE_SECS:-1800}"            # heartbeat older than this = outage
REALERT_SECS="${AOS_WD_REALERT_SECS:-86400}"       # re-alert cadence during an outage
INTENTIONAL_DELAY_SECS="${AOS_WD_INTENTIONAL_DELAY_SECS:-86400}"  # pause reminder delay
# Test hook: when set, append Discord messages to this file instead of curling.
DISCORD_CAPTURE="${AOS_WD_DISCORD_CAPTURE:-}"
# Restartability canary (RYA-1196)
CANARY_STATE_FILE="${AOS_WD_CANARY_STATE_FILE:-$AOS_DIR/node-canary-state}"
CANARY_REALERT_SECS="${AOS_WD_CANARY_REALERT_SECS:-21600}"   # re-alert every 6h while failing
AGENTOS_DIR="${AOS_WD_AGENTOS_DIR:-$HOME/projects/agentos}"
# Brew-python pyexpat canary (RYA-1203)
PYEXPAT_STATE_FILE="${AOS_WD_PYEXPAT_STATE_FILE:-$AOS_DIR/pyexpat-canary-state}"
PYEXPAT_REALERT_SECS="${AOS_WD_PYEXPAT_REALERT_SECS:-21600}" # re-alert every 6h while failing
PYEXPAT_PYTHON="${AOS_WD_PYEXPAT_PYTHON:-/opt/homebrew/bin/python3}"

NOW=$(date +%s)

# ─── helpers ───

mtime_of() {  # BSD stat first (macOS), GNU fallback (CI)
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

iso_of() {  # epoch seconds -> UTC ISO-8601
  date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

human_duration() {
  local s=$1
  if [ "$s" -ge 86400 ]; then echo "$((s / 86400))d $((s % 86400 / 3600))h"
  elif [ "$s" -ge 3600 ]; then echo "$((s / 3600))h $((s % 3600 / 60))m"
  else echo "$((s / 60))m"; fi
}

post_discord() {
  local msg=$1
  if [ -n "$DISCORD_CAPTURE" ]; then
    printf '%s\n' "$msg" >> "$DISCORD_CAPTURE"
    return 0
  fi
  local url=""
  if [ -f "$DISCORD_JSON" ]; then
    url=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("webhookUrl",""))' "$DISCORD_JSON" 2>/dev/null \
      || sed -n 's/.*"webhookUrl": *"\([^"]*\)".*/\1/p' "$DISCORD_JSON" | head -1)
  fi
  if [ -z "$url" ]; then
    echo "[watchdog] No Discord webhookUrl in $DISCORD_JSON — alert NOT delivered: $msg" >&2
    return 0
  fi
  # JSON-escape via python3; fall back to raw (message content is controlled by us)
  local payload
  payload=$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1]}))' "$msg" 2>/dev/null \
    || printf '{"content": "%s"}' "$msg")
  curl -m 10 -s -o /dev/null -X POST -H 'Content-Type: application/json' -d "$payload" "$url" \
    || echo "[watchdog] Discord POST failed: $msg" >&2
}

# state file: shell-sourceable KEY=VALUE lines (avoids JSON parsing in bash)
read_state() {
  OUTAGE_HB_TS=0; OUTAGE_KIND=""; LAST_ALERT_TS=0; ALERT_COUNT=0
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
  fi
}

write_state() {
  cat > "$STATE_FILE" <<EOF
OUTAGE_HB_TS=$OUTAGE_HB_TS
OUTAGE_KIND=$OUTAGE_KIND
LAST_ALERT_TS=$LAST_ALERT_TS
ALERT_COUNT=$ALERT_COUNT
EOF
}

# ─── node restartability canary (RYA-1196) ───

run_canary() {
  if [ -n "${AOS_WD_CANARY_CMD:-}" ]; then  # test hook
    sh -c "$AOS_WD_CANARY_CMD" 2>&1
    return $?
  fi
  local node_bin=/opt/homebrew/bin/node
  [ -x "$node_bin" ] || node_bin=node
  if [ -d "$AGENTOS_DIR/node_modules/better-sqlite3" ]; then
    "$node_bin" -e "require('$AGENTOS_DIR/node_modules/better-sqlite3')" 2>&1
  else
    "$node_bin" --version 2>&1
  fi
}

if CANARY_OUT=$(run_canary); then
  if [ -f "$CANARY_STATE_FILE" ]; then
    echo "{\"event\":\"node-canary-recovered\",\"recovered_at\":\"$(iso_of "$NOW")\"}" >> "$OUTAGE_LOG"
    post_discord "✅ **node restartability canary passing again** — fresh node spawns work; serve restarts are safe."
    rm -f "$CANARY_STATE_FILE"
    echo "[watchdog] Canary recovery: fresh node spawn OK"
  fi
else
  CANARY_ERR=$(printf '%s' "$CANARY_OUT" | head -2 | tr '\n' ' ' | cut -c1-300)
  CANARY_LAST=0
  if [ -f "$CANARY_STATE_FILE" ]; then CANARY_LAST=$(cat "$CANARY_STATE_FILE" 2>/dev/null || echo 0); fi
  CANARY_LAST=${CANARY_LAST:-0}
  if [ $((NOW - CANARY_LAST)) -ge "$CANARY_REALERT_SECS" ]; then
    if [ "$CANARY_LAST" -eq 0 ]; then
      ERR_ESC=${CANARY_ERR//\\/\\\\}
      ERR_ESC=${ERR_ESC//\"/\\\"}
      echo "{\"event\":\"node-canary-fail\",\"detected_at\":\"$(iso_of "$NOW")\",\"error\":\"$ERR_ESC\"}" >> "$OUTAGE_LOG"
    fi
    post_discord "🚨 **node restartability canary FAILING** — serve may still be alive, but any restart will brick it (fresh node spawn fails). Likely a brew upgrade moved a dylib node links, or a node ABI bump broke better-sqlite3. Error: \`$CANARY_ERR\`. Runbook: ~/.aos/agents/coo/memory/runbooks.md (brew-dylib-breaks-node)."
    echo "$NOW" > "$CANARY_STATE_FILE"
    echo "[watchdog] CANARY ALERT: fresh node spawn failing: $CANARY_ERR"
  else
    echo "[watchdog] Canary still failing — next alert not yet due"
  fi
fi

# ─── brew-python pyexpat canary (RYA-1203) ───

run_pyexpat_canary() {
  if [ -n "${AOS_WD_PYEXPAT_CMD:-}" ]; then  # test hook
    sh -c "$AOS_WD_PYEXPAT_CMD" 2>&1
    return $?
  fi
  # No brew python -> nothing to canary (node-gyp falls back to other pythons)
  [ -x "$PYEXPAT_PYTHON" ] || { echo "skipped: $PYEXPAT_PYTHON not installed"; return 0; }
  "$PYEXPAT_PYTHON" -c 'import pyexpat' 2>&1
}

if PYEXPAT_OUT=$(run_pyexpat_canary); then
  if [ -f "$PYEXPAT_STATE_FILE" ]; then
    echo "{\"event\":\"pyexpat-canary-recovered\",\"recovered_at\":\"$(iso_of "$NOW")\"}" >> "$OUTAGE_LOG"
    post_discord "✅ **brew-python pyexpat canary passing again** — \`import pyexpat\` works; node-gyp native builds are unblocked."
    rm -f "$PYEXPAT_STATE_FILE"
    echo "[watchdog] Pyexpat canary recovery: import pyexpat OK"
  fi
else
  PYEXPAT_ERR=$(printf '%s' "$PYEXPAT_OUT" | head -2 | tr '\n' ' ' | cut -c1-300)
  PYEXPAT_LAST=0
  if [ -f "$PYEXPAT_STATE_FILE" ]; then PYEXPAT_LAST=$(cat "$PYEXPAT_STATE_FILE" 2>/dev/null || echo 0); fi
  PYEXPAT_LAST=${PYEXPAT_LAST:-0}
  if [ $((NOW - PYEXPAT_LAST)) -ge "$PYEXPAT_REALERT_SECS" ]; then
    if [ "$PYEXPAT_LAST" -eq 0 ]; then
      PYEXPAT_ERR_ESC=${PYEXPAT_ERR//\\/\\\\}
      PYEXPAT_ERR_ESC=${PYEXPAT_ERR_ESC//\"/\\\"}
      echo "{\"event\":\"pyexpat-canary-fail\",\"detected_at\":\"$(iso_of "$NOW")\",\"error\":\"$PYEXPAT_ERR_ESC\"}" >> "$OUTAGE_LOG"
    fi
    post_discord "⚠️ **brew-python pyexpat canary FAILING** — \`$PYEXPAT_PYTHON -c 'import pyexpat'\` errors. serve keeps running and restarts are NOT affected, but node-gyp native builds (npm installs/rebuilds of better-sqlite3 etc.) will fail until repatched. Likely a brew reinstall/upgrade of python@3.14 reverted the RYA-1200 install_name_tool patch. Error: \`$PYEXPAT_ERR\`. Runbook: ~/.aos/agents/coo/memory/runbooks.md (brew-python-pyexpat-breaks-node-gyp)."
    echo "$NOW" > "$PYEXPAT_STATE_FILE"
    echo "[watchdog] PYEXPAT ALERT: import pyexpat failing: $PYEXPAT_ERR"
  else
    echo "[watchdog] Pyexpat canary still failing — next alert not yet due"
  fi
fi

# ─── read liveness markers ───

HB_TS=0
if [ -f "$HB_FILE" ]; then HB_TS=$(mtime_of "$HB_FILE"); fi
STOP_TS=0
if [ -f "$STOP_FILE" ]; then STOP_TS=$(mtime_of "$STOP_FILE"); fi

AGE=$((NOW - HB_TS))

# ─── healthy path ───

if [ "$HB_TS" -gt 0 ] && [ "$AGE" -le "$STALE_SECS" ]; then
  if [ -f "$STATE_FILE" ]; then
    read_state
    # OUTAGE_HB_TS=0 means the heartbeat file never existed during the outage —
    # downtime is unknowable, report 0 rather than a 56-year epoch delta.
    DOWNTIME=0
    if [ "$OUTAGE_HB_TS" -gt 0 ]; then DOWNTIME=$((HB_TS - OUTAGE_HB_TS)); fi
    echo "{\"event\":\"outage-end\",\"kind\":\"$OUTAGE_KIND\",\"recovered_at\":\"$(iso_of "$NOW")\",\"downtime_secs\":$DOWNTIME}" >> "$OUTAGE_LOG"
    post_discord "✅ **aos-serve recovered** — heartbeat is fresh again after $(human_duration "$DOWNTIME") of ${OUTAGE_KIND}."
    rm -f "$STATE_FILE"
    echo "[watchdog] Recovery: serve back after $(human_duration "$DOWNTIME") ($OUTAGE_KIND)"
  else
    echo "[watchdog] OK: heartbeat age ${AGE}s (threshold ${STALE_SECS}s)"
  fi
  exit 0
fi

# ─── stale path ───

if [ "$STOP_TS" -ge "$HB_TS" ] && [ "$STOP_TS" -gt 0 ]; then
  KIND="intentional-stop"
else
  KIND="crash"
fi

LAST_HB_ISO="null"
if [ "$HB_TS" -gt 0 ]; then LAST_HB_ISO="\"$(iso_of "$HB_TS")\""; fi

read_state
if [ ! -f "$STATE_FILE" ] || [ "$OUTAGE_HB_TS" != "$HB_TS" ]; then
  # New outage (or heartbeat moved since last recorded outage) — record start.
  OUTAGE_HB_TS=$HB_TS; OUTAGE_KIND=$KIND; LAST_ALERT_TS=0; ALERT_COUNT=0
  echo "{\"event\":\"outage-start\",\"kind\":\"$KIND\",\"detected_at\":\"$(iso_of "$NOW")\",\"last_heartbeat_at\":$LAST_HB_ISO}" >> "$OUTAGE_LOG"
  write_state
fi

# Intentional pauses get a grace period before the first reminder; crashes alert immediately.
FIRST_DELAY=0
if [ "$KIND" = "intentional-stop" ]; then FIRST_DELAY=$INTENTIONAL_DELAY_SECS; fi

if [ "$AGE" -ge "$FIRST_DELAY" ] && [ $((NOW - LAST_ALERT_TS)) -ge "$REALERT_SECS" ]; then
  if [ "$KIND" = "crash" ]; then
    MSG="🚨 **aos-serve is DOWN** (no heartbeat for $(human_duration "$AGE"), no clean-shutdown marker — likely crash or silent death). Last heartbeat: ${LAST_HB_ISO//\"/}. Restart: \`launchctl kickstart -k gui/\$(id -u)/com.agentos.serve\` or \`cd ~/projects/agentos && ./scripts/install-serve-launchd.sh\`"
  else
    MSG="⏸️ **aos-serve has been paused for $(human_duration "$AGE")** (clean shutdown detected — intentional stop). Reminder in case this was forgotten. Resume: \`launchctl load ~/Library/LaunchAgents/com.agentos.serve.plist\`"
  fi
  post_discord "$MSG"
  LAST_ALERT_TS=$NOW; ALERT_COUNT=$((ALERT_COUNT + 1))
  write_state
  echo "[watchdog] ALERT #$ALERT_COUNT ($KIND): heartbeat age $(human_duration "$AGE")"
else
  echo "[watchdog] Outage ongoing ($KIND, age $(human_duration "$AGE")) — next alert not yet due"
fi
exit 0
