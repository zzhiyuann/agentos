#!/usr/bin/env bash
#
# tunnel-quick.sh — One-off Cloudflare "quick tunnel" pointing at the local
# AgentOS webhook server. Prints a random https://*.trycloudflare.com URL to
# stdout; copy it into your Linear OAuth app's webhook URL.
#
# The URL changes every restart. For a persistent URL, use a named tunnel
# (see tunnel-install-launchd.sh).
#
# Usage:
#   bash scripts/tunnel-quick.sh
#   bash scripts/tunnel-quick.sh 3849     # custom port
#
set -euo pipefail

PORT="${1:-3848}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "✗ cloudflared not found. Install with:"
  echo "    brew install cloudflare/cloudflare/cloudflared"
  exit 1
fi

echo "Starting cloudflared quick tunnel → http://localhost:${PORT}"
echo "Copy the https URL printed below into Linear webhook settings."
echo "Press Ctrl-C to stop."
echo ""

exec cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}"
