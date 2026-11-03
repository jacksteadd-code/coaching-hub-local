#!/bin/bash
# Double-click to start Coaching Hub and open it in your browser.
# Keep the Terminal window open while you use the app; close it to stop.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Coaching Hub needs Node.js (free). Install the LTS version from nodejs.org, then double-click Coaching Hub again." buttons {"Open nodejs.org"} default button 1' >/dev/null 2>&1
  open "https://nodejs.org/en/download"
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  osascript -e "display dialog \"Coaching Hub needs Node.js 22.13 or newer. You have $(node -v). Install the current LTS from nodejs.org.\" buttons {\"Open nodejs.org\"} default button 1" >/dev/null 2>&1
  open "https://nodejs.org/en/download"
  exit 1
fi

exec node --no-warnings=ExperimentalWarning server/index.js
