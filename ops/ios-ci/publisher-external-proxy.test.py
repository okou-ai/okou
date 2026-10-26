#!/usr/bin/env python3
"""Verify the replay's external storage fence before using real credentials."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


PROXY = Path(__file__).with_name("publisher-external-proxy.py")
PREFIX = "okou-ios/experiments/publisher-provenance/123/1/1-A1/"
KEY = "okou-ios/tests/fixture/evidence.json"


class FenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proxy = self.root / "aws"
        shutil.copyfile(PROXY, self.proxy)
        self.proxy.chmod(0o755)
        real = self.root / "fixture-aws"
        real.write_text(
            """#!/usr/bin/env python3
import os, pathlib, shutil, sys
args=sys.argv[1:]
destination=pathlib.Path(os.environ['FIXTURE_STORE'])/args[args.index('--key')+1]
destination.parent.mkdir(parents=True,exist_ok=True)
shutil.copyfile(args[args.index('--body')+1],destination)
print('{}')
"""
        )
        real.chmod(0o755)
        (self.root / "keys.json").write_text(json.dumps([KEY]))
        self.source = self.root / "evidence.json"
        self.source.write_text('{"verified": true}\n')
        self.env = os.environ | {
            "PUBLISHER_REPLAY_PREFIX": PREFIX,
            "PUBLISHER_REPLAY_KEYS": str(self.root / "keys.json"),
            "PUBLISHER_REAL_AWS": str(real),
            "PUBLISHER_REPLAY_LOG": str(self.root / "calls.jsonl"),
            "FIXTURE_STORE": str(self.root / "store"),
        }

    def invoke(self, key=KEY):
        return subprocess.run(
            [str(self.proxy), "s3api", "put-object", "--key", key,
             "--body", str(self.source), "--if-none-match", "*"],
            env=self.env, capture_output=True, text=True, check=False,
        )

    def test_object_bytes_are_published_only_inside_the_owned_namespace(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.root / "store" / PREFIX / KEY).read_bytes(), self.source.read_bytes()
        )
        self.assertFalse((self.root / "store" / KEY).exists())

    def test_an_unlisted_object_cannot_be_written(self):
        result = self.invoke("okou-ios/inputs/unrelated/ready.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "store").exists())

    def test_a_canonical_namespace_cannot_be_selected_as_the_sandbox(self):
        self.env["PUBLISHER_REPLAY_PREFIX"] = "okou-ios/inputs/"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "store").exists())


if __name__ == "__main__":
    unittest.main()
