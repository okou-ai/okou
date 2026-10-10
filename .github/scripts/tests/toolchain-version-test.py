"""Exercise canonical pin extraction through its public shell CLI."""

import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EXTRACTOR = ROOT / "scripts/toolchain-version.sh"


class ToolchainVersionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.template = self.root / "build-template.sh"

    def extract(self, pin="UV_VERSION"):
        return subprocess.run(
            ["sh", str(EXTRACTOR), pin, str(self.template)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_uv_follows_template_updates_without_a_python_pin(self):
        for version in ("0.12.23", "0.13.0"):
            with self.subTest(version=version):
                self.template.write_text(f'UV_VERSION="{version}"\n')
                result = self.extract()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, version + "\n")

    def test_template_is_not_executed(self):
        marker = self.root / "executed"
        self.template.write_text(f'touch "{marker}"\nUV_VERSION="0.12.23"\n')
        self.assertEqual(self.extract().returncode, 0)
        self.assertFalse(marker.exists())

    def test_invalid_pins_are_rejected_without_output(self):
        for content in (
            'PYTHON_VERSION="3.14.0"\n',
            'UV_VERSION="0.12.23"\nUV_VERSION="0.13.0"\n',
            'UV_VERSION="0.12.23"\n export UV_VERSION="0.13.0"\n',
            'UV_VERSION="0.13.0-rc1"\n',
            "UV_VERSION=0.12.23\n",
            'UV_VERSION="$(echo 0.12.23)"\n',
        ):
            with self.subTest(content=content):
                self.template.write_text(content)
                result = self.extract()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("error:", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_missing_source_is_rejected(self):
        result = self.extract()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_unknown_pin_is_rejected(self):
        self.template.write_text('UV_VERSION="0.12.23"\n')
        result = self.extract("NOT_A_TOOLCHAIN_PIN")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported toolchain pin", result.stderr)


if __name__ == "__main__":
    unittest.main()
