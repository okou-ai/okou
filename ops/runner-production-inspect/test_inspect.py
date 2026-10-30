import datetime as dt
import json
import os
import shlex
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import collect as inspection


class InspectionTest(unittest.TestCase):
    def test_process_scan_keeps_old_owner_and_rejects_unknown_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for pid, version in [(123, "v0.241.8"), (456, "v0.241.10")]:
                (proc / str(pid)).mkdir()
                (proc / str(pid) / "exe").symlink_to(
                    f"/var/lib/vm0-runner/bin/{version}/runner"
                )
            self.assertEqual(
                inspection.processes(proc),
                [
                    {"pid": 123, "version": "v0.241.8"},
                    {"pid": 456, "version": "v0.241.10"},
                ],
            )
            (proc / "789").mkdir()
            (proc / "789" / "exe").symlink_to("/unexpected/runner")
            with self.assertRaises(ValueError):
                inspection.processes(proc)

    def test_cache_events_export_only_known_fields(self):
        digest = "a" * 64
        record = {
            "__REALTIME_TIMESTAMP": "1793376000000000",
            "MESSAGE": (
                "INFO runner_storage::content_bundle_cache: content bundle download attempt "
                f"sha256={digest} attempt=1 duration_ms=42 success=true "
                "cause=private-canary https://private.invalid/?token=secret-canary"
            ),
        }
        result = inspection.cache_event(record)
        self.assertEqual(
            result,
            {
                "event": "download",
                "sha256": digest,
                "timestampUs": 1793376000000000,
                "attempt": 1,
                "duration_ms": 42,
                "success": True,
            },
        )
        self.assertNotIn("canary", json.dumps(result))
        warm = inspection.cache_event(
            {
                **record,
                "MESSAGE": (
                    "INFO runner_storage::content_bundle_cache: content bundle cache lookup "
                    f"sha256={digest} archive_bytes=87 cache_hit=true"
                ),
            }
        )
        self.assertTrue(warm["cache_hit"])
        self.assertEqual(warm["archive_bytes"], 87)
        self.assertIsNone(
            inspection.cache_event(
                {**record, "MESSAGE": "user: " + record["MESSAGE"].split(": ", 1)[1]}
            )
        )
        with self.assertRaises(ValueError):
            inspection.cache_event(
                {**record, "MESSAGE": record["MESSAGE"].replace(digest, "invalid")}
            )

    def test_invalid_window_is_rejected_before_host_access(self):
        for value in [
            "yesterday; command",
            (inspection.now() - dt.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        ]:
            with self.assertRaises(ValueError):
                inspection.since_time(value)

    def test_fleet_rejects_provider_output_without_publishing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            ssh = Path(directory) / "ssh"
            timestamp = inspection.now().isoformat()
            valid = {
                "startedAt": timestamp,
                "finishedAt": timestamp,
                "since": timestamp,
                "collectionComplete": True,
                "processes": [{"pid": 456, "version": "v0.241.10"}],
                "services": [],
                "cacheEvents": [],
            }
            ssh.write_text(
                "#!/bin/sh\ncase \"$*\" in\n*prod-11*) printf '%s\\n' "
                + shlex.quote(json.dumps(valid))
                + ";;\n*) printf '%s\\n' "
                + shlex.quote('{"collectionComplete":true,"private":"secret-canary"}')
                + ";;\nesac\n"
            )
            ssh.chmod(0o700)
            with patch.dict(
                os.environ,
                {
                    "PATH": directory + ":" + os.environ["PATH"],
                    "AWS_METAL_RUNNER_HOSTS": "prod-11.gcp.vm3.ai,prod-12.gcp.vm3.ai",
                    "AWS_METAL_RUNNER_USER": "ubuntu",
                },
            ):
                report = inspection.fleet(
                    inspection.now().strftime("%Y-%m-%dT%H:%M:%SZ")
                )
            self.assertFalse(report["collectionComplete"])
            self.assertEqual(len(report["hosts"]), 2)
            self.assertNotIn("canary", json.dumps(report))
            self.assertTrue(report["hosts"][0]["collectionComplete"])
            self.assertEqual(report["hosts"][0]["processes"], valid["processes"])
            self.assertFalse(report["hosts"][1]["collectionComplete"])

    def test_empty_journal_match_does_not_hide_command_errors(self):
        self.assertEqual(
            inspection.command(
                [sys.executable, "-c", "raise SystemExit(1)"], empty_match=True
            ),
            "",
        )
        with self.assertRaises(ValueError):
            inspection.command(
                [
                    sys.executable,
                    "-c",
                    "import sys;sys.stderr.write('unavailable');sys.exit(1)",
                ],
                empty_match=True,
            )


if __name__ == "__main__":
    unittest.main()
