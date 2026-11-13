#!/usr/bin/env python3
"""Serve the dashboard locally and open it in the browser.

Exists because `open dashboard/index.html` doesn't work: under a file://
origin the browser blocks the dashboard's fetch of data/transactions.csv, so
it comes up empty every time. A local HTTP server is the only way the page
can read the store on its own.

Four things this does that `python3 -m http.server` alone doesn't:

- **Always serves the newest version.** Every response carries no-store cache
  headers, so a browser that has the dashboard open from yesterday can't show
  you yesterday's HTML or yesterday's transactions.csv after you've ingested a
  new month. This is the whole point of the desktop shortcut: double-click,
  get today's data, never a stale tab.
- **Reuses a dashboard that is already running.** Double-clicking the shortcut
  four times used to start four servers on four ports — and a browser origin is
  scheme+host+**port**, so each tab got its own localStorage and they overwrote
  each other's review memory. Now a second launch detects the first, opens a tab
  pointing at it, and exits. Only if the port is held by something that is *not*
  this dashboard does it walk up to a free one.
- **Binds to localhost only.** The default http.server listens on every
  interface, which puts your financial data on the local network. This
  doesn't.
- **Accepts PUT for the three data files**, so the dashboard can save your work
  to `data/` on its own: the review decisions, the rules you teach it, and the
  transaction store itself. The store is append-only from here: a save that
  would remove a transaction already in the file is refused (409), except a
  confirmed "Replace all history", which backs the old file up first. Without this, a review lives in the browser's
  localStorage until you remember to click a download button — and localStorage
  is scoped to the exact origin, so a launch that lands on port 8793 instead of
  8792 silently shows an empty history. See SAVEABLE below.

Usage:
    python scripts/serve_dashboard.py [--port 8792] [--no-browser]

Works the same on macOS, Linux and Windows (Python 3.8+, standard library only).
"""

import argparse
import csv
import http.server
import io
import json
import os
import socket
import sys
import threading
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8792
PORT_ATTEMPTS = 20
DASHBOARD_PATH = "/dashboard/index.html"


# The only paths a PUT may write. An allowlist rather than "anything under
# data/": this server is reachable by any page in the browser, and a handler
# that writes arbitrary paths is a hole in the machine, not a feature. Both
# files are gitignored — they hold your notes and your merchant keywords.
# A launch probes this before binding: if the answer names the same repo, an
# instance is already serving and there is no reason to start a second one.
IDENTITY_PATH = "/__quietbook__"

SAVEABLE = {
    "/data/review_decisions.json",
    "/data/category_overrides.json",
    "/data/classification_runs.json",
    "/data/checked_groups.json",
    "/data/transactions.csv",
}
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
# Sent by the page only after the user typed the confirmation in "Replace all
# history". A custom header also forces a CORS preflight, which this server
# never answers, so another site can't send it.
REPLACE_HEADER = "X-Finance-Replace-Store"

# The local Qwen for the review tab's "Re-run classification" (qwen method).
# The page sends a prompt to /api/llm/chat; this server forwards it to Ollama
# on this machine and adds the model name. Nothing leaves the machine.
#   FINANCE_OLLAMA_URL    default http://127.0.0.1:11434
#   FINANCE_OLLAMA_MODEL  default the Qwen3.5-9B GGUF below, pulled from Hugging Face
OLLAMA_URL = os.environ.get("FINANCE_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("FINANCE_OLLAMA_MODEL", "hf.co/bartowski/Qwen_Qwen3.5-9B-GGUF:Q4_K_M")
# Required on /api/llm/chat. Like REPLACE_HEADER it forces a CORS preflight,
# which this server never answers, so no other website can use the model.
ACTION_HEADER = "X-Finance-Action"


def ollama_status() -> dict:
    """Whether Ollama answers and whether the configured model is downloaded."""
    status = {"model": OLLAMA_MODEL, "url": OLLAMA_URL, "reachable": False, "installed": False}
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2) as res:
            names = {m.get("name") for m in json.load(res).get("models", [])}
        status["reachable"] = True
        status["installed"] = OLLAMA_MODEL in names or f"{OLLAMA_MODEL}:latest" in names
    except (OSError, ValueError) as e:
        status["error"] = f"Ollama is not answering at {OLLAMA_URL} ({e.__class__.__name__})"
    return status


