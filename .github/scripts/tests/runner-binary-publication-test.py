#!/usr/bin/env python3
"""Exercise publication recovery and cancellation through the transport command."""

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

SCRIPTS = Path(__file__).resolve().parents[1] / "runner"
SECRET = "X-Amz-Signature=fixture-private-signature"
AWS = r"""#!/usr/bin/env python3
import json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
args = sys.argv[1:]
assert args.pop(0) == "s3api"
operation = args.pop(0)
options, positional = {}, []
while args:
    arg = args.pop(0)
    if arg.startswith("--"):
        options[arg] = args.pop(0)
    else:
        positional.append(arg)
assert os.environ["AWS_MAX_ATTEMPTS"] == "1"
assert os.environ["AWS_RETRY_MODE"] == "standard"
assert os.environ["AWS_CLI_ERROR_FORMAT"] == "json"
key = options["--key"]
stage = ("reference" if key.endswith(".json") else "binary") + "-" + operation.split("-")[0]
log = root / "requests"
requests = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
attempt = sum(record["stage"] == stage for record in requests) + 1
with log.open("a") as output:
    output.write(json.dumps({"stage": stage, "key": key, "attempt": attempt}) + "\n")
object_path = root / "store" / key
mode = os.environ["FIXTURE_MODE"]
failing = stage == os.environ.get("FIXTURE_STAGE", "binary-put")
failing = failing and (not mode.endswith("-once") or attempt == 1)
secret = "X-Amz-Signature=fixture-private-signature"
def error(code):
    print(json.dumps({"Code": code, "Message": "Read timeout on endpoint URL: " + secret}), file=sys.stderr)
    sys.exit(254)
def commit():
    object_path.parent.mkdir(parents=True, exist_ok=True)
    body = pathlib.Path(options["--body"]).read_bytes()
    if failing and mode == "committed-corrupt":
        body = b"conflicting retained bytes"
    object_path.write_bytes(body)
if failing and mode in ("cancel", "hang", "hard-timeout-once"):
    if mode == "cancel":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        with (root / "ready").open("w") as output:
            output.write(str(os.getpid()) + "\n")
    time.sleep(300)
if failing and mode.startswith("committed-"):
    commit()
    print("aws: [ERROR]: Read timeout on endpoint URL: " + secret, file=sys.stderr)
    sys.exit(255)
if failing and (mode.startswith("connect") or mode == "cancel-backoff"):
    print("aws: [ERROR]: Connect timeout on endpoint URL: " + secret, file=sys.stderr)
    sys.exit(255)
if failing and mode == "service-once":
    error("ServiceUnavailable")
if failing and mode == "read-once":
    pathlib.Path(positional[0]).write_bytes(b"partial")
    print("aws: [ERROR]: Read timeout on endpoint URL: " + secret, file=sys.stderr)
    sys.exit(255)
if failing and mode == "authorization":
    error("AccessDenied")
if failing and mode == "unknown":
    error("Unrecognized")
if failing and mode == "signal":
    sys.exit(130)
if operation == "put-object":
    if "--if-none-match" in options and object_path.exists():
        error("PreconditionFailed")
    commit()
elif operation == "head-object":
    if not object_path.exists():
        error("404")
    print(json.dumps({"ContentLength": object_path.stat().st_size}))
elif operation == "get-object":
    if not object_path.exists():
        error("NoSuchKey")
    destination = pathlib.Path(positional[0])
    assert not destination.exists(), "partial read was reused"
    destination.write_bytes(object_path.read_bytes())
else:
    raise AssertionError(operation)
"""

SLEEP = r"""#!/usr/bin/env python3
import os, pathlib, signal, sys, time
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
with (root / "backoff").open("a") as output:
    output.write(sys.argv[1] + "\n")
if os.environ["FIXTURE_MODE"] == "cancel-backoff":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with (root / "ready").open("w") as output:
        output.write(str(os.getpid()) + "\n")
    time.sleep(300)
"""

TIMEOUT = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
args = sys.argv[1:]
if "aws" in args:
    with (root / "deadlines").open("a") as output:
        output.write(json.dumps(args[:2]) + "\n")
    marker = root / "shortened"
    if os.environ["FIXTURE_MODE"] == "hard-timeout-once" and not marker.exists():
        marker.touch()
        args[1] = "1s"
os.execv(os.environ["REAL_TIMEOUT"], ["timeout", *args])
"""

COMPRESSOR = r"""#!/usr/bin/env python3
import os, pathlib, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
with (pathlib.Path(os.environ["FIXTURE_ROOT"]) / "ready").open("w") as output:
    output.write(str(os.getpid()) + "\n")
