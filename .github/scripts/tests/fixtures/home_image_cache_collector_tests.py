"""Exercise the production collector with a process-boundary CLI double."""

import copy
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "ansible/files/vm0-monitoring-home-image-cache-collect.py"
PREFIX = "vm0_home_image_cache_"


def snapshot():
    return {
        "fsStats": {
            "totalBytes": 1000,
            "availableBytes": 700,
            "totalInodes": 100,
            "availableInodes": 70,
        },
        "budget": {
            "maxCacheBytes": 500,
            "targetAfterGcBytes": 375,
            "minFreeBytes": 100,
        },
        "measurementsComplete": True,
        "entriesComplete": True,
        "summary": {
            "totalEntries": 0,
            "reusableEntries": 0,
            "invalidEntries": 0,
            "staleEntries": 0,
            "temporaryEntries": 0,
            "lockedEntries": 0,
            "totalAllocatedBytes": 0,
            "totalLogicalImageBytes": 0,
            "temporaryAllocatedBytes": 0,
            "temporaryPaths": 0,
        },
        "entries": [],
    }


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "textfile"
        self.output.mkdir()
        self.runner = self.root / "runner"

    def producer(self, body):
        self.runner.write_text(
            "#!/usr/bin/python3\nimport sys\n"
            "assert sys.argv[1:] == ['home-image-cache', 'list', '--limit', '1024', '--json']\n"
            + body
        )
        self.runner.chmod(0o755)

    def collect(self):
        result = subprocess.run(
            [
                "python3",
                "-I",
                "-B",
                str(SCRIPT),
                "--runner",
                str(self.runner),
                "--textfile-dir",
                str(self.output),
            ],
            capture_output=True,
            timeout=20,
            check=True,
        )
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            list(self.output.iterdir()), [self.output / "home-image-cache.prom"]
        )
        return (self.output / "home-image-cache.prom").read_text()

    def publish(self, value):
        self.producer(f"print({json.dumps(value)!r})\n")
        return self.collect()

    def unavailable(self, output):
        self.assertIn(PREFIX + "snapshot_available 0\n", output)
        self.assertNotIn(PREFIX + "allocated_bytes ", output)
        self.assertNotIn(PREFIX + "filesystem_total_bytes ", output)

    def test_measured_empty_is_not_unavailable(self):
        text = self.publish(snapshot())
        self.assertIn(PREFIX + "snapshot_available 1\n", text)
        self.assertIn(PREFIX + "allocated_bytes 0\n", text)
        self.assertIn(PREFIX + "filesystem_available_inodes 70\n", text)
        self.assertIn(PREFIX + "measurements_complete 1\n", text)
        self.assertIn(PREFIX + "collection_timestamp_seconds ", text)

    def test_sparse_and_generation_allocation_use_canonical_summary(self):
        value = snapshot()
        value["summary"].update(
            totalEntries=1,
            reusableEntries=1,
            totalAllocatedBytes=4096,
            totalLogicalImageBytes=24 * 1024**3,
            temporaryAllocatedBytes=512,
            temporaryPaths=2,
        )
        value["entries"] = [
            {
                "status": "reusable",
                "allocatedBytes": 3584,
                "logicalImageSizeBytes": 24 * 1024**3,
                "temporaryAllocatedBytes": 512,
                "cacheKey": "private-project",
                "workingDir": "secret-directory",
            }
        ]
        text = self.publish(value)
        self.assertIn(PREFIX + "allocated_bytes 4096\n", text)
        self.assertIn(PREFIX + "temporary_allocated_bytes 512\n", text)
        self.assertIn(PREFIX + 'bucket_entries{bucket="lt_16MiB"} 1\n', text)
        self.assertIn(PREFIX + 'bucket_allocated_bytes{bucket="lt_16MiB"} 4096\n', text)
        self.assertNotIn("private-project", text)
        self.assertNotIn("secret-directory", text)

    def test_bucket_edges_use_entry_allocated_bytes(self):
        value = snapshot()
        sizes = [
            0,
            16 * 1024**2,
            64 * 1024**2,
            256 * 1024**2,
            1024**3,
            4 * 1024**3,
            16 * 1024**3,
        ]
        value["summary"].update(
            totalEntries=7, reusableEntries=7, totalAllocatedBytes=sum(sizes)
        )
        value["entries"] = [
            {
                "status": "reusable",
                "allocatedBytes": size,
                "logicalImageSizeBytes": 24 * 1024**3,
                "temporaryAllocatedBytes": 0,
            }
            for size in sizes
        ]
        text = self.publish(value)
        for label in (
            "lt_16MiB",
            "16MiB_64MiB",
            "64MiB_256MiB",
            "256MiB_1GiB",
            "1GiB_4GiB",
            "4GiB_16GiB",
            "gte_16GiB",
        ):
            self.assertIn(PREFIX + f'bucket_entries{{bucket="{label}"}} 1\n', text)

    def test_locked_snapshot_is_an_honest_lower_bound(self):
        value = snapshot()
        value["summary"].update(totalEntries=1, lockedEntries=1)
        value["measurementsComplete"] = False
        value["entries"] = [{"status": "locked", "allocatedBytes": 0}]
        text = self.publish(value)
        self.assertIn(PREFIX + "snapshot_available 1\n", text)
        self.assertIn(PREFIX + "allocation_lower_bound 1\n", text)
        self.assertIn(PREFIX + "bucket_measurements_complete 0\n", text)
        self.assertIn(PREFIX + 'entries_by_status{status="locked"} 1\n', text)

    def test_truncated_entries_do_not_truncate_summary(self):
        value = snapshot()
        value["summary"].update(
            totalEntries=1025, reusableEntries=1025, totalAllocatedBytes=20000
        )
        value["entriesComplete"] = False
        value["entries"] = [
            {
                "status": "reusable",
                "allocatedBytes": 1,
                "logicalImageSizeBytes": 24 * 1024**3,
                "temporaryAllocatedBytes": 0,
            }
        ] * 1024
        text = self.publish(value)
        self.assertIn(PREFIX + "entries_complete 0\n", text)
        self.assertIn(PREFIX + "bucket_measurements_complete 0\n", text)
        self.assertIn(PREFIX + "allocated_bytes 20000\n", text)

    def test_missing_incompatible_or_corrupt_runner_clears_stale_success(self):
        self.publish(snapshot())
        self.runner.unlink()
        self.unavailable(self.collect())
        for value in (
            {"entries": []},
            "not a snapshot",
            {**snapshot(), "measurementsComplete": 1},
        ):
            with self.subTest(value=value):
                self.unavailable(self.publish(value))
        for body in ("print('corrupt')\n", "print('[' * 2000 + '0' + ']' * 2000)\n"):
            self.producer(body)
            self.unavailable(self.collect())

    def test_relative_runner_path_fails_without_refreshing_snapshot(self):
        previous = self.publish(snapshot())
        for runner in ("runner", "./runner"):
            with self.subTest(runner=runner):
                result = subprocess.run(
                    [
                        "python3",
                        "-I",
                        "-B",
                        str(SCRIPT),
                        "--runner",
                        runner,
                        "--textfile-dir",
                        str(self.output),
                    ],
                    cwd=self.root,
                    capture_output=True,
                    timeout=5,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertIn(b"--runner must be an absolute path", result.stderr)
                self.assertEqual(
                    (self.output / "home-image-cache.prom").read_text(), previous
                )

    def test_failed_overlarge_and_timed_out_processes_are_unavailable(self):
        for body in (
            "sys.exit(2)\n",
            "print('x' * (5 * 1024 * 1024))\n",
            "import time\ntime.sleep(60)\n",
        ):
            with self.subTest(body=body):
                self.producer(body)
                self.unavailable(self.collect())

    def test_producer_descendants_do_not_survive_collection(self):
        pidfile = self.root / "descendant.pid"
        self.producer(
            "import subprocess\n"
            "child = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(60)'])\n"
            f"open({str(pidfile)!r}, 'w').write(str(child.pid))\n"
            f"print({json.dumps(snapshot())!r})\n"
        )
        self.assertIn(PREFIX + "snapshot_available 1\n", self.collect())
        status = Path("/proc") / pidfile.read_text() / "stat"
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                # A killed adopted child may briefly await its init-owned reap.
                if status.read_text().split()[2] == "Z":
                    return
            except FileNotFoundError:
                return
            time.sleep(0.01)
        self.fail("collector left a live producer descendant")

    def test_invalid_numeric_schema_is_not_zero(self):
        value = snapshot()
        for invalid in (-1, True, 1.5, "1", 1 << 64):
            case = copy.deepcopy(value)
            case["summary"]["totalAllocatedBytes"] = invalid
            self.unavailable(self.publish(case))
        value["fsStats"]["availableInodes"] = 101
        self.unavailable(self.publish(value))

    def test_atomic_replacement_does_not_follow_destination_symlink(self):
        victim = self.root / "private-victim"
        victim.write_text("unchanged")
        os.symlink(victim, self.output / "home-image-cache.prom")
        self.publish(snapshot())
        self.assertEqual(victim.read_text(), "unchanged")
        self.assertFalse((self.output / "home-image-cache.prom").is_symlink())

    def test_cli_version_change_refreshes_the_provisioning_stamp(self):
        action = yaml.safe_load(
            (ROOT / ".github/actions/provision/action.yml").read_text()
        )
        script = next(
            step["run"]
            for step in action["runs"]["steps"]
            if step["name"] == "Provision metal hosts"
        )
        binaries = self.root / "bin"
        binaries.mkdir()
        stamp = self.root / "stamp"
        calls = self.root / "calls"
        ssh = binaries / "ssh"
        ssh.write_text(
            "#!/usr/bin/python3\nimport os, pathlib, sys\n"
            "stamp = pathlib.Path(os.environ['MOCK_STAMP'])\n"
            "operation = sys.argv[-1]\n"
            "if operation.startswith('cat '):\n"
            " print(stamp.read_text() if stamp.exists() else '', end='')\n"
            "elif operation.startswith('echo '):\n"
            " stamp.write_text(operation.split()[1] + '\\n')\n"
            "else: sys.exit(9)\n"
        )
        ansible = binaries / "ansible-playbook"
        ansible.write_text(
            "#!/usr/bin/python3\nimport json, os, sys\n"
            "with open(os.environ['MOCK_CALLS'], 'a') as out:\n"
            " out.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        )
        ssh.chmod(0o755)
        ansible.chmod(0o755)
        env = {
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "MOCK_STAMP": str(stamp),
            "MOCK_CALLS": str(calls),
            "HOSTS": "mock-host",
            "METAL_USER": "mock-user",
            "ENV_LABEL": "dev",
            "GRAFANA_CLOUD_API_KEY": "synthetic-offline",
            "GRAFANA_CLOUD_PROMETHEUS_URL": "https://example.invalid",
            "GRAFANA_CLOUD_PROMETHEUS_USER": "test",
        }

        def provision(version):
            env["MONITORING_RUNNER_BINARY"] = (
                f"/var/lib/vm0-runner/bin/{version}/runner"
            )
            subprocess.run(
                ["bash", "-e", "-o", "pipefail", "-c", script],
                cwd=ROOT,
                env=env,
                check=True,
                capture_output=True,
                timeout=10,
            )

        provision("v1.2.3")
        first_stamp = stamp.read_text()
        provision("v1.2.3")
        self.assertEqual(len(calls.read_text().splitlines()), 2)
        provision("v1.2.4")
        self.assertNotEqual(stamp.read_text(), first_stamp)
        commands = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertEqual(len(commands), 4)
        self.assertIn(
            "monitoring_runner_binary=/var/lib/vm0-runner/bin/v1.2.3/runner",
            commands[1],
        )
        self.assertIn(
            "monitoring_runner_binary=/var/lib/vm0-runner/bin/v1.2.4/runner",
            commands[3],
        )

    def test_ansible_and_workflow_wiring_uses_versioned_cli_and_retires_only_monitoring(
        self,
    ):
        playbook = (ROOT / "ansible/playbooks/provision-monitoring.yml").read_text()
        for expected in (
            "vm0-monitoring-home-image-cache-collect.py",
            "--runner {{ monitoring_runner_binary }}",
            "vm0-monitoring-home-image-cache-collect.timer",
            "workspace-image-cache.prom",
        ):
            self.assertIn(expected, playbook)
        self.assertNotIn("path: /var/lib/vm0-runner/home-image-cache", playbook)
        action = (ROOT / ".github/actions/provision/action.yml").read_text()
        self.assertIn("monitoring-runner-binary", action)
        self.assertIn("monitoring_runner_binary=${MONITORING_RUNNER_BINARY}", action)
        for name in ("runner-image.yml", "release-please.yml"):
            self.assertIn(
                "monitoring-runner-binary:",
                (ROOT / ".github/workflows" / name).read_text(),
            )


if __name__ == "__main__":
    unittest.main()
