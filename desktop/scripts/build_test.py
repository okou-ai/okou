#!/usr/bin/env python3
"""Exercise the packaging CLI with a real native app, ZIP and DMG."""

import json
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("build.py")
SYMBOLS = Path(__file__).with_name("debug_symbols.py")


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


class BuildPackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="okou-build-test-")
        cls.addClassCleanup(cls.fixture.cleanup)
        cls.root = Path(cls.fixture.name)
        cls.app = cls.root / "Okou Dev.app"
        contents = cls.app / "Contents"
        resources = contents / "Resources"
        (resources / "Clerk_ClerkKit.bundle").mkdir(parents=True)
        (resources / "desktop-runtime-config.json").write_text(
            json.dumps({"product": "okou", "clerkPublishableKey": "pk_test_fixture"})
        )
        (contents / "Info.plist").write_bytes(
            plistlib.dumps(
                {
                    "CFBundleIdentifier": "ai.okou.desktop.dev",
                    "CFBundleName": "Okou Dev",
                    "CFBundleDisplayName": "Okou Dev",
                    "CFBundleExecutable": "Okou Dev",
                    "CFBundlePackageType": "APPL",
                    "CFBundleURLTypes": [
                        {"CFBundleURLSchemes": ["ai.okou.desktop.dev"]}
                    ],
                    "CFBundleShortVersionString": "1.2.3",
                    "CFBundleVersion": "1.2.3",
                    "LSMinimumSystemVersion": "14.0",
                }
            )
        )
        cls.symbols = cls.root / "dSYMs"
        cls.symbols.mkdir()
        for index, (relative, bundle) in enumerate(
            (
                ("MacOS/Okou Dev", "Okou Dev.app.dSYM"),
                ("Helpers/computer-use-helper", "computer-use-helper.dSYM"),
            )
        ):
            source = cls.root / f"main-{index}.c"
            source.write_text("int main(void) { return 0; }\n")
            binary = contents / relative
            binary.parent.mkdir(parents=True)
            run("xcrun", "clang", "-arch", "arm64", "-g", source, "-o", binary)
            run("dsymutil", binary, "-o", cls.symbols / bundle)
        run("codesign", "--force", "--sign", "-", cls.app)

    def test_packaging_formats_preserve_the_verified_app(self):
        for arguments, extensions in (
            (("--package", "zip"), ("zip",)),
            (("--package",), ("zip", "dmg")),
        ):
            with (
                self.subTest(arguments=arguments),
                tempfile.TemporaryDirectory(prefix="okou-package-test-") as directory,
            ):
                output = Path(directory)
                run(
                    sys.executable,
                    SCRIPT,
                    "--app",
                    self.app,
                    "--development",
                    "--version",
                    "1.2.3",
                    "--verify-only",
                    "--output",
                    output,
                    *arguments,
                )
                self.assertEqual(
                    {path.name for path in output.iterdir()},
                    {f"Okou Dev-darwin-arm64-1.2.3.{ext}" for ext in extensions},
                )
                packages = [
                    item
                    for ext in extensions
                    for item in (
                        f"--{ext}",
                        output / f"Okou Dev-darwin-arm64-1.2.3.{ext}",
                    )
                ]
                run(
                    sys.executable,
                    SYMBOLS,
                    "--app",
                    self.app,
                    "--symbols",
                    self.symbols,
                    *packages,
                )


if __name__ == "__main__":
    unittest.main()
