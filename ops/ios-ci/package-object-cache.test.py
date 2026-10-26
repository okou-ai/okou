"""Exercise cache receiver metadata and artifact rejection through its CLI."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("package-object-cache.py")


class PackageObjectCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.work = self.root / "work"
        self.work.mkdir()
        self.inputs = [
            "ios/Packages/ChatDomain/Package.swift",
            "ios/Packages/ChatData/Package.swift",
            "ios/scripts/ci-package-test.sh",
        ]
        for name in self.inputs:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// owned package input\n")
        for args in (["init", "-q"], ["add", "."],
                     ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "inputs"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)
        tools = self.root / "tools"
        tools.mkdir()
        mock = "#!/bin/sh\ncase ${0##*/} in\nxcrun) printf 'fixture SDK/compiler\\n';;\nxcodebuild) printf 'fixture Xcode\\n';;\nsw_vers) printf 'fixture OS\\n';;\nuname) printf 'arm64\\n';;\nesac\n"
        for name in ("xcrun", "xcodebuild", "sw_vers", "uname"):
            path = tools / name
            path.write_text(mock)
            path.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{tools}:{os.environ['PATH']}", "RUNNER_TEMP": str(self.work),
            "PACKAGE_CACHE_TRIAL_MODE": "seed", "PACKAGE_CACHE_TRIAL_LABEL": "fixture",
            "PACKAGE_CACHE_EXACT_HIT": "true",
        }
        self.assertEqual(self.invoke("start").returncode, 0)
        self.build = self.work / "okou-ios-ci"
        for package in ("ChatDomain", "ChatData"):
            (self.build / package / "Tests.xctest").mkdir(parents=True)
        result = self.invoke("snapshot")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.manifest = self.build / "package-cache-source-times.json"
        self.saved = json.loads(self.manifest.read_text())
        self.fresh = {}
        for name in self.inputs:
            path = self.repo / name
            self.fresh[name] = self.saved[name]["mtime_ns"] + 1_000_000_000
            os.utime(path, ns=(path.stat().st_atime_ns, self.fresh[name]))
        self.env["PACKAGE_CACHE_TRIAL_MODE"] = "warm"

    def invoke(self, operation):
        return subprocess.run(["python3", str(SCRIPT), operation], cwd=self.repo,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_verified_unchanged_inputs_restore_metadata_without_restoring_tests(self):
        result = self.invoke("validate")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in self.inputs:
            self.assertEqual((self.repo / name).stat().st_mtime_ns, self.saved[name]["mtime_ns"])
            self.assertEqual((self.repo / name).read_text(), "// owned package input\n")
        self.assertFalse(list(self.build.rglob("*.xctest")))

    def test_one_incorrect_source_digest_rejects_before_any_metadata_is_applied(self):
        self.saved[self.inputs[-1]]["sha256"] = "0" * 64
        self.manifest.write_text(json.dumps(self.saved))
        result = self.invoke("validate")
        self.assertNotEqual(result.returncode, 0)
        for name in self.inputs:
            self.assertEqual((self.repo / name).stat().st_mtime_ns, self.fresh[name])

    def test_restored_executable_test_bundle_is_rejected_before_source_changes(self):
        (self.build / "ChatDomain" / "CachedTests.xctest").mkdir()
        result = self.invoke("validate")
        self.assertNotEqual(result.returncode, 0)
        for name in self.inputs:
            self.assertEqual((self.repo / name).stat().st_mtime_ns, self.fresh[name])


if __name__ == "__main__":
    unittest.main()
