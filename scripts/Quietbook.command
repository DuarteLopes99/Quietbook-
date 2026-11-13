#!/usr/bin/env bash
# Double-clickable launcher for macOS (Finder runs .command files in Terminal).
# Everything else lives in quietbook.sh.
set -euo pipefail
SCRIPT_PATH="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"
exec "$(dirname "$SCRIPT_PATH")/quietbook.sh" "$@"
