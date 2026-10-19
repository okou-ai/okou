import concurrent.futures
import contextlib
import copy
import http.client
import io
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import packaged_gateway
import packaged_guest
import packaged_run as fixture
import packaged_snapshot
import test_fixture as primitive_tests


class GatewayHttpTest(unittest.TestCase):
    def setUp(self):
        self.observations = []
        observations = self.observations

        class Upstream(packaged_gateway.BenchmarkHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                observations.append(
                    {
                        "path": self.path,
                        "authorization": self.headers.get("authorization"),
                        "intent": self.headers.get("x-okou-connector-intent"),
                        "body": body,
                    }
                )
                raw = b"accepted synthetic request"
                self.send_response(200)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.gateway = packaged_gateway.Gateway(
            ("127.0.0.1", 0),
            packaged_gateway.Handler,
            "synthetic-fixed-owner",
            self.upstream.server_address,
        )
        for server in (self.upstream, self.gateway):
            worker = threading.Thread(
                target=server.serve_forever, kwargs={"poll_interval": 0.01}
            )
            worker.start()
            self.addCleanup(self.stop_server, server, worker)

    @staticmethod
    def stop_server(server, worker):
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        if worker.is_alive():
            raise AssertionError("owned HTTP server did not join")

    def test_fixed_upstream_owns_auth_and_ignores_caller_routing_headers(self):
        peer = http.client.HTTPConnection(*self.gateway.server_address, timeout=2)
        self.addCleanup(peer.close)
        peer.request(
            "POST",
            "/v1/responses",
            b'{"input":"synthetic"}',
            {
                "authorization": "Bearer caller-value",
                "x-okou-connector-intent": "different-owner",
                "host": "untrusted.invalid",
            },
        )
        response = peer.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), b"accepted synthetic request")
        self.assertEqual(
            self.observations,
            [
                {
                    "path": "/v1/responses",
                    "authorization": "Bearer synthetic-fixed-owner",
                    "intent": None,
                    "body": b'{"input":"synthetic"}',
                }
            ],
        )

    def test_rejected_framing_and_get_never_reach_upstream(self):
        for method, target, headers, expected in (
            ("GET", "/v1/responses", [], 405),
            ("POST", "http://untrusted.invalid/v1/responses", [], 400),
            (
                "POST",
                "/v1/responses",
                [("content-length", "1"), ("content-length", "1")],
                400,
            ),
            ("POST", "/v1/responses", [("transfer-encoding", "chunked")], 400),
            ("POST", "/v1/responses", [("content-length", "33554433")], 413),
        ):
            with self.subTest(method=method, target=target, headers=headers):
                peer = http.client.HTTPConnection(
                    *self.gateway.server_address, timeout=2
                )
                try:
                    peer.putrequest(method, target)
                    for name, value in headers:
                        peer.putheader(name, value)
                    peer.endheaders()
                    response = peer.getresponse()
                    self.assertEqual(response.status, expected)
                    response.read()
                finally:
                    peer.close()
        self.assertEqual(self.observations, [])


