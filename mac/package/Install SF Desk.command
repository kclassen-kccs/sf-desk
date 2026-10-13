#!/bin/bash
# Installs (or updates) SF Desk for the current user in ~/SF-Desk.
# Double-click this file in Finder, or run it from Terminal. Safe to run again: your .env,
# Salesforce login and local data (data/) are kept.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/SF-Desk"
MARKER="$DEST/.sfdesk-install"
SF_INSTANCE="https://sailpoint.my.salesforce.com"
SF_ALIAS="sailpoint"
SF_TARBALL_BASE="https://developer.salesforce.com/media/salesforce-cli/sf/channels/stable"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*"; read -r -p "Press Return to close." _ || true; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "SF Desk's installer is for macOS."
[ -d "$HERE/app" ] || die "Can't find the app folder next to this script. Unzip the whole download and run it from there."

# Files from a browser download are quarantined, and macOS would block the bundled Node and
# SQLite libraries one dialog at a time. Clear it on the installer's own files.
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null || true

bold "Installing SF Desk into $DEST"

# 1. Node: use the bundled one on Apple Silicon, otherwise a Node 22+ already on the Mac.
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ] && [ -x "$HERE/runtime/node/bin/node" ]; then
  NODE_SRC="$HERE/runtime/node"
  note "Using the bundled Node.js $("$NODE_SRC/bin/node" -v)."
else
  NODE_SRC=""
  SYS_NODE="$(command -v node || true)"
  if [ -z "$SYS_NODE" ] || [ "$("$SYS_NODE" -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    die "This Mac ($ARCH) needs Node.js 22 or newer. Install the macOS package from https://nodejs.org, then run this again."
  fi
  note "Using Node.js $("$SYS_NODE" -v) from $SYS_NODE."
fi

# 2. Copy the app. An existing install is replaced, except for your settings and data.
if [ -e "$DEST" ] && [ ! -f "$MARKER" ]; then
  die "$DEST already exists and wasn't made by this installer. Move or rename it, then run this again."
fi
mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 \
  ! -name data ! -name .env ! -name sf-cli ! -name .sfdesk-install -exec rm -rf {} +
cp -R "$HERE/app/." "$DEST/"
if [ -n "$NODE_SRC" ]; then
  mkdir -p "$DEST/runtime"
  cp -R "$NODE_SRC" "$DEST/runtime/node"
fi
cp "$HERE/app/mac/package/Start SF Desk.command" "$DEST/Start SF Desk.command"
chmod +x "$DEST/Start SF Desk.command"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
date > "$MARKER"
note "Copied the app."

[ -f "$DEST/.env" ] || cp "$DEST/.env.example" "$DEST/.env"
set_env() { # set_env KEY VALUE: replace the line in .env, or add it
  if grep -q "^$1=" "$DEST/.env"; then
    sed -i '' "s|^$1=.*|$1=$2|" "$DEST/.env"
  else
    printf '%s=%s\n' "$1" "$2" >> "$DEST/.env"
  fi
}

# 3. Xcode Command Line Tools build the calendar reader. Optional: without them SF Desk asks
#    Calendar.app instead, which is slower.
if ! xcode-select -p >/dev/null 2>&1; then
  bold "Xcode Command Line Tools"
  note "macOS will offer to install them now. Click Install; you can carry on while it runs."
  xcode-select --install 2>/dev/null || true
fi

# 4. Salesforce CLI. Use one already installed, else download Salesforce's own build into
#    ~/SF-Desk/sf-cli (no admin rights needed, and no npm).
bold "Salesforce CLI"
SF=""
for candidate in "$(command -v sf || true)" /usr/local/bin/sf /opt/homebrew/bin/sf "$DEST/sf-cli/bin/sf"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then SF="$candidate"; break; fi
done
if [ -z "$SF" ]; then
  case "$ARCH" in arm64) SF_FILE="sf-darwin-arm64.tar.xz" ;; *) SF_FILE="sf-darwin-x64.tar.xz" ;; esac
  note "Downloading the Salesforce CLI from Salesforce..."
  TMP="$(mktemp -d)"
  if curl -fL --progress-bar -o "$TMP/sf.tar.xz" "$SF_TARBALL_BASE/$SF_FILE" &&
     mkdir -p "$TMP/sf" && tar -xJf "$TMP/sf.tar.xz" -C "$TMP/sf" --strip-components 1; then
    rm -rf "$DEST/sf-cli"
    mv "$TMP/sf" "$DEST/sf-cli"
    xattr -dr com.apple.quarantine "$DEST/sf-cli" 2>/dev/null || true
    SF="$DEST/sf-cli/bin/sf"
  fi
  rm -rf "$TMP"
  [ -n "$SF" ] || { open "https://developer.salesforce.com/tools/salesforcecli";
    die "Couldn't download the Salesforce CLI. Install it with the macOS installer on the page that just opened, then run this again."; }
fi
note "Using $SF"
set_env SF_CLI_PATH "$SF"
set_env SF_TARGET_ORG "$SF_ALIAS"

# 5. Salesforce login, once. The CLI keeps it; SF Desk borrows it.
if "$SF" org display --target-org "$SF_ALIAS" --json 2>/dev/null | grep -q '"status": *0'; then
  note "Already signed in to Salesforce."
else
  note "A browser window will open. Sign in to Salesforce with SSO as usual, then come back here."
  "$SF" org login web --instance-url "$SF_INSTANCE" --alias "$SF_ALIAS" ||
    die "Salesforce sign-in didn't finish. Run this installer again to retry."
fi

# 6. Calendar. SF Desk reads the calendars macOS syncs, so the SailPoint Exchange account
#    has to be in Internet Accounts, not only in Outlook.
bold "Your SailPoint calendar"
note "SF Desk's Time Entry tab reads meetings from the Exchange account in"
note "System Settings > Internet Accounts. Check that this week's meetings show in Calendar.app."
read -r -p "  Open Internet Accounts to add or check it? [y/N] " answer || answer=""
if [[ "$answer" =~ ^[Yy] ]]; then
  open "x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension" 2>/dev/null ||
    open -b com.apple.systempreferences
  note "Add Account > Microsoft Exchange, sign in with your SailPoint email, and turn on Calendars."
  read -r -p "  Press Return when you're done. " _ || true
fi

# 7. A launcher on the Desktop.
cp "$DEST/Start SF Desk.command" "$HOME/Desktop/Start SF Desk.command" 2>/dev/null &&
  note "Put \"Start SF Desk\" on your Desktop."

bold "Done. Starting SF Desk..."
note "When macOS asks whether Terminal may access your calendars, choose Allow Full Access."
exec "$DEST/Start SF Desk.command"
