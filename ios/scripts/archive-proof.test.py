#!/usr/bin/env python3
"""Exercise archive proof commands against real temporary archives and IPA files."""

import hashlib
import json
import os
import plistlib
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

SCRIPT = Path(__file__).with_name("archive-proof.py")
VERSION = "1.2.3"
APP_PATH = Path("Products/Applications/Okou.app")


def write_plist(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(plistlib.dumps(value))


def compiled_executable(code=b"compiled app code"):
    # One 64-bit Mach-O section followed by bytes reserved for signing.
    header = struct.pack("<8I", 0xFEEDFACF, 0x100000C, 0, 2, 1, 152, 0, 0)
    segment = struct.pack(
        "<II16s4Q4I", 0x19, 152, b"__TEXT", 0, 4096, 0, 184 + len(code), 7, 5, 1, 0
    )
    section = struct.pack(
        "<16s16s2Q8I", b"__text", b"__TEXT", 184, len(code), 184, 0, 0, 0, 0, 0, 0, 0
    )
    return header + segment + section + code + b"signature placeholder"


class ArchiveProofTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        self.source = self.work / "Original.xcarchive"
        self.destination = self.work / "Prepared.xcarchive"
        self.app = self.source / APP_PATH
        self.info = {
            "CFBundleIdentifier": "ai.okou.ios",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": "1",
            "CFBundleExecutable": "Okou",
            "CFBundleSupportedPlatforms": ["iPhoneOS"],
        }
        write_plist(self.app / "Info.plist", self.info)
        write_plist(
            self.source / "Info.plist",
            {
                "ApplicationProperties": {
                    "ApplicationPath": "Applications/Okou.app",
                    **{
                        key: self.info[key]
                        for key in (
                            "CFBundleIdentifier",
                            "CFBundleShortVersionString",
                            "CFBundleVersion",
                        )
                    },
                }
            },
        )
        (self.app / "Okou").write_bytes(compiled_executable())
        symbols = self.source / "dSYMs/Okou.app.dSYM/Contents/Resources/DWARF/Okou"
        symbols.parent.mkdir(parents=True)
        symbols.write_bytes(b"original symbols")
        (self.app / "resource.txt").write_bytes(b"original resource")

    def invoke(self, command, output=None, build_number="42", success=True):
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                command,
                str(self.source),
                str(output or self.destination),
                "--version",
                VERSION,
                "--build-number",
                build_number,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return result.stderr

    def digests(self, directory):
        return {
            str(path.relative_to(directory)): hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
            for path in directory.rglob("*")
            if path.is_file()
        }

    def package(self, executable=None, build_number="42", signed=True):
        ipa = self.work / "Okou.ipa"
        info = {**self.info, "CFBundleVersion": build_number}
        with ZipFile(ipa, "w") as package:
            package.writestr("Payload/Okou.app/Info.plist", plistlib.dumps(info))
            package.writestr(
                "Payload/Okou.app/Okou", executable or (self.app / "Okou").read_bytes()
            )
            if signed:
                package.writestr(
                    "Payload/Okou.app/embedded.mobileprovision", b"profile placeholder"
                )
                package.writestr(
                    "Payload/Okou.app/_CodeSignature/CodeResources",
                    b"signature placeholder",
                )
        return ipa

    def test_prepare_changes_only_both_build_numbers_and_preserves_source(self):
        original = self.digests(self.source)
        result = self.invoke("prepare")
        self.assertEqual(result["buildNumber"], "42")
        self.assertEqual(self.digests(self.source), original)
        copied = self.digests(self.destination)
        for name, digest in original.items():
            if name not in ("Info.plist", str(APP_PATH / "Info.plist")):
                self.assertEqual(copied[name], digest)
        app_info = plistlib.loads(
            (self.destination / APP_PATH / "Info.plist").read_bytes()
        )
        archive_info = plistlib.loads((self.destination / "Info.plist").read_bytes())
        self.assertEqual(app_info["CFBundleVersion"], "42")
        self.assertEqual(archive_info["ApplicationProperties"]["CFBundleVersion"], "42")

    def test_prepare_rejects_invalid_number_and_overwrite(self):
        for number in ("0", "10000", "1.2", "0001"):
            with self.subTest(number=number):
                self.invoke("prepare", build_number=number, success=False)
                self.assertFalse(self.destination.exists())
        self.destination.mkdir()
        self.assertIn("new destination", self.invoke("prepare", success=False))

    def test_prepare_rejects_simulator_and_wrong_release(self):
        for changes in (
            {"CFBundleSupportedPlatforms": ["iPhoneSimulator"]},
            {"CFBundleShortVersionString": "9.0.0"},
            {"CFBundleIdentifier": "unrelated.app"},
        ):
            with self.subTest(changes=changes):
                write_plist(self.app / "Info.plist", {**self.info, **changes})
                self.invoke("prepare", success=False)
                self.assertFalse(self.destination.exists())

    def test_prepare_rejects_inconsistent_archive_metadata(self):
        write_plist(self.app / "Info.plist", {**self.info, "CFBundleVersion": "2"})
        self.assertIn("metadata disagree", self.invoke("prepare", success=False))

    def test_prepare_rejects_nested_app_and_escaping_symlink(self):
        extension = self.app / "PlugIns/Extension.appex"
        extension.mkdir(parents=True)
        self.assertIn("Nested application", self.invoke("prepare", success=False))
        extension.rmdir()
        outside = self.work / "outside"
        outside.write_bytes(b"must not be changed")
        (self.app / "escape").symlink_to(outside)
        self.assertIn("symlink", self.invoke("prepare", success=False))
        self.assertEqual(outside.read_bytes(), b"must not be changed")

    def test_export_allows_signing_bytes_but_not_recompiled_sections(self):
        executable = (self.app / "Okou").read_bytes() + b"new code signature"
        result = self.invoke("verify-export", self.package(executable))
        self.assertEqual(result["verifiedMachOFiles"], 1)
        ipa = self.package(compiled_executable(b"changed app code!"))
        self.assertIn(
            "compiled Mach-O", self.invoke("verify-export", ipa, success=False)
        )

    def test_export_rejects_wrong_build_and_missing_signature(self):
        self.assertIn(
            "release identity",
            self.invoke("verify-export", self.package(build_number="1"), success=False),
        )
        self.assertIn(
            "provisioning profile",
            self.invoke("verify-export", self.package(signed=False), success=False),
        )

    def test_export_verifies_universal_binary_slices(self):
        slice_data = (self.app / "Okou").read_bytes()
        universal = (
            struct.pack(">7I", 0xCAFEBABE, 1, 0x100000C, 0, 28, len(slice_data), 0)
            + slice_data
        )
        (self.app / "Okou").write_bytes(universal)
        self.invoke("verify-export", self.package(universal))
        changed = bytearray(universal)
        changed[28 + 184] ^= 1
        self.assertIn(
            "compiled Mach-O",
            self.invoke("verify-export", self.package(changed), success=False),
        )

    def test_proof_mode_rejects_bad_archive_before_using_credentials(self):
        root = SCRIPT.parents[2]
        result = subprocess.run(
            [
                "bash",
                str(root / "ios/scripts/release-testflight.sh"),
                "--verify-archive",
                str(self.work / "missing"),
            ],
            cwd=root,
            env={
                **os.environ,
                "RUNNER_TEMP": str(self.work),
                "IOS_VERSION": (root / "ios/version.txt").read_text().strip(),
                "IOS_BUILD_NUMBER": "42",
                "IOS_DISTRIBUTION_P12_BASE64": "not-a-certificate",
                "IOS_DISTRIBUTION_P12_PASSWORD": "not-a-password",
                "IOS_PROVISIONING_PROFILE_BASE64": "not-a-profile",
            },
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("xcarchive directory", result.stderr)
        self.assertNotIn("base64", result.stderr)


if __name__ == "__main__":
    unittest.main()
