#!/usr/bin/env bash
# Build the drawing editor and deploy the server to the Raspberry Pi.
# Usage: deploy/deploy.sh [ssh-host]   (default: rpi -> 192.168.3.20)
set -euo pipefail
HOST="${1:-rpi}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=apps/study_notes

echo "==> Building Excalidraw editor"
(cd "$ROOT/draw" && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build >/dev/null)

echo "==> Syncing server to $HOST:~/$APP"
ssh "$HOST" "mkdir -p ~/$APP ~/.config/systemd/user"
rsync -az --delete --exclude data/ --exclude __pycache__/ --exclude .venv/ \
  "$ROOT/server/" "$HOST:$APP/"
rsync -az "$ROOT/deploy/study-notes.service" "$ROOT/deploy/study-notes-backup.service" \
  "$ROOT/deploy/study-notes-backup.timer" "$HOST:.config/systemd/user/"
rsync -az "$ROOT/deploy/backup.sh" "$HOST:$APP/backup.sh"

echo "==> Installing dependencies and (re)starting the service"
ssh "$HOST" bash -s <<EOF
set -euo pipefail
cd ~/$APP
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
[ -f ~/.config/study-notes.env ] || printf 'LLM_URL=http://192.168.3.30:11434/v1/chat/completions\nLLM_MODEL=openclaw\n' > ~/.config/study-notes.env
systemctl --user daemon-reload
systemctl --user enable --now study-notes.service study-notes-backup.timer >/dev/null
systemctl --user restart study-notes.service
sleep 2
systemctl --user --no-pager --lines=0 status study-notes.service | head -3
curl -fsS http://127.0.0.1:8765/api/health && echo
EOF
echo "==> Done: http://192.168.3.20:8765"
