#!/usr/bin/env python3
"""Refuse anything that could put personal financial data in git.

Runs in two places with the same rules:

- the pre-commit hook (scripts/install_git_hooks.py) checks what is staged;
- CI checks every tracked file, so a commit made with --no-verify still fails.

Blocked:

- anything under data/ except data/transactions.csv.enc (the encrypted store)
  and data/.gitkeep;
- bank exports and plaintext tables anywhere: .csv .xls .xlsx .xlsm .ods .dec;
- Jupyter checkpoints and .env files;
- a notebook with cell outputs (they carry whatever the cells printed).

With --staged it also runs the tests (`node --test`) when a file under
dashboard/, tests/ or scripts/ is staged.

Usage:
    python scripts/check_privacy.py            # every tracked file (CI)
    python scripts/check_privacy.py --staged   # what is about to be committed (hook)
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parent.parent
ALLOWED_IN_DATA = {"data/transactions.csv.enc", "data/.gitkeep"}
BLOCKED_SUFFIXES = {".csv", ".xls", ".xlsx", ".xlsm", ".ods", ".dec"}
CODE_DIRS = ("dashboard/", "tests/", "scripts/")


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, check=True).stdout


def paths(staged: bool) -> list:
    if staged:
        out = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    else:
        out = git("ls-files", "-z")
    return [p for p in out.decode("utf-8").split("\0") if p]


def blocked_reason(path: str):
    p = PurePosixPath(path)
    if path.startswith("data/") and path not in ALLOWED_IN_DATA:
        return "personal data folder (only data/transactions.csv.enc may be committed)"
    if p.suffix.lower() in BLOCKED_SUFFIXES:
        return "plaintext table or bank export"
    if ".ipynb_checkpoints" in p.parts:
        return "Jupyter checkpoint (keeps a copy of the outputs)"
    if p.name == ".env" or p.name.startswith(".env."):
        return "environment file (may hold secrets)"
    return None


def notebook_has_outputs(path: str, staged: bool) -> bool:
    # The staged copy is what gets committed, not the file on disk.
    text = git("show", f":{path}") if staged else (REPO_ROOT / path).read_bytes()
    cells = json.loads(text.decode("utf-8")).get("cells", [])
    return any(c.get("outputs") for c in cells)


def run_tests() -> bool:
    node = shutil.which("node")
    if not node:
        print("Node is not installed, so the tests could not run. Install Node 18+ (nodejs.org).")
        return False
    run = subprocess.run([node, "--test"], cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8")
    if run.returncode:
        print(run.stdout[-4000:])
        print(run.stderr[-2000:])
    return run.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--staged", action="store_true", help="check the staged files (pre-commit)")
    args = parser.parse_args()

    files = paths(args.staged)
    problems = [(f, reason) for f in files if (reason := blocked_reason(f))]
    problems += [(f, "notebook with cell outputs: clear them first")
                 for f in files if f.endswith(".ipynb") and notebook_has_outputs(f, args.staged)]

    if problems:
        print("\nBLOCKED: this could put personal data in git.")
        for f, reason in problems:
            print(f"  {f}: {reason}")
        if args.staged:
            print("\nUnstage with:  git restore --staged <file>\n")
        return 1

    if args.staged and any(f.startswith(CODE_DIRS) for f in files) and not run_tests():
        print("\nBLOCKED: tests failed (run: node --test).\n")
        return 1

    store, encrypted = REPO_ROOT / "data" / "transactions.csv", REPO_ROOT / "data" / "transactions.csv.enc"
    if args.staged and store.exists() and (not encrypted.exists() or store.stat().st_mtime > encrypted.stat().st_mtime):
        print("Note: data/transactions.csv is newer than its encrypted copy (Data tab > Download encrypted).")

    print(f"Privacy check passed ({len(files)} file(s)).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
