#!/usr/bin/env python3
"""Check JVM class size using the JUnit XML in a test results directory."""

from collections import Counter
from pathlib import Path
import sys
from xml.etree import ElementTree


MAX_CASES = 20


def violations(directory):
    counts = Counter()
    for report in sorted(directory.glob("TEST-*.xml")):
        for case in ElementTree.parse(report).iter("testcase"):
            # Match the top-level class boundary used by the Gradle shard filter.
            class_name = case.attrib["classname"].split("$", 1)[0]
            counts[class_name] += 1

    if not counts:
        return [f"No JVM JUnit cases found in {directory}"]

    errors = []
    for class_name, count in sorted(counts.items()):
        if count > MAX_CASES:
            errors.append(
                f"{class_name} has {count} JVM test cases (limit {MAX_CASES}). "
                f"Split independent behaviors into top-level classes of at most {MAX_CASES} cases."
            )
    return errors


if __name__ == "__main__":
    errors = violations(Path(sys.argv[1]))
    if errors:
        sys.exit("\n".join(errors))