time.sleep(300)
"""


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="runner-publication-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        fixture_bin = self.root / "bin"
        fixture_bin.mkdir()
        for name, source in (("aws", AWS), ("sleep", SLEEP), ("timeout", TIMEOUT)):
            path = fixture_bin / name
            path.write_text(source)
            path.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{fixture_bin}:{os.environ['PATH']}",
            "FIXTURE_ROOT": str(self.root),
            "FIXTURE_MODE": "success",
            "REAL_TIMEOUT": shutil.which("timeout"),
            "EXPECTED_TARGET": "aarch64-unknown-linux-musl",
            "EXPECTED_BINARY_INPUT_DIGEST": "a" * 64,
            "R2_ACCOUNT_ID": "fixture-account",
            "R2_BUCKET_NAME": "fixture-bucket",
            "AWS_ACCESS_KEY_ID": "fixture-access",
            "AWS_SECRET_ACCESS_KEY": SECRET,
            "REPO": "okou-ai/okou",
            "CURRENT_RUN_ID": "100",
            "PRODUCER_RUN_ATTEMPT": "1",
            "PRODUCER_EVENT": "pull_request",
            "PRODUCER_HEAD_SHA": "b" * 40,
            "PRODUCER_PR_NUMBER": "1",
            "GITHUB_OUTPUT": "",
            "RUNNER_TEMP": str(self.root),
            "RUNNER_PATH": str(self.root / "runner"),
            "FRESH_METADATA_PATH": str(self.root / "metadata.json"),
            "OUTPUT_DIR": str(self.root / "output"),
        }
        self.env.pop("RUNNER_BINARY_PUBLICATION_DEADLINE", None)
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
        self.binary = b"complete runner publication fixture\n"
        (self.root / "runner").write_bytes(self.binary)
        (self.root / "metadata.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "target": self.env["EXPECTED_TARGET"],
                    "binaryInputDigest": "a" * 64,
                    "toolchainImage": toolchain,
                    "runnerSha256": hashlib.sha256(self.binary).hexdigest(),
                    "runnerSizeBytes": len(self.binary),
                    "guestSha256": {guest: "c" * 64 for guest in guests},
                }
            )
        )
        self.command = ["bash", str(SCRIPTS / "runner-binary-transport.sh"), "publish"]

    def requests(self, stage=None):
        path = self.root / "requests"
        records = (
            [json.loads(line) for line in path.read_text().splitlines()]
            if path.exists()
            else []
        )
        return [
            record for record in records if stage is None or record["stage"] == stage
        ]

    def reference(self):
        return self.root / "store/runner-binaries/transports/100" / ("a" * 64 + ".json")

    def assert_clean(self):
        self.assertEqual(list(self.root.glob("runner-binary-transport.*")), [])
        self.assertEqual(list(self.root.glob("runner-binary-publish.*")), [])

    def run_publication(self, mode, stage="binary-put", success=True, **extra):
        result = subprocess.run(
            self.command,
            env={**self.env, "FIXTURE_MODE": mode, "FIXTURE_STAGE": stage, **extra},
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        if success:
            manifest = self.root / "output/manifest.json"
            self.assertEqual(manifest.read_bytes(), self.reference().read_bytes())
            identity = json.loads(manifest.read_text())
            retained = self.root / "store" / identity["object"]["key"]
            self.assertEqual(
                subprocess.check_output(["zstd", "-q", "-d", "-c", str(retained)]),
                self.binary,
            )
        else:
            self.assertFalse((self.root / "output").exists())
        self.assert_clean()
        return result

    def test_connection_timeout_retries_before_any_read(self):
        result = self.run_publication("connect-once")
        self.assertIn("category=connect-timeout", result.stderr)
        self.assertEqual(
            [record["stage"] for record in self.requests()][:3],
            ["binary-put", "binary-put", "binary-head"],
        )
        self.assertEqual((self.root / "backoff").read_text().splitlines(), ["1"])

    def test_persistent_connection_timeout_exhausts_without_readiness(self):
        self.run_publication("connect", success=False)
        self.assertEqual(len(self.requests("binary-put")), 3)
        self.assertFalse(self.reference().exists())
        self.assertEqual((self.root / "backoff").read_text().splitlines(), ["1", "2"])

    def test_reference_connection_timeout_retries_after_binary_verification(self):
        self.run_publication("connect-once", "reference-put")
        self.assertEqual(len(self.requests("binary-put")), 1)
        self.assertEqual(len(self.requests("reference-put")), 2)

    def test_service_failure_checks_identity_before_retry(self):
        self.run_publication("service-once")
        self.assertEqual(
            [record["stage"] for record in self.requests()][:3],
            ["binary-put", "binary-head", "binary-put"],
        )

    def test_partial_verification_read_restarts(self):
        result = self.run_publication("read-once", "binary-get")
        self.assertIn("category=read-timeout", result.stderr)
        self.assertEqual(len(self.requests("binary-put")), 1)
        self.assertEqual(len(self.requests("binary-get")), 2)

    def test_committed_binary_with_lost_response_is_not_replayed(self):
        self.run_publication("committed-timeout")
        self.assertEqual(len(self.requests("binary-put")), 1)
        self.assertEqual(len(self.requests("binary-get")), 1)

    def test_committed_reference_with_lost_response_is_verified(self):
        self.run_publication("committed-timeout", "reference-put")
        self.assertEqual(len(self.requests("reference-put")), 1)
        self.assertEqual(len(self.requests("reference-get")), 1)

    def test_ambiguous_corrupt_binary_cannot_publish_readiness(self):
        self.run_publication("committed-corrupt", success=False)
        self.assertEqual(len(self.requests("binary-put")), 1)
        self.assertFalse(self.reference().exists())

    def test_conflicting_reference_is_not_overwritten_after_ambiguous_write(self):
        self.run_publication("committed-corrupt", "reference-put", success=False)
        self.assertEqual(len(self.requests("reference-put")), 1)
        self.assertEqual(self.reference().read_bytes(), b"conflicting retained bytes")

    def test_permanent_or_signal_errors_are_not_retried(self):
        for mode in ("authorization", "unknown", "signal"):
            with self.subTest(mode=mode):
                (self.root / "requests").unlink(missing_ok=True)
                self.run_publication(mode, success=False)
                self.assertEqual(len(self.requests()), 1)
                self.assertFalse(self.reference().exists())

    def test_hard_request_timeout_recovers_with_a_new_request(self):
        result = self.run_publication("hard-timeout-once")
        self.assertIn("category=timeout", result.stderr)
        self.assertEqual(len(self.requests("binary-put")), 2)
        deadlines = [
            json.loads(line)
            for line in (self.root / "deadlines").read_text().splitlines()
        ]
        self.assertTrue(all(int(record[1][:-1]) <= 60 for record in deadlines))

    def test_shared_publication_deadline_stops_retry_and_cleans_up(self):
        started = time.monotonic()
        self.run_publication(
            "hang",
            success=False,
            RUNNER_BINARY_PUBLICATION_DEADLINE=str(int(time.time()) + 7),
        )
        self.assertLess(time.monotonic() - started, 9)
        self.assertEqual(len(self.requests("binary-put")), 1)
        self.assertFalse(self.reference().exists())

    def test_cancellation_retires_requests_and_backoff(self):
        for stage, mode in (
            ("compress", "cancel"),
            ("binary-put", "cancel"),
            ("reference-put", "cancel"),
            ("binary-put", "cancel-backoff"),
        ):
            with self.subTest(stage=stage):
                # Each subcase owns a fresh store and request log.
                shutil.rmtree(self.root / "store", ignore_errors=True)
                (self.root / "requests").unlink(missing_ok=True)
                compressor = self.root / "bin/zstd"
                if stage == "compress":
                    compressor.write_text(COMPRESSOR)
                    compressor.chmod(0o755)
                ready = self.root / "ready"
                os.mkfifo(ready)
                descriptor = os.open(ready, os.O_RDONLY | os.O_NONBLOCK)
                child_descriptor = None
                process = subprocess.Popen(
                    self.command,
                    env={**self.env, "FIXTURE_MODE": mode, "FIXTURE_STAGE": stage},
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    start_new_session=True,
                )
                child_group = None
                try:
                    self.assertTrue(
                        select.select([descriptor], [], [], 5)[0],
                        "fixture did not become ready",
                    )
                    child = int(os.read(descriptor, 100).strip())
                    child_group = os.getpgid(child)
                    child_descriptor = os.pidfd_open(child)
                    process.terminate()
                    stdout, stderr = process.communicate(timeout=8)
                    self.assertNotEqual(process.returncode, 0)
                    self.assertNotIn(SECRET, stdout + stderr)
                    self.assertTrue(
                        select.select([child_descriptor], [], [], 3)[0],
                        "owned child survived cancellation",
                    )
                    self.assertFalse(self.reference().exists())
                    self.assertFalse((self.root / "output").exists())
                    self.assert_clean()
                finally:
                    for group in (child_group, process.pid):
                        if group is not None:
                            try:
                                os.killpg(group, signal.SIGKILL)
                            except ProcessLookupError:
                                # Normal cancellation may already have retired
                                # this fixture's process group.
                                pass
                    if process.poll() is None:
                        process.communicate()
                    if child_descriptor is not None:
                        os.close(child_descriptor)
                    os.close(descriptor)
                    ready.unlink()
                    compressor.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
