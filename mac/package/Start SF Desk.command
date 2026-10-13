#!/bin/bash
# Starts SF Desk and opens it in the browser. Double-click it; keep the Terminal window open
# while you use SF Desk, and close it (or press Ctrl+C) to stop.
# It runs in Terminal on purpose: macOS gives calendar access to the app that starts SF Desk.

DEST="$HOME/SF-Desk"
cd "$DEST" || { echo "SF Desk isn't installed in $DEST. Run the installer first."; read -r -p "Press Return to close." _; exit 1; }

NODE="$DEST/runtime/node/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "Node.js not found. Run the installer again."; read -r -p "Press Return to close." _; exit 1; }

PORT="$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' .env 2>/dev/null | grep . | tail -1)"
URL="http://localhost:${PORT:-3000}"

if curl -fs -o /dev/null "$URL"; then
  echo "SF Desk is already running at $URL."
  open "$URL"
  exit 0
fi

# Open the browser once the server answers.
( for _ in $(seq 1 60); do curl -fs -o /dev/null "$URL" && { open "$URL"; exit; }; sleep 0.5; done ) &

echo "Starting SF Desk at $URL (close this window to stop it)..."
exec "$NODE" server.js
