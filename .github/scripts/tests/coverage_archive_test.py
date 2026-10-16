"""Exercise artifact identity and full-workload rejection at the data boundary."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "coverage_archive",
    Path(__file__).resolve().parents[1] / "artifacts/coverage-archive.py",
)
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)


class CoverageArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.product = self.root / "product"
        self.product.mkdir()
        self.current = {
            "source_sha": "source-a",
            "workspace": str(Path.cwd().resolve()),
        }
        self.tests = {
            "test-count": 2,
            "rust-suites": {
                "suite": {
                    "package-id": "package",
                    "binary-id": "suite",
                    "kind": "test",
                    "status": "listed",
                    "testcases": {
                        "parent": {
                            "kind": "test",
                            "ignored": False,
                            "filter-match": {"status": "matches"},
                        },
                        "child": {
                            "kind": "test",
                            "ignored": True,
                            "filter-match": {"status": "matches"},
                        },
                    },
                }
            },
        }
        (self.product / "control-tests.json").write_text(json.dumps(self.tests))
        (self.product / "control-lcov.info").write_text(
            "SF:" + str(Path.cwd() / "crates/example.rs") + "\nend_of_record\n"
        )
        (self.product / "tests.tar.zst").write_bytes(
            b"transport bytes, not executed by this checker"
        )
        self.restored_tests = self.root / "restored-tests.json"
        self.restored_lcov = self.root / "restored-lcov.info"
        self.restored_tests.write_text(json.dumps(self.tests))
        self.restored_lcov.write_text("SF:crates/example.rs\nend_of_record\n")
        self.output = contextlib.redirect_stdout(io.StringIO())
        self.output.__enter__()
        self.addCleanup(self.output.__exit__, None, None, None)

    def test_verified_bytes_and_normalized_workload(self):
        archive.seal(self.product, self.current)
        archive.verify(self.product, self.current)
        archive.compare(self.product, self.restored_tests, self.restored_lcov)

    def test_source_or_tool_identity_change_rejected(self):
        archive.seal(self.product, self.current)
        for key in ("source_sha", "rustc", "run_attempt"):
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "identity mismatch"),
            ):
                archive.verify(self.product, {**self.current, key: "different"})

    def test_corruption_rejected_before_consumption(self):
        archive.seal(self.product, self.current)
        (self.product / "tests.tar.zst").write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            archive.verify(self.product, self.current)

    def test_symlink_product_rejected(self):
        archive.seal(self.product, self.current)
        path = self.product / "tests.tar.zst"
        outside = self.root / "other-archive"
        path.rename(outside)
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "invalid restored"):
            archive.verify(self.product, self.current)

    def test_omitted_case_rejected(self):
        del self.tests["rust-suites"]["suite"]["testcases"]["child"]
        self.tests["test-count"] = 1
        self.restored_tests.write_text(json.dumps(self.tests))
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            archive.compare(self.product, self.restored_tests, self.restored_lcov)

    def test_changed_ignored_or_filter_metadata_rejected(self):
        for key, value in [
            ("ignored", False),
            ("filter-match", {"status": "mismatch", "reason": "ignored"}),
        ]:
            with self.subTest(key=key):
                changed = json.loads(json.dumps(self.tests))
                changed["rust-suites"]["suite"]["testcases"]["child"][key] = value
                self.restored_tests.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, "inventory differs"):
                    archive.compare(
                        self.product, self.restored_tests, self.restored_lcov
                    )

    def test_omitted_empty_suite_rejected(self):
        empty = {
            **self.tests["rust-suites"]["suite"],
            "binary-id": "empty",
            "testcases": {},
        }
        self.tests["rust-suites"]["empty"] = empty
        (self.product / "control-tests.json").write_text(json.dumps(self.tests))
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            archive.compare(self.product, self.restored_tests, self.restored_lcov)

    def test_extra_coverage_source_rejected(self):
        self.restored_lcov.write_text(
            "SF:crates/example.rs\nSF:crates/stale.rs\nend_of_record\n"
        )
        with self.assertRaisesRegex(ValueError, "coverage source mismatch"):
            archive.compare(self.product, self.restored_tests, self.restored_lcov)

    def test_empty_coverage_rejected(self):
        self.restored_lcov.write_text("")
        with self.assertRaisesRegex(ValueError, "empty coverage"):
            archive.compare(self.product, self.restored_tests, self.restored_lcov)


if __name__ == "__main__":
    unittest.main()