def ollama_chat(body: dict) -> str:
    """Forward one chat request to Ollama with the configured model; return the reply text."""
    body = {**body, "model": OLLAMA_MODEL, "stream": False}
    request = urllib.request.Request(f"{OLLAMA_URL}/api/chat", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=300) as res:
        return json.load(res).get("message", {}).get("content", "")

def _stamp(d: dict) -> tuple:
    # reviewed_at first; between two unreviewed decisions the later updated_at decides.
    return (str(d.get("reviewed_at") or ""), str(d.get("updated_at") or ""))


def _newer(a: dict, b: dict) -> dict:
    """Whichever decision was recorded later; on a full tie the one on disk stays."""
    return a if _stamp(a) >= _stamp(b) else b


def _merge_json(path: Path, body: bytes) -> bytes:
    """Union what is on disk with what the browser sent.

    Two shapes, two rules:

    - **review_decisions.json** is a map keyed by transaction id. Union the
      keys; where both sides know one, keep the later `reviewed_at`. A
      `"__deleted"` list of ids is applied afterwards, so undoing a review
      really removes it instead of being resurrected by the merge.
      classification_runs.json and checked_groups.json have the same shape
      (id -> entry with an `updated_at`) and merge the same way.
    - **category_overrides.json** is a list of rules. Union by the rule's
      identity (its keywords + type), incoming wins, so re-teaching
      a merchant replaces that rule rather than stacking a second, shadowed one.

    Anything else is written through untouched.
    """
    incoming = json.loads(body.decode("utf-8"))
    if not path.exists():
        if isinstance(incoming, dict):
            incoming.pop("__deleted", None)
        return json.dumps(incoming, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"

    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        existing = None   # unreadable on disk: the browser's copy is all we have

    if isinstance(incoming, dict) and isinstance(existing, dict):
        deleted = set(incoming.pop("__deleted", []) or [])
        merged = dict(existing)
        for key, value in incoming.items():
            merged[key] = _newer(existing[key], value) if key in existing else value
        for key in deleted:
            merged.pop(key, None)
        result = merged
    elif isinstance(incoming, list) and isinstance(existing, list):
        def identity(rule):
            return (tuple(sorted(str(k).lower() for k in rule.get("keywords", []))),
                    rule.get("type"))
        merged = {identity(r): r for r in existing}
        merged.update({identity(r): r for r in incoming})
        # "peer" belonged to the retired peer-rule mechanism: drop it.
        result = [{k: v for k, v in r.items() if k != "peer"} for r in merged.values()]
    else:
        if isinstance(incoming, dict):
            incoming.pop("__deleted", None)
        result = incoming

    return json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"


def _transaction_ids(text: str) -> set:
    """Non-empty transaction_id values in a store CSV (empty if it has none)."""
    reader = csv.DictReader(io.StringIO(text))
    return {str(row.get("transaction_id") or "").strip() for row in reader} - {""}


def _dropped_transactions(path: Path, body: bytes) -> int:
    """How many transactions on disk the incoming store no longer contains.

    The dashboard has no way to delete a transaction, so a save that drops any
    is a bug by definition — and it was a real one: a bank export given to
    "Load transactions.csv" replaced the loaded store, and the next automatic
    save wrote those few rows over the whole history. Refusing here protects
    the file whatever the page gets wrong. A file on disk that can't be read
    can't be compared, and is not protected.
    """
    if not path.exists():
        return 0
    try:
        on_disk = _transaction_ids(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, csv.Error):
        return 0
    try:
        incoming = _transaction_ids(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, csv.Error):
        incoming = set()
    return len(on_disk - incoming)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that refuses to let anything be cached, and
    accepts PUT for the handful of files the dashboard owns."""

    # Fixed types instead of the operating system's: on Windows they come from
    # the registry, where .js is sometimes text/plain and the page breaks.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json",
        ".csv": "text/csv; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".enc": "application/octet-stream",
    }

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _from_this_page(self) -> bool:
        """Host (and Origin, when sent) must be this server: refuses other sites
        and DNS-rebinding tricks."""
        port = self.server.server_address[1]
        ours = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        return (self.headers.get("Host") in ours
                and (origin is None or origin in {f"http://{h}" for h in ours}))

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/llm/chat":
            self.send_error(404, "Unknown endpoint")
            return
        if not self.headers.get(ACTION_HEADER) or not self._from_this_page():
            self.send_error(403, "Only the dashboard page may use the model")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length).decode("utf-8")) if 0 < length <= 1_000_000 else None
        except (ValueError, UnicodeDecodeError):
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
            self._json(400, {"error": "expected a JSON body with messages"})
            return
        started = datetime.now()
        try:
            content = ollama_chat(body)
        except (OSError, ValueError) as e:
            self._json(502, {"error": f"Ollama: {e}"})
            return
        self._json(200, {"content": content, "seconds": (datetime.now() - started).total_seconds()})

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/llm/status":
            self._json(200, ollama_status())
            return
        if self.path.split("?", 1)[0] == IDENTITY_PATH:
            payload = json.dumps({"app": "quietbook", "root": str(REPO_ROOT)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_PUT(self):
        """Write one of the SAVEABLE files, atomically.

        Atomically because the alternative is a truncated transactions.csv:
        the browser saves on every review, and a crash mid-write with the file
        already opened for truncation loses the store outright. Writing to a
        temp file in the same directory and renaming makes the swap a single
        filesystem operation.
        """
        target = self.path.split("?", 1)[0]
        if target not in SAVEABLE:
            self.send_error(403, "Not a saveable path")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_error(413, "Empty or oversized body")
            return

        body = self.rfile.read(length)
        path = REPO_ROOT / target.lstrip("/")
        path.parent.mkdir(parents=True, exist_ok=True)

        # MERGE, never replace, for the two JSON files.
        #
        # A tab PUTs its whole in-memory map. With more than one tab open —
        # which is easy, since every launch used to pick a new port and so a
        # new browser origin with its own localStorage — the last writer won
        # and silently destroyed everything the other tab knew. That is the
        # "my reviews came back" bug: 60 decisions, then 10, then 60 again,
        # depending purely on which tab saved last.
        #
        # Merging makes concurrent tabs additive instead of destructive. The
        # client sends "__deleted" for the one case where losing an entry is
        # deliberate (undoing a review), so an explicit removal still works.
        if target.endswith(".json"):
            try:
                body = _merge_json(path, body)
            except ValueError as exc:
                self.send_error(400, f"Malformed JSON for {target}: {exc}")
                return

        # Append-only for the store: never write a version missing transactions
        # the file already holds — unless the page says the user confirmed
        # "Replace all history", and even then the old file is backed up first.
        # Otherwise 409 with a plain-text reason the page shows.
        if target == "/data/transactions.csv":
            dropped = _dropped_transactions(path, body)
            if dropped and self.headers.get(REPLACE_HEADER) == "confirmed":
                backup = path.with_name(
                    f"{path.stem}.backup-{datetime.now():%Y%m%dT%H%M%S}{path.suffix}")
                try:
                    backup.write_bytes(path.read_bytes())
                except OSError as exc:
                    self.send_error(500, f"Could not back up {target} before replacing it: {exc}")
                    return
                print(f"  replacing {target}: {dropped} transaction(s) dropped, "
                      f"previous file kept as data/{backup.name}")
                dropped = 0
            if dropped:
                message = (f"Refused: this save would remove {dropped} transaction(s) already in "
                           f"data/transactions.csv. The file on disk was left unchanged.").encode("utf-8")
                print(f"  refused {target}: would drop {dropped} transaction(s)")
                self.send_response(409)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(message)))
                self.end_headers()
                self.wfile.write(message)
                return

        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_bytes(body)
            os.replace(tmp, path)
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            self.send_error(500, f"Could not write {target}: {exc}")
            return

        print(f"  saved {target} ({len(body):,} bytes)")
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is noise in a window the user keeps open all
        # day; only surface things that actually went wrong.
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            sys.stderr.write(f"  {self.requestline} -> {status}\n")


def running_instance(port: int, timeout: float = 0.4):
    """True when *this* dashboard is already serving on `port`.

    Checked against the repo root, not merely "something answered": another
    project's server on 8792 must not be mistaken for ours and handed the
    browser, and a stale port from a different checkout is not ours either.
    """
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}{IDENTITY_PATH}", timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8"))
        return data.get("app") == "quietbook" and data.get("root") == str(REPO_ROOT)
    except Exception:
        return False


WINDOWS = os.name == "nt"


def exclusive_or_reusable(sock: socket.socket) -> None:
    """Make a busy port fail to bind on every OS.

    On macOS and Linux SO_REUSEADDR only lets a port be reused right after a
    previous server closed it. On Windows it lets two servers bind the SAME
    port at once, so there the socket asks for exclusive use instead.
    """
    if WINDOWS:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)


class DashboardServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = False   # set per OS in server_bind

    def server_bind(self):
        exclusive_or_reusable(self.socket)
        super().server_bind()


def find_free_port(preferred: int, attempts: int = PORT_ATTEMPTS) -> int:
    for candidate in range(preferred, preferred + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            exclusive_or_reusable(probe)
            try:
                probe.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    raise SystemExit(f"No free port in {preferred}-{preferred + attempts - 1}. "
                     f"Close whatever is using them, or pass --port.")


def describe_store() -> str:
    """A one-line 'here's what you're about to look at' so the user can tell
    at a glance whether this month has been ingested yet."""
    store = REPO_ROOT / "data" / "transactions.csv"
    encrypted = REPO_ROOT / "data" / "transactions.csv.enc"
    if store.exists():
        modified = datetime.fromtimestamp(store.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        # -1 for the header row; a store with only a header is empty, not -1 rows.
        lines = max(sum(1 for _ in store.open(encoding="utf-8", errors="replace")) - 1, 0)
        return f"data/transactions.csv — {lines} transactions, last updated {modified}"
    if encrypted.exists():
        return ("data/transactions.csv is not present, but transactions.csv.enc is — "
                "use the dashboard's \"Replace all history with an encrypted file\" button,.")
    return "No store yet — the dashboard will open empty. Add monthly file(s) from the page itself."


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"Preferred port (default {DEFAULT_PORT}; walks up if taken)")
    parser.add_argument("--no-browser", action="store_true", help="Don't open a browser window")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    os.chdir(REPO_ROOT)

    # One dashboard, one origin. Starting a second server would give the new tab
    # its own localStorage and let the two overwrite each other's review memory.
    if running_instance(args.port):
        url = f"http://127.0.0.1:{args.port}{DASHBOARD_PATH}"
        print("Quietbook")
        print(f"  Already running on port {args.port} — opening that one instead of starting a second.")
        print(f"  {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    port = find_free_port(args.port)
    url = f"http://127.0.0.1:{port}{DASHBOARD_PATH}"

    server = DashboardServer(("127.0.0.1", port), NoCacheHandler)

    print("Quietbook")
    print(f"  {describe_store()}")
    print(f"  Serving {REPO_ROOT}")
    print(f"  {url}")
    print("  Reviews, rules and new transactions are saved straight into data/ — "
          "no download button needed.")
    print("\nLeave this window open while you use the dashboard. Press Ctrl-C (or close "
          "the window) to stop the server.\n")

    if not args.no_browser:
        # Delayed so the browser doesn't race the server to the first request.
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
