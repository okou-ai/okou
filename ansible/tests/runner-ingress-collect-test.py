"""Run the production collector with real private files, curl and a TLS peer."""

import configparser
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import uuid

import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "ansible/files/vm0-monitoring-runner-ingress-collect.py"
HOST = "runner-ingress.test"
TOKEN = "vm0_official_" + "a" * 64


class HealthHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        runner_id = self.path.split("/")[2]
        with self.server.lock:
            self.server.requests.append((self.path, self.headers.get("Authorization")))
        self.server.received.set()
        self.server.release.wait(20)
        status, body = self.server.responses.get(runner_id, (503, b""))
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            status, body = 401, b""
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        if status == 302:
            self.send_header("Location", f"https://{HOST}{self.path}")
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            # Failure/timeout cases deliberately close the peer before it writes.
            pass


class CollectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.certificates = tempfile.TemporaryDirectory(prefix="runner-ingress-ca-")
        cls.ca_dir = Path(cls.certificates.name)
        cls.certificate = cls.ca_dir / "cert.pem"
        cls.key = cls.ca_dir / "key.pem"
        for name in ("cert", "untrusted"):
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    str(cls.ca_dir / f"{name}-key.pem"),
                    "-out",
                    str(cls.ca_dir / f"{name}.pem"),
                    "-days",
                    "1",
                    "-subj",
                    f"/CN={HOST}",
                    "-addext",
                    f"subjectAltName=DNS:{HOST}",
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        cls.key = cls.ca_dir / "cert-key.pem"

    @classmethod
    def tearDownClass(cls):
        cls.certificates.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="runner-ingress-collector-")
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        self.runners = self.work / "runners"
        self.output = self.work / "textfile"
        self.binary = self.work / "bin"
        for directory in (self.runners, self.output, self.binary):
            directory.mkdir(mode=0o700)
        self.peer = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
        self.peer.daemon_threads = True
        self.peer.responses = {}
        self.peer.requests = []
        self.peer.lock = threading.Lock()
        self.peer.received = threading.Event()
        self.peer.release = threading.Event()
        self.peer.release.set()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.certificate, self.key)
        self.peer.socket = context.wrap_socket(self.peer.socket, server_side=True)
        self.thread = threading.Thread(target=self.peer.serve_forever)
        self.thread.start()
        self.addCleanup(self.close_peer)
        self.arguments = self.work / "curl-arguments.jsonl"
        # The external-command fixture changes only DNS/dial address and its CA.
        # Actual production URL, request flags, credential pipe and curl remain.
        wrapper = self.binary / "curl"
        wrapper.write_text(
            "#!/usr/bin/python3\nimport json, os, sys\n"
            f"with open({str(self.arguments)!r}, 'a') as output:\n"
            "    output.write(json.dumps({'pid':os.getpid(),'argv':sys.argv[1:]})+'\\n')\n"
            f"dial = {f'{HOST}:443:127.0.0.1:{self.peer.server_port}'!r}\n"
            f"ca = os.environ.get('FIXTURE_CA', {str(self.certificate)!r})\n"
            "os.execv('/usr/bin/curl', ['curl', *sys.argv[1:-1], '--connect-to', dial, '--cacert', ca, sys.argv[-1]])\n"
        )
        wrapper.chmod(0o755)
        self.env = dict(
            os.environ,
            PATH=f"{self.binary}:/usr/bin:/bin",
            OKOU_RUNNERS_DIR=str(self.runners),
            OKOU_MONITORING_TEXTFILE_DIR=str(self.output),
        )
        self.command = ["/usr/bin/python3", "-I", "-B", str(SCRIPT), "--hostname", HOST]

    def close_peer(self):
        self.peer.release.set()
        self.peer.shutdown()
        self.thread.join()
        self.peer.server_close()

    def runner(self, name, *, mode="running", token=TOKEN, runner_id=None):
        path = self.runners / name
        path.mkdir(mode=0o700)
        runner_id = runner_id or str(uuid.uuid4())
        files = {
            "runner_id": runner_id,
            "heartbeat_generation": "1",
            "status.json": json.dumps({"mode": mode}),
            "runner.yaml": yaml.safe_dump(
                {
                    "hostname": HOST,
                    "base_dir": str(path),
                    "server": {"token": token, "url": "https://api.example.org"},
                }
            ),
        }
        for name, content in files.items():
            file = path / name
            file.write_text(content)
            file.chmod(0o600)
        return runner_id, path

    def due(self):
        # Expire the scheduler's persisted reservation without sleeping a minute.
        attempt = self.output / ".runner-ingress-attempt"
        if attempt.exists():
            saved = json.loads(attempt.read_text())
            saved[1] = 0
            attempt.write_text(json.dumps(saved))

    def run_collector(self, *, env=None, command=None, force_due=True):
        if force_due:
            self.due()
        result = subprocess.run(
            command or self.command,
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=35,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        content = (self.output / "runner-ingress.prom").read_text()
        self.assertNotIn(TOKEN, content + result.stdout + result.stderr)
        self.assertEqual(
            (self.output / "runner-ingress.prom").stat().st_mode & 0o777, 0o644
        )
        expected_files = {".runner-ingress-attempt", "runner-ingress.prom"}
        if (self.output / "runner-status.prom").exists():
            expected_files.add("runner-status.prom")
        self.assertEqual({path.name for path in self.output.iterdir()}, expected_files)
        for line in (
            self.arguments.read_text().splitlines() if self.arguments.exists() else []
        ):
            invocation = json.loads(line)
            self.assertNotIn(TOKEN, str(invocation["argv"]))
            self.assertFalse(
                Path(f"/proc/{invocation['pid']}").exists(), "curl was not reaped"
            )
        return content

    def assert_counts(self, content, success, failure):
        self.assertCountEqual(
            [line for line in content.splitlines() if not line.startswith("#")],
            [
                f"vm0_runner_ingress_success_count {success}",
                f"vm0_runner_ingress_failure_count {failure}",
            ],
        )
        for outcome in ("success", "failure"):
            self.assertIn(f"# TYPE vm0_runner_ingress_{outcome}_count gauge\n", content)

    def test_managed_targets_are_independent_of_runner_progress(self):
        first, _ = self.runner("serving")
        second, _ = self.runner("draining", mode="draining")
        self.runner("dead-but-status-remains")
        self.runner("stopped", mode="stopped")
        self.runner("personal", token="vm0_pat_example")
        (self.runners / "prepared").mkdir()
        self.peer.responses = {first: (200, b"ok"), second: (200, b"ok")}
        content = self.run_collector()
        self.assert_counts(content, 2, 1)
        self.assertEqual(len(self.peer.requests), 3)

        # Replacing all identities must update the same two host series, even
        # when the number of eligible targets and the results change.
        for round_number in range(3):
            replacements = {}
            for name in ("serving", "draining", "dead-but-status-remains"):
                path = self.runners / name
                runner_id = str(uuid.uuid4())
                (path / "runner_id").write_text(runner_id)
                (path / "heartbeat_generation").write_text(str(round_number + 2))
                replacements[name] = runner_id
            (self.runners / "dead-but-status-remains" / "status.json").write_text(
                json.dumps({"mode": "stopped"})
            )
            self.peer.responses = {replacements["serving"]: (200, b"ok")}
            self.assert_counts(self.run_collector(), 1, 1)
        self.assertEqual(len(self.peer.requests), 9)

    def test_no_eligible_targets_publish_zero_counts(self):
        self.runner("stopped", mode="stopped")
        self.runner("personal", token="vm0_pat_example")
        (self.runners / "prepared").mkdir()
        self.assert_counts(self.run_collector(), 0, 0)
        self.assertEqual(self.peer.requests, [])

    def test_strict_responses_do_not_retry_or_follow_redirects(self):
        expected = []
        for index, outcome in enumerate(
            (
                (302, b"ok"),
                (401, b""),
                (502, b""),
                (200, b"no"),
                (200, b"okay"),
                (200, b"o"),
            )
        ):
            runner_id, _ = self.runner(str(index))
            self.peer.responses[runner_id] = outcome
            expected.append(runner_id)
        content = self.run_collector()
        self.assertEqual(len(self.peer.requests), len(expected))
        self.assert_counts(content, 0, len(expected))

    def test_tls_failure_and_recovery_replace_the_file(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        self.assert_counts(
            self.run_collector(
                env=dict(self.env, FIXTURE_CA=str(self.ca_dir / "untrusted.pem"))
            ),
            0,
            1,
        )
        self.assertEqual(self.peer.requests, [])
        self.assert_counts(self.run_collector(), 1, 0)

    def test_stalled_peer_is_bounded_and_the_next_round_recovers(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        self.peer.release.clear()
        before = time.monotonic()
        self.assert_counts(self.run_collector(), 0, 1)
        self.assertLess(time.monotonic() - before, 15)
        self.assertEqual(len(self.peer.requests), 1)
        self.peer.release.set()
        self.assert_counts(self.run_collector(), 1, 0)

    def test_fast_invocations_preserve_the_file_without_repeating_probes(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        first = self.run_collector()
        before = (self.output / "runner-ingress.prom").stat().st_mtime_ns
        self.assertEqual(self.run_collector(force_due=False), first)
        self.assertEqual(
            (self.output / "runner-ingress.prom").stat().st_mtime_ns, before
        )
        self.assertEqual(len(self.peer.requests), 1)

    def test_publication_failure_does_not_bypass_the_probe_period(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        self.run_collector()
        self.due()
        output = self.output / "runner-ingress.prom"
        output.unlink()
        output.mkdir()
        failed = subprocess.run(
            self.command, env=self.env, capture_output=True, timeout=15
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn(TOKEN.encode(), failed.stdout + failed.stderr)
        skipped = subprocess.run(
            self.command, env=self.env, capture_output=True, timeout=15
        )
        self.assertEqual(skipped.returncode, 0, skipped.stderr)
        self.assertEqual(len(self.peer.requests), 2)

    def test_interrupted_schedule_update_cannot_repeat_the_probe(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        fault = self.work / "clear-state-crash.so"
        subprocess.run(
            [
                "cc",
                "-shared",
                "-fPIC",
                str(ROOT / "ansible/tests/runner-ingress-clear-state-crash.c"),
                "-o",
                str(fault),
                "-ldl",
            ],
            check=True,
            capture_output=True,
        )
        # Inject process death if an OS truncate clears existing state. A safe
        # update can complete normally without encountering that crash point.
        result = subprocess.run(
            self.command,
            env=dict(self.env, LD_PRELOAD=str(fault)),
            capture_output=True,
            timeout=15,
        )
        self.assertIn(result.returncode, (0, -signal.SIGKILL))
        self.assertNotIn(TOKEN.encode(), result.stdout + result.stderr)
        self.assert_counts(self.run_collector(force_due=False), 1, 0)
        self.assertEqual(len(self.peer.requests), 1)

    def test_overlapping_invocation_does_not_start_another_probe(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        original = self.run_collector()
        self.due()
        self.peer.received.clear()
        self.peer.release.clear()
        with subprocess.Popen(
            self.command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ) as process:
            try:
                self.assertTrue(self.peer.received.wait(5))
                skipped = subprocess.run(
                    self.command, env=self.env, capture_output=True, timeout=5
                )
                self.assertEqual(skipped.returncode, 0, skipped.stderr)
                self.assertEqual(
                    (self.output / "runner-ingress.prom").read_text(), original
                )
                self.assertEqual(len(self.peer.requests), 2)
                self.peer.release.set()
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertNotIn(TOKEN.encode(), stdout + stderr)
            finally:
                if process.poll() is None:
                    process.kill()

    def test_restart_during_request_cannot_inherit_success(self):
        runner_id, path = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        self.peer.release.clear()
        with subprocess.Popen(
            self.command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ) as process:
            try:
                self.assertTrue(self.peer.received.wait(5))
                (path / "heartbeat_generation").write_text("2")
                self.peer.release.set()
                stdout, stderr = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, stderr)
                self.assertNotIn(TOKEN.encode(), stdout + stderr)
            finally:
                if process.poll() is None:
                    process.kill()
        self.assert_counts((self.output / "runner-ingress.prom").read_text(), 0, 1)
        self.assert_counts(self.run_collector(), 1, 0)

    def test_duplicate_identity_does_not_duplicate_requests_or_samples(self):
        runner_id, _ = self.runner("one")
        self.runner("two", runner_id=runner_id)
        self.peer.responses[runner_id] = (200, b"ok")
        content = self.run_collector()
        self.assert_counts(content, 0, 1)
        self.assertEqual(len(self.peer.requests), 1)

    def test_bad_configuration_never_sends_credentials_or_retains_success(self):
        runner_id, path = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        self.assert_counts(self.run_collector(), 1, 0)
        config = path / "runner.yaml"
        original = config.read_text()
        for invalid in (
            original.replace(HOST, "other.example.org"),
            f"server: [\n{TOKEN}",
        ):
            config.write_text(invalid)
            self.assert_counts(self.run_collector(), 0, 1)
        config.write_text(original)
        config.chmod(0o644)
        self.assert_counts(self.run_collector(), 0, 1)
        config.unlink()
        outside = self.work / "outside.yaml"
        outside.write_text(original)
        outside.chmod(0o600)
        config.symlink_to(outside)
        self.assert_counts(self.run_collector(), 0, 1)
        self.assertEqual(len(self.peer.requests), 1)

    def test_root_symlink_replaces_old_healthy_file_without_probing(self):
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        self.assert_counts(self.run_collector(), 1, 0)
        alias = self.work / "alias"
        alias.symlink_to(self.runners, target_is_directory=True)
        content = self.run_collector(env=dict(self.env, OKOU_RUNNERS_DIR=str(alias)))
        self.assertEqual(
            [line for line in content.splitlines() if not line.startswith("#")], []
        )
        self.assertEqual(len(self.peer.requests), 1)

    def test_provisioned_command_and_timer_keep_network_off_the_scrape_cadence(self):
        playbook = yaml.safe_load(
            (ROOT / "ansible/playbooks/provision-monitoring.yml").read_text()
        )
        copies = {
            task["copy"].get("dest"): task["copy"]
            for task in playbook[0]["tasks"]
            if "copy" in task
        }
        service = configparser.ConfigParser(interpolation=None)
        timer = configparser.ConfigParser(interpolation=None)
        service.optionxform = str
        timer.optionxform = str
        prefix = "/etc/systemd/system/vm0-monitoring-runner-status-collect"
        service.read_string(
            copies[prefix + ".service"]["content"].replace(
                "{{ inventory_hostname }}", HOST
            )
        )
        timer.read_string(copies[prefix + ".timer"]["content"])
        self.assertEqual(timer["Timer"]["OnUnitActiveSec"], "15s")
        self.assertEqual(service["Service"]["KillMode"], "control-group")
        self.assertEqual(service["Service"]["TimeoutStartSec"], "45s")
        installed = self.binary / "vm0-monitoring-runner-ingress-collect"
        shutil.copyfile(SCRIPT, installed)
        command = shlex.split(service["Service"]["ExecStartPost"])
        command[3] = str(installed)
        unit_file = self.work / "vm0-monitoring-runner-status-collect.service"
        service["Service"]["ExecStartPost"] = shlex.join(command)
        lifecycle = self.binary / "vm0-monitoring-runner-status-collect"
        shutil.copyfile(
            ROOT / "ansible/files/vm0-monitoring-runner-status-collect.py", lifecycle
        )
        lifecycle.chmod(0o755)
        service["Service"]["ExecStart"] = str(lifecycle)
        with unit_file.open("w") as output:
            service.write(output)
        timer_file = self.work / "vm0-monitoring-runner-status-collect.timer"
        with timer_file.open("w") as output:
            timer.write(output)
        verified = subprocess.run(
            ["systemd-analyze", "verify", "--man=no", str(unit_file), str(timer_file)],
            capture_output=True,
            text=True,
        )
        self.assertEqual(verified.returncode, 0, verified.stderr)
        runner_id, _ = self.runner("serving")
        self.peer.responses[runner_id] = (200, b"ok")
        collected = subprocess.run(
            [str(lifecycle)], env=self.env, capture_output=True, text=True, timeout=5
        )
        self.assertEqual(collected.returncode, 0, collected.stderr)
        self.assertIn(
            'vm0_runner_instances{mode="running"} 1',
            (self.output / "runner-status.prom").read_text(),
        )
        self.assert_counts(self.run_collector(command=command), 1, 0)


if __name__ == "__main__":
    unittest.main()
