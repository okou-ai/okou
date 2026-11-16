#!/usr/bin/env python3
"""Require a complete, successful native suite: DIRECTORY EXPECTED_CASES."""

from pathlib import Path
import sys
from xml.parsers import expat


def check(directory, expected):
    if (directory / "test-result-exit-code.txt").read_text().strip() != "0":
        raise ValueError("Native test runner did not exit successfully")
    count = 0
    identities = set()

    def element(name, attributes):
        nonlocal count
        if name == "testcase":
            count += 1
            identities.add((attributes["classname"], attributes["name"]))
        if name in {"failure", "error", "skipped"}:
            raise ValueError("Native results contain a failure, error or skipped test")
        if name in {"testsuites", "testsuite"}:
            if any(int(attributes.get(key, "0")) for key in ("failures", "errors", "skipped")):
                raise ValueError("Native suite summary reports unsuccessful tests")

    def reject_declaration(*_):
        raise ValueError("Native JUnit reports must not contain DTDs or entities")

    parser = expat.ParserCreate()
    parser.StartElementHandler = element
    # Reject DTDs before processing any internal/external entity declarations.
    # Event parsing also avoids building a DOM for an oversized report.
    parser.StartDoctypeDeclHandler = reject_declaration
    parser.EntityDeclHandler = reject_declaration
    parser.ExternalEntityRefHandler = reject_declaration
    with (directory / "TEST-pixel2Api35.xml").open("rb") as report:
        parser.ParseFile(report)
    if count != expected or len(identities) != expected:
        raise ValueError(f"Expected {expected} distinct native cases; received {count}")
    print(f"All {expected} native cases passed")


if __name__ == "__main__":
    check(Path(sys.argv[1]), int(sys.argv[2]))
