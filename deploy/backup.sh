#!/usr/bin/env bash
# Nightly snapshot of Study Notes data (consistent SQLite copy + files + markdown); keeps 14 days.
set -euo pipefail
DATA="${NOTES_DATA:-$HOME/apps/study_notes/data}"
DEST="$HOME/backups/study_notes"
STAMP="$(date +%Y%m%d-%H%M)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DEST"
"$HOME/apps/study_notes/.venv/bin/python" - "$DATA/notes.db" "$TMP/notes.db" <<'EOF'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
EOF
tar -czf "$DEST/study-notes-$STAMP.tar.gz" -C "$TMP" notes.db -C "$DATA" files markdown
find "$DEST" -name 'study-notes-*.tar.gz' -mtime +14 -delete
echo "snapshot: $DEST/study-notes-$STAMP.tar.gz"
