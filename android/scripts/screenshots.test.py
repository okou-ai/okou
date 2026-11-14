#!/usr/bin/env python3
"""Exercise the public capture command with real Git/files/processes and fixture device output."""

import base64
import json
import os
from pathlib import Path
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib


COMMAND = Path(__file__).with_name("screenshots.py")


def pixel_png():
    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload)))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
            + chunk(b"IEND", b""))


class ScreenshotCommandTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        scripts = self.root / "android/scripts"
        scripts.mkdir(parents=True)
        shutil.copyfile(COMMAND, scripts / COMMAND.name)
        self.recipe = self.root / "android/screenshots/pr-fixture/run.sh"
        self.recipe.parent.mkdir(parents=True)
        (self.recipe.parent / "src").mkdir()
        (self.root / ".gitignore").write_text("/android/build/\n/android/app/build/\n")
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Fixture")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True).strip()

    def commit(self, recipe):
        self.recipe.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + recipe)
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def invoke(self, commit, script="android/screenshots/pr-fixture/run.sh"):
        return subprocess.run([sys.executable, "android/scripts/screenshots.py", "run",
                               "--commit", commit, "--driver", commit, "--script", script],
                              cwd=self.root, text=True, capture_output=True, timeout=10)

    def capture_recipe(self, payload=None, run_expression="os.environ['OKOU_SCREENSHOT_RUN']"):
        encoded = base64.b64encode(payload if payload is not None else pixel_png()).decode()
        return f"""python3 - <<'PY'
import base64,json,os
from pathlib import Path
p=Path('android/app/build/outputs/managed_device_android_test_additional_output/device/shot.png')
p.parent.mkdir(parents=True,exist_ok=True)
p.write_bytes(base64.b64decode('{encoded}'))
p.with_name('shot.png.json').write_text(json.dumps({{'runId':{run_expression},'width':1,'height':1,'api':35}}))
PY
python3 android/scripts/screenshots.py collect shot.png
"""

    def test_collects_declared_current_images_with_exact_source_and_index(self):
        commit = self.commit(self.capture_recipe())
        result = self.invoke(commit)
        self.assertEqual(0, result.returncode, result.stderr)
        output = self.root / "android/build/screenshots"
        run = json.loads((output / "run.json").read_text())
        self.assertEqual((commit, "success"), (run["commitSha"], run["status"]))
        images = json.loads((output / "screenshots.json").read_text())["images"]
        self.assertEqual("images/shot.png", images[0]["file"])
        self.assertEqual(pixel_png(), (output / images[0]["file"]).read_bytes())
        self.assertIn('src="images/shot.png"', (output / "index.html").read_text())

    def test_rejects_wrong_commit_dirty_source_and_escaped_or_missing_recipe(self):
        commit = self.commit("exit 0\n")
        self.assertNotEqual(0, self.invoke("0" * 40).returncode)
        for path in ("../outside.sh", "/tmp/outside.sh", "android/screenshots/missing.sh"):
            self.assertNotEqual(0, self.invoke(commit, path).returncode)
        (self.root / "uncommitted").write_text("not in target commit")
        self.assertIn("clean checkout", self.invoke(commit).stderr)

    def test_symlink_cannot_select_a_recipe_outside_the_screenshot_directory(self):
        commit = self.commit("exit 0\n")
        outside = self.root / "outside.sh"
        outside.write_text("exit 0\n")
        link = self.recipe.parent / "escape.sh"
        link.symlink_to(outside)
        self.git("add", ".")
        self.git("commit", "-qm", "escaped recipe")
        result = self.invoke(self.git("rev-parse", "HEAD"), str(link.relative_to(self.root)))
        self.assertIn("Path must be inside", result.stderr)

    def test_recipe_failure_retains_exit_status_and_log(self):
        commit = self.commit("echo capture-failed\nexit 7\n")
        result = self.invoke(commit)
        self.assertEqual(7, result.returncode)
        output = self.root / "android/build/screenshots"
        self.assertEqual("failed", json.loads((output / "run.json").read_text())["status"])
        self.assertIn("capture-failed", (output / "recipe.log").read_text())

    def test_empty_success_and_missing_expected_image_cannot_pass(self):
        commit = self.commit("exit 0\n")
        self.assertNotEqual(0, self.invoke(commit).returncode)
        commit = self.commit("python3 android/scripts/screenshots.py collect missing.png\n")
        self.assertIn("current capture", self.invoke(commit).stdout)

    def test_stale_and_truncated_device_outputs_cannot_pass(self):
        commit = self.commit(self.capture_recipe(run_expression="'earlier-run'"))
        self.assertNotEqual(0, self.invoke(commit).returncode)
        commit = self.commit(self.capture_recipe(payload=pixel_png()[:-4]))
        self.assertNotEqual(0, self.invoke(commit).returncode)

    def test_bundle_device_metadata_cannot_be_replaced_with_an_earlier_run(self):
        recipe = self.capture_recipe() + """python3 - <<'PY'
import json
from pathlib import Path
p=Path('android/build/screenshots/screenshots.json')
bundle=json.loads(p.read_text())
bundle['images'][0]['device']['runId']='earlier-run'
p.write_text(json.dumps(bundle))
PY
"""
        commit = self.commit(recipe)
        self.assertNotEqual(0, self.invoke(commit).returncode)
        record = json.loads((self.root / "android/build/screenshots/run.json").read_text())
        self.assertEqual("failed", record["status"])
        self.assertIn("device metadata", record["error"])

    def test_cancelling_the_runner_reaps_its_recipe_and_retains_failure_evidence(self):
        commit = self.commit("echo ready:$BASHPID\nexec python3 -c 'import signal; signal.pause()'\n")
        process = subprocess.Popen(
            [sys.executable, "android/scripts/screenshots.py", "run", "--commit", commit,
             "--driver", commit, "--script", "android/screenshots/pr-fixture/run.sh"],
            cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "Recipe never started")
            child = int(process.stdout.readline().strip().split(":")[1])
            process.send_signal(signal.SIGTERM)
            process.communicate(timeout=10)
            self.assertNotEqual(0, process.returncode)
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)
            output = self.root / "android/build/screenshots/run.json"
            self.assertEqual("failed", json.loads(output.read_text())["status"])
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)


if __name__ == "__main__":
    unittest.main()
