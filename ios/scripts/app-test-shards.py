#!/usr/bin/env python3
"""Qualify manual App test shards against an exact-head complete serial run.

Ordinary CI remains a complete serial suite. Receipts contain test identities,
durations and provenance, never console output or test payloads.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

PARTITION = Path(__file__).with_name("app-test-shard-a.txt")
TEST_STEP = "Build app and run isolated simulator tests"
CASE = re.compile(
    r"Test Case '-\[OkouTests\.(\w+) (test\w+)\]' passed "
    r"\(([0-9.]+) seconds\)\.",
)
SUMMARY = re.compile(
    r"Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\) in"
)


def partition():
    classes = PARTITION.read_text().splitlines()
    if (
        not classes
        or len(classes) != len(set(classes))
        or not all(re.fullmatch(r"[A-Za-z_]\w*", name) for name in classes)
    ):
        raise ValueError("Expected unique XCTest class names in the partition")
    return classes


def partition_hash():
    return hashlib.sha256("\n".join(partition()).encode()).hexdigest()


def github(route):
    return json.loads(subprocess.check_output(["gh", "api", route], text=True))


def reference_run(run_id, attempt=None):
    if not re.fullmatch(r"[1-9][0-9]*", str(run_id)):
        raise ValueError("Two shards require a successful serial reference run ID")
    route = f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{run_id}"
    if attempt is not None:
        route += f"/attempts/{attempt}"
    run = github(route)
    if (
        run["head_sha"] != os.environ["GITHUB_SHA"]
        or run["event"] != "workflow_dispatch"
        or run["path"] != ".github/workflows/ios.yml"
        or run["status"] != "completed"
        or run["conclusion"] != "success"
        or run["id"] == int(os.environ["GITHUB_RUN_ID"])
    ):
        raise ValueError("Reference must be a successful exact-head manual iOS run")
    pages = json.loads(
        subprocess.check_output(
            ["gh", "api", route + "/jobs?per_page=100", "--paginate", "--slurp"],
            text=True,
        )
    )
    jobs = [job for page in pages for job in page["jobs"]]
    serial = [job for job in jobs if job["name"] == "build-test"]
    if (
        len(serial) != 1
        or serial[0]["conclusion"] != "success"
        or not any(
            step["name"] == TEST_STEP and step["conclusion"] == "success"
            for step in serial[0]["steps"]
        )
    ):
        raise ValueError("Reference must contain the successful complete serial job")
    return run["run_attempt"]


def validate_inputs():
    mode = os.environ.get("IOS_APP_TEST_SHARDS", "one") or "one"
    if mode not in ("one", "two"):
        raise ValueError("Expected one or two App test jobs")
    if mode == "two":
        if os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch":
            raise ValueError("App sharding is manual-only during qualification")
        if any(
            os.environ.get(key) == "true"
            for key in ("IOS_XCODE_STARTUP_SAMPLING", "IOS_ARCHIVE_CACHE_EXPERIMENT")
        ):
            raise ValueError("Sharding comparisons cannot enable other experiments")
        attempt = reference_run(os.environ.get("IOS_SERIAL_REFERENCE_RUN_ID", ""))
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write(f"reference-attempt={attempt}\n")


def selectors(role):
    if role != "all" and os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        raise ValueError("Partial App test selection is manual-only")
    if role != "all":
        flag = "only-testing" if role == "a" else "skip-testing"
        for name in partition():
            print(f"-{flag}:OkouTests/{name}")


def receipt(log, output):
    if os.environ["GITHUB_EVENT_NAME"] != "workflow_dispatch":
        raise ValueError("Only manual runs produce experiment receipts")
    role = os.environ.get("IOS_APP_TEST_PARTITION", "all")
    if role not in ("all", "a", "b"):
        raise ValueError("Invalid App test partition")
    text = log.read_text()
    selected = set(partition())
    cases = {}
    for name, method, seconds in CASE.findall(text):
        identity = f"OkouTests/{name}/{method}"
        if identity in cases:
            raise ValueError("A test executed more than once")
        if role != "all" and ((name in selected) != (role == "a")):
            raise ValueError("A test executed outside its assigned partition")
        cases[identity] = float(seconds)
    summaries = SUMMARY.findall(text)
    if (
        not cases
        or not summaries
        or tuple(map(int, summaries[-1]))
        != (
            len(cases),
            0,
            0,
        )
    ):
        raise ValueError("Missing complete successful XCTest result or case identities")
    inputs = json.loads(
        (Path(os.environ["IOS_ARCHIVE_DIR"]) / "inputs.json").read_text()
    )
    record = {
        "version": 1,
        "repository": os.environ["GITHUB_REPOSITORY"],
        "commitSha": os.environ["GITHUB_SHA"],
        "event": os.environ["GITHUB_EVENT_NAME"],
        "runId": int(os.environ["GITHUB_RUN_ID"]),
        "runAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "partition": role,
        "partitionSha256": partition_hash(),
        "testInputSha256": inputs["testInputSha256"],
        "toolchain": inputs["toolchain"],
        "observed": any(
            os.environ.get(key) == "true"
            for key in ("IOS_XCODE_STARTUP_SAMPLING", "IOS_ARCHIVE_CACHE_EXPERIMENT")
        ),
        "cases": cases,
    }
    output.write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
    print(f"Recorded {len(cases)} passed App tests for partition {role}")


def verify(reference, shards):
    records = [json.loads(path.read_text()) for path in (reference, *shards)]
    control, first, second = records
    selected = set(partition())
    if [record["partition"] for record in records] != ["all", "a", "b"]:
        raise ValueError(
            "Expected a complete serial reference and both distinct shards"
        )
    shared = (
        "version",
        "repository",
        "commitSha",
        "event",
        "partitionSha256",
        "testInputSha256",
        "toolchain",
        "observed",
    )
    if any(record[key] != control[key] for record in records for key in shared):
        raise ValueError("Source, configuration, toolchain or partition inputs differ")
    if (
        control["version"] != 1
        or control["observed"]
        or control["repository"] != os.environ["GITHUB_REPOSITORY"]
        or control["commitSha"] != os.environ["GITHUB_SHA"]
        or control["event"] != "workflow_dispatch"
        or control["partitionSha256"] != partition_hash()
    ):
        raise ValueError("Expected unobserved exact-source manual experiment evidence")
    expected_attempt = int(os.environ["IOS_SERIAL_REFERENCE_ATTEMPT"])
    if (
        control["runId"] != int(os.environ["IOS_SERIAL_REFERENCE_RUN_ID"])
        or control["runAttempt"] != expected_attempt
        or reference_run(control["runId"], expected_attempt) != expected_attempt
    ):
        raise ValueError("Serial reference run identity differs")
    for record in (first, second):
        if (
            record["runId"] != int(os.environ["GITHUB_RUN_ID"])
            or record["runAttempt"] != int(os.environ["GITHUB_RUN_ATTEMPT"])
            or not record["cases"]
        ):
            raise ValueError("Missing current-attempt shard results")
        for identity in record["cases"]:
            if not re.fullmatch(r"OkouTests/\w+/test\w+", identity) or (
                (identity.split("/")[1] in selected) != (record["partition"] == "a")
            ):
                raise ValueError("Unexpected test in shard results")
    left, right = set(first["cases"]), set(second["cases"])
    if left & right or left | right != set(control["cases"]):
        raise ValueError("Shards must cover the entire serial suite exactly once")
    print(f"Both shards cover all {len(control['cases'])} serial tests exactly once")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("validate-inputs")
    selection = commands.add_parser("selectors")
    selection.add_argument("partition", choices=("all", "a", "b"))
    capture = commands.add_parser("receipt")
    capture.add_argument("log", type=Path)
    capture.add_argument("output", type=Path)
    check = commands.add_parser("verify")
    check.add_argument("reference", type=Path)
    check.add_argument("a", type=Path)
    check.add_argument("b", type=Path)
    args = parser.parse_args()
    if args.command == "validate-inputs":
        validate_inputs()
    elif args.command == "selectors":
        selectors(args.partition)
    elif args.command == "receipt":
        receipt(args.log, args.output)
    else:
        verify(args.reference, (args.a, args.b))


if __name__ == "__main__":
    main()
