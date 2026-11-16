#!/usr/bin/env python3
"""Verify transferred-product identity and real compiler/boot process ownership."""

import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("experiment.py")
spec = importlib.util.spec_from_file_location("experiment", SCRIPT)
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


class TransferTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.lock = b'{"pins": []}\n'
        work = self.root / "okou-ios-ci"
        products = work / "DerivedData/Build/Products"
        app = products / "Debug-iphonesimulator/Okou.app"
        app.mkdir(parents=True)
        (app / "Okou").write_bytes(b"completed native executable")
        (app / "Okou").chmod(0o755)
        (app / "Current").symlink_to("Okou")
        (products / "Okou.xctestrun").write_bytes(b"original test specification")
        (work / "Package.resolved.before").write_bytes(self.lock)
        inputs = self.root / "captured"
        inputs.mkdir()
        self.inputs = {
            "testInputSha256": "same sources",
            "toolchain": {"xcode": "27.1"},
        }
        (inputs / "inputs.json").write_text(json.dumps(self.inputs))
        environment = {
            "RUNNER_TEMP": str(self.root),
            "IOS_ARCHIVE_DIR": str(inputs),
            "GITHUB_REPOSITORY": "example/repo",
            "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "1",
        }
        context = patch.dict(os.environ, environment)
        context.start()
        self.addCleanup(context.stop)
        experiment.pack()
        self.bundle = self.root / "ios-test-products"

    def unpack(self, *, context=None, inputs=None):
        return experiment.unpack(
            self.bundle,
            self.root / "consumer",
            context or experiment.context(),
            inputs or self.inputs,
            self.lock,
        )

    def test_other_mac_receives_the_same_executable_specification_and_lock(self):
        self.unpack()
        products = self.root / "consumer/DerivedData/Build/Products"
        self.assertEqual(
            (products / "Okou.xctestrun").read_bytes(), b"original test specification"
        )
        app = products / "Debug-iphonesimulator/Okou.app"
        self.assertEqual((app / "Current").read_bytes(), b"completed native executable")
        self.assertTrue((app / "Okou").stat().st_mode & 0o100)
        self.assertEqual(
            (self.root / "consumer/Package.resolved.before").read_bytes(), self.lock
        )

    def test_other_commit_cannot_supply_native_test_products(self):
        wrong = experiment.context() | {"GITHUB_SHA": "b" * 40}
        with self.assertRaisesRegex(ValueError, "source/run/toolchain mismatch"):
            self.unpack(context=wrong)

    def test_other_sdk_cannot_supply_native_test_products(self):
        wrong = self.inputs | {"toolchain": {"xcode": "27.2"}}
        with self.assertRaisesRegex(ValueError, "source/run/toolchain mismatch"):
            self.unpack(inputs=wrong)

    def test_corrupted_transfer_is_rejected_before_test_execution(self):
        with (self.bundle / "products.tar.gz").open("ab") as stream:
            stream.write(b"damaged transfer")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.unpack()


SLOW = """import pathlib,signal,sys,time
root=pathlib.Path(sys.argv[1]); role=sys.argv[2]
def stop(*args):
 (root/(role+'-stopped')).touch()
 sys.exit(143)
signal.signal(signal.SIGTERM,stop)
(root/(role+'-ready')).touch()
while True: time.sleep(0.05)
"""


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def slow(self, role):
        return [sys.executable, "-c", SLOW, str(self.root), role]

    def await_marker(self, name):
        deadline = time.monotonic() + 5
        while not (self.root / name).exists():
            if time.monotonic() > deadline:
                self.fail("Missing owned process marker: " + name)
            time.sleep(0.01)

    def test_failed_artifact_wait_retires_the_still_booting_simulator(self):
        failing = """import pathlib,sys,time
p=pathlib.Path(sys.argv[1])/'simulator-ready'
while not p.exists(): time.sleep(0.01)
sys.exit(23)
"""
        with self.assertRaises(subprocess.CalledProcessError) as error:
            experiment.run_owned(
                [
                    ("simulator", self.slow("simulator")),
                    ("products", [sys.executable, "-c", failing, str(self.root)]),
                ]
            )
        self.assertEqual(error.exception.returncode, 23)
        self.assertTrue((self.root / "simulator-stopped").exists())

    def test_cancellation_retires_boot_and_artifact_wait(self):
        code = "import runpy,sys,json; m=runpy.run_path(sys.argv[1]); m['run_owned'](json.loads(sys.argv[2]))"
        commands = [
            ("simulator", self.slow("simulator")),
            ("products", self.slow("products")),
        ]
        with subprocess.Popen(
            [sys.executable, "-c", code, str(SCRIPT), json.dumps(commands)]
        ) as process:
            self.await_marker("simulator-ready")
            self.await_marker("products-ready")
            process.send_signal(signal.SIGTERM)
            self.assertEqual(process.wait(timeout=5), 143)
        self.assertTrue((self.root / "simulator-stopped").exists())
        self.assertTrue((self.root / "products-stopped").exists())


class MetadataTests(unittest.TestCase):
    def test_a_temporary_metadata_timeout_recovers_the_safe_read(self):
        body = io.BytesIO(
            b'{"jobs": [{"name": "build-test-products", "status": "completed"}]}'
        )
        with (
            patch.dict(os.environ, {"GH_TOKEN": "test-only"}),
            patch.object(experiment, "urlopen", side_effect=[TimeoutError(), body]),
        ):
            jobs = experiment.read_jobs("example/repo", "123", "1")
        self.assertEqual(jobs, [{"name": "build-test-products", "status": "completed"}])

    def test_a_failed_producer_blocks_download_and_native_execution(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.dict(
                os.environ,
                {
                    "RUNNER_TEMP": temporary,
                    "GITHUB_REPOSITORY": "example/repo",
                    "GITHUB_RUN_ID": "123",
                    "GITHUB_RUN_ATTEMPT": "1",
                },
            ),
            patch.object(
                experiment,
                "read_jobs",
                return_value=[
                    {
                        "name": "build-test-products",
                        "status": "completed",
                        "conclusion": "failure",
                    }
                ],
            ),
            patch.object(experiment.subprocess, "run") as download,
            self.assertRaisesRegex(ValueError, "producer did not succeed"),
        ):
            experiment.fetch()
        download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
