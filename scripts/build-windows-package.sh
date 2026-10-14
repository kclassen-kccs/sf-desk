#!/bin/bash
# Builds dist/SF-Desk-windows.zip (Intel/AMD PCs) or dist/SF-Desk-windows-arm64.zip (ARM PCs, e.g.
# Snapdragon): the app, its node_modules and Node.js for that kind of Windows PC, plus the double-click
# installer (windows/package). Run it anywhere npm and nodejs.org are reachable (any OS); the people
# installing need neither.
#   scripts/build-windows-package.sh [--arch x64|arm64] [node-version]    e.g. v26.11.1 (default: latest release)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
ARCH=x64
if [ "${1:-}" = "--arch" ]; then ARCH="$2"; shift 2; fi
case "$ARCH" in x64) ZIP=SF-Desk-windows.zip ;; arm64) ZIP=SF-Desk-windows-arm64.zip ;; *) echo "--arch must be x64 or arm64" >&2; exit 1 ;; esac
STAGE="$OUT/SF Desk for Windows"
NODE_VERSION="${1:-$(curl -fsS https://nodejs.org/dist/index.json | node -p 'JSON.parse(require("fs").readFileSync(0))[0].version')}"
NODE_NAME="node-$NODE_VERSION-win-$ARCH"

rm -rf "$STAGE" "$OUT/$ZIP"
mkdir -p "$STAGE/app" "$STAGE/runtime"

# The committed app, as on the current commit (not uncommitted edits, .env or data/).
git -C "$ROOT" archive HEAD | tar -x -C "$STAGE/app"

# Dependencies from the lockfile. better-sqlite3 ships prebuilt binaries for every platform in
# its package, so installing on Linux or macOS still gives a tree that runs on Windows.
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
test -f "$STAGE/app/node_modules/better-sqlite3/prebuilds/win32-$ARCH.node"

# Node.js for this kind of Windows PC, checked against nodejs.org's published checksums.
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/$NODE_NAME.zip" "https://nodejs.org/dist/$NODE_VERSION/$NODE_NAME.zip"
curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
(cd "$TMP" && grep " $NODE_NAME.zip\$" SHASUMS256.txt | { command -v sha256sum >/dev/null && sha256sum -c - || shasum -a 256 -c -; })
unzip -q -j "$TMP/$NODE_NAME.zip" "$NODE_NAME/node.exe" "$NODE_NAME/LICENSE" -d "$STAGE/runtime"
rm -rf "$TMP"

cp "$ROOT/windows/package/Install SF Desk.cmd" "$ROOT/windows/package/READ ME FIRST.txt" "$STAGE/"
# Notepad shows CRLF line endings best.
awk '{ printf "%s\r\n", $0 }' "$ROOT/RELEASE-NOTES.md" > "$STAGE/Release Notes.txt"
printf 'SF Desk %s (%s, %s), Node.js %s for Windows '"$ARCH"'\n' "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)" \
  "$(git -C "$ROOT" describe --always --dirty)" "$(git -C "$ROOT" log -1 --format=%cs)" "$NODE_VERSION" | tee "$OUT/VERSION-windows-$ARCH.txt" > "$STAGE/app/VERSION.txt"

(cd "$OUT" && zip -qry "$ZIP" "SF Desk for Windows")
rm -rf "$STAGE"
echo "Built $OUT/$ZIP ($(du -h "$OUT/$ZIP" | cut -f1)): $(cat "$OUT/VERSION-windows-$ARCH.txt")"
