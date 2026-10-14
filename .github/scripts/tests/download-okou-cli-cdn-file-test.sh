#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
python3 - "${repo_root}/.github/scripts/artifacts/download-okou-cli-cdn-file.sh" <<'PY'
import http.server
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import unittest


script = sys.argv[1]
real_curl = shutil.which("curl")
payload = bytes(range(256)) * 256


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        first = self.path not in self.server.seen
        self.server.seen.add(self.path)
        late_recovery_failure = False
        if self.path == "/recover-after-six-errors":
            self.server.recovery_failures -= 1
            late_recovery_failure = self.server.recovery_failures >= 0
        if (
            self.path == "/unavailable"
            or (self.path == "/recover" and first)
            or late_recovery_failure
        ):
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.path == "/interrupted" and first:
            self.wfile.write(payload[:37])
            self.wfile.flush()
            self.close_connection = True
            return
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if real_curl is None:
            raise RuntimeError("curl is required")
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.seen = set()
        cls.server.recovery_failures = 6
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = Path(root.name)
        self.destination = self.root / "package.tgz"

    def run_download(self, url, *, short_budget=False, timeout=20):
        env = os.environ.copy()
        env.update(
            TMPDIR=str(self.root),
            NO_PROXY="*",
            no_proxy="*",
            AWS_ACCESS_KEY_ID="cdn-test-access-key-canary",
            AWS_SECRET_ACCESS_KEY="cdn-test-secret-key-canary",
            CDN_TEST_REAL_CURL=real_curl,
            CDN_TEST_SHORT_BUDGET="1" if short_budget else "0",
        )
        # Keep real HTTP transfers and the production attempt limit. Curl owns
        # the delay schedule; use a fixed delay instead of waiting through 63s
        # of exponential backoff. Permanent failures also get a shorter budget.
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        wrapper = bin_dir / "curl"
        wrapper.write_text(
            "#!/usr/bin/env python3\n"
            "import os, sys\n"
            "args = sys.argv[1:]\n"
            "separator = args.index('--')\n"
            "args[separator:separator] = ['--retry-delay', '1']\n"
            "if os.environ['CDN_TEST_SHORT_BUDGET'] == '1':\n"
            "    args[args.index('--retry-max-time') + 1] = '1'\n"
            "real_curl = os.environ['CDN_TEST_REAL_CURL']\n"
            "os.execv(real_curl, [real_curl, *args])\n"
        )
        wrapper.chmod(0o755)
        env["PATH"] = f"{bin_dir}:{env['PATH']}"

        command = ["bash", script, url, str(self.destination)]
        with subprocess.Popen(
            command,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        ) as process:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # The process group finished while the timeout fired.
                process.communicate()
                raise
            result = subprocess.CompletedProcess(
                command, process.returncode, stdout, stderr
            )
        self.assertNotIn("cdn-test-access-key-canary", result.stdout + result.stderr)
        self.assertNotIn("cdn-test-secret-key-canary", result.stdout + result.stderr)
        self.assertEqual(
            {path.name for path in self.root.iterdir()} - {"package.tgz"},
            {"bin"},
            "download diagnostics must be cleaned up on success and failure",
        )
        return result

    def assert_downloaded(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.destination.read_bytes(), payload)
        self.assertIn("http=200", result.stdout)
        self.assertIn("remote_ip=127.0.0.1", result.stdout)
        self.assertEqual(result.stderr, "", "successful downloads should not dump traces")

    def test_success(self):
        self.assert_downloaded(self.run_download(f"{self.base_url}/success"))

    def test_transient_http_failure_recovers(self):
        self.assert_downloaded(self.run_download(f"{self.base_url}/recover"))

    def test_recovers_after_repeated_transient_failures(self):
        self.assert_downloaded(self.run_download(f"{self.base_url}/recover-after-six-errors"))

    def test_interrupted_transfer_recovers_without_duplicate_bytes(self):
        self.assert_downloaded(self.run_download(f"{self.base_url}/interrupted"))

    def test_http_failure_preserves_curl_status_and_diagnostics(self):
        url = f"{self.base_url}/unavailable"
        result = self.run_download(url, short_budget=True)
        self.assertEqual(result.returncode, 22)
        self.assertIn(url, result.stderr)
        self.assertIn("503", result.stderr)
        self.assertIn("127.0.0.1", result.stderr)
        self.assertIn("http=503", result.stdout)

    def test_refused_connection_preserves_curl_status_and_diagnostics(self):
        # Hold a bound, non-listening port so another process cannot claim it.
        with socket.socket() as refused:
            refused.bind(("127.0.0.1", 0))
            url = f"http://127.0.0.1:{refused.getsockname()[1]}/package.tgz"
            result = self.run_download(url, short_budget=True)
        self.assertEqual(result.returncode, 7)
        self.assertIn(url, result.stderr)
        self.assertIn("127.0.0.1", result.stderr)
        self.assertIn("curl exit 7", result.stderr)

    def test_missing_arguments_fail(self):
        result = subprocess.run(
            ["bash", script], capture_output=True, text=True, timeout=5
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("Usage:", result.stderr)


unittest.main(argv=[sys.argv[0]])
PY
