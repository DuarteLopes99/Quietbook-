#!/usr/bin/env python3
"""Put a double-clickable "Quietbook" shortcut on the Desktop.

- macOS: a symlink to scripts/Quietbook.command (Finder opens it in Terminal).
- Linux: a symlink to scripts/quietbook.sh.
- Windows: a small Quietbook.bat that calls scripts\\quietbook.bat (symlinks
  need administrator rights on Windows, a one-line .bat doesn't).

The shortcut always runs the project's current launcher, never a stale copy.
Run it again if you move the project folder.

Usage:
    python scripts/install_desktop_shortcut.py            # install / repair
    python scripts/install_desktop_shortcut.py --remove   # take it off the Desktop
"""

import argparse
import os
import stat
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WINDOWS = os.name == "nt"
MACOS = sys.platform == "darwin"

if WINDOWS:
    LAUNCHER, SHORTCUT_NAME = REPO_ROOT / "scripts" / "quietbook.bat", "Quietbook.bat"
elif MACOS:
    LAUNCHER, SHORTCUT_NAME = REPO_ROOT / "scripts" / "Quietbook.command", "Quietbook.command"
else:
    LAUNCHER, SHORTCUT_NAME = REPO_ROOT / "scripts" / "quietbook.sh", "Quietbook.sh"

WINDOWS_MARKER = "rem quietbook desktop shortcut"


def desktop_dir() -> Path:
    home = Path.home()
    # Windows often moves the Desktop into OneDrive.
    candidates = [home / "Desktop", Path(os.environ.get("OneDrive", home / "OneDrive")) / "Desktop"]
    for desktop in candidates:
        if desktop.is_dir():
            return desktop
    raise SystemExit(f"No Desktop folder at {candidates[0]}: nothing to install into. "
                     f"Start Quietbook with: python scripts/serve_dashboard.py")


def is_ours(shortcut: Path) -> bool:
    if shortcut.is_symlink():
        return True
    if WINDOWS and shortcut.is_file():
        return WINDOWS_MARKER in shortcut.read_text(encoding="utf-8", errors="replace")
    return False


def install() -> int:
    if not LAUNCHER.exists():
        raise SystemExit(f"Launcher missing: {LAUNCHER}")
    shortcut = desktop_dir() / SHORTCUT_NAME

    if shortcut.exists() or shortcut.is_symlink():
        if not is_ours(shortcut):
            raise SystemExit(f"{shortcut} already exists and isn't a Quietbook shortcut: "
                             f"move or delete it first.")
        shortcut.unlink()   # repoint: the project may have moved

    if WINDOWS:
        with open(shortcut, "w", encoding="utf-8", newline="\r\n") as f:
            f.write(f'@echo off\n{WINDOWS_MARKER}\ncall "{LAUNCHER}" %*\n')
    else:
        LAUNCHER.chmod(LAUNCHER.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        (REPO_ROOT / "scripts" / "quietbook.sh").chmod(0o755)
        shortcut.symlink_to(LAUNCHER)

    print(f"Installed: {shortcut}\n  -> {LAUNCHER}")
    print("\nDouble-click it to start Quietbook. A terminal window stays open while the")
    print("server runs; close it (or press Ctrl-C) when you're done.")
    if MACOS:
        print("The first launch may show a prompt about running a downloaded script: choose Open.")
    if WINDOWS:
        print('If Windows SmartScreen asks, choose "More info" then "Run anyway".')
    return 0


def remove() -> int:
    shortcut = desktop_dir() / SHORTCUT_NAME
    if not (shortcut.exists() or shortcut.is_symlink()):
        print("Nothing to remove.")
    elif is_ours(shortcut):
        shortcut.unlink()
        print(f"Removed {shortcut}")
    else:
        raise SystemExit(f"{shortcut} isn't a Quietbook shortcut: leaving it alone.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--remove", action="store_true", help="Remove the Desktop shortcut")
    args = parser.parse_args()
    return remove() if args.remove else install()


if __name__ == "__main__":
    sys.exit(main())
