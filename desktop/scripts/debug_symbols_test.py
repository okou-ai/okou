#!/usr/bin/env python3
"""Exercise the symbol command with real Mach-O files, dSYMs and packages."""

import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("debug_symbols.py")


def run(*args):
    result = subprocess.run(
        [str(arg) for arg in args], check=False, capture_output=True, text=True
    )
    if result.returncode:
        raise RuntimeError(f"Command failed: {args}\n{result.stdout}{result.stderr}")
    return result


def make_app(directory, value):
    app = directory / "Okou.app"
    symbols = directory / "dSYMs"
    symbols.mkdir(parents=True)
    contents = app / "Contents"
    contents.mkdir(parents=True)
    (contents / "Info.plist").write_bytes(
        plistlib.dumps(
            {
                "CFBundleExecutable": "Okou",
                "CFBundleIdentifier": "ai.okou.debug-symbols-test",
                "CFBundlePackageType": "APPL",
            }
        )
    )
    for index, (relative, bundle) in enumerate(
        (
            ("MacOS/Okou", "Okou.app.dSYM"),
            ("Helpers/computer-use-helper", "computer-use-helper.dSYM"),
        )
    ):
        source = directory / f"main-{index}.c"
        source.write_text(f"int main(void) {{ return {value + index}; }}\n")
        binary = contents / relative
        binary.parent.mkdir(parents=True)
        run("xcrun", "clang", "-arch", "arm64", "-g", source, "-o", binary)
        run("dsymutil", binary, "-o", symbols / bundle)
    return app, symbols


class DebugSymbolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory(prefix="okou-debug-symbols-test-")
        cls.addClassCleanup(cls.fixtures.cleanup)
        cls.root = Path(cls.fixtures.name)
        cls.base_app, cls.base_symbols = make_app(cls.root / "base", 0)
        cls.other_app, _ = make_app(cls.root / "other", 1)
        cls.archive = cls.root / "Okou.zip"
        # Signing changes code-signature bytes, but must preserve LC_UUID.
        run("codesign", "--force", "--sign", "-", cls.base_app)
        run("ditto", "-c", "-k", "--keepParent", cls.base_app, cls.archive)
        cls.dmg = cls.root / "Okou.dmg"
        cls.other_dmg = cls.root / "Other.dmg"
        for app, dmg in ((cls.base_app, cls.dmg), (cls.other_app, cls.other_dmg)):
            staging = cls.root / f"image-{dmg.stem}"
            staging.mkdir()
            run("ditto", app, staging / "Okou.app")
            run("hdiutil", "create", "-format", "UDZO", "-srcfolder", staging, dmg)
        cls.other_archive = cls.root / "Other.zip"
        run("ditto", "-c", "-k", "--keepParent", cls.other_app, cls.other_archive)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="okou-symbol-case-")
        self.addCleanup(self.directory.cleanup)
        self.case = Path(self.directory.name)
        self.app = self.case / "Okou.app"
        self.symbols = self.case / "dSYMs"
        shutil.copytree(self.base_app, self.app)
        shutil.copytree(self.base_symbols, self.symbols)
        self.bin = self.case / "bin"
        self.bin.mkdir()
        self.log = self.case / "sentry-calls.jsonl"
        # Sentry is the external service boundary; native tooling remains real.
        cli = self.bin / "sentry-cli"
        cli.write_text(
            f"#!{sys.executable}\n"
            + """
import json
import os
import sys
with open(os.environ["SENTRY_TEST_CALLS"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("SENTRY_TEST_FAILURE") == sys.argv[2]:
    sys.exit(23)
"""
        )
        cli.chmod(0o755)

    def command(self, *args, success=True, **environment):
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{self.bin}:{env['PATH']}",
                "SENTRY_TEST_CALLS": str(self.log),
                "SENTRY_AUTH_TOKEN": "test-token-kept-out-of-arguments",
                "SENTRY_ORG": "test-org",
                "SENTRY_PROJECT": "desktop",
            }
        )
        env.update(environment)
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--app",
                str(self.app),
                "--symbols",
                str(self.symbols),
                *map(str, args),
            ],
            check=False,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_signed_app_and_both_distribution_packages_match(self):
        self.command("--zip", self.archive, "--dmg", self.dmg)

    def test_missing_symbols_stop_upload(self):
        shutil.rmtree(self.symbols / "Okou.app.dSYM")
        self.command("--upload", success=False)
        self.assertFalse(self.log.exists())

    def test_helper_from_another_build_stops_upload(self):
        shutil.copyfile(
            self.other_app / "Contents/Helpers/computer-use-helper",
            self.app / "Contents/Helpers/computer-use-helper",
        )
        self.command("--upload", success=False)
        self.assertFalse(self.log.exists())

    def test_dsym_from_another_build_stops_upload(self):
        dwarf = Path("Okou.app.dSYM/Contents/Resources/DWARF/Okou")
        shutil.copyfile(self.other_app.parent / "dSYMs" / dwarf, self.symbols / dwarf)
        self.command("--upload", success=False)
        self.assertFalse(self.log.exists())

    def test_linked_symbols_are_rejected(self):
        bundle = self.symbols / "Okou.app.dSYM"
        shutil.rmtree(bundle)
        bundle.symlink_to(self.base_symbols / bundle.name, target_is_directory=True)
        self.command("--upload", success=False)
        self.assertFalse(self.log.exists())

    def test_published_package_from_another_build_stops_upload(self):
        self.command("--zip", self.other_archive, "--upload", success=False)
        self.assertFalse(self.log.exists())

    def test_published_dmg_from_another_build_stops_upload(self):
        self.command("--dmg", self.other_dmg, "--upload", success=False)
        self.assertFalse(self.log.exists())

    def test_upload_requires_all_verified_ids_and_waits_for_processing(self):
        self.command("--upload")
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual(
            [call[:2] for call in calls],
            [
                ["debug-files", "check"],
                ["debug-files", "check"],
                ["debug-files", "upload"],
            ],
        )
        upload = calls[-1]
        self.assertIn("--require-all", upload)
        self.assertEqual(upload[upload.index("--wait-for") + 1], "600")
        expected = {
            run("dwarfdump", "--uuid", self.app / relative).stdout.split()[1].lower()
            for relative in (
                "Contents/MacOS/Okou",
                "Contents/Helpers/computer-use-helper",
            )
        }
        actual = {
            upload[index + 1] for index, arg in enumerate(upload) if arg == "--id"
        }
        self.assertEqual(len(actual), 2)
        self.assertEqual(actual, expected)
        self.assertNotIn("test-token-kept-out-of-arguments", " ".join(upload))
        self.assertNotIn("--include-sources", upload)

    def test_sentry_upload_and_processing_failure_fail_the_command(self):
        self.command("--upload", success=False, SENTRY_TEST_FAILURE="upload")


if __name__ == "__main__":
    unittest.main()
