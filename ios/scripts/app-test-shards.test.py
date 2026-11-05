#!/usr/bin/env python3
"""Exercise manual App partitioning/proof through the real CLI and CI caller."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).parent
SCRIPT = SCRIPTS / "app-test-shards.py"
FIRST = (SCRIPTS / "app-test-shard-a.txt").read_text().splitlines()[0]
CASES = [
    f"{FIRST}/testOriginal",
    f"{FIRST}/testAddedMethod",
    "OtherTests/testOriginal",
    "NewRetainedClass/testAddedClass",
]
GH = """#!/usr/bin/env python3
import json, os, sys
root = os.environ['SHARD_FIXTURES']
file = 'jobs.json' if '/jobs?' in sys.argv[2] else 'run.json'
print(open(root + '/' + file).read())
"""
XCODE = """#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
if 'build-for-testing' in args:
    sys.exit(0)
assert 'test-without-building' in args
assert pathlib.Path(args[args.index('-xctestrun') + 1]).read_text() == 'built tests'
cases = json.loads(os.environ['SHARD_TEST_CASES'])
only = {x.split(':', 1)[1] for x in args if x.startswith('-only-testing:')}
skip = {x.split(':', 1)[1] for x in args if x.startswith('-skip-testing:')}
chosen = [x for x in cases if (not only or 'OkouTests/' + x.split('/')[0] in only)
          and 'OkouTests/' + x.split('/')[0] not in skip]
for identity in chosen:
    cls, method = identity.split('/')
    print(f"Test Case '-[OkouTests.{cls} {method}]' passed (0.010 seconds).")
