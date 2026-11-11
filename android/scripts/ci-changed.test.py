"""Exercise change selection through real Git histories, including the whole merge group."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("ci-changed.sh")


class ChangeSelectionTest(unittest.TestCase):
    def test_native_shared_and_renamed_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

            def write(path):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("input")

            def commit():
                git("add", "--all")
                git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
                return git("rev-parse", "HEAD")

            def detect(base, event="merge_group", check=True):
                env = dict(os.environ, EVENT_NAME=event, MERGE_GROUP_BASE_SHA=base, PUSH_BEFORE_SHA=base)
                result = subprocess.run(["bash", str(SCRIPT)], cwd=root, env=env, text=True, capture_output=True)
                if check:
                    self.assertEqual(result.returncode, 0, result.stderr)
                return result

            git("init", "--quiet", "--initial-branch=main")
            git("config", "user.name", "Android CI Test")
            git("config", "user.email", "android-ci@example.invalid")
            write("unrelated.txt")
            base = commit()
            self.assertEqual(detect(base).stdout.strip(), "false")
            write("android/app/source.kt")
            first = commit()
            write("other.txt")
            commit()
            self.assertEqual(detect(base).stdout.strip(), "true")
            self.assertEqual(detect(first).stdout.strip(), "false")
            self.assertEqual(detect(base, "push").stdout.strip(), "true")
            git("mv", "android/app/source.kt", "moved.kt")
            commit()
            self.assertEqual(detect(first).stdout.strip(), "true")
            current = git("rev-parse", "HEAD")
            write("turbo/packages/ui/src/styles/globals.css")
            commit()
            self.assertEqual(detect(current).stdout.strip(), "true")
            current = git("rev-parse", "HEAD")
            write(".github/scripts/checks/android_launcher.py")
            commit()
            self.assertEqual(detect(current).stdout.strip(), "true")
            self.assertEqual(detect(base, "workflow_dispatch").stdout.strip(), "true")
            self.assertNotEqual(detect(base, "unsupported", check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
