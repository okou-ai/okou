import concurrent.futures
import contextlib
import copy
import http.client
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import packaged_guest
import packaged_run as fixture
import test_fixture as primitive_tests


def summary():
    checks = [{"name": name, "passed": True} for name in sorted(fixture.EXPECTED)]
    by_name = {check["name"]: check for check in checks}
    by_name["untrusted_pi_extension_denied"].update(
        qualified=True, executed=None, ingressObserved=False
    )
    by_name["pi_extension_known_load_control"].update(
        qualified=True,
        identity={"uid": 1000, "context": "system_u:system_r:agent_t"},
        ingressObserved=True,
    )
    by_name["untrusted_shell_startup_denied"].update(
        ingressObserved=False,
        observations=[
            {
                "framework": name,
                "context": "system_u:system_r:workload_t",
                "connectErrno": 13,
            }
            for name in ("claude", "codex")
        ],
    )
    return {
        "gateF": "incomplete",
        "kernel": {
            "architecture": "x86_64",
            "lsm": "capability,selinux",
            "enforcing": True,
        },
        "installedManifest": {
            "schemaVersion": 1,
            "versions": fixture.VERSIONS.copy(),
            "package": fixture.PACKAGE.copy(),
            "entrypoint": "/usr/local/lib/okou-cli/9.400.3/okou.js",
        },
        "results": checks,
        "brokerErrors": [],
    }


class ReceiptTest(unittest.TestCase):
    def test_complete_subset_remains_incomplete_gate(self):
        value = fixture.decode_summary(json.dumps(summary()))
        fixture.validate_summary(value, "x86_64")
        self.assertEqual(value["gateF"], "incomplete")

    def test_missing_duplicate_and_unknown_cases_fail(self):
        for change in ("missing", "duplicate", "unknown", "failed", "truthy"):
            value = summary()
            if change == "missing":
                value["results"].pop()
            elif change == "duplicate":
                value["results"].append(value["results"][0])
            elif change == "unknown":
                value["results"][0]["name"] = "unexpected"
            else:
                value["results"][0]["passed"] = False if change == "failed" else 1
            with self.subTest(change=change), self.assertRaises(ValueError):
                fixture.validate_summary(value, "x86_64")

    def test_wrong_kernel_identity_scope_and_broker_error_fail(self):
        for change in (
            "arch",
            "enforcing",
            "lsm",
            "version",
            "package",
            "scope",
            "broker",
        ):
            value = summary()
            if change == "arch":
                value["kernel"]["architecture"] = "aarch64"
            elif change == "enforcing":
                value["kernel"]["enforcing"] = False
            elif change == "lsm":
                value["kernel"]["lsm"] = "capability"
            elif change == "version":
                value["installedManifest"]["versions"]["cli"] = "0.0.0"
            elif change == "package":
                value["installedManifest"]["package"]["sha256"] = "0" * 64
            elif change == "scope":
                value["gateF"] = "passed"
            else:
                value["brokerErrors"] = ["placement failed"]
            with self.subTest(change=change), self.assertRaises(ValueError):
                fixture.validate_summary(value, "x86_64")

    def test_unqualified_extension_and_successful_startup_ingress_fail(self):
        good = summary()
        for change in ("unqualified", "privileged", "connected", "unobserved"):
            value = copy.deepcopy(good)
            cases = {c["name"]: c for c in value["results"]}
            if change == "unqualified":
                cases["untrusted_pi_extension_denied"]["qualified"] = False
            else:
                shell = cases["untrusted_shell_startup_denied"]
                if change == "privileged":
                    shell["observations"][0]["context"] = "system_u:system_r:agent_t"
                elif change == "connected":
                    shell["observations"][0]["connectErrno"] = 0
                    shell["ingressObserved"] = True
                else:
                    shell["observations"] = []
            with self.subTest(change=change), self.assertRaises(ValueError):
                fixture.validate_summary(value, "x86_64")

    def test_duplicate_json_fields_and_oversized_result_fail(self):
        for raw in ('{"gateF":"passed","gateF":"incomplete"}', " " * 131073):
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                fixture.decode_summary(raw)

    def test_extension_control_requires_actual_privileged_execution_and_ingress(self):
        for change in (
            "identity",
            "role",
            "ingress",
            "qualification",
            "executed",
            "negative-ingress",
        ):
            value = summary()
            cases = {c["name"]: c for c in value["results"]}
            control = cases["pi_extension_known_load_control"]
            denied = cases["untrusted_pi_extension_denied"]
            if change == "identity":
                control["identity"] = None
            elif change == "role":
                control["identity"]["context"] = "system_u:system_r:workload_t"
            elif change == "ingress":
                control["ingressObserved"] = False
            elif change == "qualification":
                control["qualified"] = False
            elif change == "executed":
                denied["executed"] = "loaded"
            else:
                denied["ingressObserved"] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                fixture.validate_summary(value, "x86_64")


