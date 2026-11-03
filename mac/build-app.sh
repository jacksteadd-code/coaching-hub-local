#!/bin/bash
# Builds "Coaching Hub.app" with its own copy of Node.js (Apple silicon and
# Intel), so nothing else needs installing. Usage: mac/build-app.sh [out-dir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
NODE_VERSION="v24.22.2"
CACHE="${NODE_CACHE:-$ROOT/.node-cache}"
APP="$OUT/Coaching Hub.app"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

mkdir -p "$CACHE"
( cd "$CACHE"
  curl -sSfO "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  for arch in arm64 x64; do
    f="node-$NODE_VERSION-darwin-$arch.tar.xz"
    [ -f "$f" ] || curl -sSfO "https://nodejs.org/dist/$NODE_VERSION/$f"
    grep " $f\$" SHASUMS256.txt | sha -c -
  done )

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/node"
cp "$ROOT/mac/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/mac/launcher.sh" "$APP/Contents/MacOS/CoachingHub"
chmod 755 "$APP/Contents/MacOS/CoachingHub"
cp "$ROOT/mac/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp -R "$ROOT/server" "$ROOT/public" "$ROOT/package.json" "$ROOT/README.md" "$APP/Contents/Resources/app/"
for arch in arm64 x64; do
  mkdir -p "$APP/Contents/Resources/node/$arch"
  tar -xJf "$CACHE/node-$NODE_VERSION-darwin-$arch.tar.xz" -C "$APP/Contents/Resources/node/$arch" --strip-components=2 "node-$NODE_VERSION-darwin-$arch/bin/node"
  tar -xJf "$CACHE/node-$NODE_VERSION-darwin-$arch.tar.xz" -C "$APP/Contents/Resources/node/$arch" --strip-components=1 "node-$NODE_VERSION-darwin-$arch/LICENSE"
done
echo "Built $APP"
