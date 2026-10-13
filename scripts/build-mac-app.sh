#!/bin/bash
# Builds "SF Desk.app": a Mac app (mac/app) that carries the SF Desk server, its node_modules, Node.js and
# the calendar reader inside, and shows SF Desk in its own window. Run it on a Mac with the Xcode Command
# Line Tools (for swiftc); it downloads nothing.
#
#   scripts/build-mac-app.sh --from dist/SF-Desk-mac.zip     # recommended
#   scripts/build-mac-app.sh [--node /path/to/node]          # from this checkout
#
# The app's code is always this checkout's current commit. --from takes node_modules and Node.js from the
#   download scripts/build-mac-package.sh makes (the zip or its unzipped folder), which can be built
#   anywhere npm and nodejs.org are reachable; it only needs rebuilding when package-lock.json changes.
# Without --from it uses this checkout's node_modules, with --node (default: the node on PATH). That has
#   to be a standalone build like nodejs.org's: Homebrew's needs libraries that aren't in the app.
# --out DIR puts "SF Desk.app", SF-Desk-app.zip and SF-Desk.dmg (the disk image to hand out, with the docs)
#   in DIR (default: dist/).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
FROM=""
NODE=""
die() { printf '%s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) die "Unknown option $1. See the top of $0." ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "Build SF Desk.app on a Mac."
xcrun --find swiftc >/dev/null 2>&1 || die "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. The server (this commit), its node_modules and Node.js.
PAYLOAD="$TMP/payload"
mkdir -p "$PAYLOAD"
git -C "$ROOT" archive HEAD | tar -x -C "$PAYLOAD"
BUILD_INFO="SF Desk $(git -C "$ROOT" describe --always --dirty) ($(git -C "$ROOT" log -1 --format=%cs))"
if [ -n "$FROM" ]; then
  if [ -f "$FROM" ]; then
    ditto -x -k "$FROM" "$TMP/from"
    FROM="$TMP/from"
  fi
  [ -d "$FROM/SF Desk Installer" ] && FROM="$FROM/SF Desk Installer"
  [ -d "$FROM/app/node_modules" ] && [ -x "$FROM/runtime/node/bin/node" ] ||
    die "$FROM isn't a download from scripts/build-mac-package.sh (no app/node_modules and runtime/node)."
  cmp -s "$FROM/app/package-lock.json" "$PAYLOAD/package-lock.json" ||
    die "That download's package-lock.json differs from this commit's. Rebuild it with scripts/build-mac-package.sh."
  ditto "$FROM/app/node_modules" "$PAYLOAD/node_modules"
  NODE="$FROM/runtime/node/bin/node"
else
  [ -d "$ROOT/node_modules/better-sqlite3" ] || die "No node_modules in $ROOT. Install them (see INSTALL.md step 4) or use --from."
  ditto "$ROOT/node_modules" "$PAYLOAD/node_modules"
  NODE="${NODE:-$(command -v node || true)}"
  [ -x "$NODE" ] || die "No Node.js found. Pass --node /path/to/node, or use --from."
  # Only a standalone Node can travel inside the app.
  if otool -L "$NODE" | tail -n +2 | awk '{print $1}' | grep -qvE '^(/usr/lib/|/System/)'; then
    die "$NODE needs libraries outside macOS (Homebrew's node does), so it can't go in the app. Use nodejs.org's build with --node, or --from."
  fi
fi
BUILD_INFO="$BUILD_INFO, Node.js $("$NODE" -v)"
VERSION="$("$NODE" -p "require(process.argv[1]).version" "$PAYLOAD/package.json" 2>/dev/null ||
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PAYLOAD/package.json" | head -1)"

# 2. The app and the calendar reader, for Apple Silicon and Intel.
compile() { # compile OUTPUT SWIFTC-ARGS...
  local out="$1"; shift
  local slices=()
  for arch in arm64 x86_64; do
    xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" "$@" -o "$TMP/slice-$arch"
    slices+=("$TMP/slice-$arch")
  done
  lipo -create "${slices[@]}" -output "$out"
  rm -f "${slices[@]}"
}

APP="$OUT/SF Desk.app"
C="$APP/Contents"
rm -rf "$APP" "$OUT/SF-Desk-app.zip"
mkdir -p "$C/MacOS" "$C/Resources/node/bin"

echo "Compiling the app..."
compile "$C/MacOS/SF Desk" -parse-as-library "$ROOT/mac/app/SFDesk.swift"
echo "Compiling the calendar reader..."
compile "$C/MacOS/sfdesk-calendar" "$PAYLOAD/mac/calendar.swift" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PAYLOAD/mac/Info.plist"

sed -e "s|__VERSION__|$VERSION|" -e "s|__BUILD__|$(date +%Y%m%d.%H%M)|" -e "s|__BUILD_INFO__|$BUILD_INFO|" \
  "$ROOT/mac/app/Info.plist" > "$C/Info.plist"
plutil -lint "$C/Info.plist" >/dev/null

ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ROOT/mac/app/AppIcon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ROOT/mac/app/AppIcon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$C/Resources/AppIcon.icns"

# 3. The server, without anything personal or not needed on a Mac.
ditto "$PAYLOAD" "$C/Resources/app"
(cd "$C/Resources/app" && rm -rf .env data certs dist runtime sf-cli .sfdesk-install .git node_modules/.bin)
find "$C/Resources/app/node_modules" -path '*/prebuilds/*' -name '*.node' ! -name 'darwin-*' -delete
cp "$NODE" "$C/Resources/node/bin/node"
[ -f "$(dirname "$NODE")/../LICENSE" ] && cp "$(dirname "$NODE")/../LICENSE" "$C/Resources/node/LICENSE"
chmod +x "$C/Resources/node/bin/node"
echo "$BUILD_INFO" > "$C/Resources/app/VERSION.txt"

# 4. Sign it ad hoc (there's no Apple developer certificate), keeping signatures that are already valid
#    such as Node.js's own.
xattr -cr "$APP"
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q Mach-O && ! codesign -v "$f" 2>/dev/null; then codesign -f -s - "$f"; fi
done < <(find "$C/Resources" -type f -print0)
codesign -f -s - "$C/MacOS/sfdesk-calendar"
codesign -f -s - "$APP"
codesign --verify --strict "$APP" || echo "Warning: codesign --verify reported a problem (above)." >&2

# 5. Check the bundled Node can load SQLite, then zip it for handing out.
if [ "$(uname -m)" = "arm64" ]; then
  "$C/Resources/node/bin/node" -e "new (require(process.argv[1]))(':memory:').close()" \
    "$C/Resources/app/node_modules/better-sqlite3" || die "The bundled Node.js couldn't load better-sqlite3."
fi
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/SF-Desk-app.zip"

# 6. The disk image to hand out: the app, a shortcut to Applications to drag it onto, and the docs as pages.
DMG="$TMP/dmg"
mkdir -p "$DMG"
ditto "$APP" "$DMG/SF Desk.app"
ln -s /Applications "$DMG/Applications"
printf '{"INSTALL.md":"Read Me First.html","README.md":"About SF Desk.html","OUTLOOK.md":"Outlook Add-in.html"}' > "$TMP/links.json"
"$NODE" "$ROOT/scripts/md-to-html.mjs" "$PAYLOAD/mac/app/READ ME FIRST.md" "$DMG/Read Me First.html" "Installing SF Desk" "$TMP/links.json"
"$NODE" "$ROOT/scripts/md-to-html.mjs" "$PAYLOAD/README.md" "$DMG/About SF Desk.html" "About SF Desk" "$TMP/links.json"
"$NODE" "$ROOT/scripts/md-to-html.mjs" "$PAYLOAD/OUTLOOK.md" "$DMG/Outlook Add-in.html" "SF Desk in Outlook" "$TMP/links.json"
cp "$C/Resources/AppIcon.icns" "$DMG/.VolumeIcon.icns"
SetFile -a C "$DMG" 2>/dev/null || true # use that icon for the mounted disk, where SetFile is installed
rm -f "$OUT/SF-Desk.dmg"
hdiutil create -quiet -volname "SF Desk" -srcfolder "$DMG" -fs HFS+ -format UDZO -ov "$OUT/SF-Desk.dmg"

echo "Built $APP, $OUT/SF-Desk-app.zip and $OUT/SF-Desk.dmg ($(du -h "$OUT/SF-Desk.dmg" | cut -f1)): $BUILD_INFO"