failed = os.environ.get('SHARD_TEST_FAILURE') == 'true'
print(f'Executed {len(chosen)} tests, with {int(failed)} failures (0 unexpected) in 0.1 (0.1) seconds')
sys.exit(65 if failed else 0)
"""


def console(cases):
    lines = [
        f"Test Case '-[OkouTests.{name.replace('/', ' ')}]' passed (0.010 seconds)."
        for name in cases
    ]
    return "\n".join(
        lines
        + [
            f"Executed {len(cases)} tests, with 0 failures (0 unexpected) in 0.1 (0.1) seconds"
        ]
    )


class AppShardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, source in (("gh", GH), ("xcodebuild", XCODE)):
            tool = self.bin / name
            tool.write_text(source)
            tool.chmod(0o755)
        self.inputs = {"testInputSha256": "b" * 64, "toolchain": {"xcode": "fixture"}}
        (self.root / "inputs.json").write_text(json.dumps(self.inputs))
        self.run = {
            "id": 101,
            "head_sha": "a" * 40,
            "event": "workflow_dispatch",
            "path": ".github/workflows/ios.yml",
            "status": "completed",
            "conclusion": "success",
            "run_attempt": 1,
        }
        self.jobs = [
            {
                "jobs": [
                    {
                        "name": "build-test",
                        "conclusion": "success",
                        "steps": [
                            {
                                "name": "Build app and run isolated simulator tests",
                                "conclusion": "success",
                            }
                        ],
                    }
                ]
            }
        ]
        self.save_reference_api()
        self.env = os.environ | {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "SHARD_FIXTURES": str(self.root),
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REPOSITORY": "okou-ai/okou",
            "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "202",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_OUTPUT": str(self.root / "outputs"),
            "IOS_ARCHIVE_DIR": str(self.root),
            "IOS_APP_TEST_SHARDS": "two",
            "IOS_APP_TEST_RECEIPTS": "true",
            "IOS_SERIAL_REFERENCE_RUN_ID": "101",
            "IOS_SERIAL_REFERENCE_ATTEMPT": "1",
            "IOS_XCODE_STARTUP_SAMPLING": "false",
            "IOS_ARCHIVE_CACHE_EXPERIMENT": "false",
        }

    def save_reference_api(self):
        (self.root / "run.json").write_text(json.dumps(self.run))
        (self.root / "jobs.json").write_text(json.dumps(self.jobs))

    def invoke(self, *arguments, env=None, success=True):
        result = subprocess.run(
            ["python3", str(SCRIPT), *map(str, arguments)],
            env=self.env | (env or {}),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def capture(self, role, cases, reference=False):
        log = self.root / f"{role}.log"
        log.write_text(console(cases))
        target = self.root / f"{role}.json"
        env = {"IOS_APP_TEST_PARTITION": role}
        if reference:
            env |= {"GITHUB_RUN_ID": "101", "GITHUB_RUN_ATTEMPT": "1"}
        self.invoke("receipt", log, target, env=env)
        return target

    def records(self):
        return (
            self.capture("all", CASES, reference=True),
            self.capture("a", CASES[:2]),
            self.capture("b", CASES[2:]),
        )

    def test_complete_union_includes_new_methods_and_new_classes(self):
        self.invoke("validate-inputs")
        self.assertIn("reference-attempt=1", (self.root / "outputs").read_text())
        result = self.invoke("verify", *self.records())
        self.assertIn("all 4 serial tests exactly once", result.stdout)

    def test_native_console_interleaving_does_not_lose_case_identities(self):
        log = self.root / "interleaved.log"
        log.write_text(console(CASES).replace("Test Case", "SDK output: Test Case"))
        self.invoke("receipt", log, self.root / "receipt.json")
        result = json.loads((self.root / "receipt.json").read_text())
        self.assertEqual(set(result["cases"]), {"OkouTests/" + case for case in CASES})

    def test_reference_must_be_an_exact_head_successful_full_manual_job(self):
        for field, value in (
            ("head_sha", "c" * 40),
            ("event", "pull_request"),
            ("conclusion", "failure"),
            ("status", "in_progress"),
        ):
            with self.subTest(field=field):
                original = self.run[field]
                self.run[field] = value
                self.save_reference_api()
                self.invoke("validate-inputs", success=False)
                self.run[field] = original
        self.jobs[0]["jobs"][0]["name"] = "build-test-a"
        self.save_reference_api()
        self.invoke("validate-inputs", success=False)

    def test_missing_reference_or_observed_candidate_is_rejected(self):
        for env in (
            {"IOS_SERIAL_REFERENCE_RUN_ID": ""},
            {"IOS_XCODE_STARTUP_SAMPLING": "true"},
            {"IOS_ARCHIVE_CACHE_EXPERIMENT": "true"},
            {"GITHUB_EVENT_NAME": "merge_group"},
        ):
            with self.subTest(env=env):
                self.invoke("validate-inputs", env=env, success=False)

    def test_automatic_events_cannot_select_partial_tests(self):
        for event in ("pull_request", "merge_group", "push"):
            self.invoke(
                "selectors", "a", env={"GITHUB_EVENT_NAME": event}, success=False
            )
            self.assertEqual(
                self.invoke(
                    "selectors", "all", env={"GITHUB_EVENT_NAME": event}
                ).stdout,
                "",
            )

    def test_failed_incomplete_duplicate_or_skipped_execution_cannot_emit_proof(self):
        text = console(CASES)
        for content in (
            "",
            text.rsplit("\n", 1)[0],
            text.replace("0 failures", "1 failures"),
            console(CASES + CASES[:1]),
            text.replace("passed (0.010 seconds).", "skipped.", 1),
        ):
            (self.root / "bad.log").write_text(content)
            self.invoke(
                "receipt", self.root / "bad.log", self.root / "bad.json", success=False
            )

    def test_foreign_attempt_toolchain_partition_or_incomplete_union_fails(self):
        paths = self.records()
        source = json.loads(paths[2].read_text())
        changes = (
            {"runAttempt": 1},
            {"toolchain": {"xcode": "another"}},
            {"commitSha": "c" * 40},
            {"partition": "a"},
            {"observed": True},
            {"cases": {}},
            {"cases": {"OkouTests/OtherTests/testOriginal": 0.01}},
            {"cases": {"OkouTests/" + CASES[0]: 0.01}},
        )
        for change in changes:
            with self.subTest(change=change):
                paths[2].write_text(json.dumps(source | change))
                self.invoke("verify", *paths, success=False)
        paths[2].unlink()
        self.invoke("verify", *paths, success=False)

    def test_real_ci_caller_selects_the_complement_and_preserves_failure(self):
        repo = self.root / "repo"
        scripts = repo / "ios/scripts"
        scripts.mkdir(parents=True)
        subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
        for name in ("ci-test.sh", "app-test-shards.py", "app-test-shard-a.txt"):
            shutil.copyfile(SCRIPTS / name, scripts / name)
        resolved = (
            repo
            / "ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        )
        resolved.parent.mkdir(parents=True)
        resolved.write_text("locked")
        build = self.root / "work/okou-ios-ci"
        products = build / "DerivedData/Build/Products"
        products.mkdir(parents=True)
        (products / "Okou.xctestrun").write_text("built tests")
        (build / "Package.resolved.before").write_text("locked")
        for role, expected, failed in (
            ("a", CASES[:2], False),
            ("b", CASES[2:], False),
            ("a", [], True),
        ):
            with self.subTest(role=role, failed=failed):
                env = self.env | {
                    "RUNNER_TEMP": str(self.root / "work"),
                    "IOS_TEST_DESTINATION": "platform=iOS Simulator,id=owned",
                    "IOS_APP_TEST_PARTITION": role,
                    "SHARD_TEST_CASES": json.dumps(CASES),
                    "SHARD_TEST_FAILURE": str(failed).lower(),
                }
                compiled = subprocess.run(
                    ["bash", str(scripts / "ci-test.sh"), "compile"],
                    cwd=repo,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(compiled.returncode, 0, compiled.stderr)
                result = subprocess.run(
                    ["bash", str(scripts / "ci-test.sh"), "run"],
                    cwd=repo,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 65 if failed else 0, result.stderr)
                if not failed:
                    record = json.loads(
                        (build / f"app-test-receipt-{role}.json").read_text()
                    )
                    self.assertEqual(
                        set(record["cases"]), {"OkouTests/" + x for x in expected}
                    )

    def test_required_gate_rejects_failed_cancelled_or_missing_shard_proof(self):
        env = self.env | {
            "EVENT_NAME": "workflow_dispatch",
            "DETECT_RESULT": "success",
            "SCRIPT_CHECKS_RESULT": "success",
            "IOS_NEEDED": "true",
            "PACKAGES_RESULT": "success",
            "BUILD_RESULT": "success",
            "ARCHIVE_RESULT": "skipped",
            "PUBLISH_RESULT": "skipped",
            "APP_TEST_SHARDS": "two",
        }
        for proof in ("success", "failure", "cancelled", "skipped", ""):
            result = subprocess.run(
                ["bash", str(SCRIPTS / "ci-gate.sh")],
                env=env | {"SHARD_PROOF_RESULT": proof},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode == 0, proof == "success", result.stderr)


if __name__ == "__main__":
    unittest.main()
