#!/usr/bin/env python3
"""Exercise real CI scripts with controlled external compiler/simulator processes."""

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).parent
MOCK = r"""#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
state = pathlib.Path(os.environ['CI_PROCESS_STATE'])
scenario = os.environ['CI_PROCESS_SCENARIO']
role = ''
def mark(name):
    (state / name).write_text(str(os.getpid()))
def wait_for(name):
    deadline = time.monotonic() + 3
    while not (state / name).exists():
        if time.monotonic() >= deadline:
            sys.exit('Missing concurrent process: ' + name)
        time.sleep(0.01)
def stopped(signum, frame):
    mark(role + '-stopped')
    sys.exit(128 + signum)
signal.signal(signal.SIGTERM, stopped)
args = sys.argv[1:]
command = pathlib.Path(sys.argv[0]).name
if command == 'xcrun':
    if args == ['simctl', 'list', 'devices', 'available', '--json']:
        print(json.dumps({'devices': {'com.apple.CoreSimulator.SimRuntime.iOS-26-2':
            [{'name': 'iPhone 17 Pro', 'udid': 'configured', 'state': 'Shutdown'}]}}))
    elif args == ['simctl', 'boot', 'configured']:
        pass
    elif args == ['simctl', 'bootstatus', 'configured']:
        role = 'boot'
        mark('boot-started')
        if scenario == 'boot-failure':
            sys.exit('Boot rejected')
        wait_for('prepare-finished')
        mark('boot-finished')
    elif args[0] != 'swift-format':
        raise ValueError(args)
elif command == 'swift':
    with (state / 'packages').open('a') as output:
        output.write(args[args.index('--package-path') + 1] + '\n')
    if scenario == 'package-failure':
        sys.exit(19)
elif command == 'xcodebuild':
    with (state / 'xcode-commands').open('a') as output:
        output.write(json.dumps(args) + '\n')
    if '-resolvePackageDependencies' in args:
        role = 'prepare'
        mark('prepare-started')
        if scenario != 'manual':
            wait_for('boot-started')
        if scenario == 'prepare-failure':
            sys.exit(17)
        if scenario == 'cancel':
            wait_for('allow-prepare')
        mark('prepare-finished')
        sys.exit(0)
    if 'build-for-testing' in args:
        role = 'build'
        if scenario != 'manual' and not (state / 'boot-finished').exists():
            sys.exit('Compilation started before system boot readiness')
        mark('build-started')
        if scenario == 'build-failure':
            sys.exit(23)
        products = pathlib.Path(args[args.index('-derivedDataPath') + 1]) / 'Build/Products'
        products.mkdir(parents=True)
        if scenario != 'missing-products':
            (products / 'Okou_iphonesimulator27.1-arm64.xctestrun').write_text('built tests')
        mark('build-finished')
    elif 'test-without-building' in args:
        if not (state / 'build-finished').exists():
            sys.exit('Tests require built products')
        if scenario != 'manual' and not (state / 'boot-finished').exists():
            sys.exit('Tests started before simulator readiness')
        if (state / 'tests-ran').exists():
            sys.exit('Native tests ran twice')
        specification = pathlib.Path(args[args.index('-xctestrun') + 1])
        if specification.read_text() != 'built tests':
            sys.exit('Tests require the current build specification')
        mark('tests-ran')
    else:
        raise ValueError(args)
else:
    raise ValueError(command)
"""


class CIProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True)
        scripts = self.repo / "ios/scripts"
        scripts.mkdir(parents=True)
        for name in (
            "ci-test.sh",
            "prepare-package-sources.py",
            "ci-package-test.sh",
            "preboot-simulator.py",
            "run-ci-tests.sh",
        ):
            shutil.copy2(SCRIPTS / name, scripts / name)
        resolved = (
            self.repo
            / "ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        )
        resolved.parent.mkdir(parents=True)
        resolved.write_text('{"pins": []}\n')
        self.state = self.root / "state"
        self.state.mkdir()
        mock = self.root / "bin"
        mock.mkdir()
        for name in ("xcrun", "swift", "xcodebuild"):
            executable = mock / name
            executable.write_text(MOCK)
            executable.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{mock}:{os.environ['PATH']}",
            "RUNNER_TEMP": str(self.root / "work"),
            "IOS_TEST_DESTINATION": "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.2",
            "CI_PROCESS_STATE": str(self.state),
            "CI_PROCESS_SCENARIO": "success",
        }
        self.env.pop("IOS_PACKAGE_RESOLUTION_DESTINATION", None)

    def command(self, script="run-ci-tests.sh", *args):
        return ["bash", str(self.repo / "ios/scripts" / script), *args]

    def invoke(self, script="run-ci-tests.sh", *args):
        return subprocess.run(
            self.command(script, *args),
            cwd=self.repo,
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
            timeout=8,
        )

    def await_marker(self, name):
        deadline = time.monotonic() + 5
        while not (self.state / name).exists():
            if time.monotonic() >= deadline:
                self.fail(f"Missing process lifecycle marker: {name}")
            time.sleep(0.01)

    def assert_complete_suite(self):
        self.assertEqual(
            (self.state / "packages").read_text().splitlines(),
            ["ios/Packages/ChatDomain", "ios/Packages/ChatData"],
        )
        self.assertTrue((self.state / "tests-ran").exists())

    def test_boot_and_resolution_overlap_before_compilation_and_the_complete_suite(
        self,
    ):
        packages = self.invoke("ci-package-test.sh")
        self.assertEqual(packages.returncode, 0, packages.stderr)
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.state / "boot-finished").exists())
        self.assert_complete_suite()

    def test_package_failure_reaches_its_independent_job(self):
        self.env["CI_PROCESS_SCENARIO"] = "package-failure"
        result = self.invoke("ci-package-test.sh")
        self.assertEqual(result.returncode, 19, result.stderr)

    def test_prepare_only_waits_for_both_children_without_compiling_or_running_tests(
        self,
    ):
        result = self.invoke("run-ci-tests.sh", "prepare")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.state / "prepare-finished").exists())
        self.assertTrue((self.state / "boot-finished").exists())
        self.assertIn("iOS combined preparation:", result.stdout)
        self.assertFalse((self.state / "build-started").exists())
        self.assertFalse((self.state / "tests-ran").exists())

    def test_resolution_needs_no_simulator_destination(self):
        self.env["CI_PROCESS_SCENARIO"] = "manual"
        del self.env["IOS_TEST_DESTINATION"]
        result = self.invoke("ci-test.sh", "prepare")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [
            json.loads(line)
            for line in (self.state / "xcode-commands").read_text().splitlines()
        ]
        self.assertEqual(len(commands), 1)
        self.assertIn("-resolvePackageDependencies", commands[0])
        self.assertNotIn("-destination", commands[0])
        self.assertIn("iOS package graph resolution:", result.stdout)

    def test_resolution_control_does_not_change_compile_or_test_destination(self):
        self.env["CI_PROCESS_SCENARIO"] = "manual"
        self.env["IOS_PACKAGE_RESOLUTION_DESTINATION"] = (
            "platform=iOS Simulator,id=resolution-control"
        )
        result = self.invoke("ci-test.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = [
            json.loads(line)
            for line in (self.state / "xcode-commands").read_text().splitlines()
        ]
        self.assertEqual(len(commands), 3)
        self.assertEqual(
            commands[0][commands[0].index("-destination") + 1],
            self.env["IOS_PACKAGE_RESOLUTION_DESTINATION"],
        )
        for command in commands[1:]:
            self.assertEqual(
                command[command.index("-destination") + 1],
                self.env["IOS_TEST_DESTINATION"],
            )
        self.assert_complete_suite()

    def test_resolution_failure_stops_owned_boot_process_and_blocks_native_tests(self):
        self.env["CI_PROCESS_SCENARIO"] = "prepare-failure"
        result = self.invoke()
        self.assertEqual(result.returncode, 17, result.stderr)
        self.await_marker("boot-stopped")
        self.assertFalse((self.state / "tests-ran").exists())

    def test_boot_failure_blocks_compilation_and_native_tests(self):
        self.env["CI_PROCESS_SCENARIO"] = "boot-failure"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.state / "prepare-finished").exists())
        self.assertFalse((self.state / "tests-ran").exists())

    def test_compilation_failure_blocks_native_tests(self):
        self.env["CI_PROCESS_SCENARIO"] = "build-failure"
        result = self.invoke()
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertFalse((self.state / "tests-ran").exists())

    def test_missing_build_products_block_native_tests(self):
        self.env["CI_PROCESS_SCENARIO"] = "missing-products"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("Expected exactly one built test specification", result.stderr)
        self.assertFalse((self.state / "tests-ran").exists())

    def test_cancellation_retires_both_owned_process_groups(self):
        self.env["CI_PROCESS_SCENARIO"] = "cancel"
        with subprocess.Popen(
            self.command(),
            cwd=self.repo,
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            self.await_marker("boot-started")
            self.await_marker("prepare-started")
            process.send_signal(signal.SIGTERM)
            _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 143, stderr)
        self.await_marker("boot-stopped")
        self.await_marker("prepare-stopped")
        self.assertFalse((self.state / "tests-ran").exists())

    def test_manual_default_still_builds_and_runs_every_suite(self):
        self.env["CI_PROCESS_SCENARIO"] = "manual"
        self.env["IOS_TEST_DESTINATION"] = "platform=iOS Simulator,id=configured"
        result = self.invoke("ci-test.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_complete_suite()

    def test_cache_preparation_without_prefetched_sources_on_system_bash(self):
        self.env["CI_PROCESS_SCENARIO"] = "manual"
        self.env["IOS_BUILD_CACHE_ENABLED"] = "true"
        self.env.pop("IOS_PACKAGE_SOURCES_DIR", None)
        result = subprocess.run(
            ["/bin/bash", str(self.repo / "ios/scripts/ci-test.sh"), "prepare"],
            cwd=self.repo,
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
            timeout=8,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.state / "prepare-finished").exists())


if __name__ == "__main__":
    unittest.main()
