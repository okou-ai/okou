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
    comparison = ast.parse(expression, mode="eval").body
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

    def test_only_main_warms_and_exact_hits_skip_compilation(self):
        workflow = yaml(ROOT / ".github/workflows/ios-build-cache.yml")
        for job in workflow["jobs"].values():
            for ref in (
                "refs/heads/main",
                "refs/pull/1/merge",
                "refs/heads/gh-readonly-queue/main/pr-1",
            ):
                condition = job["if"].replace("github.ref", repr(ref))
                self.assertEqual(compare_literals(condition), ref == "refs/heads/main")
            for step in job["steps"]:
                if "if" not in step:
                    continue
                for hit in ("true", "false", ""):
                    condition = (
                        step["if"]
                        .replace("steps.cache.outputs.dependencies-hit", repr(hit))
                        .replace("steps.cache.outputs.compilation-hit", repr(hit))
                    )
                    self.assertEqual(compare_literals(condition), hit != "true")

    def test_producer_and_restore_paths_and_keys_match(self):
        workflow = yaml(ROOT / ".github/workflows/ios-build-cache.yml")
        restores = {
            step["id"]: step
            for step in self.action["runs"]["steps"]
            if step.get("id") in ("dependencies", "compilation")
        }
        for role, job in workflow["jobs"].items():
            save = next(
                step
                for step in job["steps"]
                if step.get("uses", "").startswith("actions/cache/save@")
            )
            self.assertEqual(save["with"]["path"], restores[role]["with"]["path"])
            self.assertEqual(
                save["with"]["key"].replace(
                    "steps.cache.outputs.", "steps.identity.outputs."
                ),
                restores[role]["with"]["key"],
            )


if __name__ == "__main__":
    unittest.main()
