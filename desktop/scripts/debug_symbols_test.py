#!/usr/bin/env python3
"""Exercise the symbol command with real Mach-O files, dSYMs and packages."""

import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

SCRIPT = Path(__file__).with_name("debug_symbols.py")
BUILD = Path(__file__).with_name("build.py")


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
    resources = contents / "Resources"
    (resources / "Clerk_ClerkKit.bundle").mkdir(parents=True)
    (resources / "desktop-runtime-config.json").write_text(
        json.dumps(
            {
                "product": "okou",
                "platformUrl": "https://app.okou.ai",
                "clerkPublishableKey": "pk_live_fixture",
            }
        )
    )
    (contents / "Info.plist").write_bytes(
        plistlib.dumps(
            {
                "CFBundleExecutable": "Okou",
                "CFBundleIdentifier": "ai.okou.desktop",
                "CFBundleName": "Okou",
                "CFBundleDisplayName": "Okou",
                "CFBundlePackageType": "APPL",
                "CFBundleURLTypes": [{"CFBundleURLSchemes": ["ai.okou.desktop"]}],
                "CFBundleShortVersionString": "1.2.3",
                "CFBundleVersion": "1.2.3",
                "LSMinimumSystemVersion": "14.0",
                "OkouSentryDSN": "https://example.invalid/1",
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
        object_file = source.with_suffix(".o")
        binary = contents / relative
        binary.parent.mkdir(parents=True)
        run("xcrun", "clang", "-arch", "arm64", "-g", "-c", source, "-o", object_file)
        run("xcrun", "clang", "-arch", "arm64", object_file, "-o", binary)
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
        # Signing changes code-signature bytes, but must preserve LC_UUID.
        run("codesign", "--force", "--sign", "-", cls.base_app)
        packages = cls.root / "packages"
        # The real build CLI supplies the ZIP/DMG used by the symbol tests,
        # covering default distribution packaging without a second fixture set.
        run(
            sys.executable,
            BUILD,
            "--app",
            cls.base_app,
            "--version",
            "1.2.3",
            "--verify-only",
            "--package",
            "--output",
            packages,
        )
        cls.archive = packages / "Okou-darwin-arm64-1.2.3.zip"
        cls.dmg = cls.archive.with_suffix(".dmg")
        cls.other_dmg = cls.root / "Other.dmg"
        staging = cls.root / "image-other"
        staging.mkdir()
        run("ditto", cls.other_app, staging / "Okou.app")
        run(
            "hdiutil", "create", "-format", "UDZO", "-srcfolder", staging, cls.other_dmg
        )
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
from pathlib import Path
from urllib.request import Request, urlopen
with open(os.environ["SENTRY_TEST_CALLS"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("SENTRY_TEST_FAILURE") == sys.argv[2]:
    sys.exit(23)
if sys.argv[2] == "upload":
    fixtures = json.loads(Path(os.environ["SENTRY_TEST_SYMBOLS"]).read_text())
    required = {
        sys.argv[index + 1] for index, arg in enumerate(sys.argv) if arg == "--id"
    }
    symbols = [
        fixtures[Path(arg).name] for arg in sys.argv[3:]
        if Path(arg).is_file()
        and (not required or fixtures[Path(arg).name]["debugId"] in required)
    ]
    request = Request(
        os.environ["SENTRY_URL"] + "/fixture/upload",
        data=json.dumps(symbols).encode(),
        headers={"Authorization": "Bearer " + os.environ["SENTRY_AUTH_TOKEN"]},
    )
    with urlopen(request, timeout=5) as response:
        uploaded = json.load(response)
    # Model 2.58.5: --require-all checks only this invocation's processed files.
    if "--require-all" in sys.argv and required - {s["debugId"] for s in uploaded}:
        sys.exit("Some symbols could not be found!")
"""
        )
        cli.chmod(0o755)
        self.expected_symbols = {}
        for dwarf in self.symbols.glob("*/Contents/Resources/DWARF/*"):
            self.expected_symbols[dwarf.name] = {
                "debugId": run("dwarfdump", "--uuid", dwarf).stdout.split()[1].lower(),
                # Use an independent tool to calculate the fixture's expected checksum.
                "sha1": run("shasum", "-a", "1", dwarf).stdout.split()[0],
                "cpuName": "arm64",
                "data": {"features": ["debug", "symtab", "unwind"]},
            }
        (self.case / "sentry-symbols.json").write_text(
            json.dumps(self.expected_symbols)
        )
        self.remote_symbols = []
        self.readback = {}
        self.api_status = 200
        self.page_size = 100
        owner = self

        class SentryHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, data, **headers):
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())

            def do_POST(self):
                owner.assertEqual(self.path, "/fixture/upload")
                owner.assertEqual(
                    self.headers["Authorization"],
                    "Bearer test-token-kept-out-of-arguments",
                )
                symbols = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                uploaded = [s for s in symbols if s not in owner.remote_symbols]
                owner.remote_symbols.extend(uploaded)
                self.respond(200, uploaded)

            def do_GET(self):
                url = urlsplit(self.path)
                owner.assertEqual(
                    url.path, "/api/0/projects/test-org/desktop/files/dsyms/"
                )
                owner.assertEqual(
                    self.headers["Authorization"],
                    "Bearer test-token-kept-out-of-arguments",
                )
                if owner.api_status != 200:
                    self.respond(
                        owner.api_status,
                        {"detail": "Sentry request failed"},
                        Location="https://untrusted.invalid/wrong-project/",
                    )
                    return
                query = parse_qs(url.query)
                owner.assertEqual(query["file_formats"], ["macho"])
                identifier = query["debug_id"][0]
                records = owner.readback.get(
                    identifier,
                    [s for s in owner.remote_symbols if s["debugId"] == identifier],
                )
                offset = int(query.get("cursor", ["0"])[0])
                end = offset + owner.page_size
                # Only the cursor may be reused from an untrusted pagination URL.
                next_url = "https://untrusted.invalid/wrong-project/?" + urlencode(
                    {"cursor": end}
                )
                more = "true" if end < len(records) else "false"
                self.respond(
                    200,
                    records[offset:end],
                    Link=f'<{next_url}>; rel="next"; results="{more}"',
                )

        server = ThreadingHTTPServer(("127.0.0.1", 0), SentryHandler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.sentry_url = f"http://127.0.0.1:{server.server_port}"

    def command(self, *args, success=True, **environment):
        env = dict(os.environ)
        env.update(
            {
                "PATH": f"{self.bin}:{env['PATH']}",
                "SENTRY_TEST_CALLS": str(self.log),
                "SENTRY_TEST_SYMBOLS": str(self.case / "sentry-symbols.json"),
                "SENTRY_AUTH_TOKEN": "test-token-kept-out-of-arguments",
                "SENTRY_ORG": "test-org",
                "SENTRY_PROJECT": "desktop",
                "SENTRY_URL": self.sentry_url,
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
            timeout=60,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_signed_app_and_both_distribution_packages_match(self):
        self.command("--zip", self.archive, "--dmg", self.dmg)
        self.assert_dmg_detached(self.dmg)

    def test_zip_only_packaging_preserves_the_verified_app(self):
        output = self.case / "packages"
        run(
            sys.executable,
            BUILD,
            "--app",
            self.app,
            "--version",
            "1.2.3",
            "--verify-only",
            "--package",
            "zip",
            "--output",
            output,
        )
        archive = output / "Okou-darwin-arm64-1.2.3.zip"
        self.assertEqual(list(output.iterdir()), [archive])
        self.command("--zip", archive)

    def assert_dmg_detached(self, dmg):
        output = run("hdiutil", "info", "-plist").stdout
        images = plistlib.loads(output.encode())["images"]
        self.assertNotIn(
            dmg.resolve(),
            [Path(image["image-path"]).resolve() for image in images],
        )

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
        result = self.command("--dmg", self.other_dmg, "--upload", success=False)
        self.assertRegex(
            result.stderr, r"ValueError: Binary/dSYM UUID mismatch: [^\n]+\n\Z"
        )
        self.assertFalse(self.log.exists())
        self.assert_dmg_detached(self.other_dmg)

    def test_upload_verifies_all_symbols_and_waits_for_processing(self):
        result = self.command("--upload")
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", result.stdout)
        self.assertCountEqual(self.remote_symbols, self.expected_symbols.values())
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        upload = calls[-1]
        self.assertEqual(upload[upload.index("--wait-for") + 1], "600")
        self.assertNotIn("test-token-kept-out-of-arguments", " ".join(upload))
        self.assertNotIn("--include-sources", upload)

    def test_reuses_existing_app_while_uploading_helper_symbols(self):
        self.remote_symbols.append(self.expected_symbols["Okou"])
        result = self.command("--upload")
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", result.stdout)
        self.assertCountEqual(self.remote_symbols, self.expected_symbols.values())

    def test_rerun_verifies_both_existing_symbols(self):
        self.command("--upload")
        rerun = self.command("--upload")
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", rerun.stdout)
        self.assertCountEqual(self.remote_symbols, self.expected_symbols.values())

    def test_finds_exact_symbols_on_later_page(self):
        self.page_size = 1
        symbol = self.expected_symbols["computer-use-helper"]
        self.readback[symbol["debugId"]] = [{**symbol, "sha1": "0" * 40}, symbol]
        result = self.command("--upload")
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", result.stdout)

    def test_missing_or_incorrect_remote_symbols_fail_the_command(self):
        symbol = self.expected_symbols["computer-use-helper"]
        for records in (
            [],
            [{**symbol, "debugId": self.expected_symbols["Okou"]["debugId"]}],
            [{**symbol, "sha1": "0" * 40}],
            [{**symbol, "cpuName": "x86_64"}],
            [{**symbol, "data": {"features": ["symtab"]}}],
        ):
            with self.subTest(records=records):
                self.readback[symbol["debugId"]] = records
                result = self.command("--upload", success=False)
                self.assertIn("Cannot verify Sentry dSYM", result.stderr)

    def test_sentry_readback_errors_fail_the_command(self):
        for status in (302, 401, 500):
            with self.subTest(status=status):
                self.api_status = status
                result = self.command("--upload", success=False)
                self.assertIn(f"HTTP Error {status}", result.stderr)

    def test_sentry_upload_and_processing_failure_fail_the_command(self):
        for stage in ("check", "upload"):
            with self.subTest(stage=stage):
                result = self.command(
                    "--upload", success=False, SENTRY_TEST_FAILURE=stage
                )
                self.assertIn("non-zero exit status 23", result.stderr)


if __name__ == "__main__":
    unittest.main()
