#!/usr/bin/env python3
"""Exercise the staging artifact CLI with isolated archives and real IPA output."""

import base64
import hashlib
import json
import plistlib
import stat
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

SCRIPT = Path(__file__).with_name("preview-artifact.py")


class PreviewArtifactTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.archive = self.root / "Staging.xcarchive"
        self.output = self.root / "output"
        self.app = self.archive / "Products/Applications/Okou.app"
        self.extension = self.app / "PlugIns/OkouNotificationService.appex"
        self.key = "pk_test_" + base64.b64encode(
            b"informed-calf-6.clerk.accounts.dev$"
        ).decode().rstrip("=")
        for bundle, identifier, executable in [
            (self.app, "ai.okou.ios", "Okou"),
            (self.extension, "ai.okou.ios.notifications", "OkouNotificationService"),
        ]:
            bundle.mkdir(parents=True)
            info = {
                "CFBundleIdentifier": identifier,
                "CFBundleShortVersionString": "1.2.3",
                "CFBundleVersion": "1",
                "CFBundleExecutable": executable,
                "CFBundleSupportedPlatforms": ["iPhoneOS"],
                "MinimumOSVersion": "26.0",
                "APIBaseURL": "https://staging-api.vm6.ai",
                "WebBaseURL": "https://staging-app-okou-app-preview.vm0.workers.dev",
                "ClerkPublishableKey": self.key,
                "SentryDSN": "",
                "ClerkKeychainAccessGroup": "",
            }
            (bundle / "Info.plist").write_bytes(plistlib.dumps(info))
            self.executable(bundle / executable)

    def executable(self, path, platform=2):
        header = struct.pack("<8I", 0xFEEDFACF, 0x100000C, 0, 2, 1, 24, 0, 0)
        version = struct.pack("<6I", 0x32, 24, platform, 0x1A0000, 0x1B0000, 0)
        path.write_bytes(header + version)
        path.chmod(0o755)

    def invoke(self, success=True):
        result = subprocess.run(
            ["python3", str(SCRIPT), str(self.archive), str(self.output),
             "--version", "1.2.3"],
            capture_output=True, text=True, check=False,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads((self.output / "manifest.json").read_text())
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_ipa_preserves_executables_links_and_verified_provenance(self):
        (self.app / "current").symlink_to("Okou")
        manifest = self.invoke()
        self.assertEqual(manifest["environment"], "staging")
        self.assertEqual(manifest["apiBaseURL"], "https://staging-api.vm6.ai")
        self.assertEqual(manifest["clerkFrontendAPI"], "informed-calf-6.clerk.accounts.dev")
        self.assertEqual(
            manifest["commitSha"],
            subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        )
        for name, digest in manifest["files"].items():
            self.assertEqual(hashlib.sha256((self.output / name).read_bytes()).hexdigest(), digest)
        with ZipFile(self.output / "Okou-Staging.ipa") as package:
            executable = package.getinfo("Payload/Okou.app/Okou")
            self.assertTrue((executable.external_attr >> 16) & stat.S_IXUSR)
            link = package.getinfo("Payload/Okou.app/current")
            self.assertTrue(stat.S_ISLNK(link.external_attr >> 16))
            self.assertEqual(package.read(link), b"Okou")
            self.assertEqual(package.read(executable), (self.app / "Okou").read_bytes())

    def test_production_configuration_cannot_be_labelled_as_staging(self):
        path = self.app / "Info.plist"
        info = plistlib.loads(path.read_bytes())
        info["APIBaseURL"] = "https://api.okou.ai"
        path.write_bytes(plistlib.dumps(info))
        self.invoke(success=False)

    def test_arm64_simulator_cannot_be_packaged_for_a_real_device(self):
        self.executable(self.app / "Okou", platform=7)
        self.invoke(success=False)

    def test_external_links_cannot_include_files_outside_the_archive(self):
        external = self.root / "private.txt"
        external.write_text("not an application resource")
        (self.app / "external").symlink_to(external)
        self.invoke(success=False)


if __name__ == "__main__":
    unittest.main()
