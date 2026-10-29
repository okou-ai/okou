#!/usr/bin/env python3
"""Exercise symbol upload through the real CLI entry with external tool fixtures."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("upload-sentry-symbols.py")
APP_ID = "c59a5436-71eb-42f0-a7d1-3845ae276a48"
EXTENSION_ID = "243b8228-2502-4134-9d27-8f90da58c07e"
TOOL = """#!/usr/bin/env python3
import json, os, pathlib, sys
state = pathlib.Path(os.environ['SYMBOL_TEST_STATE'])
if pathlib.Path(sys.argv[0]).name == 'xcrun':
    assert sys.argv[1:3] == ['dwarfdump', '--uuid']
    path = pathlib.Path(sys.argv[3])
    identifier = json.loads((state / 'uuids.json').read_text())[path.name]
    print('UUID: ' + identifier + ' (arm64) ' + str(path))
else:
    assert os.environ['SENTRY_AUTH_TOKEN'] == 'fixture-upload-token'
    (state / 'upload.json').write_text(json.dumps({
        'arguments': sys.argv[1:], 'org': os.environ['SENTRY_ORG'],
        'project': os.environ['SENTRY_PROJECT']}))
    sys.exit(int(os.environ.get('SYMBOL_TEST_UPLOAD_EXIT', '0')))
"""


class UploadSentrySymbolsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.archive = self.work / "Original.xcarchive"
        app = self.archive / "Products/Applications/Okou.app"
        for path in (
            app / "Okou",
            app / "PlugIns/OkouNotificationService.appex/OkouNotificationService",
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"executable fixture")
        for name in ("Okou.app.dSYM", "OkouNotificationService.appex.dSYM"):
            (self.archive / "dSYMs" / name).mkdir(parents=True)
        self.identifiers = {
            "Okou": APP_ID,
            "Okou.app.dSYM": APP_ID,
            "OkouNotificationService": EXTENSION_ID,
            "OkouNotificationService.appex.dSYM": EXTENSION_ID,
        }
        (self.work / "uuids.json").write_text(json.dumps(self.identifiers))
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
        }

    def upload(self, **environment):
        return subprocess.run(
            ["python3", str(SCRIPT), str(self.archive)],
            env={**self.environment, **environment},
            text=True,
            capture_output=True,
            timeout=10,
        )

    def test_uploads_both_matching_symbols_and_waits_for_processing(self):
        result = self.upload()
        self.assertEqual(result.returncode, 0, result.stderr)
        upload = json.loads((self.work / "upload.json").read_text())
        self.assertEqual(upload["org"], "fixture-org")
        self.assertEqual(upload["project"], "ios")
        self.assertEqual(
            upload["arguments"],
            [
                "debug-files",
                "upload",
                "--type",
                "dsym",
                "--require-all",
                "--wait-for",
                "300",
                "--id",
                EXTENSION_ID,
                "--id",
                APP_ID,
                str(self.archive / "dSYMs"),
            ],
        )

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
        self.assertTrue((self.work / "upload.json").is_file())


if __name__ == "__main__":
    unittest.main()
