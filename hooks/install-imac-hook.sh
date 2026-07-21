#!/bin/bash
# Install AgentOS hook on the iMac
# Run this from the MacBook to deploy the hook to the iMac

set -e

IMAC="${AOS_USER:-$USER}@${AOS_HOST:?Set AOS_HOST to your execution host IP/hostname}"
HOOK_SRC="$(dirname "$0")/aos-report.sh"
HOOK_DST="~/.aos/hooks/aos-report.sh"

echo "Deploying AgentOS hook to iMac..."

# Copy hook script
ssh "$IMAC" "mkdir -p ~/.aos/hooks ~/.aos/events"
scp "$HOOK_SRC" "$IMAC:~/.aos/hooks/aos-report.sh"
ssh "$IMAC" "chmod +x ~/.aos/hooks/aos-report.sh"

echo "✓ Hook deployed to iMac"
echo ""
echo "Now add to iMac's ~/.claude/settings.json:"
echo ""
echo '  "hooks": {'
echo '    "Stop": ['
echo '      {'
echo '        "command": "bash ~/.aos/hooks/aos-report.sh",'
echo '        "event": "Stop"'
echo '      }'
echo '    ]'
echo '  }'
echo ""
echo "Or run this on the iMac to auto-add it:"
echo "  ssh $IMAC"
echo "  # Then manually add the hook to ~/.claude/settings.json"
