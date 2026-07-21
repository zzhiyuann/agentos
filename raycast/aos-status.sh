#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title AgentOS Status
# @raycast.mode fullOutput
# @raycast.packageName AgentOS

# Optional parameters:
# @raycast.icon 🤖
# @raycast.description Show active agent sessions

/opt/homebrew/bin/aos status 2>&1
