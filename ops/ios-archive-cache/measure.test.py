#!/usr/bin/env python3
"""Exercise cache restore through its CLI with real files, links and native tar."""

import io
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


class CacheRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.work = self.root / "okou-ios-promotion"
        self.work.mkdir()
        self.seed = self.root / "ios-archive-cache-seed"
        self.seed.mkdir()
        output = self.root / "ios-archive-cache-measurement"
        output.mkdir()
        for directory in [self.seed, output]:
            (directory / "identity.json").write_text('{"source":"same-run"}\n')
        self.env = os.environ | {
            "RUNNER_TEMP": str(self.root),
            "IOS_ARCHIVE_CACHE_MODE": "warm",
            "IOS_ARCHIVE_CACHE_LABEL": "warm-one",
        }

    def restore(self):
        return subprocess.run(
            ["python3", str(Path(__file__).with_name("measure.py")), "restore"],
            check=False,
            env=self.env,
            capture_output=True,
            text=True,
        )

    def test_restores_only_cache_data_and_relative_links(self):
        with tarfile.open(self.seed / "cache.tar", "w") as archive:
            for path in [
                "SourcePackages/locked.swift",
                "DerivedData/CompilationCache.noindex/object",
            ]:
                entry = tarfile.TarInfo(path)
                entry.size = 6
                archive.addfile(entry, io.BytesIO(b"cached"))
            link = tarfile.TarInfo("SourcePackages/linked.swift")
            link.type = tarfile.SYMTYPE
            link.linkname = "locked.swift"
            archive.addfile(link)
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.work / "SourcePackages/linked.swift").read_bytes(), b"cached"
        )
        self.assertEqual(
            (self.work / "DerivedData/CompilationCache.noindex/object").read_bytes(),
            b"cached",
        )

    def test_rejects_an_escape_before_extracting_any_cache_entry(self):
        with tarfile.open(self.seed / "cache.tar", "w") as archive:
            valid = tarfile.TarInfo("SourcePackages/locked.swift")
            valid.size = 6
            archive.addfile(valid, io.BytesIO(b"cached"))
            escape = tarfile.TarInfo("SourcePackages/escape")
            escape.type = tarfile.SYMTYPE
            escape.linkname = "../../outside"
            archive.addfile(escape)
        result = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Cache link escapes its namespace", result.stderr)
        self.assertEqual(list(self.work.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
