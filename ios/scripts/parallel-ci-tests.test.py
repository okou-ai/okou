#!/usr/bin/env python3
"""Verify same-run native product transfer, including reruns and executable bundles."""

import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "wait_artifact", SCRIPTS / "wait-ci-test-artifact.py"
)
waiter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(waiter)


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.output = Path(tmp.name, "output")
        self.env = {
            "GITHUB_RUN_ID": "12",
            "GITHUB_SHA": "abc",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_OUTPUT": str(self.output),
        }
        self.job = {
            "name": "test-packages",
            "run_attempt": 2,
            "head_sha": "abc",
            "run_id": 12,
            "conclusion": None,
        }
        self.jobs = {"total_count": 1, "jobs": [self.job]}

    def test_waits_for_the_actual_producer_attempt(self):
        name = "ios-ci-products-abc-2"
        artifacts = {"artifacts": [{"name": name, "id": 36, "expired": False}]}
        with (
            patch.dict(os.environ, self.env),
            patch.object(
                waiter,
                "request",
                side_effect=[self.jobs, {"artifacts": []}, self.jobs, artifacts],
            ),
            patch.object(waiter.time, "sleep"),
        ):
            waiter.wait("products")
        self.assertEqual(self.output.read_text(), f"name={name}\n")

    def test_rejects_failure_or_another_head_before_receiving_products(self):
        for change in ({"conclusion": "failure"}, {"head_sha": "other"}):
            with self.subTest(change=change):
                jobs = {"total_count": 1, "jobs": [self.job | change]}
                with (
                    patch.dict(os.environ, self.env),
                    patch.object(waiter, "request", return_value=jobs),
                    self.assertRaises(ValueError),
                ):
                    waiter.wait("products")
        self.assertFalse(self.output.exists())


class ProductTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.work = self.base / "repo"
        self.lock = (
            self.work
            / "ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        )
        self.lock.parent.mkdir(parents=True)
        self.lock.write_text("locked")
        self.src = self.base / "producer"
        self.dst = self.base / "consumer"
        self.root = self.src / "okou-ios-ci"
        products = self.root / "DerivedData/Build/Products"
        binary = products / "Debug-iphonesimulator/Okou.app/Okou"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"test executable")
        binary.chmod(0o755)
        (binary.parent / "alias").symlink_to("Okou")
        (products / "Okou.xctestrun").write_text("test specification")
        (self.root / "package-sources.gitconfig").write_text("")
        shutil.copyfile(self.lock, self.root / "Package.resolved.before")
        self.toolchain = self.base / "tools.json"
        self.toolchain.write_text('{"xcode":"the same"}')
        # The CI host uses sw_vers; provide a deterministic host identity on Linux.
        version = self.base / "sw_vers"
        version.write_text("#!/bin/sh\necho 24D39\n")
        version.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.base}:{os.environ['PATH']}",
            "GITHUB_RUN_ID": "12",
            "GITHUB_SHA": "abc",
            "IOS_PRODUCT_TOOLCHAIN": str(self.toolchain),
        }
        self.command("pack", self.src, check=True)
        shutil.copytree(
            self.src / "ios-native-products", self.dst / "ios-native-products"
        )

    def command(self, mode, temp, check=False, **extra):
        return subprocess.run(
            ["bash", str(SCRIPTS / "transfer-ci-test-products.sh"), mode],
            cwd=self.work,
            env=self.env | {"RUNNER_TEMP": str(temp)} | extra,
            capture_output=True,
            check=check,
        )

    def test_preserves_specification_permissions_and_links(self):
        self.command("unpack", self.dst, check=True)
        products = self.dst / "okou-ios-ci/DerivedData/Build/Products"
        self.assertEqual(
            (products / "Okou.xctestrun").read_text(), "test specification"
        )
        alias = products / "Debug-iphonesimulator/Okou.app/alias"
        self.assertTrue(alias.is_symlink())
        self.assertTrue(os.access(alias, os.X_OK))

    def test_rejects_wrong_run_toolchain_and_package_lock_before_extraction(self):
        self.assertNotEqual(
            self.command("unpack", self.dst, GITHUB_RUN_ID="13").returncode, 0
        )
        self.toolchain.write_text("other")
        self.assertNotEqual(self.command("unpack", self.dst).returncode, 0)
        self.toolchain.write_text('{"xcode":"the same"}')
        self.lock.write_text("other")
        self.assertNotEqual(self.command("unpack", self.dst).returncode, 0)
        self.assertFalse((self.dst / "okou-ios-ci/DerivedData").exists())


if __name__ == "__main__":
    unittest.main()
