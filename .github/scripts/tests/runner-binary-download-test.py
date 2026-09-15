#!/usr/bin/env python3
"""Exercise required download consumers with controlled external CLI processes."""

import hashlib
import json
import os
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
SECRET = "X-Amz-Signature=fixture-private-signature"
AWS = r"""#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
args = sys.argv[1:]
assert args[:2] == ["s3api", "get-object"], args
key = args[args.index("--key") + 1]
destination = pathlib.Path(args[-1])
assert not destination.exists(), "a partial download was reused"
log = root / "requests"
requests = log.read_text().splitlines() if log.exists() else []
attempt = sum(json.loads(line)["key"] == key for line in requests) + 1
with log.open("a") as output:
    output.write(json.dumps({"key": key, "attempt": attempt,
        "destination": str(destination), "sdk_attempts": os.environ["AWS_MAX_ATTEMPTS"],
        "retry_mode": os.environ["AWS_RETRY_MODE"],
        "error_format": os.environ["AWS_CLI_ERROR_FORMAT"]}) + "\n")
mode = os.environ["FIXTURE_MODE"]
stage = os.environ.get("FIXTURE_STAGE", "")
if stage and not key.endswith(stage):
    mode = "success"
if mode in ("cancel", "timeout", "timeout-once", "budget-timeout") and (mode != "timeout-once" or attempt == 1):
    destination.write_bytes(b"incomplete")
    if mode == "cancel":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        with (root / "ready").open("w") as ready:
            ready.write(str(os.getpid()) + "\n")
    time.sleep(300)
failure = mode not in ("success", "timeout-once") and not (mode.endswith("-once") and attempt > 1)
if failure:
    destination.write_bytes(b"partial " * 100)
    detail = "X-Amz-Signature=fixture-private-signature"
    codes = {"service": "ServiceUnavailable", "throttle": "SlowDown",
        "authorization": "AccessDenied", "missing": "NoSuchKey",
        "configuration": "Configuration", "unknown-code": "Unrecognized"}
    base = mode.removesuffix("-once")
    if base in codes:
        print(json.dumps({"Code": codes[base], "Message": detail}), file=sys.stderr)
        sys.exit(254)
    if base == "transport":
        print('aws: [ERROR]: An error occurred while reading from response stream: ' + detail,
            file=sys.stderr)
        sys.exit(255)
    if base == "incomplete":
        print("aws: [ERROR]: 800 read, but total bytes expected is 2000", file=sys.stderr)
        sys.exit(255)
    if base == "nested-service":
        print(json.dumps({"Error": {"Code": "InternalError", "Message": detail}}), file=sys.stderr)
        sys.exit(254)
    if base == "message-spoof":
        print(json.dumps({"Code": "AccessDenied", "Message":
            "Read timeout on endpoint URL: " + detail}), file=sys.stderr)
        sys.exit(254)
    if base == "signal":
        sys.exit(130)
    print("unknown " + detail * 2000, file=sys.stderr)
    sys.exit(255)
source = root / ("manifest.json" if key.endswith(".json") else "binary.zst")
destination.write_bytes(source.read_bytes())
"""

TIMEOUT = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
args = sys.argv[1:]
with (root / "deadlines").open("a") as output:
    output.write(json.dumps(args[:2]) + "\n")
if os.environ["FIXTURE_MODE"].startswith("timeout"):
    args[1] = "0.2s"
os.execv(os.environ["REAL_TIMEOUT"], ["timeout", *args])
"""

SLEEP = r"""#!/usr/bin/env python3
import os, pathlib, sys, time
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
with (root / "backoff").open("a") as output:
    output.write(sys.argv[1] + "\n")
if os.environ.get("FIXTURE_CANCEL_BACKOFF"):
    with (root / "ready").open("w") as ready:
        ready.write(str(os.getpid()) + "\n")
    time.sleep(300)
