"""Exercise the production diagnostic command against real filesystem fixtures."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "rootfs-usage.py"


class RootfsUsageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory()
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name)
        (self.root / "tmp").mkdir()
        (self.root / "home/user/.pi").mkdir(parents=True)

    def sample(self):
        result = subprocess.run(
            ["python3", "-I", "-B", str(SCRIPT), "--root", str(self.root)],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        self.assertEqual(result.stderr, "")
        self.assertLess(len(result.stdout.encode()), 4096)
        self.assertTrue(result.stdout.endswith("done\n"), result.stdout)
        return result.stdout

    def observation(self, output, path):
        lines = [line for line in output.splitlines() if line.startswith(path + " ")]
        self.assertTrue(lines, output)
        return dict(item.split("=", 1) for item in lines[-1].split()[1:])

    def test_allocated_bytes_hard_links_and_metadata_privacy(self):
        directory = self.root / "tmp"
        payload = directory / "private-project-name"
        payload.write_bytes(b"private-content" * 1024)
        os.link(payload, directory / "private-hard-link")
        sparse = directory / "private-sparse"
        with sparse.open("wb") as handle:
            handle.truncate(128 * 1024 * 1024)
        os.symlink(payload, directory / "private-symlink")
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        (Path(outside.name) / "private-external").write_bytes(b"x" * 65536)
        os.symlink(outside.name, directory / "private-directory-link")
        expected = sum(
            path.lstat().st_blocks * 512
            for path in (
                directory,
                payload,
                sparse,
                directory / "private-symlink",
                directory / "private-directory-link",
            )
        )
        before = payload.read_bytes()
        output = self.sample()
        observed = self.observation(output, "/tmp")
        self.assertEqual(observed["status"], "complete")
        self.assertEqual(int(observed["bytes"]), expected)
        self.assertNotIn("private-", output)
        self.assertEqual(payload.read_bytes(), before)
        self.assertEqual(sparse.stat().st_size, 128 * 1024 * 1024)

    def test_large_tmp_keeps_partial_bytes_and_pi_still_gets_observed(self):
        allocated = []
        for index in range(6000):
            payload = self.root / "tmp" / str(index)
            # Every entry needs payload: directory blocks can be zero and
            # traversal order is unspecified.
            payload.write_bytes(b"x" * 4096)
            allocated.append(payload.stat().st_blocks * 512)
        minimum_allocated = min(allocated)
        self.assertGreater(minimum_allocated, 0)
        (self.root / "home/user/.pi/session").write_bytes(b"history" * 1024)
        output = self.sample()
        observed = self.observation(output, "/tmp")
        self.assertEqual(observed["status"], "partial")
        self.assertIn(observed["reason"], ("entries", "time"))
        entries = int(observed["entries"])
        self.assertGreater(entries, 0)
        self.assertLessEqual(entries, 4096)
        self.assertGreaterEqual(int(observed["bytes"]), entries * minimum_allocated)
        self.assertEqual(
            self.observation(output, "/home/user/.pi")["status"], "complete"
        )

    def test_workspace_and_virtual_trees_are_excluded_even_on_the_same_device(self):
        before = self.sample()
        home_bytes = self.observation(before, "/home/user")["bytes"]
        for location in ("home/user/workspace", "proc", "sys", "dev", "run"):
            target = self.root / location
            target.mkdir()
            (target / "private-workload").write_bytes(b"x" * (1024 * 1024))
        output = self.sample()
        self.assertEqual(self.observation(output, "/home/user")["bytes"], home_bytes)
        self.assertNotIn("private-workload", output)
        self.assertLess(int(self.observation(output, "/")["bytes"]), 1024 * 1024)

    def test_symlink_targets_and_ancestors_are_not_traversed(self):
        outside = self.root / "outside"
        (outside / "user/.pi").mkdir(parents=True)
        (outside / "user/.pi/private-history").write_bytes(b"x" * 65536)
        pi = self.root / "home/user/.pi"
        pi.rmdir()
        os.symlink(outside / "user/.pi", pi)
        output = self.sample()
        self.assertEqual(
            self.observation(output, "/home/user/.pi")["status"],
            "symlink_or_non_directory",
        )
        pi.unlink()
        (self.root / "home/user").rmdir()
        (self.root / "home").rmdir()
        os.symlink(outside, self.root / "home")
        output = self.sample()
        self.assertEqual(
            self.observation(output, "/home/user/.pi")["status"],
            "symlink_or_non_directory",
        )
        self.assertNotIn("private-history", output)

    def test_depth_limit_is_explicit_and_missing_is_not_measured_zero(self):
        target = self.root / "tmp"
        for _ in range(40):
            target = target / "deep"
            target.mkdir()
        (target / "unvisited").write_bytes(b"x" * 65536)
        output = self.sample()
        observed = self.observation(output, "/tmp")
        self.assertEqual(observed["status"], "partial")
        self.assertIn("depth", observed["reason"])
        missing = self.observation(output, "/home/user/.cargo")
        self.assertEqual(missing, {"status": "missing"})

    def test_total_entry_budget_bounds_overlapping_observations(self):
        for location in ("tmp", "home/user/.pi", "home/user/.cache", "var", "usr"):
            target = self.root / location
            target.mkdir(parents=True, exist_ok=True)
            for index in range(6000):
                (target / str(index)).touch()
        output = self.sample()
        counts = [
            int(item.removeprefix("entries="))
            for item in output.split()
            if item.startswith("entries=")
        ]
        self.assertLessEqual(sum(counts), 32768)
        self.assertIn("status=partial", output)

    def test_device_boundary_excludes_a_real_mounted_filesystem(self):
        if not shutil.which("unshare") or not shutil.which("mount"):
            self.skipTest("requires Linux mount namespace tools")
        namespace = ["unshare", "--user", "--map-root-user", "--mount"]
        probe = subprocess.run(
            namespace + ["true"], capture_output=True, text=True, timeout=5, check=False
        )
        if probe.returncode != 0:
            if (
                "Operation not permitted" in probe.stderr
                or "Permission denied" in probe.stderr
            ):
                self.skipTest(
                    "requires permission to create an isolated mount namespace"
                )
            self.fail(probe.stderr)
        result = subprocess.run(
            namespace
            + [
                "sh",
                "-eu",
                "-c",
                """mount -t tmpfs -o size=8m tmpfs "$1/tmp"
python3 -I -B "$2" --root "$1"
""",
                "rootfs-mount-fixture",
                str(self.root),
                str(SCRIPT),
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        self.assertEqual(
            self.observation(result.stdout, "/tmp"), {"status": "other_filesystem"}
        )
        self.assertEqual(
            self.observation(result.stdout, "/home/user/.pi")["status"], "complete"
        )


if __name__ == "__main__":
    unittest.main()
