#!/bin/bash
# Stops the background Coaching Hub and removes the login item. Your data is not touched.
PLIST="$HOME/Library/LaunchAgents/local.coaching-hub.plist"
launchctl bootout "gui/$(id -u)/local.coaching-hub" 2>/dev/null || true
rm -f "$PLIST"
echo "Background Coaching Hub removed. Your data in ~/Library/Application Support/CoachingHub is unchanged."
