#!/bin/bash
# Optional: start Coaching Hub automatically when you log in and keep it
# running in the background, so the calendar feed and daily backups work
# without a Terminal window. Undo with scripts/uninstall-login-item.sh.
set -e
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="$(command -v node)" || { echo "Install Node.js first (nodejs.org)."; exit 1; }
PLIST="$HOME/Library/LaunchAgents/local.coaching-hub.plist"
LOG_DIR="$HOME/Library/Logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.coaching-hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--no-warnings=ExperimentalWarning</string>
    <string>$APP_DIR/server/index.js</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/coaching-hub.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/coaching-hub.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/local.coaching-hub" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Coaching Hub will now run in the background at http://localhost:4747"
echo "Double-clicking 'Coaching Hub.command' just opens the browser."
echo "Log file: $LOG_DIR/coaching-hub.log"
