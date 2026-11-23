#!/usr/bin/env python3
"""Exercise the JVM class size check against Gradle-style JUnit reports."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from xml.etree import ElementTree


CHECK = Path(__file__).with_name("check-jvm-test-counts.py")


class JvmTestCountsTest(unittest.TestCase):
    def check_counts(self, counts):
        with tempfile.TemporaryDirectory() as directory:
            for class_name, count in counts.items():
                report = ElementTree.Element("testsuite", name=class_name, tests=str(count))
                for index in range(count):
                    ElementTree.SubElement(
                        report, "testcase", classname=class_name, name=f"case[{index}]"
                    )
                ElementTree.ElementTree(report).write(Path(directory) / f"TEST-{class_name}.xml")
            return subprocess.run([sys.executable, CHECK, directory], capture_output=True, text=True)

    def test_counts_nested_classes_and_parameterized_invocations_together(self):
        at_limit = self.check_counts({"app.RouteTest": 12, "app.RouteTest$Nested": 8})
        self.assertEqual(at_limit.returncode, 0, at_limit.stderr)

        over_limit = self.check_counts({"app.RouteTest": 12, "app.RouteTest$Nested": 9})
        self.assertNotEqual(over_limit.returncode, 0)
        self.assertIn("app.RouteTest has 21 JVM test cases (limit 20)", over_limit.stderr)

    def test_existing_oversized_class_can_keep_its_count(self):
        class_name = "ai.okou.android.ChatListRootTest"
        at_limit = self.check_counts({class_name: 48, "app.RouteTest": 20})
        self.assertEqual(at_limit.returncode, 0, at_limit.stderr)

        over_limit = self.check_counts({class_name: 49})
        self.assertNotEqual(over_limit.returncode, 0)
        self.assertIn(f"{class_name} has 49 JVM test cases (limit 48)", over_limit.stderr)

    def test_missing_cases_fail_the_check(self):
        result = self.check_counts({})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No JVM JUnit cases found", result.stderr)


if __name__ == "__main__":
    unittest.main()
