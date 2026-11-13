#!/usr/bin/env bash
# Launcher for Quietbook (macOS and Linux): starts the local server and opens
# the dashboard. The Desktop shortcut points here (through Quietbook.command on
# macOS), so it always runs the current version of the project.
#
# The server needs only the Python standard library. A project .venv is used
# if one exists, otherwise python3.

set -euo pipefail

# Resolve symlinks to find the real project root ($0 may be the Desktop
# shortcut). macOS `readlink` has no -f, hence python3.
SCRIPT_PATH="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"
REPO_ROOT="$(dirname "$(dirname "$SCRIPT_PATH")")"
cd "$REPO_ROOT"

if [ -x ".venv/bin/python" ]; then
  PYTHON=".venv/bin/python"
else
  PYTHON="python3"
fi

exec "$PYTHON" scripts/serve_dashboard.py "$@"
