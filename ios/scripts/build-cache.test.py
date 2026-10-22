#!/usr/bin/env python3
"""Exercise native cache identity and main-only warm routing without cache writes."""

import ast
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def yaml(path):
    return json.loads(subprocess.check_output(["yq", "-o=json", ".", str(path)]))


def compare_literals(expression):
    expression = expression.replace("&&", " and ").replace("||", " or ")
    comparison = ast.parse(expression, mode="eval").body
    if isinstance(comparison, ast.BoolOp):
        values = [compare_literals(ast.unparse(value)) for value in comparison.values]
        if isinstance(comparison.op, ast.And):
            return all(values)
        if isinstance(comparison.op, ast.Or):
            return any(values)
        raise ValueError("Unsupported cache-routing boolean operator")
    if not isinstance(comparison, ast.Compare) or len(comparison.ops) != 1:
        raise ValueError("Expected one literal cache-routing comparison")
    left = ast.literal_eval(comparison.left)
    right = ast.literal_eval(comparison.comparators[0])
    if isinstance(comparison.ops[0], ast.Eq):
        return left == right
    if isinstance(comparison.ops[0], ast.NotEq):
        return left != right
    raise ValueError("Unsupported cache-routing comparison")


class BuildCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        scripts = self.repo / "ios/scripts"
        scripts.mkdir(parents=True)
        shutil.copy2(ROOT / "ios/scripts/archive-promotion.py", scripts)
        self.resolved = (
            self.repo
            / "ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
        )
        self.resolved.parent.mkdir(parents=True)
        self.resolved.write_text('{"pins": []}\n')
        self.git("init", "-q")
        self.git("config", "user.name", "Cache Test")
        self.git("config", "user.email", "cache@example.invalid")
        self.commit()
        mock = self.root / "bin"
        mock.mkdir()
        for name in ("xcodebuild", "xcrun"):
            executable = mock / name
            executable.write_text(
                "#!/bin/sh\n"
                'if [ "${0##*/}" = xcodebuild ]; then\n'
                '  printf "Xcode 27.1\\nBuild version %s\\n" "${TEST_XCODE:-27A9275}"\n'
                "else\n"
                '  printf "%s-%s\\n" "$2" "${TEST_SDK:-SDK-build}"\n'
                "fi\n"
            )
            executable.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{mock}:{os.environ['PATH']}",
            "RUNNER_TEMP": str(self.root),
            "GITHUB_OUTPUT": str(self.root / "outputs"),
            "IOS_TEST_DESTINATION": "platform=iOS Simulator,name=iPhone 18 Pro,OS=27.0",
        }
        self.action = yaml(ROOT / ".github/actions/setup-ios-build-cache/action.yml")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture inputs")

    def identity(self):
        output = Path(self.env["GITHUB_OUTPUT"])
        output.write_text("")
        script = next(
            step["run"]
            for step in self.action["runs"]["steps"]
            if step.get("id") == "identity"
        )
        subprocess.run(
            ["bash", "-euo", "pipefail", "-c", script],
            cwd=self.repo,
            env=self.env,
            check=True,
        )
        return dict(line.split("=", 1) for line in output.read_text().splitlines())

    def test_cache_identity_tracks_sources_lock_and_actual_toolchain(self):
        initial = self.identity()
        (self.repo / "unrelated.txt").write_text("outside native inputs\n")
        self.commit()
        self.assertEqual(initial, self.identity())
        (self.repo / "ios/App.swift").write_text("let value = 1\n")
        self.commit()
        changed = self.identity()
        self.assertEqual(initial["dependencies-key"], changed["dependencies-key"])
        self.assertNotEqual(initial["compilation-key"], changed["compilation-key"])
        self.assertEqual(initial["compilation-prefix"], changed["compilation-prefix"])
        self.resolved.write_text('{"pins": ["changed revision"]}\n')
        self.commit()
        locked = self.identity()
        self.assertNotEqual(changed["dependencies-key"], locked["dependencies-key"])
        self.assertNotEqual(changed["compilation-key"], locked["compilation-key"])
        for key, value in (
            ("TEST_XCODE", "different-Xcode-build"),
            ("TEST_SDK", "different-SDK-build"),
            ("IOS_TEST_DESTINATION", "platform=iOS Simulator,name=iPad,OS=27.0"),
        ):
            with self.subTest(input=key):
                self.env[key] = value
                changed_toolchain = self.identity()
                self.assertNotEqual(
                    locked["dependencies-key"], changed_toolchain["dependencies-key"]
                )
                self.assertNotEqual(
                    locked["compilation-prefix"],
                    changed_toolchain["compilation-prefix"],
                )
                del self.env[key]

    def test_only_selected_main_jobs_can_write_caches(self):
        workflow = yaml(ROOT / ".github/workflows/ios-build-cache.yml")
        source = yaml(ROOT / ".github/workflows/ios.yml")
        self.assertIn(source["name"], workflow["on"]["workflow_run"]["workflows"])
        self.assertEqual(
            source["jobs"]["build-test"].get("name", "build-test"), "build-test"
        )
        for role, job in workflow["jobs"].items():
            for ref in (
                "refs/heads/main",
                "refs/pull/1/merge",
                "refs/heads/gh-readonly-queue/main/pr-1",
            ):
                for needed in ("true", "false", ""):
                    condition = (
                        job["if"]
                        .replace("github.ref", repr(ref))
                        .replace("needs.detect.outputs.needed", repr(needed))
                    )
                    self.assertEqual(
                        compare_literals(condition),
                        ref == "refs/heads/main"
                        and (role == "detect" or needed == "true"),
                    )
        warm = workflow["jobs"]["warm"]
        self.assertFalse(warm["concurrency"]["cancel-in-progress"])
        checkout = next(
            step
            for step in warm["steps"]
            if step.get("uses", "").startswith("actions/checkout@")
        )
        self.assertEqual(checkout["with"]["ref"], "${{ github.sha }}")
        self.assertFalse(checkout["with"]["persist-credentials"])

    def test_exact_hits_skip_only_the_work_already_cached(self):
        workflow = yaml(ROOT / ".github/workflows/ios-build-cache.yml")
        steps = {
            step["id"]: step
            for step in workflow["jobs"]["warm"]["steps"]
            if "if" in step
        }
        for dependencies in ("true", "false", ""):
            for compilation in ("true", "false", ""):
                needed = {
                    "prepare": dependencies != "true" or compilation != "true",
                    "save-dependencies": dependencies != "true",
                    "compile": compilation != "true",
                    "save-compilation": compilation != "true",
                }
                for role, step in steps.items():
                    condition = (
                        step["if"]
                        .replace(
                            "steps.cache.outputs.dependencies-hit", repr(dependencies)
                        )
                        .replace(
                            "steps.cache.outputs.compilation-hit", repr(compilation)
                        )
                    )
                    self.assertEqual(compare_literals(condition), needed[role])

    def test_producer_and_restore_paths_and_keys_match(self):
        workflow = yaml(ROOT / ".github/workflows/ios-build-cache.yml")
        restores = {
            step["id"]: step
            for step in self.action["runs"]["steps"]
            if step.get("id") in ("dependencies", "compilation")
        }
        for role in ("dependencies", "compilation"):
            save = next(
                step
                for step in workflow["jobs"]["warm"]["steps"]
                if step.get("id") == f"save-{role}"
            )
            self.assertEqual(save["with"]["path"], restores[role]["with"]["path"])
            self.assertEqual(
                save["with"]["key"].replace(
                    "steps.cache.outputs.", "steps.identity.outputs."
                ),
                restores[role]["with"]["key"],
            )

    def warm_decision(self, event, jobs, source="okou-ai/okou", api_status=0):
        workflow = yaml(ROOT / ".github/workflows/ios-build-cache.yml")
        script = workflow["jobs"]["detect"]["steps"][0]["run"]
        response = self.root / "jobs.json"
        response.write_text(json.dumps({"jobs": jobs}))
        request = self.root / "request"
        output = Path(self.env["GITHUB_OUTPUT"])
        request.unlink(missing_ok=True)
        output.write_text("")
        gh = self.root / "bin/gh"
        gh.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, subprocess, sys\n"
            "from pathlib import Path\n"
            "Path(os.environ['TEST_REQUEST']).write_text(json.dumps(sys.argv[1:]))\n"
            "if int(os.environ['TEST_API_STATUS']):\n"
            "    sys.exit(int(os.environ['TEST_API_STATUS']))\n"
            "query = sys.argv[sys.argv.index('--jq') + 1]\n"
            "subprocess.run(['jq', '-r', query, os.environ['TEST_RESPONSE']], check=True)\n"
        )
        gh.chmod(0o755)
        result = subprocess.run(
            ["bash", "-euo", "pipefail", "-c", script],
            cwd=self.repo,
            env=self.env
            | {
                "EVENT_NAME": event,
                "SOURCE_REPOSITORY": source,
                "SOURCE_RUN_ID": "123",
                "GITHUB_REPOSITORY": "okou-ai/okou",
                "GH_TOKEN": "fixture",
                "TEST_REQUEST": str(request),
                "TEST_RESPONSE": str(response),
                "TEST_API_STATUS": str(api_status),
            },
            check=False,
            capture_output=True,
            text=True,
        )
        return result, output.read_text(), request.exists()

    def test_native_completion_heals_cache_but_skipped_jobs_and_forks_do_not(self):
        for outcome in ("success", "failure", "cancelled", "skipped"):
            with self.subTest(outcome=outcome):
                result, output, requested = self.warm_decision(
                    "workflow_run",
                    [
                        {
                            "name": "build-test",
                            "conclusion": outcome,
                            "runner_id": 1234,
                        }
                    ],
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    output, f"needed={str(outcome != 'skipped').lower()}\n"
                )
                self.assertTrue(requested)
        result, output, _ = self.warm_decision(
            "workflow_run", [{"name": "script-checks", "conclusion": "success"}]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "needed=false\n")
        result, output, _ = self.warm_decision(
            "workflow_run",
            [
                {
                    "name": "build-test",
                    "conclusion": "cancelled",
                    "runner_id": None,
                }
            ],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "needed=false\n")
        result, output, requested = self.warm_decision(
            "workflow_run",
            [{"name": "build-test", "conclusion": "success", "runner_id": 1234}],
            source="someone/fork",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "needed=false\n")
        self.assertFalse(requested)

    def test_main_push_and_manual_dispatch_warm_without_reading_pr_jobs(self):
        for event in ("push", "workflow_dispatch"):
            result, output, requested = self.warm_decision(event, [])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output, "needed=true\n")
            self.assertFalse(requested)

    def test_failed_source_job_lookup_fails_instead_of_skipping_recovery(self):
        result, output, requested = self.warm_decision("workflow_run", [], api_status=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")
        self.assertTrue(requested)


if __name__ == "__main__":
    unittest.main()