class ModelPeerTest(unittest.TestCase):
    def test_parallel_response_ids_and_request_budget(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.multiple(
                packaged_guest,
                ROOT=Path(directory),
                requests=[],
                request_counts={},
                spawned=set(),
                errors=[],
            ),
            contextlib.redirect_stdout(io.StringIO()),
            ThreadingHTTPServer(("127.0.0.1", 0), packaged_guest.Handler) as server,
        ):
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            start = threading.Barrier(4)

            def request(index):
                connection = http.client.HTTPConnection(
                    *server.server_address, timeout=5
                )
                try:
                    if index < 4:
                        start.wait(timeout=5)
                    connection.request(
                        "POST",
                        "/v1/chat/completions",
                        json.dumps(
                            {
                                "messages": [{"role": "user", "content": "PI_MAIN"}],
                                "tools": [
                                    {"function": {"name": name}}
                                    for name in ("read", "bash")
                                ],
                            }
                        ),
                        {"content-type": "application/json"},
                    )
                    response = connection.getresponse()
                    body = response.read().decode()
                    identity = (
                        json.loads(body.splitlines()[0][6:])["id"]
                        if response.status == 200
                        else None
                    )
                    return response.status, identity
                finally:
                    connection.close()

            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    responses = list(pool.map(request, range(4)))
                self.assertTrue(all(status == 200 for status, _ in responses))
                self.assertEqual(len({identity for _, identity in responses}), 4)
                for index in range(4, 16):
                    self.assertEqual(request(index)[0], 200)
                self.assertEqual(request(16)[0], 400)
            finally:
                server.shutdown()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())


class OwnerTest(unittest.TestCase):
    def test_owner_cancellation_joins_packaged_vmm(self):
        primitive_tests.OwnerTest.owner_signal(
            self, signal.SIGTERM, "packaged_run", "vm"
        )

    def test_owner_sigkill_fences_packaged_vmm(self):
        primitive_tests.OwnerTest.owner_signal(
            self, signal.SIGKILL, "packaged_run", "vm"
        )

    def assert_reaped(self, state):
        self.assertEqual(state["cleanup"], "vmm_joined")
        with self.assertRaises(ProcessLookupError):
            os.kill(state["vmmPid"], 0)

    def test_writable_drive_is_not_subject_to_console_file_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            drive = root / "drive"
            state = {}
            code = f"from pathlib import Path; Path({str(drive)!r}).write_bytes(b'x'*524288); print('done')"
            fixture.vm([sys.executable, "-c", code], root / "console", state, timeout=5)
            self.assertEqual(drive.stat().st_size, 524288)
            self.assertEqual((root / "console").read_text(), "done\n")
            self.assert_reaped(state)

    def test_timeout_failure_and_output_bound_reap_process_and_restore_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = signal.pthread_sigmask(signal.SIG_BLOCK, [])
            for index, (code, error, timeout, bound) in enumerate(
                [
                    ("raise SystemExit(23)", ValueError, 5, 131072),
                    ("import signal; signal.pause()", TimeoutError, 0.15, 131072),
                    ("import sys; sys.stdout.write('x'*65536)", ValueError, 5, 1024),
                ]
            ):
                state = {}
                with self.subTest(index=index), self.assertRaises(error):
                    fixture.vm(
                        [sys.executable, "-c", code],
                        root / str(index),
                        state,
                        timeout=timeout,
                        max_bytes=bound,
                    )
                self.assert_reaped(state)
                self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK, []), before)
                self.assertLessEqual((root / str(index)).stat().st_size, bound)

    def test_launch_cancellation_is_owned_before_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = root / "receipt"
            code = (
                "import json,os,signal,sys; from pathlib import Path; sys.path.insert(0,"
                + repr(str(fixture.HERE))
                + "); import packaged_run; state={}; armed=True\ndef audit(event,args):\n global armed\n if event=='subprocess.Popen' and armed:\n  armed=False\n  os.kill(os.getpid(),signal.SIGTERM)\nsys.addaudithook(audit)\ntry: packaged_run.vm([sys.executable,'-c','print(1)'],Path("
                + repr(str(root / "console"))
                + "),state)\nexcept InterruptedError: pass\nfinally: Path("
                + repr(str(receipt))
                + ").write_text(json.dumps(state))"
            )
            run = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assert_reaped(json.loads(receipt.read_text()))


if __name__ == "__main__":
    unittest.main()
