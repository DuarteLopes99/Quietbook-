#!/usr/bin/env python3
"""Install a pre-commit hook that keeps plaintext financial data out of git.

`.gitignore` is a convention, not a guarantee: `git add -f data/transactions.csv`
bypasses it silently. The hook runs scripts/check_privacy.py on what is staged
and refuses the commit on personal data, a notebook with outputs, or failing
tests. See that script for the full list.

Works on macOS, Linux and Windows (Git for Windows runs hooks with its own sh).
The hook looks for python3, python or the Windows `py` launcher, and if it
finds none it blocks the commit rather than skipping the check.

Usage:
    python scripts/install_git_hooks.py            # install
    python scripts/install_git_hooks.py --remove
"""

import argparse
import stat
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOK_MARKER = "# quietbook pre-commit guard"

HOOK = """#!/bin/sh
# quietbook pre-commit guard
# Installed by scripts/install_git_hooks.py. Bypass only in an emergency with --no-verify.
cd "$(git rev-parse --show-toplevel)" || exit 1
for py in python3 python py; do
  # The version check also skips the Windows Store "python3" stub, which exists but doesn't run.
  if command -v "$py" >/dev/null 2>&1 && "$py" -c "import sys; sys.exit(sys.version_info < (3, 8))" >/dev/null 2>&1; then
    exec "$py" scripts/check_privacy.py --staged
  fi
done
echo "COMMIT BLOCKED: Python 3.8+ not found, so the privacy check could not run." >&2
exit 1
"""


def hooks_dir() -> Path:
    try:
        out = subprocess.run(["git", "rev-parse", "--git-path", "hooks"],
                             cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        raise SystemExit("Not a git repository (or git is unavailable): nothing to install into.")
    path = Path(out.stdout.strip())
    return path if path.is_absolute() else REPO_ROOT / path


def install() -> int:
    target = hooks_dir()
    target.mkdir(parents=True, exist_ok=True)
    hook_path = target / "pre-commit"

    if hook_path.exists() and HOOK_MARKER not in hook_path.read_text(encoding="utf-8", errors="replace"):
        raise SystemExit(f"{hook_path} already exists and isn't ours: refusing to overwrite it.\n"
                         f"Merge the guard from scripts/install_git_hooks.py into it by hand.")

    # newline="\n": a hook with Windows line endings fails in sh.
    with open(hook_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(HOOK)
    hook_path.chmod(hook_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"Installed {hook_path}")
    print("  Blocks: anything in data/ but the encrypted store, bank exports, notebook outputs, failing tests")
    return 0


def remove() -> int:
    hook_path = hooks_dir() / "pre-commit"
    if not hook_path.exists():
        print("No pre-commit hook to remove.")
        return 0
    if HOOK_MARKER not in hook_path.read_text(encoding="utf-8", errors="replace"):
        raise SystemExit(f"{hook_path} isn't ours: leaving it alone.")
    hook_path.unlink()
    print(f"Removed {hook_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--remove", action="store_true", help="Uninstall the hook")
    args = parser.parse_args()
    return remove() if args.remove else install()


if __name__ == "__main__":
    sys.exit(main())