"""


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="runner-download-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, source in (("aws", AWS), ("timeout", TIMEOUT), ("sleep", SLEEP)):
            path = self.bin / name
            path.write_text(source)
            path.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FIXTURE_ROOT": str(self.root),
            "FIXTURE_MODE": "success",
            "REAL_TIMEOUT": shutil.which("timeout"),
            "EXPECTED_TARGET": "aarch64-unknown-linux-musl",
            "EXPECTED_BINARY_INPUT_DIGEST": "a" * 64,
            "R2_ACCOUNT_ID": "fixture-account",
            "R2_BUCKET_NAME": "fixture-bucket",
            "AWS_ACCESS_KEY_ID": "fixture-access",
            "AWS_SECRET_ACCESS_KEY": SECRET,
            "REPO": "vm0-ai/vm0",
            "CURRENT_RUN_ID": "100",
            "GITHUB_OUTPUT": "",
            "RUNNER_TEMP": str(self.root),
        }
        toolchain, *guests = subprocess.check_output(
            [
                "bash",
                "-c",
                (
                    'source "$1/runner-binary-build/contract.env"; '
                    'source "$1/runner-guest-binaries.sh"; runner_guest_binaries_load; '
                    'printf "%s\\n" "$RUNNER_BINARY_TOOLCHAIN_IMAGE" "${RUNNER_GUEST_BINARIES[@]}"'
                ),
                "fixture",
                str(SCRIPTS),
            ],
            text=True,
        ).splitlines()
        self.reference = {
            "schemaVersion": 1,
            "target": self.env["EXPECTED_TARGET"],
            "binaryInputDigest": "a" * 64,
            "toolchainImage": toolchain,
            "guestSha256": {guest: "b" * 64 for guest in guests},
            "objectKey": f"runner-binaries/{self.env['EXPECTED_TARGET']}/{'c' * 64}.zst",
        }
        self.env["CACHE_REFERENCE"] = json.dumps(self.reference)
        self.binary = b"complete runner fixture\n"
        (self.root / "binary.zst").write_bytes(
            subprocess.check_output(["zstd", "-q", "-c"], input=self.binary)
        )
        self.output = self.root / "output"
        self.env["RESOLVE_OUTPUT_DIR"] = str(self.output)
        self.env["OUTPUT_DIR"] = str(self.output)
        self.command = [
            "bash",
            str(SCRIPTS / "runner-binary-cache.sh"),
            "download-reference",
        ]

    def use_fresh_consumer(self):
        sha = hashlib.sha256(self.binary).hexdigest()
        manifest = {
            "schemaVersion": 1,
            "target": self.reference["target"],
            "binaryInputDigest": self.reference["binaryInputDigest"],
            "toolchainImage": self.reference["toolchainImage"],
            "guests": self.reference["guestSha256"],
            "runner": {"sha256": sha, "sizeBytes": len(self.binary)},
            "object": {
                "compression": "zstd",
                "key": f"runner-binaries/{self.reference['target']}/{sha}.zst",
                "sizeBytes": (self.root / "binary.zst").stat().st_size,
            },
            "producer": {
                "repository": "vm0-ai/vm0",
                "workflowPath": ".github/workflows/runner-image.yml",
                "runId": 100,
                "runAttempt": 1,
                "event": "pull_request",
                "headSha": "d" * 40,
                "prNumber": 1,
            },
            "createdAt": "2026-09-15T00:00:00Z",
        }
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        self.command = ["bash", str(SCRIPTS / "runner-binary-transport.sh"), "download"]

    def requests(self):
        path = self.root / "requests"
        return (
            [json.loads(line) for line in path.read_text().splitlines()]
            if path.exists()
            else []
        )

    def run_download(self, mode, success, attempts):
        result = subprocess.run(
            self.command,
            env={**self.env, "FIXTURE_MODE": mode},
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode == 0, success, result.stderr)
        self.assertEqual(len(self.requests()), attempts, result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertLess(len(result.stderr), 2000)
        self.assertEqual(list(self.root.glob("runner-binary-cache.*")), [])
        self.assertEqual(list(self.root.glob("runner-binary-transport.*")), [])
        if success:
            self.assertEqual((self.output / "runner").read_bytes(), self.binary)
            if self.command[-1] == "download-reference":
                self.assertEqual(result.stdout.count("resolve-reason=downloaded"), 1)
        else:
            self.assertFalse(self.output.exists())
        for request in self.requests():
            self.assertEqual(request["sdk_attempts"], "1")
            self.assertEqual(request["retry_mode"], "standard")
            self.assertEqual(request["error_format"], "json")
        self.assertEqual(
            len({item["destination"] for item in self.requests()}), attempts
        )
        return result

    def test_partial_service_failure_recovers(self):
        self.run_download("service-once", True, 2)

    def test_nested_service_error_recovers(self):
        self.run_download("nested-service-once", True, 2)

    def test_transport_failure_recovers(self):
        self.run_download("transport-once", True, 2)

    def test_throttling_recovers(self):
        self.run_download("throttle-once", True, 2)

    def test_incomplete_response_body_recovers(self):
        self.run_download("incomplete-once", True, 2)

    def test_whole_command_timeout_recovers(self):
        result = self.run_download("timeout-once", True, 2)
        self.assertIn("exit=124 category=timeout", result.stderr)
        self.assertEqual(
            json.loads((self.root / "deadlines").read_text().splitlines()[0]),
            ["--kill-after=5s", "60s"],
        )

    def test_timeouts_exhaust_three_attempts(self):
        result = self.run_download("timeout", False, 3)
        self.assertIn("attempts=3/3", result.stderr)
        self.assertEqual((self.root / "backoff").read_text().splitlines(), ["1", "2"])

    def test_service_failures_exhaust_three_attempts(self):
        self.run_download("service", False, 3)

    def test_fresh_manifest_failure_recovers(self):
        self.use_fresh_consumer()
        self.env["FIXTURE_STAGE"] = ".json"
        self.run_download("service-once", True, 3)
        self.assertTrue(
            all(
                json.loads(line) == ["--kill-after=5s", "120s"]
                for line in (self.root / "deadlines").read_text().splitlines()
            )
        )

    def test_fresh_binary_failure_recovers(self):
        self.use_fresh_consumer()
        self.env["FIXTURE_STAGE"] = ".zst"
        self.run_download("transport-once", True, 3)

    def test_fresh_missing_manifest_stops_before_binary(self):
        self.use_fresh_consumer()
        self.run_download("missing", False, 1)

    def test_fresh_binary_exhaustion_does_not_publish_manifest(self):
        self.use_fresh_consumer()
        self.env["FIXTURE_STAGE"] = ".zst"
        self.run_download("service", False, 4)

    def test_permanent_unknown_and_signal_failures_stop(self):
        for mode in (
            "authorization",
            "missing",
            "configuration",
            "unknown-code",
            "message-spoof",
            "unknown",
            "signal",
        ):
            with self.subTest(mode=mode):
                (self.root / "requests").unlink(missing_ok=True)
                self.run_download(mode, False, 1)
                self.assertFalse((self.root / "backoff").exists())

    def test_corrupt_success_is_not_retried(self):
        (self.root / "binary.zst").write_bytes(b"not zstd")
        self.run_download("success", False, 1)

    def test_cancellation_during_download_and_backoff(self):
        self.check_cancellation()

    def test_fresh_cancellation_during_download_and_backoff(self):
        self.use_fresh_consumer()
        self.check_cancellation()

    def check_cancellation(self):
        for backoff in (False, True):
            for interrupt in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                with self.subTest(backoff=backoff, interrupt=interrupt):
                    (self.root / "requests").unlink(missing_ok=True)
                    ready = self.root / "ready"
                    os.mkfifo(ready)
                    descriptor = os.open(ready, os.O_RDONLY | os.O_NONBLOCK)
                    env = {
                        **self.env,
                        "FIXTURE_MODE": "service" if backoff else "cancel",
                    }
                    if backoff:
                        env["FIXTURE_CANCEL_BACKOFF"] = "1"
                    process = subprocess.Popen(
                        self.command,
                        env=env,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        start_new_session=True,
                    )
                    child_group = None
                    try:
                        self.assertTrue(
                            select.select([descriptor], [], [], 5)[0],
                            "download/backoff did not reach its cancellation barrier",
                        )
                        child = int(os.read(descriptor, 100).strip())
                        child_group = os.getpgid(child)
                        process.send_signal(interrupt)
                        stdout, stderr = process.communicate(timeout=5)
                        self.assertEqual(process.returncode, 128 + interrupt, stderr)
                        self.assertNotIn(SECRET, stdout + stderr)
                        self.assertEqual(len(self.requests()), 1)
                        self.assertFalse(self.output.exists())
                        self.assertEqual(
                            list(self.root.glob("runner-binary-cache.*")), []
                        )
                        self.assertEqual(
                            list(self.root.glob("runner-binary-transport.*")), []
                        )
                        # A killed grandchild can briefly await its init reaper.
                        stat = Path(f"/proc/{child}/stat")
                        self.assertTrue(
                            not stat.exists() or stat.read_text().split()[2] == "Z",
                            "cancelled download/backoff is still running",
                        )
                    finally:
                        # Contain fixtures even when a cancellation assertion fails.
                        for group in (child_group, process.pid):
                            if group is not None:
                                try:
                                    os.killpg(group, signal.SIGKILL)
                                except ProcessLookupError:
                                    pass
                        if process.poll() is None:
                            process.communicate()
                        os.close(descriptor)
                        ready.unlink()

    def test_total_budget_prevents_another_attempt(self):
        # Exercise the same sourced entry point with a small caller budget:
        # reserve 5s grace, allow one 2s attempt, then no room for backoff/retry.
        command = [
            "bash",
            "-c",
            (
                'set -euo pipefail; source "$1"; '
                'runner_binary_download budget-test "$2" bytes=0-100 "$3" 2 7'
            ),
            "fixture",
            str(SCRIPTS / "runner-binary-download.sh"),
            self.reference["objectKey"],
            str(self.root / "partial"),
        ]
        started = time.monotonic()
        result = subprocess.run(
            command,
            env={**self.env, "FIXTURE_MODE": "budget-timeout"},
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(time.monotonic() - started, 9)
        self.assertEqual(len(self.requests()), 1)
        self.assertIn("category=budget", result.stderr)
        self.assertFalse((self.root / "partial").exists())
        self.assertEqual(list(self.root.glob("runner-r2-get.*")), [])


if __name__ == "__main__":
    unittest.main()
