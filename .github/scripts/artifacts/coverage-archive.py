#!/usr/bin/env python3
"""Seal/verify a current-run coverage archive and compare fresh test/report inventories.

Run from the repository root with Python 3 and the pinned coverage tools on PATH.
Usage: coverage-archive.py seal|verify ARTIFACT_DIR
       coverage-archive.py compare ARTIFACT_DIR RESTORED_TESTS RESTORED_LCOV
No cache lookup, extraction, test execution or successful-result fallback is owned
here. A mismatch exits nonzero; callers must preserve that failure.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

PRODUCTS = ("tests.tar.zst", "control-tests.json", "control-lcov.info")


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def identity():
    subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], check=True)
    return {
        "source_sha": command("git", "rev-parse", "HEAD"),
        "source_tree": command("git", "rev-parse", "HEAD^{tree}"),
        "workspace": str(Path.cwd().resolve()),
        "rustc": command("rustc", "-vV"),
        "llvm_cov": command("cargo", "llvm-cov", "--version"),
        "nextest": command("cargo", "nextest", "--version"),
        "image": os.environ["COVERAGE_ARCHIVE_IMAGE"],
        "test_debug": os.environ["CARGO_PROFILE_TEST_DEBUG"],
        "profile_pattern": os.environ["LLVM_PROFILE_FILE_NAME"],
        "run_id": os.environ["GITHUB_RUN_ID"],
        "run_attempt": os.environ["COVERAGE_ARCHIVE_PRODUCER_ATTEMPT"],
    }


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(path):
    data = json.loads(path.read_text())
    suites = data["rust-suites"]
    if not isinstance(suites, dict) or not suites:
        raise ValueError("empty test suite inventory")
    normalized = {}
    count = 0
    for key, suite in suites.items():
        cases = suite["testcases"]
        if suite["status"] != "listed" or not isinstance(cases, dict):
            raise ValueError("test suite was not completely listed")
        for case in cases.values():
            if type(case["ignored"]) is not bool or not isinstance(
                case["filter-match"], dict
            ):
                raise ValueError("invalid test selection metadata")
        count += len(cases)
        normalized[key] = {
            name: suite[name]
            for name in ("package-id", "binary-id", "kind", "status", "testcases")
        }
    if count == 0 or data["test-count"] != count:
        raise ValueError("invalid discovered test count")
    return normalized


def sources(path, root):
    found = set()
    prefix = str(root) + "/"
    with path.open() as stream:
        for line in stream:
            if line.startswith("SF:"):
                name = line[3:].rstrip("\r\n")
                if not name:
                    raise ValueError("empty coverage source path")
                found.add(name.removeprefix(prefix))
    if not found:
        raise ValueError("empty coverage report")
    return found


def seal(directory, current):
    inventory(directory / "control-tests.json")
    sources(directory / "control-lcov.info", current["workspace"])
    products = {}
    for name in PRODUCTS:
        path = directory / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError("missing or invalid archive product: " + name)
        products[name] = {"sha256": file_digest(path), "bytes": path.stat().st_size}
    receipt = {"schema": 1, "identity": current, "products": products}
    with (directory / "identity.json").open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print(json.dumps(receipt, indent=2))


def verify(directory, current):
    receipt = json.loads((directory / "identity.json").read_text())
    if receipt["schema"] != 1 or receipt["identity"] != current:
        raise ValueError(
            "archive producer source/tool/environment/run identity mismatch"
        )
    if set(receipt["products"]) != set(PRODUCTS):
        raise ValueError("archive product inventory mismatch")
    for name in PRODUCTS:
        path = directory / name
        expected = receipt["products"][name]
        if path.is_symlink() or not path.is_file():
            raise ValueError("invalid restored archive product: " + name)
        if (
            path.stat().st_size != expected["bytes"]
            or file_digest(path) != expected["sha256"]
        ):
            raise ValueError("archive product checksum mismatch: " + name)
    print("Current-run source, tools, environment and product bytes verified.")


def compare(directory, restored_tests, restored_lcov):
    if inventory(directory / "control-tests.json") != inventory(restored_tests):
        raise ValueError(
            "restored test/ignored/filter inventory differs from the control"
        )
    root = Path.cwd().resolve()
    expected = sources(directory / "control-lcov.info", root)
    actual = sources(restored_lcov, root)
    if expected != actual:
        raise ValueError(
            f"coverage source mismatch: {len(expected - actual)} missing, {len(actual - expected)} extra"
        )
    result = {
        "test_inventory_equal": True,
        "coverage_source_sets_equal": True,
        "coverage_sources": len(actual),
        "coverage_source_set_sha256": hashlib.sha256(
            ("\n".join(sorted(actual)) + "\n").encode()
        ).hexdigest(),
        "net_ci_speedup": "not established by inventory equality",
    }
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    for name in ("seal", "verify", "compare"):
        operation = commands.add_parser(name)
        operation.add_argument("directory", type=Path)
        if name == "compare":
            operation.add_argument("restored_tests", type=Path)
            operation.add_argument("restored_lcov", type=Path)
    args = parser.parse_args()
    if args.operation == "compare":
        compare(args.directory, args.restored_tests, args.restored_lcov)
    else:
        {"seal": seal, "verify": verify}[args.operation](args.directory, identity())


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"coverage archive validation failed: {error}", file=sys.stderr)
        sys.exit(1)
