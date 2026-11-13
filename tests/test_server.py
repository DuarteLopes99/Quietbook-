"""Tests for scripts/serve_dashboard.py, on every OS (CI runs them on macOS, Linux and Windows).

Run with:  python -m unittest discover -s tests -p "test_*.py"

Each test serves a temporary copy of the project, so nothing here reads or
writes the real data/ folder.
"""

import functools
import importlib.util
import shutil
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("serve_dashboard", REPO / "scripts" / "serve_dashboard.py")
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        shutil.copytree(REPO / "dashboard", self.root / "dashboard")
        self.original_root = server_module.REPO_ROOT
        server_module.REPO_ROOT = self.root
        handler = functools.partial(server_module.NoCacheHandler, directory=str(self.root))
        port = server_module.find_free_port(18792)
        self.server = server_module.DashboardServer(("127.0.0.1", port), handler)
        self.base = f"http://127.0.0.1:{port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        server_module.REPO_ROOT = self.original_root
        shutil.rmtree(self.root, ignore_errors=True)

    def request(self, path, method="GET", body=None, headers=None):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_serves_the_dashboard_uncached_with_the_right_types(self):
        status, headers, body = self.request("/dashboard/index.html")
        self.assertEqual(status, 200)
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertIn(b"<html", body.lower())
        _, headers, _ = self.request("/dashboard/engine.js")
        self.assertTrue(headers["Content-Type"].startswith("text/javascript"))

    def test_only_listed_files_can_be_written(self):
        status, _, _ = self.request("/dashboard/index.html", "PUT", b"x")
        self.assertEqual(status, 403)
        status, _, _ = self.request("/data/../dashboard/index.html", "PUT", b"x")
        self.assertEqual(status, 403)

    def test_store_is_append_only(self):
        header = "transaction_id,Date,Notes\n"
        two = (header + "a,2026-01-01,x\nb,2026-01-02,y\n").encode()
        status, _, _ = self.request("/data/transactions.csv", "PUT", two)
        self.assertEqual(status, 204)
        status, _, body = self.request("/data/transactions.csv", "PUT", (header + "a,2026-01-01,x\n").encode())
        self.assertEqual(status, 409)
        self.assertIn(b"remove 1 transaction", body)
        self.assertEqual((self.root / "data" / "transactions.csv").read_bytes(), two)

    def test_json_files_merge_instead_of_overwriting(self):
        self.request("/data/review_decisions.json", "PUT", b'{"a": {"reviewed_at": "1"}}')
        self.request("/data/review_decisions.json", "PUT", b'{"b": {"reviewed_at": "2"}}')
        _, _, body = self.request("/data/review_decisions.json")
        self.assertIn(b'"a"', body)
        self.assertIn(b'"b"', body)

    def test_a_busy_port_is_not_reused(self):
        busy = self.server.server_address[1]
        self.assertNotEqual(server_module.find_free_port(busy, attempts=5), busy)
        with self.assertRaises(OSError):
            server_module.DashboardServer(("127.0.0.1", busy), server_module.NoCacheHandler)

    def test_identity_names_this_project(self):
        _, _, body = self.request(server_module.IDENTITY_PATH)
        self.assertIn(b'"quietbook"', body)

    def test_binds_to_localhost_only(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        with socket.socket() as s:
            s.settimeout(1)
            s.connect(("127.0.0.1", self.server.server_address[1]))


if __name__ == "__main__":
    unittest.main()
