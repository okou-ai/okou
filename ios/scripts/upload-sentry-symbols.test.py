#!/usr/bin/env python3
"""Exercise the release command with external tool and Sentry HTTP fixtures."""

import json
import os
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

SCRIPT = Path(__file__).with_name("upload-sentry-symbols.py")
APP_ID = "c59a5436-71eb-42f0-a7d1-3845ae276a48"
EXTENSION_ID = "243b8228-2502-4134-9d27-8f90da58c07e"
TOOL = """#!/usr/bin/env python3
import json, os, pathlib, sys, urllib.request
state = pathlib.Path(os.environ['SYMBOL_TEST_STATE'])
uuids = json.loads((state / 'uuids.json').read_text())
if pathlib.Path(sys.argv[0]).name == 'xcrun':
    path = pathlib.Path(sys.argv[3])
    identifier = uuids[path.name]
    print('UUID: ' + identifier + ' (arm64) ' + str(path))
else:
    (state / 'upload.json').write_text(json.dumps(sys.argv[1:]))
    failure = int(os.environ.get('SYMBOL_TEST_UPLOAD_EXIT', '0'))
    if failure:
        sys.exit(failure)
    fixtures = json.loads((state / 'symbols.json').read_text())
    symbols = []
    for dsym in pathlib.Path(sys.argv[-1]).glob('*.dSYM'):
        for dwarf in (dsym / 'Contents/Resources/DWARF').iterdir():
            fixture = fixtures[dwarf.name]
            assert dwarf.read_text() == fixture['content']
            symbols.append(fixture['symbol'])
    request = urllib.request.Request(os.environ['SENTRY_URL'] + '/fixture/upload',
        data=json.dumps(symbols).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['SENTRY_AUTH_TOKEN']})
    with urllib.request.urlopen(request, timeout=5) as response:
        uploaded = json.load(response)
    # Model the pinned CLI: --require-all only sees newly uploaded files.
    if '--require-all' in sys.argv and len(uploaded) != len(symbols):
        sys.exit('Some symbols could not be found!')
"""


class UploadSentrySymbolsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.archive = self.work / "Original.xcarchive"
        app = self.archive / "Products/Applications/Okou.app"
        self.symbols = []
        fixtures = {}
        # Fixed Sentry checksums are independent of the production digest calculation.
        for executable, dsym, identifier, checksum in (
            (
                app / "Okou",
                "Okou.app.dSYM",
                APP_ID,
                "d031e50b3398536d8eb21a14d97341e533907d4d",
            ),
            (
                app / "PlugIns/OkouNotificationService.appex/OkouNotificationService",
                "OkouNotificationService.appex.dSYM",
                EXTENSION_ID,
                "3a528eada452b8be6f88ecb2916899a066f27eb4",
            ),
        ):
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_bytes(b"executable fixture")
            dwarf = (
                self.archive
                / "dSYMs"
                / dsym
                / "Contents/Resources/DWARF"
                / executable.name
            )
            dwarf.parent.mkdir(parents=True)
            content = f"debug info for {executable.name}".encode()
            dwarf.write_bytes(content)
            symbol = {
                "debugId": identifier,
                "sha1": checksum,
                "data": {"features": ["debug", "symtab", "unwind"]},
            }
            self.symbols.append(symbol)
            fixtures[executable.name] = {"content": content.decode(), "symbol": symbol}
        self.identifiers = {
            "Okou": APP_ID,
            "Okou.app.dSYM": APP_ID,
            "OkouNotificationService": EXTENSION_ID,
            "OkouNotificationService.appex.dSYM": EXTENSION_ID,
        }
        (self.work / "uuids.json").write_text(json.dumps(self.identifiers))
        (self.work / "symbols.json").write_text(json.dumps(fixtures))
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
                    self.headers["Authorization"], "Bearer fixture-upload-token"
                )
                symbols = json.loads(
                    self.rfile.read(int(self.headers["Content-Length"]))
                )
                uploaded = [
                    symbol for symbol in symbols if symbol not in owner.remote_symbols
                ]
                owner.remote_symbols.extend(uploaded)
                self.respond(200, uploaded)

            def do_GET(self):
                url = urlsplit(self.path)
                owner.assertEqual(
                    url.path, "/api/0/projects/fixture-org/ios/files/dsyms/"
                )
                owner.assertEqual(
                    self.headers["Authorization"], "Bearer fixture-upload-token"
                )
                if owner.api_status != 200:
                    self.respond(owner.api_status, {"detail": "Sentry request failed"})
                    return
                query = parse_qs(url.query)
                identifier = query["debug_id"][0]
                records = owner.readback.get(
                    identifier,
                    [
                        symbol
                        for symbol in owner.remote_symbols
                        if symbol["debugId"] == identifier
                    ],
                )
                offset = int(query.get("cursor", ["0"])[0])
                end = offset + owner.page_size
                # The caller must retain its origin/project/filter when following a cursor.
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
        binaries = self.work / "bin"
        binaries.mkdir()
        for name in ("xcrun", "sentry-cli"):
            executable = binaries / name
            executable.write_text(TOOL)
            executable.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "SYMBOL_TEST_STATE": str(self.work),
            "SENTRY_AUTH_TOKEN": "fixture-upload-token",
            "SENTRY_ORG": "fixture-org",
            "SENTRY_PROJECT": "ios",
            "SENTRY_URL": f"http://127.0.0.1:{server.server_port}",
        }

    def upload(self, **environment):
        return subprocess.run(
            ["python3", str(SCRIPT), str(self.archive)],
            env={**self.environment, **environment},
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )

    def test_uploads_and_verifies_both_canonical_symbols(self):
        result = self.upload()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", result.stdout)
        self.assertCountEqual(self.remote_symbols, self.symbols)

    def test_reuses_existing_extension_while_uploading_new_app_symbols(self):
        self.remote_symbols.append(self.symbols[1])
        result = self.upload()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", result.stdout)

    def test_rerun_reuses_both_symbols(self):
        first = self.upload()
        self.assertEqual(first.returncode, 0, first.stderr)
        rerun = self.upload()
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertIn("Verified 2 canonical dSYM UUIDs in Sentry", rerun.stdout)

    def test_finds_exact_symbols_on_later_page(self):
        self.page_size = 1
        self.readback[EXTENSION_ID] = [
            {**self.symbols[1], "sha1": "0" * 40},
            self.symbols[1],
        ]
        result = self.upload()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_or_incorrect_remote_symbols_stop_publication(self):
        for records in (
            [],
            [{**self.symbols[1], "debugId": APP_ID}],
            [{**self.symbols[1], "sha1": "0" * 40}],
            [{**self.symbols[1], "data": {"features": ["symtab"]}}],
        ):
            with self.subTest(records=records):
                self.readback[EXTENSION_ID] = records
                result = self.upload()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Cannot verify Sentry dSYM", result.stderr)
                self.assertNotIn("Verified", result.stdout)

    def test_sentry_api_errors_stop_publication(self):
        for status in (401, 500):
            with self.subTest(status=status):
                self.api_status = status
                result = self.upload()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"HTTP Error {status}", result.stderr)
                self.assertNotIn("Verified", result.stdout)

    def test_mismatched_symbols_stop_before_upload(self):
        self.identifiers["OkouNotificationService.appex.dSYM"] = APP_ID
        (self.work / "uuids.json").write_text(json.dumps(self.identifiers))
        result = self.upload()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dSYM UUIDs do not match OkouNotificationService", result.stderr)
        self.assertFalse((self.work / "upload.json").exists())

    def test_failed_upload_stops_publication(self):
        result = self.upload(SYMBOL_TEST_UPLOAD_EXIT="19")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-zero exit status 19", result.stderr)
        self.assertFalse(self.remote_symbols)


if __name__ == "__main__":
    unittest.main()
