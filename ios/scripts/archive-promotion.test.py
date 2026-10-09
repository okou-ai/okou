#!/usr/bin/env python3
"""Exercise the promotion CLI with real Git/files and mocked R2/GitHub boundaries."""

import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("archive-promotion.py")

AWS = """#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
args = sys.argv[1:]
operation = args[1]
key = args[args.index('--key') + 1]
path = pathlib.Path(os.environ['STORE']) / key
if operation == 'get-object':
    if os.environ.get('DENY_STORE'):
        print('An error occurred (AccessDenied)', file=sys.stderr)
        sys.exit(1)
    if not path.is_file():
        print('An error occurred (NoSuchKey)', file=sys.stderr)
        sys.exit(1)
    shutil.copyfile(path, args[-1])
elif operation == 'put-object':
    assert args[args.index('--if-none-match') + 1] == '*'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        print('An error occurred (PreconditionFailed)', file=sys.stderr)
        sys.exit(1)
    shutil.copyfile(args[args.index('--body') + 1], path)
else:
    raise ValueError(operation)
print('{}')
"""

GH = """#!/usr/bin/env python3
import json, os, sys
assert sys.argv[1] == 'api'
route = sys.argv[2]
records = json.load(open(os.environ['GITHUB_RECORDS']))
run_id = route.split('/runs/')[1].split('/')[0]
record = records[run_id]
if '/jobs?' in route:
    print(json.dumps([{'jobs': record['jobs']}]))
else:
    print(json.dumps(record['run']))
"""


class PromotionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, content in (("aws", AWS), ("gh", GH)):
            path = self.bin / name
            path.write_text(content)
            path.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "GITHUB_REPOSITORY": "okou-ai/okou",
            "GITHUB_EVENT_NAME": "merge_group",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_OUTPUT": str(self.root / "output"),
            "GITHUB_RECORDS": str(self.root / "github.json"),
            "R2_BUCKET_NAME": "private-test",
            "R2_ACCOUNT_ID": "account",
            "AWS_ACCESS_KEY_ID": "test-key",
            "AWS_SECRET_ACCESS_KEY": "test-secret",
            "STORE": str(self.root / "store"),
            "IOS_RAN_TESTS": "true",
            "IOS_VERSION": "1.0.0",
        }
        self.git("init", "-q")
        self.git("config", "user.name", "Promotion Test")
        self.git("config", "user.email", "test@example.invalid")
        self.file("ios/App.swift", "let application = 1\n")
        self.file("ios/version.txt", "1.0.0\n")
        self.file(
            "ios/Config/Shared.xcconfig",
            "MARKETING_VERSION = 1.0.0 // x-release-please-version\nOTHER_SWIFT_FLAGS = -strict-concurrency=complete\n",
        )
        self.file("ios/Package.resolved", '{"pins": []}\n')
        self.file(".github/workflows/ios.yml", "trusted iOS workflow\n")
        self.file(
            "release-please-config.json",
            json.dumps(
                {
                    "packages": {
                        "ios": {"release-type": "simple"},
                        "turbo/apps/cli": {"release-type": "node"},
                        "crates/runner": {"release-type": "rust"},
                    }
                }
            ),
        )
        self.file(".release-please-manifest.json", '{"ios": "1.0.0"}\n')
        self.file(
            "turbo/apps/cli/package.json",
            '{"name": "cli", "version": "1.0.0", "scripts": {"build": "build"}}\n',
        )
        self.file(
            "crates/runner/Cargo.toml",
            '[package]\nname = "runner"\nversion = "1.0.0"\n',
        )
        self.file(
            "crates/Cargo.lock",
            'version = 4\n[[package]]\nname = "runner"\nversion = "1.0.0"\n',
        )
        self.commit()
        self.base = self.git("rev-parse", "HEAD")
        self.env["MERGE_GROUP_BASE_SHA"] = self.base
        self.records = {}
        self.record()
        self.work = self.root / "work"
        self.work.mkdir()
        (self.root / "toolchain.json").write_text(
            json.dumps(
                {
                    "xcode": "Xcode 26.3\nBuild version 17C600",
                    "deviceSDK": "23C57",
                    "simulatorSDK": "23C54",
                    "architecture": "arm64",
                    "testDestination": "iPhone 17 Pro,OS=26.2",
                }
            )
        )
        self.capture()
        self.archive()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def file(self, path, content):
        destination = self.repo / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "test change")

    def record(self):
        self.records[self.env["GITHUB_RUN_ID"]] = {
            "run": {
                "head_sha": self.git("rev-parse", "HEAD"),
                "event": "merge_group",
                "path": ".github/workflows/ios.yml",
                "head_branch": "gh-readonly-queue/main/pr-1",
            },
            "jobs": [
                {
                    "name": "build-test",
                    "conclusion": "success",
                    "steps": [
                        {
                            "name": "Build app and run isolated simulator tests",
                            "conclusion": "success",
                        },
                        {
                            "name": "Build unsigned device Release archive",
                            "conclusion": "success",
                        },
                    ],
                }
            ],
        }
        self.save_records()

    def save_records(self):
        Path(self.env["GITHUB_RECORDS"]).write_text(json.dumps(self.records))

    def cli(self, *args, error=None):
        result = subprocess.run(
            ["python3", str(SCRIPT), *map(str, args)],
            cwd=self.repo,
            env=self.env,
            text=True,
            capture_output=True,
            check=False,
        )
        if error is None:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(error, result.stderr)
        return result.stdout.strip()

    def capture(self):
        self.cli(
            "inputs",
            "--toolchain",
            self.root / "toolchain.json",
            "--output",
            self.work / "inputs.json",
        )
        return json.loads((self.work / "inputs.json").read_bytes())

    def archive(self):
        archive = self.work / "Original.xcarchive"
        archive.mkdir(exist_ok=True)
        app = archive / "Products/Applications/Okou.app"
        app.mkdir(parents=True, exist_ok=True)
        info = {
            "CFBundleIdentifier": "ai.okou.ios",
            "CFBundleShortVersionString": self.env["IOS_VERSION"],
            "CFBundleVersion": "1",
            "CFBundleSupportedPlatforms": ["iPhoneOS"],
            "CFBundleExecutable": "Okou",
        }
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        (app / "Okou").write_bytes(b"compiled-device-code")
        (archive / "dSYMs/Okou.app.dSYM").mkdir(parents=True, exist_ok=True)
        (archive / "Info.plist").write_bytes(
            plistlib.dumps(
                {
                    "ApplicationProperties": info
                    | {"ApplicationPath": "Applications/Okou.app"}
                }
            )
        )
        with tarfile.open(self.work / "archive.tar.gz", "w:gz") as output:
            output.add(archive, arcname="Original.xcarchive")
        (self.work / "archive-sha256.txt").write_text(
            hashlib.sha256((self.work / "archive.tar.gz").read_bytes()).hexdigest()
            + "\n"
        )

    def ready(self):
        inputs = json.loads((self.work / "inputs.json").read_bytes())
        return (
            Path(self.env["STORE"])
            / f"okou-ios/inputs/{inputs['archiveInputSha256']}/ready.json"
        )

    def consume_work(self):
        target = self.root / "consume"
        target.mkdir(exist_ok=True)
        shutil.copyfile(self.work / "inputs.json", target / "inputs.json")
        return target

    def release(self):
        self.file("ios/version.txt", "1.0.1\n")
        self.file(
            "ios/Config/Shared.xcconfig",
            "MARKETING_VERSION = 1.0.1 // x-release-please-version\nOTHER_SWIFT_FLAGS = -strict-concurrency=complete\n",
        )
        self.file(".release-please-manifest.json", '{"ios": "1.0.1"}\n')
        self.commit()
        self.env["IOS_VERSION"] = "1.0.1"

    def test_maps_different_main_and_builder_shas_without_rebuild(self):
        builder = self.git("rev-parse", "HEAD")
        self.cli("publish", self.work)
        self.file("unrelated.txt", "a later main commit\n")
        self.commit()
        self.capture()
        target = self.consume_work()
        self.cli("consume", target, "--wait-seconds", 0)
        mapping = json.loads((target / "release-mapping.json").read_bytes())
        self.assertEqual(mapping["builderCommit"], builder)
        self.assertEqual(mapping["releaseTarget"], self.git("rev-parse", "HEAD"))
        self.assertNotEqual(mapping["builderCommit"], mapping["releaseTarget"])
        self.assertEqual(
            (
                target / "Original.xcarchive/Products/Applications/Okou.app/Okou"
            ).read_bytes(),
            b"compiled-device-code",
        )

    def test_release_reuses_prior_tests_but_builds_version_specific_archive(self):
        old = self.capture()
        self.cli("publish", self.work)
        self.release()
        current = self.capture()
        self.assertEqual(old["testInputSha256"], current["testInputSha256"])
        self.assertNotEqual(old["archiveInputSha256"], current["archiveInputSha256"])
        self.cli("resolve-tests", self.work)
        self.assertIn("run_tests=false", Path(self.env["GITHUB_OUTPUT"]).read_text())
        self.env["GITHUB_RUN_ID"] = "124"
        self.env["IOS_RAN_TESTS"] = "false"
        self.record()
        self.records["124"]["jobs"][0]["steps"][0]["conclusion"] = "skipped"
        self.save_records()
        self.archive()
        self.cli("publish", self.work)
        target = self.consume_work()
        self.cli("consume", target, "--wait-seconds", 0)
        mapping = json.loads((target / "release-mapping.json").read_bytes())
        self.assertEqual(mapping["builderRunId"], 124)
        self.assertEqual(mapping["testEvidence"]["runId"], 123)

    def test_missing_test_evidence_runs_tests(self):
        self.release()
        self.capture()
        self.cli("resolve-tests", self.work)
        self.assertIn("run_tests=true", Path(self.env["GITHUB_OUTPUT"]).read_text())

    def test_mixed_group_never_skips_even_with_matching_ios_evidence(self):
        self.cli("publish", self.work)
        self.release()
        self.file("turbo/source.ts", "export const value = 1;\n")
        self.commit()
        self.capture()
        self.cli("resolve-tests", self.work)
        self.assertIn("run_tests=true", Path(self.env["GITHUB_OUTPUT"]).read_text())

    def test_source_configuration_dependency_workflow_and_toolchain_invalidate_evidence(
        self,
    ):
        original = self.capture()
        for path, content in [
            ("ios/App.swift", "let application = 2\n"),
            ("ios/Config/Release.xcconfig", "SWIFT_OPTIMIZATION_LEVEL = -Osize\n"),
            ("ios/Package.resolved", '{"pins": ["new dependency"]}\n'),
            (".github/workflows/ios.yml", "changed native workflow\n"),
            ("ios/scripts/build.sh", "changed compiler arguments\n"),
        ]:
            with self.subTest(path=path):
                self.git("reset", "--hard", self.base)
                self.file(path, content)
                self.commit()
                self.assertNotEqual(
                    original["testInputSha256"], self.capture()["testInputSha256"]
                )
        tools = json.loads((self.root / "toolchain.json").read_bytes())
        previous = self.capture()
        tools["deviceSDK"] = "new SDK build"
        (self.root / "toolchain.json").write_text(json.dumps(tools))
        self.assertNotEqual(
            previous["archiveInputSha256"], self.capture()["archiveInputSha256"]
        )

    def test_whole_group_metadata_allowlist_rejects_manifest_script_and_external_lock_changes(
        self,
    ):
        self.release()
        self.file(
            "turbo/apps/cli/package.json",
            '{"name": "cli", "version": "1.0.1", "scripts": {"build": "build"}}\n',
        )
        self.file(
            "crates/runner/Cargo.toml",
            '[package]\nname = "runner"\nversion = "1.0.1"\n',
        )
        self.file(
            "crates/Cargo.lock",
            'version = 4\n[[package]]\nname = "runner"\nversion = "1.0.1"\n',
        )
        self.commit()
        self.assertEqual(self.cli("release-only", "--base", self.base), "true")
        self.file(
            "turbo/apps/cli/package.json",
            '{"name": "cli", "version": "1.0.1", "scripts": {"build": "malicious"}}\n',
        )
        self.commit()
        self.assertEqual(self.cli("release-only", "--base", self.base), "false")
        self.git("reset", "--hard", self.base)
        self.file(
            "crates/Cargo.lock",
            'version = 4\n[[package]]\nname = "external"\nversion = "1.0.0"\nsource = "registry"\n',
        )
        self.commit()
        self.assertEqual(self.cli("release-only", "--base", self.base), "false")

    def test_failed_or_non_merge_group_tests_cannot_publish(self):
        self.records["123"]["jobs"][0]["steps"][0]["conclusion"] = "failure"
        self.save_records()
        self.cli("publish", self.work, error="did not pass")
        self.assertFalse(self.ready().exists())
        self.records["123"]["run"]["event"] = "pull_request"
        self.save_records()
        self.cli("publish", self.work, error="exact main merge-group")

    def test_tampered_prior_test_evidence_is_not_a_cache_miss(self):
        self.cli("publish", self.work)
        self.release()
        self.capture()
        self.records["123"]["run"]["head_sha"] = "0" * 40
        self.save_records()
        self.cli("resolve-tests", self.work, error="exact main merge-group")

    def test_missing_ready_and_access_denied_fail_without_rebuilding(self):
        self.cli(
            "consume",
            self.consume_work(),
            "--wait-seconds",
            0,
            error="no rebuild fallback",
        )
        self.release()
        self.capture()
        self.env["DENY_STORE"] = "true"
        self.cli("resolve-tests", self.work, error="AccessDenied")

    def test_checksum_and_missing_archive_fail_closed(self):
        self.cli("publish", self.work)
        ready = json.loads(self.ready().read_bytes())
        manifest_path = Path(self.env["STORE"]) / ready["manifestKey"]
        archive_path = manifest_path.with_name("archive.tar.gz")
        archive_path.write_bytes(archive_path.read_bytes() + b"tampered")
        self.cli(
            "consume",
            self.consume_work(),
            "--wait-seconds",
            0,
            error="Archive checksum mismatch",
        )
        archive_path.unlink()
        self.cli(
            "consume",
            self.consume_work(),
            "--wait-seconds",
            0,
            error="Mapped archive is missing",
        )
        manifest_path.write_bytes(manifest_path.read_bytes() + b" ")
        self.cli(
            "consume",
            self.consume_work(),
            "--wait-seconds",
            0,
            error="Manifest checksum mismatch",
        )

    def test_ready_identity_and_path_traversal_are_rejected(self):
        self.cli("publish", self.work)
        ready = json.loads(self.ready().read_bytes())
        manifest_path = Path(self.env["STORE"]) / ready["manifestKey"]
        archive_path = manifest_path.with_name("archive.tar.gz")
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(self.repo / "ios/App.swift", arcname="../escaped.swift")
        manifest = json.loads(manifest_path.read_bytes())
        manifest["archiveSha256"] = hashlib.sha256(
            archive_path.read_bytes()
        ).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        ready["manifestSha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        self.ready().write_text(json.dumps(ready))
        self.cli(
            "consume",
            self.consume_work(),
            "--wait-seconds",
            0,
            error="Unexpected archive member path",
        )
        self.assertFalse((self.root / "escaped.swift").exists())
        ready["archiveInputSha256"] = "0" * 64
        self.ready().write_text(json.dumps(ready))
        self.cli(
            "consume",
            self.consume_work(),
            "--wait-seconds",
            0,
            error="Readiness identity mismatch",
        )

    def test_archive_links_cannot_overwrite_promotion_metadata(self):
        self.cli("publish", self.work)
        ready = json.loads(self.ready().read_bytes())
        manifest_path = Path(self.env["STORE"]) / ready["manifestKey"]
        archive_path = manifest_path.with_name("archive.tar.gz")
        with tarfile.open(archive_path, "w:gz") as archive:
            archive.add(self.work / "Original.xcarchive", arcname="Original.xcarchive")
            link = tarfile.TarInfo(
                "Original.xcarchive/Products/Applications/Okou.app/escape"
            )
            link.type = tarfile.SYMTYPE
            link.linkname = "../../../../inputs.json"
            archive.addfile(link)
        manifest = json.loads(manifest_path.read_bytes())
        manifest["archiveSha256"] = hashlib.sha256(
            archive_path.read_bytes()
        ).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        ready["manifestSha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        self.ready().write_text(json.dumps(ready))
        target = self.consume_work()
        original_inputs = (target / "inputs.json").read_bytes()
        self.cli(
            "consume",
            target,
            "--wait-seconds",
            0,
            error="Archive link escapes the application archive",
        )
        self.assertEqual((target / "inputs.json").read_bytes(), original_inputs)
        self.assertFalse((target / "release-mapping.json").exists())

    def test_ready_is_immutable_when_another_builder_publishes_same_inputs(self):
        self.cli("publish", self.work)
        first_ready = self.ready().read_bytes()
        self.env["GITHUB_RUN_ID"] = "124"
        self.record()
        self.cli("publish", self.work)
        self.assertEqual(self.ready().read_bytes(), first_ready)
        self.cli("consume", self.consume_work(), "--wait-seconds", 0)

    def test_same_run_archive_transfer_must_match_the_native_checksum(self):
        archive = self.work / "archive.tar.gz"
        archive.write_bytes(archive.read_bytes() + b"transfer corruption")
        self.cli("publish", self.work, error="Archive transfer checksum mismatch")
        self.assertFalse(self.ready().exists())

    def test_forged_matching_hash_cannot_hide_different_tested_source(self):
        self.cli("publish", self.work)
        original = self.capture()
        key = (
            Path(self.env["STORE"])
            / f"okou-ios/tests/{original['testInputSha256']}/evidence.json"
        )
        self.file("ios/App.swift", "let application = 999\n")
        self.commit()
        self.env["GITHUB_RUN_ID"] = "124"
        self.record()
        evidence = json.loads(key.read_bytes())
        evidence["commitSha"] = self.git("rev-parse", "HEAD")
        evidence["runId"] = 124
        key.write_text(json.dumps(evidence))
        self.git("reset", "--hard", self.base)
        self.release()
        self.capture()
        self.cli(
            "resolve-tests",
            self.work,
            error="source/configuration/dependencies/toolchain mismatch",
        )

    def test_corrupt_first_readiness_marker_cannot_be_accepted_by_a_later_publisher(
        self,
    ):
        self.cli("publish", self.work)
        ready = json.loads(self.ready().read_bytes())
        ready["manifestSha256"] = "0" * 64
        self.ready().write_text(json.dumps(ready))
        self.env["GITHUB_RUN_ID"] = "124"
        self.record()
        self.cli("publish", self.work, error="Manifest checksum mismatch")

    def test_non_main_consumption_and_invalid_test_decision_fail_closed(self):
        self.env["GITHUB_REF"] = "refs/heads/untrusted"
        self.cli("consume", self.consume_work(), "--wait-seconds", 0, error="Only main")
        self.env["IOS_RAN_TESTS"] = "unknown"
        self.cli("publish", self.work, error="explicit simulator test decision")
        self.env["IOS_RAN_TESTS"] = "false"
        self.file("ios/App.swift", "let application = 2\n")
        self.commit()
        self.record()
        self.capture()
        self.cli("publish", self.work, error="Mixed merge groups")

    def test_mode_and_non_version_shared_configuration_changes_invalidate_inputs(self):
        original = self.capture()
        (self.repo / "ios/App.swift").chmod(0o755)
        self.commit()
        self.assertNotEqual(
            original["testInputSha256"], self.capture()["testInputSha256"]
        )
        self.git("reset", "--hard", self.base)
        self.release()
        with (self.repo / "ios/Config/Shared.xcconfig").open("a") as shared:
            shared.write("SWIFT_OPTIMIZATION_LEVEL = -Osize\n")
        self.commit()
        self.assertNotEqual(
            original["testInputSha256"], self.capture()["testInputSha256"]
        )
        self.assertEqual(self.cli("release-only", "--base", self.base), "false")

    def test_dirty_or_untracked_inputs_cannot_be_fingerprinted(self):
        self.file("ios/App.swift", "uncommitted input\n")
        self.cli(
            "inputs",
            "--toolchain",
            self.root / "toolchain.json",
            "--output",
            self.work / "inputs.json",
            error="returned non-zero",
        )
        self.git("reset", "--hard", self.base)
        self.file("ios/untracked.swift", "untracked input\n")
        self.cli(
            "inputs",
            "--toolchain",
            self.root / "toolchain.json",
            "--output",
            self.work / "inputs.json",
            error="Untracked promotion inputs",
        )


if __name__ == "__main__":
    unittest.main()
