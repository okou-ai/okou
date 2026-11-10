"""Exercise native-linter publication, provenance and offline verification."""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="native lint install ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.ios = self.root / "ios"
        source = Path(__file__).resolve().parent
        shutil.copytree(
            source.parent / "Tools" / "SwiftLint", self.ios / "Tools" / "SwiftLint"
        )
        (self.ios / "scripts").mkdir()
        shutil.copy2(source / "install-swiftlint.sh", self.ios / "scripts")
        self.installer = self.ios / "scripts" / "install-swiftlint.sh"
        self.upstream = self.root / "upstream"
        extension = self.upstream / "Source" / "SwiftLintExtraRules"
        extension.mkdir(parents=True)
        (extension / "Exports.swift").write_text("// Fixture upstream export\n")
        (self.upstream / "LICENSE").write_text("Fixture license\n")
        self.git("init", "--quiet")
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture",
        )
        self.revision = self.git("rev-parse", "HEAD").stdout.strip()
        (self.ios / ".swiftlint-version").write_text(
            f"version=0.65.1\nrevision={self.revision}\n"
        )
        cached_source = self.ios / ".tools" / "swiftlint" / "source" / self.revision
        cached_source.parent.mkdir(parents=True)
        shutil.move(self.upstream, cached_source)
        self.compiler = self.root / "bin"
        self.compiler.mkdir()
        self.output = self.root / "output"
        self.output.mkdir()
        binary = self.output / "swiftlint"
        binary.write_text('#!/usr/bin/env bash\nprintf "0.65.1\\n"\n')
        binary.chmod(0o755)
        swift = self.compiler / "swift"
        swift.write_text(
            "#!/usr/bin/env bash\nset -eu\n"
            'if [[ "$*" == "--version" ]]; then echo "Fixture Swift";\n'
            'elif [[ "$*" == *"--show-bin-path"* ]]; then echo "$SWIFTLINT_FIXTURE_OUTPUT";\n'
            'elif [[ "$SWIFTLINT_FIXTURE_FAIL" == 1 ]]; then exit 9; fi\n'
        )
        swift.chmod(0o755)
        self.env = dict(
            os.environ,
            PATH=f"{self.compiler}:{os.environ['PATH']}",
            SWIFTLINT_FIXTURE_OUTPUT=str(self.output),
            SWIFTLINT_FIXTURE_FAIL="0",
        )

    def git(self, *args):
        return subprocess.run(
            ["git", *args],
            cwd=self.upstream,
            check=True,
            capture_output=True,
            text=True,
        )

    def invoke(self, *args):
        return subprocess.run(
            ["bash", str(self.installer), *args],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def install(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.strip())

    def test_installed_binary_is_available_offline(self):
        binary = self.install()
        self.assertEqual((binary.parent / "LICENSE").read_text(), "Fixture license\n")
        receipt = json.loads((binary.parent / "receipt.json").read_text())
        self.assertEqual(receipt["revision"], self.revision)
        self.assertEqual(
            receipt["sha256"], hashlib.sha256(binary.read_bytes()).hexdigest()
        )
        self.env["PATH"] = os.environ["PATH"]
        cached = self.invoke("--path-only")
        self.assertEqual(cached.returncode, 0, cached.stderr)
        self.assertEqual(cached.stdout.strip(), str(binary))

    def test_changed_rule_sources_reject_old_binary(self):
        binary = self.install()
        rules = self.ios / "Tools" / "SwiftLint" / "Rules"
        (rules / "NewRule.swift").write_text("// A different rule build\n")
        result = self.invoke("--verify", str(binary))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)

    def test_changed_binary_is_rejected(self):
        binary = self.install()
        binary.write_text('#!/usr/bin/env bash\nprintf "0.65.1\\n"\n# changed\n')
        result = self.invoke("--path-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)

    def test_wrong_version_is_not_published(self):
        (self.output / "swiftlint").write_text(
            '#!/usr/bin/env bash\nprintf "0.0.0\\n"\n'
        )
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("version does not match", result.stderr)
        self.assertEqual(
            list((self.ios / ".tools" / "swiftlint").glob("*/receipt.json")), []
        )

    def test_failed_compilation_is_not_published(self):
        self.env["SWIFTLINT_FIXTURE_FAIL"] = "1"
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            list((self.ios / ".tools" / "swiftlint").glob("*/receipt.json")), []
        )

    def test_missing_binary_does_not_build_in_offline_mode(self):
        result = self.invoke("--path-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("install-swiftlint.sh", result.stderr)


if __name__ == "__main__":
    unittest.main()
