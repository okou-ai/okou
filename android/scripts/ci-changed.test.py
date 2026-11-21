"""Exercise change selection through real Git histories, including the whole merge group."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("ci-changed.sh")


class ChangeSelectionTest(unittest.TestCase):
    def test_native_shared_and_renamed_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True).strip()

            def write(path):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("input")

            def commit():
                git("add", "--all")
                git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
                return git("rev-parse", "HEAD")

            def detect(base, event="merge_group", check=True):
                env = dict(os.environ, EVENT_NAME=event, MERGE_GROUP_BASE_SHA=base, PUSH_BEFORE_SHA=base)
                result = subprocess.run(["bash", str(SCRIPT)], cwd=root, env=env, text=True, capture_output=True)
                if check:
                    self.assertEqual(result.returncode, 0, result.stderr)
                return result

            def expect(base, needed, shallow="false", event="merge_group"):
                self.assertEqual(
                    detect(base, event).stdout.splitlines(),
                    [f"needed={needed}", f"shallow-discovery={shallow}"],
                )

            git("init", "--quiet", "--initial-branch=main")
            git("config", "user.name", "Android CI Test")
            git("config", "user.email", "android-ci@example.invalid")
            write("unrelated.txt")
            base = commit()
            expect(base, "false")
            write("android/app/source.kt")
            first = commit()
            write("other.txt")
            commit()
            expect(base, "true")
            expect(first, "false")
            expect(base, "true", event="push")
            git("mv", "android/app/source.kt", "moved.kt")
            commit()
            expect(first, "true")
            current = git("rev-parse", "HEAD")
            write("turbo/packages/ui/src/styles/globals.css")
            commit()
            expect(current, "true")
            for path in ["turbo/packages/api-contracts/src/contracts/user-preferences.ts",
                         ".github/workflows/android-screenshots.yml",
                         "turbo/apps/platform/src/views/css/index.css",
                         "ios/Okou/DesignSystem/Foundations/Lucide-LICENSE.txt",
                         "turbo/packages/api-contracts/src/kotlin-bindings/bindings.ts",
                         "turbo/packages/api-contracts/src/validators/user-preferences.ts",
                         ".github/scripts/artifacts/sign-okou-android-apk.sh",
                         ".github/scripts/release/archive-android-mapping.py",
                         ".github/scripts/tests/android-release-workflow-test.sh"]:
                current = git("rev-parse", "HEAD")
                write(path)
                commit()
                expect(current, "true")
            current = git("rev-parse", "HEAD")
            write(".github/scripts/checks/android_launcher.py")
            commit()
            expect(current, "true")
            for path in (
                "android/settings.gradle.kts", "android/app/build.gradle.kts",
                "android/app/gradle.properties", "android/gradle/libs.versions.toml",
                "android/gradle/wrapper/gradle-wrapper.jar", "android/gradlew",
                "android/version.txt", "android/scripts/version-code.sh",
                "android/scripts/ci-changed.sh", ".github/workflows/android.yml",
                ".github/scripts/checks/changed-base-ref.sh",
            ):
                with self.subTest(path=path):
                    current = git("rev-parse", "HEAD")
                    write(path)
                    commit()
                    expect(current, "true", "true")
                    expect(current, "true", "true", event="push")
            current = git("rev-parse", "HEAD")
            git("mv", "android/settings.gradle.kts", "renamed.txt")
            commit()
            expect(current, "true", "true")
            expect(base, "true", "true", event="workflow_dispatch")
            self.assertNotEqual(detect(base, "unsupported", check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
