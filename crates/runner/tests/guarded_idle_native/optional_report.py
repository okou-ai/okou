#!/usr/bin/env python3
"""Validate guarded Ready optional preparation, complete reads and required saving."""

import argparse
import hashlib
import json
import pathlib

import pressure_report
import report

PREFIX = "NATIVE_OPTIONAL_WITNESS "
CASES = {f"Optional{scope}-{mode}" for scope in ("Ordinary", "Aged")
         for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "preparation_accepted", "preparation_published",
          "producers_joined")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    metadata = collector["metadata"]
    raw_policy = metadata["native_optional_policy_json"]
    raw_inputs = metadata["native_optional_inputs_json"]
    if not isinstance(raw_policy, str) or not isinstance(raw_inputs, str):
        raise ValueError("optional raw policy/inputs missing")
    if hashlib.sha256(raw_policy.encode()).hexdigest() != result["artifacts"]["policy_sha256"]:
        raise ValueError("optional policy hash mismatch")
    policy = json.loads(raw_policy, object_pairs_hook=pressure_report.unique_object)
    inputs = json.loads(raw_inputs, object_pairs_hook=pressure_report.unique_object)
    if (not isinstance(policy, dict) or set(policy) != pressure_report.POLICY_FIELDS
            or any(not pressure_report.integer(v, 1) for v in policy.values())):
        raise ValueError("invalid optional supplied policy")
    if (not isinstance(inputs, dict) or set(inputs) != {
            "snapshot_path", "snapshot_memory_mb", "prefetch_overhead_bytes"}
            or not isinstance(inputs["snapshot_path"], str)
            or not pathlib.PurePosixPath(inputs["snapshot_path"]).is_absolute()
            or pathlib.PurePosixPath(inputs["snapshot_path"]).name != "memory.bin"
            or ".." in pathlib.PurePosixPath(inputs["snapshot_path"]).parts
            or type(inputs["snapshot_memory_mb"]) is not int
            or inputs["snapshot_memory_mb"] != result["artifacts"]["profile"]["memory_mib"]
            or not pressure_report.integer(inputs["prefetch_overhead_bytes"], 1024**2)):
        raise ValueError("invalid original optional snapshot inputs")
    snapshot_bytes = metadata["native_optional_snapshot_bytes"]
    if (not pressure_report.integer(snapshot_bytes, 1)
            or snapshot_bytes > inputs["snapshot_memory_mb"] * 1024**2):
        raise ValueError("optional snapshot byte length missing or out of bounds")
    protected = policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
    required = max(protected + 4096 * 1024**2 + policy["replacement_preparation_bytes"],
                   protected + inputs["snapshot_memory_mb"] * 1024**2
                   + inputs["prefetch_overhead_bytes"], policy["recovery_available_bytes"])
    if (not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or required > policy["host_total_bytes"]
            or policy["tail_growth_bytes"] < 65 * 1024**2
            or policy["max_cleanup_inflight"] < 2):
        raise ValueError("invalid optional admission bounds")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):])
        if (event.get("case") not in CASES or type(event.get("version")) is not int
                or event["version"] != 1
                or not report.positive_integer(event.get("monotonic_ns"))
                or not report.positive_integer(event.get("unix_ns"))):
            raise ValueError("invalid optional witness")
        witnesses[event["case"]].append(event)
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing, duplicate or unordered optional witnesses")
        identity = (terminal[1]["sandbox_id"], terminal[1]["backing_generation"])
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events),
                  terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("optional work lost original generation/phase ordering")
        original, accepted, prepared, joined = [e["evidence"] for e in events]
        aged = case.startswith("OptionalAged-")
        expected = {
            "policy": policy, "optional_inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"],
            "snapshot_bytes": snapshot_bytes, "snapshot_memory_mb": inputs["snapshot_memory_mb"],
            "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "allocated": [2, 4096, 1], "aged": aged,
        }
        if (original != expected or original.get("aged") is not aged
                or json.dumps(original.get("policy"), sort_keys=True) != json.dumps(policy, sort_keys=True)
                or any(type(v) is not int for v in original.get("allocated", []))
                or any(type(original.get(k)) is not int for k in (
                    "snapshot_bytes", "snapshot_memory_mb", "prefetch_overhead_bytes"))):
            raise ValueError("optional original input/hash/shape/budget differs")
        if (set(accepted) != {"state", "wave_inflight", "available_bytes", "age_ns",
                             "read_duration_ns", "allocated"}
                or accepted["state"] != "Ready" or accepted["wave_inflight"] is not False
                or accepted["allocated"] != [2, 4096, 1]
                or any(type(v) is not int for v in accepted["allocated"])
                or not pressure_report.integer(accepted["available_bytes"])
                or not required <= accepted["available_bytes"] <= policy["host_total_bytes"]
                or not pressure_report.integer(accepted["age_ns"])
                or not pressure_report.integer(accepted["read_duration_ns"])
                or not accepted["read_duration_ns"] <= accepted["age_ns"]
                < policy["max_sample_age_millis"] * 1_000_000):
            raise ValueError("optional preparation lacks actual fresh fitting Ready observation")
        if (set(prepared) != {"prepared", "published", "retired_exact", "finished",
                             "retained_resource", "error"}
                or any(prepared[k] is not True for k in ("prepared", "published", "finished"))
                or prepared["retired_exact"] is not aged
                or prepared["retained_resource"] is not False or prepared["error"] is not None):
            raise ValueError("optional preparation/publication did not positively complete")
        counts = {"accepted": 1, "completed": 1, "cancelled": 0, "failed": 0,
                  "uncertain": 0, "read_bytes": snapshot_bytes}
        flags = {"finished": True, "pressure_stopped": True, "producer_lost": False,
                 "prefetch_drained": True, "blank_shutdown_joined": True}
        if (joined != counts | flags or any(type(joined.get(k)) is not int for k in counts)
                or any(joined.get(k) is not v for k, v in flags.items())):
            raise ValueError("optional complete original read/producer joins missing")
        result["cases"][case]["optional"] = {
            "snapshot_bytes": snapshot_bytes,
            "snapshot_sha256": original["snapshot_sha256"],
            "optional_inputs_sha256": original["optional_inputs_sha256"],
            "aged": aged, "accepted": accepted,
        }
    result["remaining_parent_gate"] = (
        "startup/foreground/progress and suppression/recovery in #40173; "
        "native failure/provenance/residency/envelopes in #39998 and parents/P4")
    return {"format": "native-optional-phase-report-v1",
            "native_optional_ready_corpus_complete": True, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2))
