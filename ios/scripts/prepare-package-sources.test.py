#!/usr/bin/env python3
"""Exercise locked source preparation with real Git repositories and clones."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("prepare-package-sources.py")


class PackageSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.root / "dependency.git"
        self.origin.mkdir()
        self.git("init", "--quiet", "--initial-branch=main", str(self.origin))
        self.git("-C", str(self.origin), "config", "user.name", "Package Source Test")
        self.git(
            "-C", str(self.origin), "config", "user.email", "package@example.invalid"
        )
        self.git("-C", str(self.origin), "config", "commit.gpgsign", "false")
        self.commit("locked")
        self.revision = self.git("-C", str(self.origin), "rev-parse", "HEAD").strip()
        self.commit("newer")
        self.build = self.root / "build"
        self.build.mkdir()
        self.resolved = self.root / "Package.resolved"
        self.pins = [
            {
                "identity": "dependency",
                "location": self.origin.as_uri(),
                "state": {"revision": self.revision, "version": "1.0.0"},
            }
        ]

    def git(self, *args, env=None):
        return subprocess.check_output(["git", *args], text=True, env=env)

    def commit(self, content):
        (self.origin / "source").write_text(content)
        self.git("-C", str(self.origin), "add", "source")
        self.git("-C", str(self.origin), "commit", "--quiet", "-m", content)

    def prepare(self):
        self.resolved.write_text(json.dumps({"pins": self.pins}))
        return subprocess.run(
            ["python3", str(SCRIPT), str(self.resolved), str(self.build)],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_system_git_clones_exact_locked_sources_without_the_upstream(self):
        before = json.dumps({"pins": self.pins})
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.resolved.read_text(), before)
        self.origin.rename(self.root / "offline")
        env = os.environ | {
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "include.path",
            "GIT_CONFIG_VALUE_0": str(self.build / "package-sources.gitconfig"),
        }
        for index, url in enumerate((self.origin.as_uri(), self.origin.as_uri()[:-4])):
            with self.subTest(url=url):
                clone = self.root / f"clone-{index}"
                self.git("clone", "--quiet", "--mirror", url, str(clone), env=env)
                self.assertEqual(
                    self.git("-C", str(clone), "rev-parse", "HEAD").strip(),
                    self.revision,
                )
                self.assertEqual(
                    self.git("-C", str(clone), "rev-list", "--count", "HEAD").strip(),
                    "1",
                )
                self.assertEqual(
                    self.git("-C", str(clone), "show", "1.0.0:source").strip(), "locked"
                )

    def test_failed_fetch_does_not_publish_a_partial_source_configuration(self):
        self.pins[0]["state"]["revision"] = "0" * 40
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.build / "package-sources.gitconfig").exists())


if __name__ == "__main__":
    unittest.main()
