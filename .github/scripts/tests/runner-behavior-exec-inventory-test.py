import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER = REPO_ROOT / ".github/scripts/runner-behavior-exec-remote.sh"
EXPECTED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EXPECTED_ENV = {
    "LANG": "C.UTF-8",
    "NPM_CONFIG_UPDATE_NOTIFIER": "false",
    "NODE_EXTRA_CA_CERTS": "/usr/local/share/ca-certificates/vm0-proxy-ca.crt",
    "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
    "REQUESTS_CA_BUNDLE": "/etc/ssl/certs/ca-certificates.crt",
    "CARGO_HTTP_CAINFO": "/etc/ssl/certs/ca-certificates.crt",
    "RUSTUP_HOME": "/usr/local/rustup",
}
RUNTIME_COMMANDS = [
    ["node", "--version"],
    ["npm", "--version"],
    ["python3", "--version"],
    ["pip3", "--version"],
    ["ruby", "--version"],
    ["bundler", "--version"],
    ["php", "--version"],
    ["composer", "--version"],
    ["javac", "-version"],
    ["mvn", "--version"],
    ["gradle", "--version"],
    ["go", "version"],
    ["rustc", "--version"],
    ["cargo", "--version"],
    ["gcc", "--version"],
    ["g++", "--version"],
    ["clang", "--version"],
    ["make", "--version"],
    ["cmake", "--version"],
    ["psql", "--version"],
    ["redis-server", "--version"],
]

# Control only the external Runner command boundary. Execute the real guest
# shell and printenv; native CI still owns Runner/RPC/profile/image coverage.
RUNNER_FIXTURE = r'''
import json
import os
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
with open(os.environ["INVENTORY_TEST_LOG"], "a") as log:
    log.write(json.dumps({"root": root, "command": args}) + "\n")
case = json.loads(os.environ["INVENTORY_TEST_CASE"])
probe = "runtime" if args[3] == "runtime-inventory" else "root" if root else "user"
if case.get("transport_failure") == probe:
    print("runner transport fixture failed", file=sys.stderr)
    sys.exit(73)
env = os.environ.copy()
env.update(json.loads(os.environ["INVENTORY_TEST_EXPECTED_ENV"]))
env["PATH"] = os.environ["INVENTORY_TEST_BIN"] + ":" + os.environ["INVENTORY_TEST_EXPECTED_PATH"] + ":/extra/bin"
if probe == "runtime" and case.get("unavailable"):
    env["PATH"] = os.environ["INVENTORY_TEST_BIN"]
if probe != "runtime":
    for name, value in case.get("root" if root else "user", {}).items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
sys.exit(subprocess.call(args, env=env))
'''

VERSION_FIXTURE = r'''
import json
import os
from pathlib import Path
import sys

name = Path(sys.argv[0]).name
with open(os.environ["INVENTORY_TEST_VERSIONS"], "a") as log:
    log.write(json.dumps([name, *sys.argv[1:]]) + "\n")
case = json.loads(os.environ["INVENTORY_TEST_CASE"])
if case.get("failed_command") == name:
    print("version-looking stdout from failed command", flush=True)
    print("required version failure", file=sys.stderr, flush=True)
    sys.exit(42)
print("fixture " + name + " version", file=sys.stderr if name == "javac" else sys.stdout, flush=True)
print("second version line", flush=True)
'''


class InventoryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.case_number = 0
        source = WORKER.read_text()
        # Isolate only the inventory sections, excluding native VM setup and
        # unrelated checks. The executed checks and failure handler are real.
        runtime = source.split("# Test 7: verify pre-installed", 1)[1].split(
            "# Verify PostgreSQL can actually start", 1
        )[0]
        environment = source.split("# Test 10: verify /etc/environment", 1)[1].split(
            "# Test 11: verify HTTPS", 1
        )[0]
        fail = next(line for line in source.splitlines() if line.startswith("fail()"))
        prefix = "BIN_DIR=$1; SANDBOX_ID=$2\n" + fail + "\n"
        self.fragments = {
            "all": prefix + "#" + runtime + "\n#" + environment,
            "runtime": prefix + "#" + runtime,
            "environment": prefix + "#" + environment,
        }

    def run_case(self, case, inventory="all"):
        self.case_number += 1
        directory = self.root / str(self.case_number)
        fake_bin = directory / "bin"
        fake_bin.mkdir(parents=True)
        executable_header = "#!" + sys.executable + "\n"
        sudo = fake_bin / "sudo"
        sudo.write_text(executable_header + RUNNER_FIXTURE)
        sudo.chmod(0o755)
        for name, _ in RUNTIME_COMMANDS:
            version = fake_bin / name
            version.write_text(executable_header + VERSION_FIXTURE)
            version.chmod(0o755)
        if case.get("unavailable"):
            (fake_bin / case["unavailable"]).unlink()
            (fake_bin / "sh").symlink_to("/bin/sh")
            (fake_bin / "head").symlink_to("/usr/bin/head")
        invocation_log = directory / "runner.jsonl"
        version_log = directory / "versions.jsonl"
        env = os.environ.copy()
        env.update({
            "PATH": str(fake_bin) + ":" + os.environ["PATH"],
            "INVENTORY_TEST_BIN": str(fake_bin),
            "INVENTORY_TEST_LOG": str(invocation_log),
            "INVENTORY_TEST_VERSIONS": str(version_log),
            "INVENTORY_TEST_CASE": json.dumps(case),
            "INVENTORY_TEST_EXPECTED_ENV": json.dumps(EXPECTED_ENV),
            "INVENTORY_TEST_EXPECTED_PATH": EXPECTED_PATH,
        })
        result = subprocess.run(
            ["bash", "-c", self.fragments[inventory], "inventory-test", "/fake/bin", "inventory-sandbox"],
            env=env, capture_output=True, text=True, timeout=15,
        )
        invocations = [json.loads(line) for line in invocation_log.read_text().splitlines()]
        versions = [json.loads(line) for line in version_log.read_text().splitlines()] if version_log.exists() else []
        return result, invocations, versions

    def assert_failure(self, result, diagnostic):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(diagnostic, result.stdout + result.stderr)
        self.assertNotIn("PASS: environment variables", result.stdout)

    def test_all_observations_in_three_separate_privilege_probes(self):
        result, invocations, versions = self.run_case({})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(versions, RUNTIME_COMMANDS)
        self.assertEqual([item["root"] for item in invocations], [False, False, True])
        for command, argument in RUNTIME_COMMANDS:
            self.assertIn(f"{command} {argument} -> fixture {command} version", result.stdout)
        self.assertNotIn("second version line", result.stdout)
        for label in ["user", "root"]:
            for name, value in EXPECTED_ENV.items():
                self.assertIn(f"  {label} {name}={value}\n", result.stdout)
            path_line = next(line for line in result.stdout.splitlines() if line.startswith(f"  {label} PATH="))
            self.assertIn(EXPECTED_PATH + ":/extra/bin", path_line)
            self.assertIn(f"{label} environment inventory: 8 checks in 1 runner-exec probe", result.stdout)
        self.assertIn("runtime inventory: 21 checks in 1 runner-exec probe", result.stdout)
        self.assertIn("PASS: environment variables", result.stdout)

    def test_required_early_middle_and_late_runtime_failures(self):
        for command in ["node", "javac", "redis-server"]:
            with self.subTest(command=command):
                result, invocations, versions = self.run_case({"failed_command": command}, "runtime")
                self.assert_failure(result, f"command failed: {command}")
                self.assertIn("(exit 42)", result.stderr)
                self.assertIn("version-looking stdout from failed command", result.stderr)
                self.assertIn("required version failure", result.stderr)
                self.assertEqual(len(invocations), 1)
                self.assertEqual(versions[-1][0], command)

    def test_unavailable_runtime_reports_exact_command(self):
        result, invocations, _ = self.run_case({"unavailable": "redis-server"}, "runtime")
        self.assert_failure(result, "command failed: redis-server --version (exit 127)")
        self.assertEqual(len(invocations), 1)

    def test_missing_environment_values_at_both_privileges(self):
        for label in ["user", "root"]:
            with self.subTest(label=label):
                result, _, _ = self.run_case({label: {"RUSTUP_HOME": None}}, "environment")
                self.assert_failure(result, f"{label}: RUSTUP_HOME not set")

    def test_mismatched_environment_values_at_both_privileges(self):
        for label in ["user", "root"]:
            with self.subTest(label=label):
                result, _, _ = self.run_case({label: {"LANG": "unexpected"}}, "environment")
                self.assert_failure(result, f"{label}: LANG=unexpected, expected C.UTF-8")

    def test_environment_values_are_not_evaluated(self):
        marker = self.root / "injected"
        value = f"literal ' $(touch {marker}); *"
        result, _, _ = self.run_case({"root": {"LANG": value}}, "environment")
        self.assert_failure(result, f"root: LANG={value}, expected C.UTF-8")
        self.assertFalse(marker.exists())

    def test_missing_path_sequence_at_both_privileges(self):
        for label in ["user", "root"]:
            with self.subTest(label=label):
                result, _, _ = self.run_case({label: {"PATH": "/usr/bin:/bin"}}, "environment")
                self.assert_failure(result, f"{label}: PATH missing {EXPECTED_PATH} in: /usr/bin:/bin")

    def test_runner_failure_in_each_probe_propagates(self):
        for probe in ["runtime", "user", "root"]:
            with self.subTest(probe=probe):
                inventory = "runtime" if probe == "runtime" else "environment"
                result, _, _ = self.run_case({"transport_failure": probe}, inventory)
                diagnostic = "runtime inventory probe" if probe == "runtime" else f"{probe}: environment inventory probe"
                self.assert_failure(result, diagnostic)
                self.assertIn("runner transport fixture failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
