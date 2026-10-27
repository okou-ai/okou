#!/usr/bin/env python3
"""Exercise the cache seed boundary against real isolated filesystem contents."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("reset-oversized-compilation-cache.py")


class CompilationCacheResetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.cache = self.root / "okou-ios-ci/DerivedData/CompilationCache.noindex"

    def run_reset(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            env=os.environ | {"RUNNER_TEMP": str(self.root)},
            capture_output=True,
            text=True,
        )

    def populate_cache(self):
        self.cache.mkdir(parents=True)
        data = self.cache / "v9.data"
        with data.open("wb") as output:
            output.truncate(2 * 1024**3)
        return data

    def test_cache_at_limit_is_retained(self):
        data = self.populate_cache()
        result = self.run_reset()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(data.stat().st_size, 2 * 1024**3)

    def test_oversized_history_is_reset_without_removing_package_sources(self):
        self.populate_cache()
        (self.cache / "index").write_bytes(b"x")
        source = self.root / "okou-ios-ci/SourcePackages/package.swift"
        source.parent.mkdir(parents=True)
        source.write_text("locked package sources\n")
        result = self.run_reset()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.cache.exists())
        self.assertEqual(source.read_text(), "locked package sources\n")

    def test_cold_seed_does_not_require_an_inherited_cache(self):
        result = self.run_reset()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.cache.exists())

    def test_symlinked_cache_cannot_delete_another_directory(self):
        target = self.root / "other-cache"
        target.mkdir()
        sentinel = target / "data"
        sentinel.write_text("another owner\n")
        self.cache.parent.mkdir(parents=True)
        self.cache.symlink_to(target, target_is_directory=True)
        result = self.run_reset()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.cache.is_symlink())
        self.assertEqual(sentinel.read_text(), "another owner\n")


if __name__ == "__main__":
    unittest.main()
