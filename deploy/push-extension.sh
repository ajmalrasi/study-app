#!/usr/bin/env bash
# Copy the Chrome extension to another machine, then click "reload" on it in chrome://extensions.
# Usage: deploy/push-extension.sh [user@host] [dest]
set -euo pipefail
HOST="${1:-ajmalrasi@192.168.3.210}"
DEST="${2:-/home/ajmalrasi/tgs/study}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

ssh "$HOST" "mkdir -p '$DEST'"
rsync -az --delete --exclude .DS_Store "$ROOT/extension/" "$HOST:$DEST/"
ssh "$HOST" "ls '$DEST'"
echo "==> Copied to $HOST:$DEST. In Chrome there: chrome://extensions → Load unpacked (first time) or ↻ reload."
