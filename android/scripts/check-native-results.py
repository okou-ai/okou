#!/usr/bin/env python3
"""Require a complete, successful native suite: DIRECTORY EXPECTED_CASES."""

from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def check(directory, expected):
    if (directory / "test-result-exit-code.txt").read_text().strip() != "0":
        raise ValueError("Native test runner did not exit successfully")
    report = ET.parse(directory / "TEST-pixel2Api35.xml").getroot()
    cases = report.findall(".//testcase")
    identities = {(case.attrib["classname"], case.attrib["name"]) for case in cases}
    if len(cases) != expected or len(identities) != expected:
        raise ValueError(f"Expected {expected} distinct native cases; received {len(cases)}")
    if any(list(report.iter(tag)) for tag in ("failure", "error", "skipped")):
        raise ValueError("Native results contain a failure, error or skipped test")
    for suite in report.iter():
        if suite.tag in {"testsuites", "testsuite"}:
            if any(int(suite.attrib.get(key, "0")) for key in ("failures", "errors", "skipped")):
                raise ValueError("Native suite summary reports unsuccessful tests")
    print(f"All {expected} native cases passed")


if __name__ == "__main__":
    check(Path(sys.argv[1]), int(sys.argv[2]))
