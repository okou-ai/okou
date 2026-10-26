#!/usr/bin/env python3
"""Exercise the source-readiness command with an isolated GitHub CLI fixture."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("wait-for-package-sources.py")
SHA = "a" * 40


def producer(job_id=1, status="completed", conclusion="success", sha=SHA):
    return {
        "id": job_id,
        "name": "prepare-package-sources",
        "head_sha": sha,
        "status": status,
        "conclusion": conclusion,
    }


class ReadinessTests(unittest.TestCase):
    def invoke(self, snapshots, *, expired=False, wait_seconds=5):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "fixture.json").write_text(
                json.dumps({"snapshots": snapshots, "expired": expired})
            )
            gh = root / "gh"
            gh.write_text(
                """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['GITHUB_FIXTURE'])
fixture = json.loads((root / 'fixture.json').read_text())
endpoint = sys.argv[2]
if '/jobs?' in endpoint:
    progress = root / 'progress.json'
    index = json.loads(progress.read_text()) if progress.exists() else 0
    progress.write_text(json.dumps(index + 1))
    jobs = fixture['snapshots'][min(index, len(fixture['snapshots']) - 1)]
    if any(j['status'] == 'completed' and j['conclusion'] == 'success' for j in jobs):
        (root / 'producer-completed').write_text('success')
    print(json.dumps([{'jobs': jobs}]))
elif '/artifacts?' in endpoint:
    print(json.dumps([{'artifacts': [{
        'id': 2, 'name': 'ios-package-sources-' + os.environ['GITHUB_SHA'],
        'expired': fixture['expired']
    }]}]))
else:
    raise SystemExit('Unexpected GitHub request')
"""
            )
            gh.chmod(0o755)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--wait-seconds", str(wait_seconds)],
                env=os.environ
                | {
                    "PATH": str(root) + os.pathsep + os.environ["PATH"],
                    "GITHUB_FIXTURE": str(root),
                    "GH_TOKEN": "fixture-only",
                    "GITHUB_REPOSITORY": "fixture/repository",
                    "GITHUB_RUN_ID": "123",
                    "GITHUB_SHA": SHA,
                },
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0:
                self.assertTrue(
                    (root / "producer-completed").exists(),
                    "Consumer returned before the source producer completed",
                )
            return result

    def test_waits_for_producer_completion_even_when_artifact_exists(self):
        result = self.invoke(
            [
                [producer(status="in_progress", conclusion=None)],
                [producer()],
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("sources ready", result.stdout)

    def test_failed_producer_blocks_an_already_published_artifact(self):
        result = self.invoke([[producer(conclusion="failure")]])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not succeed: failure", result.stderr)

    def test_latest_failed_rerun_cannot_reuse_prior_success(self):
        result = self.invoke(
            [[producer(), producer(job_id=3, conclusion="cancelled")]]
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not succeed: cancelled", result.stderr)

    def test_downstream_only_rerun_accepts_the_prior_successful_producer(self):
        result = self.invoke([[producer(job_id=7)]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("job 7", result.stdout)

    def test_rejects_another_revision(self):
        result = self.invoke([[producer(sha="b" * 40)]])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("different revision", result.stderr)

    def test_expired_artifact_is_unusable(self):
        result = self.invoke([[producer()]], expired=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("artifact has expired", result.stderr)

    def test_unfinished_producer_cannot_pass_the_wait_deadline(self):
        result = self.invoke(
            [[producer(status="queued", conclusion=None)]], wait_seconds=0
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Timed out", result.stderr)


if __name__ == "__main__":
    unittest.main()
