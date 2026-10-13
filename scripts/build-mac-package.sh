#!/bin/bash
# Builds dist/SF-Desk-mac.zip: the app, its node_modules and Node.js for Apple Silicon, plus the
# double-click installer (mac/package). Run it anywhere npm and nodejs.org are reachable (any OS);
# the people installing need neither.
#   scripts/build-mac-package.sh [node-version]    e.g. v26.11.1 (default: latest release)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
STAGE="$OUT/SF Desk Installer"
NODE_VERSION="${1:-$(curl -fsS https://nodejs.org/dist/index.json | node -p 'JSON.parse(require("fs").readFileSync(0))[0].version')}"
NODE_NAME="node-$NODE_VERSION-darwin-arm64"

rm -rf "$STAGE" "$OUT/SF-Desk-mac.zip"
mkdir -p "$STAGE/app" "$STAGE/runtime"

# The committed app, as on the current commit (not uncommitted edits, .env or data/).
git -C "$ROOT" archive HEAD | tar -x -C "$STAGE/app"

# Dependencies from the lockfile. better-sqlite3 ships prebuilt binaries for every platform in
# its package, so installing on Linux still gives a tree that runs on a Mac.
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
test -f "$STAGE/app/node_modules/better-sqlite3/prebuilds/darwin-arm64.node"

# Node.js for Apple Silicon, checked against nodejs.org's published checksums.
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/$NODE_NAME.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/$NODE_NAME.tar.xz"
curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
(cd "$TMP" && grep " $NODE_NAME.tar.xz\$" SHASUMS256.txt | { command -v sha256sum >/dev/null && sha256sum -c - || shasum -a 256 -c -; })
tar -xJf "$TMP/$NODE_NAME.tar.xz" -C "$TMP"
mkdir -p "$STAGE/runtime/node/bin"
cp "$TMP/$NODE_NAME/bin/node" "$STAGE/runtime/node/bin/node"
cp "$TMP/$NODE_NAME/LICENSE" "$STAGE/runtime/node/LICENSE"
rm -rf "$TMP"

cp "$ROOT/mac/package/Install SF Desk.command" "$ROOT/mac/package/READ ME FIRST.txt" "$STAGE/"
chmod +x "$STAGE/Install SF Desk.command" "$STAGE/app/mac/package/"*.command "$STAGE/runtime/node/bin/node"
printf 'SF Desk %s (%s), Node.js %s\n' "$(git -C "$ROOT" describe --always --dirty)" \
  "$(git -C "$ROOT" log -1 --format=%cs)" "$NODE_VERSION" | tee "$OUT/VERSION.txt" > "$STAGE/app/VERSION.txt"

(cd "$OUT" && zip -qry SF-Desk-mac.zip "SF Desk Installer")
rm -rf "$STAGE"
echo "Built $OUT/SF-Desk-mac.zip ($(du -h "$OUT/SF-Desk-mac.zip" | cut -f1)): $(cat "$OUT/VERSION.txt")"