def summary():
    checks = [{"name": name, "passed": True} for name in sorted(fixture.EXPECTED)]
    by_name = {check["name"]: check for check in checks}
    for runtime, version in (
        ("node", "v24.22.0"),
        ("claude", "2.1.302 (Claude Code)"),
        ("codex", "codex-cli 0.163.0"),
    ):
        by_name[runtime + "_packaged_version"].update(exit=0, stdout=version)
    for name in ("home_helper_initialization", "home_helper_repeated"):
        by_name[name].update(
            layout="fresh",
            unlabelledSeed=True,
            helperExit=0,
            retainedSha256={},
            mount=[
                "42 25 254:16 / /home/user rw - ext4 /dev/vdb rw,defcontext=system_u:object_r:workload_data_t"
            ],
            context="system_u:object_r:workload_data_t",
        )
    identity = {
        "context": "system_u:system_r:gateway_t",
        "cgroup": "0::/vm0-exec/exec-native/workload/gateway",
    }
    by_name["gateway_bounded_streaming_accounting"].update(
        identity=identity,
        memoryPeakBytes=32 * 1024**2,
        pidsPeak=18,
        observed={
            "overLimitStatus": 413,
            "concurrentLimitStatus": 503,
            "aggregateBodyLimitStatus": 503,
            "directUpstreamDenied": True,
            "observations": [
                {"port": port} for port in (18080, 18083) for _ in range(4)
            ],
        },
    )
    by_name["gateway_local_oom_fails_closed"].update(exit=-9, events={"oom_kill": "1"})
    by_name["home_workload_retained_data"].update(
        layout="fresh",
        observations=[
            {
                "role": role,
                "exit": 0,
                "identity": {
                    "uid": 0 if role == "root" else 1000,
                    "context": "system_u:system_r:workload_t",
                    "retained": False,
                },
            }
            for role in ("workload", "root")
        ],
    )
    for framework in ("claude", "codex"):
        by_name[framework + "_configuration_known_load_and_mask"].update(
            observations=[
                {
                    "role": "agent-resource-control",
                    "exit": 0,
                    "identity": {
                        "uid": 1000,
                        "context": "system_u:system_r:agent_t",
                        "capEff": "0000000000000000",
                        "connectErrno": 0,
                        "initialized": True,
                    },
                    "ingressObserved": True,
                },
                {
                    "role": "agent",
                    "exit": 0,
                    "identity": None,
                    "ingressObserved": False,
                },
            ]
        )
    for name in (
        "pi_inprocess_read_key",
        "pi_inprocess_write_config",
        "claude_inprocess_read_key",
        "claude_inprocess_write_config",
        "claude_inprocess_http",
        "codex_inprocess_read_key",
    ):
        by_name[name].update(exit=0, actualToolOutputs=["permission denied"])
    by_name["claude_inprocess_http"].update(
        actualToolOutputs=["HTTP 405"], tlsIngressObserved=True, upstreamGetDelta=0
    )
    by_name["alternate_resolver_role_admission"].update(
        actualRequests=[{}],
        observations=[
            {
                "role": role,
                "exit": 0,
                "identity": {
                    "context": "system_u:system_r:"
                    + ("workload_t" if role in ("workload", "root") else role + "_t"),
                    "connectErrno": 0 if role == "gateway" else 13,
                },
            }
            for role in ("workload", "root", "agent", "gateway")
        ],
    )
    by_name["real_pi_paired_startup_accounting"].update(
        samples=[
            {
                "role": role,
                "exit": 0,
                "settled": True,
                "firstModelRequestSeconds": 0.1,
                "settledSeconds": 0.2,
                "runtimeCpuUsec": 1,
                "workloadCpuUsec": 2,
                "runtimePeakBytes": 1024,
                "workloadPeakBytes": 2048,
            }
            for _ in range(3)
            for role in ("agent-resource-control", "agent")
        ]
    )
    by_name["real_pi_child_uses_captured_workspace"].update(
        exit=0,
        observedChildToolDirectory="/home/user/workspace",
        requestedToolDirectory="/home/user/workspace/nested-user-project",
        extensionExecuted=False,
        familyUnpopulated=True,
    )
    by_name["untrusted_pi_extension_denied"].update(
        qualified=True, executed=None, ingressObserved=False
    )
    by_name["pi_extension_known_load_control"].update(
        qualified=True,
        identity={"uid": 1000, "context": "system_u:system_r:agent_t"},
        ingressObserved=True,
    )
    for framework in ("claude", "codex"):
        for mode in ("direct", "lowered"):
            direct = mode == "direct"
            by_name[framework + "_mcp_" + mode].update(
                identity={
                    "uid": 1000,
                    "initialized": True,
                    "capEff": "0000000000000000",
                    "context": "system_u:system_r:"
                    + ("agent_t" if direct else "workload_t"),
                    "connectErrno": 0 if direct else 13,
                },
                ingressObserved=direct,
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
        "bootMode": "fresh",
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

    def test_extended_observations_cannot_be_replaced_by_positive_flags(self):
        for name, field, replacement in (
            ("codex_packaged_version", "stdout", "codex-cli unqualified"),
            (
                "home_helper_initialization",
                "mount",
                ["42 25 254:16 / /home/user rw - ext4 /dev/vdc rw"],
            ),
            ("claude_configuration_known_load_and_mask", "observations", []),
            (
                "gateway_bounded_streaming_accounting",
                "identity",
                {"context": "system_u:system_r:control_t"},
            ),
            ("gateway_local_oom_fails_closed", "events", {"oom_kill": "0"}),
            ("claude_inprocess_http", "tlsIngressObserved", False),
            ("claude_inprocess_http", "upstreamGetDelta", 1),
            ("alternate_resolver_role_admission", "actualRequests", []),
            ("real_pi_paired_startup_accounting", "samples", []),
            (
                "real_pi_child_uses_captured_workspace",
                "observedChildToolDirectory",
                "/home/user/workspace/nested-user-project",
            ),
        ):
            value = summary()
            case = next(item for item in value["results"] if item["name"] == name)
            case[field] = replacement
            with self.subTest(name=name, field=field), self.assertRaises(ValueError):
                fixture.validate_summary(value, "x86_64")

    def test_mcp_success_requires_handshake_lowering_and_actual_ingress(self):
        for change in (
            "missing",
            "uninitialized",
            "privileged",
            "capabilities",
            "boolean-errno",
            "connected",
        ):
            value = summary()
            case = next(c for c in value["results"] if c["name"] == "codex_mcp_lowered")
            if change == "missing":
                case["identity"] = None
            elif change == "uninitialized":
                case["identity"]["initialized"] = False
            elif change == "privileged":
                case["identity"]["context"] = "system_u:system_r:agent_t"
            elif change == "capabilities":
                case["identity"]["capEff"] = "000001ffffffffff"
            elif change == "boolean-errno":
                case["identity"]["connectErrno"] = True
            else:
                case["ingressObserved"] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                fixture.validate_summary(value, "x86_64")


class SnapshotOwnershipTest(unittest.TestCase):
    def test_snapshot_child_is_fenced_after_owner_sigkill(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo = Path(directory) / "ready"
            os.mkfifo(fifo)
            descriptor = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
            self.addCleanup(os.close, descriptor)
            child = (
                "import os,signal\nwith open("
                + repr(str(fifo))
                + ",'w') as ready:\n ready.write(str(os.getpid()))\nsignal.pause()"
            )
            program = (
                "import packaged_snapshot,signal,sys\nwith packaged_snapshot.owned([sys.executable,'-c',"
                + repr(child)
                + "],{'processes':[]}) as child: child.wait()"
            )
            owner = subprocess.Popen(
                [sys.executable, "-c", program],
                cwd=fixture.HERE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                self.assertTrue(
                    select.select([descriptor], [], [], 5)[0],
                    "snapshot child never became ready",
                )
                pidfd = os.pidfd_open(int(os.read(descriptor, 128)))
                try:
                    owner.kill()
                    owner.wait(timeout=5)
                    self.assertTrue(
                        select.select([pidfd], [], [], 5)[0],
                        "snapshot child survived owner SIGKILL",
                    )
                finally:
                    os.close(pidfd)
            finally:
                if owner.poll() is None:
                    owner.kill()
                owner.wait(timeout=5)

    def test_failed_snapshot_cleanup_is_separate_from_restore_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = {"schemaVersion": 1, "result": "failed", "processes": []}
            observed_error = None
            try:
                with packaged_snapshot.owned(
                    [sys.executable, "-c", "print('ready',flush=True)"], receipt
                ) as child:
                    self.assertEqual(child.stdout.readline(), b"ready\n")
                    raise ValueError("owned failure")
            except ValueError as error:
                observed_error = str(error)
            self.assertEqual(observed_error, "owned failure")
            path = root / "snapshot-receipt.json"
            path.write_text(json.dumps(receipt))
            fixture.snapshot_receipt(root, complete=False)
            with self.assertRaises(ValueError):
                fixture.snapshot_receipt(root, complete=True)
            for invalid in (
                None,
                {
                    **receipt,
                    "processes": [{"pid": os.getpid(), "exit": 0, "cleanup": "joined"}],
                },
            ):
                path.write_text(json.dumps(invalid))
                with (
                    self.subTest(invalid=invalid),
                    self.assertRaises((ValueError, TypeError)),
                ):
                    fixture.snapshot_receipt(root, complete=False)

    def test_restore_checkpoint_requires_unchanged_enforcing_namespaces(self):
        value = summary()
        checkpoint = {
            "enforcing": "1",
            "controllerContext": "system_u:system_r:control_t",
            "agentNamespace": "mnt:[100]",
            "workloadNamespace": "mnt:[101]",
        }
        value.update(
            bootMode="restored",
            restoration={"before": checkpoint, "after": checkpoint.copy()},
        )
        fixture.validate_summary(value, "x86_64", "restored")
        for field, replacement in (("enforcing", "0"), ("agentNamespace", "mnt:[102]")):
            invalid = copy.deepcopy(value)
            invalid["restoration"]["after"][field] = replacement
            with self.subTest(field=field), self.assertRaises(ValueError):
                fixture.validate_summary(invalid, "x86_64", "restored")

    def test_owned_context_joins_child_on_failure(self):
        receipt = {"processes": []}
        observed_error = None
        try:
            with packaged_snapshot.owned(
                [
                    sys.executable,
                    "-c",
                    "import time; print('ready',flush=True); time.sleep(30)",
                ],
                receipt,
            ) as child:
                self.assertEqual(child.stdout.readline(), b"ready\n")
                raise ValueError("owned failure")
        except ValueError as error:
            observed_error = str(error)
        self.assertEqual(observed_error, "owned failure")
        self.assertEqual(receipt["processes"][0]["cleanup"], "joined")
        self.assertFalse(Path(f"/proc/{receipt['processes'][0]['pid']}").exists())

    def test_launch_signal_cannot_escape_child_ownership(self):
        program = """import json,os,signal,sys
import packaged_snapshot as fixture
receipt={'processes':[]}
def interrupted(*_args): raise InterruptedError('cancelled launch')
signal.signal(signal.SIGTERM,interrupted)
armed=True
def audit(event,_args):
 global armed
 if event=='subprocess.Popen' and armed:
  armed=False; os.kill(os.getpid(),signal.SIGTERM)
sys.addaudithook(audit)
try:
 with fixture.owned([sys.executable,'-c','import time;time.sleep(30)'],receipt):
  raise AssertionError('cancelled launch entered caller')
except InterruptedError: pass
print(json.dumps(receipt))
"""
        result = subprocess.run(
            [sys.executable, "-c", program],
            cwd=Path(fixture.__file__).parent,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        observed = json.loads(result.stdout)["processes"][0]
        self.assertEqual(observed["cleanup"], "joined")
        self.assertFalse(Path(f"/proc/{observed['pid']}").exists())

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
    def test_ordinary_service_cannot_answer_model_or_admission_requests(self):
        with ThreadingHTTPServer(
            ("127.0.0.1", 0), packaged_guest.OrdinaryHandler
        ) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            try:
                for method, path, status in (
                    ("POST", "/v1/chat/completions", 405),
                    ("GET", "/mcp-claude-direct", 404),
                    ("GET", "/ordinary", 200),
                ):
                    connection.request(
                        method, path, b"{}" if method == "POST" else None
                    )
                    response = connection.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, status)
                    if status == 200:
                        self.assertEqual(body, b'{"data":[]}')
            finally:
                connection.close()
                server.shutdown()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())

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
                for index in range(4, 32):
                    self.assertEqual(request(index)[0], 200)
                self.assertEqual(request(32)[0], 400)
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
