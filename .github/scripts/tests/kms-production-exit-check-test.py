#!/usr/bin/env python3
"""Exercise the actual CLI, files and child-process boundaries without live access."""

import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "kms-production-exit-check.py"
SOURCE = "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8"
TARGET = "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947"
SECRET = "must-not-leak-secret"


def envelope(key, direct=False):
    kms = {"keyId": key, "ciphertext": base64.b64encode(SECRET.encode()).decode()}
    if not direct:
        kms.update(
            {
                "encryptedDataKey": "eA==",
                "iv": "AAAAAAAAAAAAAAAA",
                "authTag": "AAAAAAAAAAAAAAAAAAAAAA==",
            }
        )
    body = json.dumps({"v": 1, "kind": "stored-secret", "kms": kms}).encode()
    return "vm0secret:v1:" + base64.urlsafe_b64encode(body).decode().rstrip("=")


class ExitCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = os.environ.copy()
        self.env.update(
            {
                "RUNNER_TEMP": str(self.root),
                "GITHUB_STEP_SUMMARY": str(self.root / "summary.md"),
                "GITHUB_REPOSITORY": "vm0-ai/okou",
                "GITHUB_REPOSITORY_ID": "1096175506",
                "GITHUB_REF": "refs/heads/main",
                "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_RUN_ID": "1234",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW_REF": "vm0-ai/okou/.github/workflows/kms-production-exit-check.yml@refs/heads/main",
                "NEON_PROJECT_ID": "hidden-lab-39609750",
                "NEON_API_KEY": SECRET,
                "MIGRATION_VERIFIED_AT": (
                    dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)
                )
                .isoformat()
                .replace("+00:00", "Z"),
                "AWS_METAL_RUNNER_USER": "ubuntu",
                "AWS_METAL_RUNNER_HOSTS": "a.vm3.ai,b.vm3.ai",
            }
        )
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env["PATH"] = str(self.bin) + os.pathsep + self.env["PATH"]
        self.tool(
            "systemctl",
            """import sys
assert sys.argv[1:3] == ["show", "--all"]
assert sys.argv[-1].startswith("vm0-runner-v") and sys.argv[-1].endswith(".service")
print("LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=\\nMainPID=0\\nControlPID=0")
""",
        )
        self.tool(
            "ps",
            "import sys\nassert sys.argv[1:]==['-C','runner','-o','args=','-ww']\nsys.exit(1)\n",
        )

    def run_script(self, *args):
        result = subprocess.run(
            ["python3", str(SCRIPT), *args],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=15,
        )
        for value in (
            result.stdout,
            result.stderr,
            *(p.read_text() for p in self.root.glob("kms-exit-*.json")),
            *(p.read_text() for p in self.root.glob("summary.md")),
        ):
            self.assertNotIn(SECRET, value)
        return result

    def tool(self, name, content):
        path = self.bin / name
        path.write_text("#!/usr/bin/env python3\n" + content)
        path.chmod(0o755)

    def fake_neon(self):
        self.env["REQUEST_LOG"] = str(self.root / "requests.jsonl")
        self.tool(
            "curl",
            """import json,os,sys,urllib.parse
url=sys.argv[-1]
assert url.startswith("https://console.neon.tech/api/v2/projects/hidden-lab-39609750")
assert not any(arg in sys.argv for arg in ["-L", "--location", "--data", "-X", "--request"])
with open(os.environ["REQUEST_LOG"],"a") as f: f.write(json.dumps(url)+"\\n")
path=urllib.parse.urlsplit(url).path
if path.endswith("/branches"):
    if "cursor=page2" in url:
        data={"branches":json.loads(os.environ["BRANCHES_FIXTURE"]) if "BRANCHES_FIXTURE" in os.environ else [{"id":"br-other","name":"other"}]}
    else:
        data={"branches":[{"id":"br-prod","name":"production"}],"pagination":{"cursor":"page2"}}
elif path.endswith("/snapshots"):
    if os.environ.get("FAIL_SNAPSHOTS"):
        print(json.dumps({"message":"must-not-leak-secret"})+"\\n403", end="")
        sys.stderr.write("must-not-leak-secret")
        sys.exit(0)
    data={"snapshots":json.loads(os.environ["SNAPSHOTS_FIXTURE"]) if "SNAPSHOTS_FIXTURE" in os.environ else [{"id":"old","created_at":"2025-01-01T00:00:00Z"},{"id":"new-historical-lsn","created_at":"2099-01-01T00:00:00Z"}]}
elif path.endswith("/backup_schedule"):
    data={"schedule":[{"frequency":"daily","hour":3,"retention_seconds":604800}]}
else:
    data={"project":{"id":"hidden-lab-39609750","history_retention_seconds":int(os.environ.get("RETENTION","604800")),"unrelated_secret":"must-not-leak-secret"}}
print(json.dumps(data)+"\\n200", end="")
""",
        )

    def test_registry_inventory_counts_source_and_unknown_without_exposing_or_writing(
        self,
    ):
        runners = self.root / "runners"
        release = runners / "v1.2.3"
        release.mkdir(parents=True)
        values = [
            envelope(SOURCE),
            envelope(TARGET),
            envelope(SOURCE, direct=True),
            envelope("alias/unknown"),
            "malformed",
            None,
        ]
        data = {
            "sandboxes": {
                str(i): {"encryptedSecrets": value, "sandboxToken": SECRET}
                for i, value in enumerate(values)
            }
        }
        path = release / "proxy-registry.json"
        path.write_text(json.dumps(data))
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        staging = runners / "staging"
        staging.mkdir()
        (staging / "proxy-registry.json").write_text(SECRET)
        result = self.run_script("runner-local", str(runners))
        self.assertEqual(result.returncode, 0, result.stderr)
        counts = json.loads(result.stdout)["counts"]
        self.assertEqual(
            {
                k: counts[k]
                for k in [
                    "source",
                    "target",
                    "unknownKey",
                    "invalid",
                    "noSecret",
                    "entries",
                ]
            },
            {
                "source": 2,
                "target": 1,
                "unknownKey": 1,
                "invalid": 1,
                "noSecret": 1,
                "entries": 6,
            },
        )
        self.assertEqual(counts["productionDirectories"], 1)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)

    def test_missing_and_symlink_registries_are_unreadable(self):
        runners = self.root / "runners"
        for version in ["v1.2.3", "v1.2.4"]:
            (runners / version).mkdir(parents=True)
        outside = self.root / "outside.json"
        outside.write_text('{"sandboxes": {}}')
        (runners / "v1.2.4" / "proxy-registry.json").symlink_to(outside)
        result = self.run_script("runner-local", str(runners))
        self.assertEqual(result.returncode, 0)
        inventory = json.loads(result.stdout)
        self.assertEqual(inventory["counts"]["unreadable"], 2)
        self.assertEqual(
            {f["runnerVersion"]: f["reason"] for f in inventory["failures"]},
            {"v1.2.3": "missing_registry", "v1.2.4": "symlink_registry"},
        )

    def test_oversized_registry_reports_metadata_without_reading_its_contents(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        path = release / "proxy-registry.json"
        size = 16 * 1024 * 1024 + 1
        with path.open("wb") as stream:
            stream.write(SECRET.encode())
            stream.truncate(size)
        before = path.stat()
        result = self.run_script("runner-local", str(release.parent))
        self.assertEqual(result.returncode, 0)
        inventory = json.loads(result.stdout)
        self.assertEqual(inventory["counts"]["unreadable"], 1)
        self.assertEqual(
            inventory["failures"],
            [
                {
                    "runnerVersion": "v1.2.3",
                    "reason": "registry_size_limit",
                    "sizeBytes": size,
                }
            ],
        )
        self.assertEqual(path.stat().st_size, before.st_size)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)

    def test_unstarted_directory_evidence_does_not_turn_missing_registry_into_zero(
        self,
    ):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        config = release / "runner.yaml"
        config.write_text(SECRET)
        before = config.stat()
        result = self.run_script("runner-local", str(release.parent))
        self.assertEqual(result.returncode, 0)
        inventory = json.loads(result.stdout)
        evidence = inventory["missingRegistryEvidence"][0]
        self.assertTrue(evidence["collectionComplete"])
        self.assertTrue(evidence["configFileOnly"])
        self.assertEqual(evidence["service"]["LoadState"], "not-found")
        self.assertEqual(evidence["matchingRunnerCommandLines"], 0)
        self.assertEqual(inventory["counts"]["unreadable"], 1)
        self.assertEqual(inventory["counts"]["registriesRead"], 0)
        self.assertEqual(config.read_text(), SECRET)
        self.assertEqual(config.stat().st_mtime_ns, before.st_mtime_ns)

    def test_manual_runner_match_is_counted_without_exporting_command_line(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release / "status.json").write_text(SECRET)
        self.tool(
            "ps",
            "print('/var/lib/vm0-runner/bin/v1.2.3/runner start --token must-not-leak-secret')\nprint('/var/lib/vm0-runner/bin/v1.2.30/runner start')\n",
        )
        result = self.run_script("runner-local", str(release.parent))
        self.assertEqual(result.returncode, 0)
        evidence = json.loads(result.stdout)["missingRegistryEvidence"][0]
        self.assertFalse(evidence["configFileOnly"])
        self.assertEqual(evidence["matchingRunnerCommandLines"], 1)

    def test_denied_service_inspection_stays_unknown_and_sanitized(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        self.tool(
            "systemctl",
            "import sys\nsys.stderr.write('must-not-leak-secret')\nsys.exit(1)\n",
        )
        result = self.run_script("runner-local", str(release.parent))
        self.assertEqual(result.returncode, 0)
        evidence = json.loads(result.stdout)["missingRegistryEvidence"][0]
        self.assertFalse(evidence["collectionComplete"])
        self.assertEqual(evidence["error"], "runner_state_unavailable")
        self.assertEqual(evidence["diagnostics"]["directoryEntryCount"], 0)
        self.assertEqual(evidence["diagnostics"]["serviceReturnCode"], 1)
        self.assertTrue(evidence["diagnostics"]["serviceStderrPresent"])
        self.assertEqual(evidence["diagnostics"]["serviceProperties"], {})

    def test_real_ps_accepts_wide_process_query(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release / "runner.yaml").write_text(SECRET)
        # Exercise the installed procps parser instead of teaching a fixture
        # to accept the same invalid option as the production command.
        (self.bin / "ps").unlink()
        result = self.run_script("runner-local", str(release.parent))
        inventory = json.loads(result.stdout)
        evidence = inventory["missingRegistryEvidence"][0]
        self.assertTrue(evidence["collectionComplete"])
        self.assertTrue(evidence["configFileOnly"])
        self.assertEqual(inventory["counts"]["unreadable"], 1)

    def test_invalid_service_values_preserve_directory_evidence_without_leaking(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release / "runner.yaml").write_text(SECRET)
        self.tool(
            "systemctl",
            'print("LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=must-not-leak-secret\\nMainPID=0\\nControlPID=0")\n',
        )
        result = self.run_script("runner-local", str(release.parent))
        evidence = json.loads(result.stdout)["missingRegistryEvidence"][0]
        self.assertFalse(evidence["collectionComplete"])
        self.assertTrue(evidence["diagnostics"]["configFileOnly"])
        self.assertEqual(evidence["diagnostics"]["stage"], "service_properties")
        self.assertNotIn("UnitFileState", evidence["diagnostics"]["serviceProperties"])

    def test_duplicate_registry_keys_cannot_silently_hide_source_values(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release / "proxy-registry.json").write_text(
            '{"sandboxes": {"x": {}}, "sandboxes": {}}'
        )
        result = self.run_script("runner-local", str(release.parent))
        inventory = json.loads(result.stdout)
        self.assertEqual(inventory["counts"]["unreadable"], 1)
        self.assertEqual(inventory["failures"][0]["reason"], "duplicate_json_key")

    def test_renamed_repository_uses_the_same_protected_workflow(self):
        self.env["GITHUB_REPOSITORY"] = "maxandzoe/okou"
        self.env["GITHUB_WORKFLOW_REF"] = (
            "maxandzoe/okou/.github/workflows/"
            "kms-production-exit-check.yml@refs/heads/main"
        )
        self.fake_neon()
        result = self.run_script("backups")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_paginated_metadata_keeps_all_snapshots_for_review(self):
        self.fake_neon()
        result = self.run_script("backups")
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        self.assertFalse(report["retirementCleared"])
        inventory = report["inventory"]
        self.assertTrue(inventory["configuredHistoryWindowOverlapsMigration"])
        self.assertEqual(inventory["otherBranchesNotInspected"], 1)
        self.assertEqual(inventory["retainedSnapshotsRequiringKeyReview"], 2)
        self.assertFalse(inventory["databaseConnected"])
        self.assertNotIn("connection_uri", (self.root / "requests.jsonl").read_text())

    def test_branch_origins_are_sanitized_without_assuming_creation_is_the_data_point(
        self,
    ):
        self.fake_neon()
        self.env["BRANCHES_FIXTURE"] = json.dumps(
            [
                {
                    "id": "br-historical",
                    "name": SECRET,
                    "parent_id": "br-prod",
                    "created_at": "2099-01-01T00:00:00Z",
                    "parent_timestamp": "2025-01-01T00:00:00Z",
                    "parent_lsn": "0/ABCD",
                    "private": SECRET,
                },
                {
                    "id": "br-inspection",
                    "name": "kms-recovery-32264-12345-1",
                    "parent_id": "br-historical",
                },
            ]
        )
        self.assertEqual(self.run_script("backups").returncode, 0)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        inventory = report["inventory"]
        self.assertTrue(inventory["branchMetadataCollected"])
        self.assertEqual(inventory["otherBranchesNotInspected"], 2)
        branches = {b["branchIdSha256"]: b for b in inventory["branches"]}
        historical = branches[hashlib.sha256(b"br-historical").hexdigest()]
        self.assertTrue(historical["parentIsProduction"])
        self.assertTrue(historical["parentPointBeforeMigrationVerification"])
        self.assertEqual(historical["reportedParentLsn"], "0/ABCD")
        inspection = branches[hashlib.sha256(b"br-inspection").hexdigest()]
        self.assertEqual(inspection["inspectionRunId"], "12345")
        self.assertIsNone(inspection["parentPointBeforeMigrationVerification"])
        self.assertEqual(
            inspection["parentBranchIdSha256"], historical["branchIdSha256"]
        )
        self.assertTrue(
            all(b["ciphertextVerified"] is False for b in branches.values())
        )
        self.assertFalse(report["retirementCleared"])
        self.assertFalse(inventory["databaseConnected"])
        self.assertNotIn("br-historical", json.dumps(report))

    def test_invalid_or_duplicate_branch_metadata_fails_closed(self):
        self.fake_neon()
        branch = {"id": "br-other", "name": SECRET}
        for records, failure in [
            ([branch, branch], "invalid_branch_identity"),
            ([{**branch, "parent_id": "br-other"}], "invalid_branch_identity"),
            ([{**branch, "parent_id": SECRET}], "invalid_branch_id"),
            ([{**branch, "parent_lsn": SECRET}], "invalid_branch_lsn"),
            ([{**branch, "parent_timestamp": SECRET}], "invalid_metadata_timestamp"),
        ]:
            with self.subTest(failure=failure):
                self.env["BRANCHES_FIXTURE"] = json.dumps(records)
                self.assertEqual(self.run_script("backups").returncode, 1)
                report = json.loads((self.root / "kms-exit-backups.json").read_text())
                self.assertEqual(report["failure"], failure)
                self.assertEqual(report["result"], "incomplete")

    def test_zero_history_window_does_not_clear_retained_snapshots(self):
        self.fake_neon()
        self.env["RETENTION"] = "0"
        self.assertEqual(self.run_script("backups").returncode, 0)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        self.assertFalse(
            report["inventory"]["configuredHistoryWindowOverlapsMigration"]
        )
        self.assertEqual(report["inventory"]["retainedSnapshotsRequiringKeyReview"], 2)
        self.assertFalse(report["retirementCleared"])

    def test_provider_failure_is_incomplete_and_sanitized(self):
        self.fake_neon()
        self.env["FAIL_SNAPSHOTS"] = "1"
        self.assertEqual(self.run_script("backups").returncode, 1)
        report = json.loads((self.root / "kms-exit-backups.json").read_text())
        self.assertEqual(report["result"], "incomplete")
        self.assertEqual(report["failure"], "neon_metadata_request_failed")

    def test_snapshot_points_and_expirations_are_reported_independently_of_creation(
        self,
    ):
        self.fake_neon()
        cutoff = dt.datetime.fromisoformat(
            self.env["MIGRATION_VERIFIED_AT"].replace("Z", "+00:00")
        )
        created = (cutoff + dt.timedelta(minutes=1)).isoformat()
        self.env["SNAPSHOTS_FIXTURE"] = json.dumps(
            [
                {
                    "id": "old-point",
                    "name": SECRET,
                    "created_at": created,
                    "timestamp": (cutoff - dt.timedelta(days=1)).isoformat(),
                    "expires_at": (cutoff + dt.timedelta(days=7)).isoformat(),
                    "manual": False,
                    "source_branch_id": "br-prod",
                },
                {
                    "id": "new-point",
                    "name": SECRET,
                    "created_at": created,
                    "timestamp": (cutoff + dt.timedelta(seconds=10)).isoformat(),
                    "lsn": "AB/CD",
                    "manual": True,
                    "source_branch_id": "br-prod",
                },
            ]
        )
        self.assertEqual(self.run_script("backups").returncode, 0)
        inventory = json.loads((self.root / "kms-exit-backups.json").read_text())[
            "inventory"
        ]
        self.assertEqual(inventory["snapshotsWithReportedPreMigrationPoint"], 1)
        self.assertEqual(inventory["snapshotsWithUnreportedPoint"], 0)
        self.assertEqual(inventory["snapshotsWithoutReportedExpiration"], 1)
        self.assertEqual(inventory["retainedSnapshotsRequiringKeyReview"], 2)
        self.assertTrue(
            all(s["sourceBranchIsProduction"] for s in inventory["snapshots"])
        )
        self.assertFalse(inventory["backupCiphertextVerified"])
        self.assertEqual(inventory["backupSchedule"][0]["retention_seconds"], 604800)
        self.assertNotIn("old-point", json.dumps(inventory))

    def test_invalid_snapshot_metadata_and_duplicate_ids_fail_closed(self):
        self.fake_neon()
        snapshot = {"id": "snapshot", "created_at": "2025-01-01T00:00:00Z"}
        for snapshots, failure in [
            ([{**snapshot, "lsn": SECRET}], "invalid_snapshot_lsn"),
            ([snapshot, snapshot], "invalid_snapshot_id"),
        ]:
            with self.subTest(failure=failure):
                self.env["SNAPSHOTS_FIXTURE"] = json.dumps(snapshots)
                self.assertEqual(self.run_script("backups").returncode, 1)
                report = json.loads((self.root / "kms-exit-backups.json").read_text())
                self.assertEqual(report["result"], "incomplete")
                self.assertEqual(report["failure"], failure)

    def test_nonproduction_context_never_contacts_neon(self):
        for variable, value in [
            ("GITHUB_REF", "refs/heads/feature"),
            ("GITHUB_REPOSITORY_ID", "1"),
        ]:
            with self.subTest(variable=variable):
                self.fake_neon()
                self.env[variable] = value
                self.assertEqual(self.run_script("backups").returncode, 1)
                self.assertFalse((self.root / "requests.jsonl").exists())
                self.env[variable] = {
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_REPOSITORY_ID": "1096175506",
                }[variable]

    def test_unexpected_remote_fields_are_never_exported(self):
        self.tool(
            "ssh",
            'import sys\nsys.stdin.read()\nprint(\'{"secret":"must-not-leak-secret"}\')\n',
        )
        self.assertEqual(self.run_script("runners").returncode, 1)
        report = json.loads((self.root / "kms-exit-runners.json").read_text())
        self.assertEqual(report["inventory"]["hostsExpected"], 2)
        self.assertFalse(report["inventory"]["collectionComplete"])

    def test_partial_fleet_failure_preserves_observed_source_dependency(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        (release.parent / "v1.2.4").mkdir()
        (release / "proxy-registry.json").write_text(
            json.dumps({"sandboxes": {"x": {"encryptedSecrets": envelope(SOURCE)}}})
        )
        local = self.run_script("runner-local", str(release.parent))
        fixture = self.root / "host-report.json"
        fixture.write_text(local.stdout)
        self.env["HOST_REPORT_FIXTURE"] = str(fixture)
        self.tool(
            "ssh",
            """import os,sys
sys.stdin.read()
if "ubuntu@b.vm3.ai" in sys.argv:
    sys.stderr.write("must-not-leak-secret")
    sys.exit(1)
print(open(os.environ["HOST_REPORT_FIXTURE"]).read())
""",
        )
        self.assertEqual(self.run_script("runners").returncode, 1)
        report = json.loads((self.root / "kms-exit-runners.json").read_text())
        self.assertEqual(report["inventory"]["totals"]["source"], 1)
        self.assertEqual(
            report["inventory"]["hosts"][0]["registryFailures"],
            [
                {
                    "runnerVersion": "v1.2.4",
                    "reason": "missing_registry",
                    "sizeBytes": None,
                }
            ],
        )
        self.assertFalse(report["inventory"]["collectionComplete"])
        self.assertFalse(report["retirementCleared"])

    def test_remote_failure_text_is_not_exported_as_a_diagnostic_reason(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        local = self.run_script("runner-local", str(release.parent))
        inventory = json.loads(local.stdout)
        inventory["failures"][0]["reason"] = SECRET
        fixture = self.root / "host-report.json"
        fixture.write_text(json.dumps(inventory))
        self.env["HOST_REPORT_FIXTURE"] = str(fixture)
        self.tool(
            "ssh",
            "import os,sys\nsys.stdin.read()\n"
            "print(open(os.environ['HOST_REPORT_FIXTURE']).read())\n",
        )
        self.assertEqual(self.run_script("runners").returncode, 1)
        report = json.loads((self.root / "kms-exit-runners.json").read_text())
        self.assertFalse(report["inventory"]["collectionComplete"])
        self.assertTrue(all("error" in h for h in report["inventory"]["hosts"]))

    def test_untrusted_service_metadata_cannot_leak_or_preserve_a_partial_success(self):
        release = self.root / "runners" / "v1.2.3"
        release.mkdir(parents=True)
        local = self.run_script("runner-local", str(release.parent))
        inventory = json.loads(local.stdout)
        inventory["missingRegistryEvidence"][0]["service"]["UnitFileState"] = SECRET
        fixture = self.root / "host-report.json"
        fixture.write_text(json.dumps(inventory))
        self.env["HOST_REPORT_FIXTURE"] = str(fixture)
        self.tool(
            "ssh",
            "import os,sys\nsys.stdin.read()\nprint(open(os.environ['HOST_REPORT_FIXTURE']).read())\n",
        )
        self.assertEqual(self.run_script("runners").returncode, 1)
        report = json.loads((self.root / "kms-exit-runners.json").read_text())
        self.assertFalse(report["inventory"]["collectionComplete"])
        self.assertTrue(
            all(
                "error" in h and "counts" not in h for h in report["inventory"]["hosts"]
            )
        )


if __name__ == "__main__":
    unittest.main()
