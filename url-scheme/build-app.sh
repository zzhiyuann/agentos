#!/bin/bash
# Build AgentOS.app URL scheme handler

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Applications/AgentOS.app"

echo "Building AgentOS.app..."

# Create AppleScript handler
cat > /tmp/agentos-handler.applescript << 'APPLESCRIPT_EOF'
on open location theURL
    set issueKey to do shell script "echo " & quoted form of theURL & " | sed -E 's|agentos://session/([A-Z]+-[0-9]+).*|\\1|'"
    if issueKey is not "" then
        do shell script "/usr/local/bin/aos jump " & issueKey & " >> $HOME/.aos/url-handler.log 2>&1 &"
    end if
end open location
APPLESCRIPT_EOF

# Compile to temp, then move
rm -rf /tmp/AgentOS.app "$APP_DIR"
osacompile -o /tmp/AgentOS.app /tmp/agentos-handler.applescript
cp -R /tmp/AgentOS.app "$APP_DIR"

# Overlay our Info.plist with URL scheme registration
cp "$SCRIPT_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"

# Register with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -R "$APP_DIR" 2>/dev/null || true

# Clean up
rm -rf /tmp/AgentOS.app /tmp/agentos-handler.applescript

echo "✓ AgentOS.app installed at: $APP_DIR"
echo "✓ URL scheme 'agentos://' registered"
echo "Test: open 'agentos://session/RYA-5'"
