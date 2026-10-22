import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


INVENTORY = Path(__file__).resolve().parents[1] / "exec/inventory.sh"

# Control the external Runner boundary, then execute the actual guest command.
# Native CI owns installed values; these fixtures prove batching, privileges and
# failures without copying the runtime or environment configuration.
RUNNER_FIXTURE = r'''
import json
import os
from pathlib import Path
import subprocess
import sys

args = sys.argv[1:]
assert args[:4] == ["/fake/bin/runner", "exec", "--sandbox", "inventory-sandbox"], args
args = args[4:]
root = args[0] == "--sudo"
if root:
    args = args[1:]
assert args[0] == "--", args
args = args[1:]
assert args[:2] == ["sh", "-c"], args
probe = "runtime" if args[3] == "runtime-inventory" else "root" if root else "user"
with open(os.environ["INVENTORY_TEST_LOG"], "a") as log:
    log.write(json.dumps({"root": root, "probe": probe}) + "\n")
case = json.loads(os.environ["INVENTORY_TEST_CASE"])
if case.get("transport_failure") == probe:
    print("runner transport fixture failed", file=sys.stderr)
    sys.exit(73)

env = os.environ.copy()
fake_bin = Path(os.environ["INVENTORY_TEST_BIN"])
if probe == "runtime":
    env["INVENTORY_TEST_FAILED_COMMAND"] = case.get("failed_command", "")
    for name in args[4::2]:
        if case.get("unavailable") == name:
            continue
        version = fake_bin / name
        version.write_text(os.environ["INVENTORY_TEST_VERSION_SOURCE"])
        version.chmod(0o755)
    env["PATH"] = str(fake_bin) + ":" + os.environ["PATH"]
    if case.get("unavailable"):
        (fake_bin / "sh").symlink_to("/bin/sh")
        (fake_bin / "head").symlink_to("/usr/bin/head")
        env["PATH"] = str(fake_bin)
else:
    assert args[3] == "environment-inventory" and args[4] == probe, args
    env.update(dict(zip(args[6::2], args[7::2])))
    env["PATH"] = str(fake_bin) + ":" + args[5] + ":/extra/bin"
    for name, value in case.get(probe, {}).items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
sys.exit(subprocess.call(args, env=env))
'''

VERSION_FIXTURE = r'''#!/bin/sh
set -eu
name=${0##*/}
printf '%s\n' "$name" >> "$INVENTORY_TEST_VERSIONS"
if [ "$name" = "$INVENTORY_TEST_FAILED_COMMAND" ]; then
    printf 'version-looking stdout from failed command\n'
    printf 'required version failure\n' >&2
    exit 42
fi
if [ "$name" = javac ]; then
    printf 'fixture %s version\n' "$name" >&2
else
    printf 'fixture %s version\n' "$name"
fi
'''


class InventoryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.case_number = 0

    def run_case(self, case):
        self.case_number += 1
        directory = self.root / str(self.case_number)
        fake_bin = directory / "bin"
        fake_bin.mkdir(parents=True)
        sudo = fake_bin / "sudo"
        sudo.write_text("#!" + sys.executable + "\n" + RUNNER_FIXTURE)
        sudo.chmod(0o755)
        invocation_log = directory / "runner.jsonl"
        version_log = directory / "versions.jsonl"
        env = os.environ.copy()
        env.update({
            "PATH": str(fake_bin) + ":" + os.environ["PATH"],
            "INVENTORY_TEST_BIN": str(fake_bin),
            "INVENTORY_TEST_LOG": str(invocation_log),
            "INVENTORY_TEST_VERSIONS": str(version_log),
            "INVENTORY_TEST_CASE": json.dumps(case),
            "INVENTORY_TEST_VERSION_SOURCE": VERSION_FIXTURE,
        })
        result = subprocess.run(
            ["bash", str(INVENTORY), "/fake/bin", "inventory-sandbox"],
            env=env, capture_output=True, text=True, timeout=15,
        )
        invocations = [json.loads(line) for line in invocation_log.read_text().splitlines()]
        versions = version_log.read_text().splitlines() if version_log.exists() else []
        return result, invocations, versions

    def assert_failure(self, result, diagnostic):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(diagnostic, result.stdout + result.stderr)
        self.assertNotIn("PASS: environment variables", result.stdout)

    def test_three_privilege_probes_preserve_all_observations(self):
        result, invocations, versions = self.run_case({})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(versions), 21)
        self.assertEqual(len(set(versions)), 21)
        self.assertEqual([item["root"] for item in invocations], [False, False, True])
        self.assertEqual([item["probe"] for item in invocations], ["runtime", "user", "root"])
        for label in ["user", "root"]:
            self.assertIn(f"{label} environment inventory: 8 checks in 1 runner-exec probe", result.stdout)

    def test_runtime_failures_are_not_hidden_by_version_output(self):
        for command in ["node", "javac", "redis-server"]:
            with self.subTest(command=command):
                result, invocations, versions = self.run_case({"failed_command": command})
                self.assert_failure(result, f"command failed: {command}")
                self.assertIn("(exit 42)", result.stderr)
                self.assertIn("version-looking stdout from failed command", result.stderr)
                self.assertIn("required version failure", result.stderr)
                self.assertEqual(len(invocations), 1)
                self.assertEqual(versions[-1], command)

    def test_unavailable_runtime_fails_the_scenario(self):
        result, invocations, _ = self.run_case({"unavailable": "redis-server"})
        self.assert_failure(result, "command failed: redis-server --version (exit 127)")
        self.assertEqual(len(invocations), 1)

    def test_missing_environment_values_at_both_privileges(self):
        for label in ["user", "root"]:
            with self.subTest(label=label):
                result, _, _ = self.run_case({label: {"RUSTUP_HOME": None}})
                self.assert_failure(result, f"{label}: RUSTUP_HOME not set")

    def test_mismatched_environment_values_at_both_privileges(self):
        for label in ["user", "root"]:
            with self.subTest(label=label):
                result, _, _ = self.run_case({label: {"LANG": "unexpected"}})
                self.assert_failure(result, f"{label}: LANG=unexpected")

    def test_environment_values_are_not_evaluated(self):
        marker = self.root / "injected"
        value = f"literal ' $(touch {marker}); *"
        result, _, _ = self.run_case({"root": {"LANG": value}})
        self.assert_failure(result, f"root: LANG={value}")
        self.assertFalse(marker.exists())

    def test_missing_path_sequence_at_both_privileges(self):
        for label in ["user", "root"]:
            with self.subTest(label=label):
                result, _, _ = self.run_case({label: {"PATH": "/usr/bin:/bin"}})
                self.assert_failure(result, f"{label}: PATH missing")

    def test_runner_failure_in_each_probe_propagates(self):
        for probe in ["runtime", "user", "root"]:
            with self.subTest(probe=probe):
                result, _, _ = self.run_case({"transport_failure": probe})
                diagnostic = "runtime inventory probe" if probe == "runtime" else f"{probe}: environment inventory probe"
                self.assert_failure(result, diagnostic)
                self.assertIn("runner transport fixture failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
