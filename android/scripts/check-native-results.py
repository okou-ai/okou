#!/usr/bin/env python3
"""Verify a complete native suite from DIRECTORY EXPECTED_CASES [DIRECTORY ...]."""

from pathlib import Path
import sys
from xml.parsers import expat


def read_cases(directory):
    if (directory / "test-result-exit-code.txt").read_text().strip() != "0":
        raise ValueError(f"Native test runner did not exit successfully in {directory}")
    identities = set()

    def element(name, attributes):
        if name == "testcase":
            identity = (attributes["classname"], attributes["name"])
            if identity in identities:
                raise ValueError(f"Duplicate native case {identity} in {directory}")
            identities.add(identity)
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
    if not identities:
        raise ValueError(f"No native cases ran in {directory}")
    return identities


def check(directories, expected):
    identities = set()
    for directory in directories:
        cases = read_cases(directory)
        duplicates = sorted(identities & cases)
        if duplicates:
            raise ValueError(f"Duplicate native cases across shards: {duplicates}")
        identities.update(cases)
    if len(identities) != expected:
        raise ValueError(f"Expected {expected} distinct native cases, received {len(identities)}")
    print(f"All {expected} native cases passed")


if __name__ == "__main__":
    check([Path(directory) for directory in [sys.argv[1], *sys.argv[3:]]], int(sys.argv[2]))
