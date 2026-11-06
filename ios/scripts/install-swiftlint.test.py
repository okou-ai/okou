"""Exercise installer publication and integrity with an external download fixture."""

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="swiftlint install ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.ios = self.root / "ios"
        scripts = self.ios / "scripts"
        scripts.mkdir(parents=True)
        source = Path(__file__).resolve().parent
        shutil.copy2(source / "install-swiftlint.sh", scripts)
        self.installer = scripts / "install-swiftlint.sh"
        self.version = next(
            line.removeprefix("version=")
            for line in (source.parent / ".swiftlint-version").read_text().splitlines()
            if line.startswith("version=")
        )
        self.archive = self.root / "release.zip"
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr(
                "swiftlint", f'#!/usr/bin/env bash\nprintf "{self.version}\\n"\n'
            )
            archive.writestr("LICENSE", "Fixture license\n")
        self.pin(hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.command("uname", '#!/usr/bin/env bash\nprintf "Darwin\\n"\n')
        self.command(
            "curl",
            '#!/usr/bin/env bash\nset -eu\n'
            'while [[ "$1" != --output ]]; do shift; done\n'
            'cp "$SWIFTLINT_TEST_ARCHIVE" "$2"\n',
        )
        self.env = dict(
            os.environ,
            PATH=f"{self.bin}:{os.environ['PATH']}",
            SWIFTLINT_TEST_ARCHIVE=str(self.archive),
        )
        self.binary = self.ios / ".tools" / "swiftlint" / self.version / "swiftlint"

    def command(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def pin(self, checksum):
        (self.ios / ".swiftlint-version").write_text(
            f"version={self.version}\nsha256={checksum}\n"
        )

    def run_installer(self, *args):
        return subprocess.run(
            ["bash", str(self.installer), *args],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_verified_install_is_available_offline(self):
        installed = self.run_installer()
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(installed.stdout.strip(), str(self.binary))
        self.assertEqual((self.binary.parent / "LICENSE").read_text(), "Fixture license\n")
        self.command("curl", "#!/usr/bin/env bash\nexit 97\n")
        cached = self.run_installer("--path-only")
        self.assertEqual(cached.returncode, 0, cached.stderr)
        self.assertEqual(cached.stdout, installed.stdout)
        self.assertEqual(list(self.binary.parent.glob(".download.*")), [])

    def test_checksum_mismatch_does_not_publish_an_executable(self):
        self.pin("0" * 64)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertFalse(self.binary.exists())
        self.assertEqual(list(self.binary.parent.glob(".download.*")), [])

    def test_cached_version_must_match_pin(self):
        self.binary.parent.mkdir(parents=True)
        self.binary.write_text('#!/usr/bin/env bash\nprintf "0.0.0\\n"\n')
        self.binary.chmod(0o755)
        result = self.run_installer("--path-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match", result.stderr)


if __name__ == "__main__":
    unittest.main()
