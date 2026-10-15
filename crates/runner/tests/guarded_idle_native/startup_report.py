#!/usr/bin/env python3
"""Validate actual startup snapshot completion and joined native read owners."""

import argparse
import hashlib
import json
import pathlib

import critical_report
import pressure_report
import report

PREFIX = "NATIVE_STARTUP_WITNESS "
CASES = {f"Startup-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "initial_unknown", "startup_completed", "producers_joined")
BYTES = 4 * 1024**3


def exact(actual, expected, reason):
    # JSON distinguishes booleans and integers, including in nested leases.
    if json.dumps(actual, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise ValueError(reason)


def complete(read):
    exact(read, {"accepted": 1, "completed": 1, "cancelled": 0, "failed": 0,
                 "read_bytes": BYTES, "last_error": None}, "startup complete original read missing")


def original_inputs(metadata, artifacts, prefix):
    raw_policy, raw_inputs = metadata[prefix+"_policy_json"], metadata[prefix+"_inputs_json"]
    if (not isinstance(raw_policy, str) or not isinstance(raw_inputs, str)
            or hashlib.sha256(raw_policy.encode()).hexdigest() != artifacts["policy_sha256"]):
        raise ValueError("startup raw policy/hash mismatch")
    policy = json.loads(raw_policy, object_pairs_hook=pressure_report.unique_object)
    inputs = json.loads(raw_inputs, object_pairs_hook=pressure_report.unique_object)
    if (not isinstance(policy, dict) or set(policy) != pressure_report.POLICY_FIELDS
            or any(not pressure_report.integer(v, 1) for v in policy.values())
            or not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or not 2 <= policy["max_cleanup_inflight"] <= policy["max_operations"]
            or policy["tail_growth_bytes"] < 65 * 1024**2):
        raise ValueError("invalid startup supplied policy")
    protected = policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
    if (protected > policy["recovery_available_bytes"] or not isinstance(inputs, dict)
            or set(inputs) != {"snapshot_path", "snapshot_memory_mb", "prefetch_overhead_bytes"}
            or not isinstance(inputs["snapshot_path"], str)
            or not pathlib.PurePosixPath(inputs["snapshot_path"]).is_absolute()
            or pathlib.PurePosixPath(inputs["snapshot_path"]).name != "memory.bin"
            or ".." in pathlib.PurePosixPath(inputs["snapshot_path"]).parts
            or type(inputs["snapshot_memory_mb"]) is not int or inputs["snapshot_memory_mb"] != 4096
            or not pressure_report.integer(inputs["prefetch_overhead_bytes"], 1024**2)
            or protected + BYTES + inputs["prefetch_overhead_bytes"] > policy["host_total_bytes"]
            or type(metadata[prefix+"_snapshot_bytes"]) is not int
            or metadata[prefix+"_snapshot_bytes"] != BYTES):
        raise ValueError("invalid startup original input/shape/bounds")
    return policy, inputs, raw_inputs


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw_inputs = original_inputs(collector["metadata"], result["artifacts"], "native_startup")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure_report.unique_object)
        if (not isinstance(event, dict) or event.get("case") not in CASES
                or type(event.get("version")) is not int or event["version"] != 1
                or not report.positive_integer(event.get("monotonic_ns"))
                or not report.positive_integer(event.get("unix_ns"))):
            raise ValueError("invalid startup witness")
        witnesses[event["case"]].append(event)
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered startup witnesses")
        identity = (terminal[1]["sandbox_id"], terminal[1]["backing_generation"])
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[2]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("startup original identity/ownership ordering changed")
        initial, unknown, done, joined = [e["evidence"] for e in events]
        exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"],
            "snapshot_bytes": BYTES, "snapshot_memory_mb": 4096,
            "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "allocated": [2, 4096, 1], "startup_pressure_guarded": False},
            "startup original inputs/full lease or admission claim changed")
        for value, finished in ((unknown, False), (done, False), (joined, True)):
            critical_report.no_reads(value.get("reads"), finished)
        exact(unknown, {"state": "Unknown", "reads": unknown.get("reads"),
            "registered_operations": 0, "tracked_tasks": 0}, "startup runtime is not Unknown/quiescent")
        complete(done.get("startup"))
        exact(done, {"startup": done["startup"], "startup_drained": True, "state": "Unknown",
            "reads": done.get("reads"), "allocated": [2, 4096, 1],
            "registered_operations": 0, "tracked_tasks": 0}, "startup read owner/original lease changed")
        complete(joined.get("startup"))
        exact(joined, {"startup": joined["startup"], "startup_drained": True,
            "reads": joined.get("reads"), "runtime_drained": True,
            "pressure_stopped": True, "producer_lost": False, "wave_inflight": False,
            "snapshot_reverified": True, "registered_operations": 0, "tracked_tasks": 0},
            "startup physical producer joins incomplete")
        result["cases"][case]["startup"] = {"witnesses": events, "startup_pressure_guarded": False}
    result["remaining_parent_gate"] = "40353 foreground/heartbeat contention; 40355 accepted cancellation/late results and final reconciliation"
    return {"format": "native-startup-phase-report-v1", "native_startup_corpus_complete": True,
            "startup_pressure_guarded": False, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
