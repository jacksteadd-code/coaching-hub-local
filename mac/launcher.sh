#!/bin/bash
# Coaching Hub.app launcher.
# 1. Makes sure the local server runs as a background login item (so the
#    calendar sync and daily backups keep working when the window is closed).
# 2. Opens the Coaching Hub window: the installed Chrome app (own Dock icon)
#    if it exists, otherwise a Chrome tab offering to install it, otherwise the
#    default browser.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  NODE="$RES/node/arm64/node"
else
  NODE="$RES/node/x64/node"
fi
LABEL="local.coaching-hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/CoachingHub"
URL="http://localhost:4747/"
mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

NEW_PLIST="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>$RES/app/server/index.js</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOGDIR/coaching-hub.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/coaching-hub.log</string>
</dict>
</plist>"

up() { curl -s -o /dev/null -m 1 -H "Host: localhost" "http://127.0.0.1:4747/api/location"; }

if [ ! -f "$PLIST" ] || [ "$(cat "$PLIST")" != "$NEW_PLIST" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  printf '%s\n' "$NEW_PLIST" > "$PLIST"
  # A copy started by an older version: ask it to stop so the new one takes over.
  up && curl -s -o /dev/null -m 2 -X POST -H "Host: localhost" -H "x-coaching-hub: 1" "http://127.0.0.1:4747/api/quit" && sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null
fi
up || launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null
for i in $(seq 1 40); do up && break; sleep 0.25; done

# If the running server is an older version than the files in this app (for
# example the app was reinstalled while it was running), restart it.
WANT="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$RES/app/package.json" | head -1)"
HAVE="$(curl -s -m 1 -H "Host: localhost" "http://127.0.0.1:4747/api/location" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
if [ -n "$WANT" ] && [ "$WANT" != "$HAVE" ]; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null
  sleep 1
  for i in $(seq 1 40); do up && break; sleep 0.25; done
fi

# The installed Chrome app has its own window and Dock icon.
for dir in "$HOME/Applications/Chrome Apps.localized" "$HOME/Applications/Chrome Apps" "$HOME/Applications/Edge Apps.localized" "$HOME/Applications/Brave Browser Apps.localized"; do
  if [ -d "$dir/Coaching Hub.app" ]; then open "$dir/Coaching Hub.app"; exit 0; fi
done
for b in "Google Chrome" "Microsoft Edge" "Brave Browser"; do
  if [ -d "/Applications/$b.app" ]; then open -a "/Applications/$b.app" "${URL}#/install"; exit 0; fi
done
open "$URL"
exit 0
