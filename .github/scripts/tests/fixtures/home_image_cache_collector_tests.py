"""Exercise the production collector process against real cache allocation."""

import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / "ansible/files/vm0-monitoring-home-image-cache-collect.py"
PREFIX = "vm0_home_image_cache_"


def allocated_tree(path):
    """Independent lstat oracle: count hard-linked inodes once, never follow links."""
    seen = set()
    pending = [path]
    allocated = 0
    while pending:
        current = pending.pop()
        metadata = current.lstat()
        identity = (metadata.st_dev, metadata.st_ino)
        if identity in seen:
            continue
        seen.add(identity)
        allocated += metadata.st_blocks * 512
        if stat.S_ISDIR(metadata.st_mode):
            pending.extend(current.iterdir())
    return allocated


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / "home-image-cache"
        self.cache.mkdir()
        self.output = self.root / "textfile"
        self.output.mkdir()

    def entry(self, index=1):
        path = self.cache / f"{index:064x}"
        path.mkdir()
        return path

    def run_collector(self, cache=None, output=None):
        return subprocess.run(
            ["python3", "-I", "-B", str(SCRIPT)],
            env={
                **os.environ,
                "OKOU_HOME_IMAGE_CACHE_DIR": str(cache or self.cache),
                "OKOU_MONITORING_TEXTFILE_DIR": str(output or self.output),
            },
            capture_output=True,
            timeout=20,
            check=False,
        )

    def collect(self, cache=None):
        result = self.run_collector(cache)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
        self.assertEqual(
            list(self.output.iterdir()), [self.output / "home-image-cache.prom"]
        )
        return (self.output / "home-image-cache.prom").read_text()

    def metric(self, text, name):
        return int(
            next(
                line.split()[1]
                for line in text.splitlines()
                if line.startswith(PREFIX + name + " ")
            )
        )

    def unavailable(self, text):
        self.assertEqual(self.metric(text, "snapshot_available"), 0)
        self.assertEqual(self.metric(text, "measurements_complete"), 0)
        self.assertNotIn(PREFIX + "allocated_bytes ", text)
        self.assertNotIn(PREFIX + "filesystem_total_bytes ", text)

    def test_measured_empty_and_filesystem_counters(self):
        text = self.collect()
        self.assertEqual(self.metric(text, "snapshot_available"), 1)
        self.assertEqual(self.metric(text, "measurements_complete"), 1)
        self.assertEqual(self.metric(text, "entries"), 0)
        self.assertEqual(self.metric(text, "allocated_bytes"), 0)
        fs = os.statvfs(self.cache)
        self.assertEqual(
            self.metric(text, "filesystem_total_bytes"), fs.f_blocks * fs.f_frsize
        )
        self.assertEqual(self.metric(text, "filesystem_total_inodes"), fs.f_files)
        self.assertLessEqual(
            self.metric(text, "filesystem_available_bytes"),
            self.metric(text, "filesystem_total_bytes"),
        )
        self.assertLessEqual(
            self.metric(text, "filesystem_available_inodes"), fs.f_files
        )
        self.assertLessEqual(
            abs(self.metric(text, "collection_timestamp_seconds") - time.time()), 2
        )

    def test_sparse_generations_staging_and_metadata_count_physical_allocation(self):
        entry = self.entry()
        image = entry / "image-00000000-0000-4000-8000-000000000001.ext4"
        with image.open("wb") as stream:
            stream.truncate(24 * 1024**3)
            stream.write(b"x" * 4096)
        (entry / "image-00000000-0000-4000-8000-000000000002.ext4").write_bytes(
            b"retained" * 1024
        )
        staging = entry / "staging"
        staging.mkdir()
        (staging / "image-00000000-0000-4000-8000-000000000003.ext4.tmp").write_bytes(
            b"staging" * 1024
        )
        (entry / "metadata.json").write_text('{"workingDir":"private-project"}')
        (entry / "metadata.json.tmp.synthetic").write_bytes(b"temporary metadata")
        os.link(image, entry / "duplicate-hardlink")
        expected = allocated_tree(entry)
        self.assertLess(expected, image.stat().st_size)
        text = self.collect()
        self.assertEqual(self.metric(text, "entries"), 1)
        self.assertEqual(self.metric(text, "allocated_bytes"), expected)
        self.assertIn(PREFIX + 'bucket_entries{bucket="lt_16MiB"} 1\n', text)
        self.assertIn(
            PREFIX + f'bucket_allocated_bytes{{bucket="lt_16MiB"}} {expected}\n', text
        )
        self.assertNotIn(entry.name, text)
        self.assertNotIn("private-project", text)

    def test_entry_names_symlinks_and_special_files_cannot_redirect_or_block(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "private-data").write_bytes(b"x" * 65536)
        (self.cache / "unknown-directory").mkdir()
        os.symlink(outside, self.cache / f"{2:064x}")
        (self.cache / f"{3:064x}").write_bytes(b"not an entry")
        entry = self.entry()
        os.symlink(outside, entry / "directory-link")
        os.symlink(outside / "private-data", entry / "file-link")
        os.mkfifo(entry / "pipe")
        text = self.collect()
        self.assertEqual(self.metric(text, "entries"), 1)
        self.assertEqual(self.metric(text, "allocated_bytes"), allocated_tree(entry))
        self.assertEqual(self.metric(text, "measurements_complete"), 1)
        self.assertNotIn("private-data", text)

    def test_allocated_size_selects_the_next_bucket_at_sixteen_mib(self):
        entry = self.entry()
        (entry / "image.ext4").write_bytes(b"x" * (16 * 1024**2))
        expected = allocated_tree(entry)
        self.assertGreaterEqual(expected, 16 * 1024**2)
        self.assertLess(expected, 64 * 1024**2)
        text = self.collect()
        self.assertIn(PREFIX + 'bucket_entries{bucket="lt_16MiB"} 0\n', text)
        self.assertIn(PREFIX + 'bucket_entries{bucket="16MiB_64MiB"} 1\n', text)
        self.assertIn(
            PREFIX + f'bucket_allocated_bytes{{bucket="16MiB_64MiB"}} {expected}\n',
            text,
        )

    def test_missing_or_non_directory_cache_replaces_stale_success(self):
        self.collect()
        self.cache.rmdir()
        self.unavailable(self.collect())
        self.cache.write_text("not a cache directory")
        self.unavailable(self.collect())

    def test_cache_ancestor_symlink_is_unavailable(self):
        alias = self.root / "alias"
        os.symlink(self.root, alias)
        self.unavailable(self.collect(alias / self.cache.name))

    def test_entry_limit_reports_partial_observation(self):
        for index in range(1025):
            self.entry(index)
        text = self.collect()
        self.assertEqual(self.metric(text, "snapshot_available"), 1)
        self.assertEqual(self.metric(text, "entries"), 1024)
        self.assertEqual(self.metric(text, "entries_complete"), 0)
        self.assertEqual(self.metric(text, "measurements_complete"), 0)
        self.assertEqual(self.metric(text, "allocation_lower_bound"), 1)
        self.assertEqual(self.metric(text, "bucket_measurements_complete"), 0)

    def test_depth_limit_preserves_a_lower_bound_without_bucket_guessing(self):
        entry = self.entry()
        deepest = entry
        for index in range(34):
            deepest = deepest / str(index)
            deepest.mkdir()
        (deepest / "payload").write_bytes(b"x" * 65536)
        text = self.collect()
        self.assertEqual(self.metric(text, "entries_complete"), 1)
        self.assertEqual(self.metric(text, "measurements_complete"), 0)
        self.assertEqual(self.metric(text, "allocation_lower_bound"), 1)
        self.assertLess(self.metric(text, "allocated_bytes"), allocated_tree(entry))
        self.assertIn(PREFIX + 'bucket_entries{bucket="lt_16MiB"} 0\n', text)

    def test_atomic_replacement_does_not_follow_destination_symlink(self):
        victim = self.root / "private-victim"
        victim.write_text("unchanged")
        os.symlink(victim, self.output / "home-image-cache.prom")
        self.collect()
        self.assertEqual(victim.read_text(), "unchanged")
        self.assertFalse((self.output / "home-image-cache.prom").is_symlink())

    def test_unsafe_output_directory_fails_without_publishing(self):
        self.output.chmod(0o777)
        result = self.run_collector()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_failed_replacement_cleans_temporary_output(self):
        destination = self.output / "home-image-cache.prom"
        destination.mkdir()
        result = self.run_collector()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.output.iterdir()), [destination])

    def test_output_ancestor_symlink_cannot_redirect_publication(self):
        alias = self.root / "alias"
        os.symlink(self.root, alias)
        result = self.run_collector(output=alias / self.output.name)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_provisioning_retires_only_obsolete_monitoring_and_runs_collector(self):
        tasks = yaml.safe_load(
            (ROOT / "ansible/playbooks/provision-monitoring.yml").read_text()
        )[0]["tasks"]
        removed = next(
            task for task in tasks if task.get("file", {}).get("state") == "absent"
        )
        self.assertEqual(
            set(removed["loop"]),
            {
                "/etc/systemd/system/vm0-monitoring-workspace-image-cache-collect.timer",
                "/etc/systemd/system/vm0-monitoring-workspace-image-cache-collect.service",
                "/usr/local/bin/vm0-monitoring-workspace-image-cache-collect",
                "/var/lib/vm0-monitoring/textfile-collector/workspace-image-cache.prom",
            },
        )
        service = next(
            task["copy"]["content"]
            for task in tasks
            if task.get("copy", {}).get("dest")
            == "/etc/systemd/system/vm0-monitoring-home-image-cache-collect.service"
        )
        command = next(
            line.removeprefix("ExecStart=")
            for line in service.splitlines()
            if line.startswith("ExecStart=")
        )
        self.assertEqual(
            command.split(),
            [
                "/usr/bin/python3",
                "-I",
                "-B",
                "/usr/local/bin/vm0-monitoring-home-image-cache-collect",
            ],
        )


if __name__ == "__main__":
    unittest.main()
