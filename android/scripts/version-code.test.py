"""Verify APK commit counts against real complete and shallow Git histories."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("version-code.sh")


class VersionCodeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.root.mkdir()
        self.git("init", "--initial-branch=main")
        self.script = self.root / "android/scripts/version-code.sh"
        self.script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, self.script)
        self.commit()

    def git(self, *arguments):
        return subprocess.check_output(["git", "-C", str(self.root), *arguments], text=True).strip()

    def commit(self):
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
                 "commit", "--allow-empty", "-m", "fixture")

    def code(self):
        return int(subprocess.check_output(["bash", str(self.script)], text=True))

    def test_same_commit_is_stable_and_new_commits_increase_the_code(self):
        self.assertEqual(self.code(), 1)
        self.assertEqual(self.code(), 1)
        self.commit()
        self.assertEqual(self.code(), 2)
        self.git("checkout", "-b", "feature")
        self.commit()
        self.git("checkout", "main")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
                 "merge", "--no-ff", "feature", "-m", "merge")
        self.assertEqual(self.code(), 4)

    def test_shallow_history_is_rejected_until_completed(self):
        self.commit()
        clone = Path(self.temp.name) / "shallow"
        subprocess.run(["git", "clone", "--depth=1", self.root.as_uri(), str(clone)], check=True, capture_output=True)
        script = clone / "android/scripts/version-code.sh"
        script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, script)
        result = subprocess.run(["bash", str(script)], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("complete Git history", result.stderr)
        subprocess.run(["git", "-C", str(clone), "fetch", "--unshallow"], check=True, capture_output=True)
        self.assertEqual(subprocess.check_output(["bash", str(script)], text=True).strip(), "2")


if __name__ == "__main__":
    unittest.main()
