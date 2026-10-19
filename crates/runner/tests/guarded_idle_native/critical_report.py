#!/usr/bin/env python3
"""Validate native bounded Critical waves sharing P2 with suppressed runtime reads."""

import argparse
import hashlib
import json
import pathlib
import uuid

import pressure_report
import report

PREFIX = "NATIVE_CRITICAL_WITNESS "
CASES = {f"Critical-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "initial_unknown", "critical_observed",
          "wave_completed", "wave_completed", "wave_completed", "producers_joined")


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**64 - 1


def no_reads(value, finished):
    counts = {key: 0 for key in ("accepted", "completed", "cancelled", "failed",
                                "uncertain", "deferred", "read_bytes")}
    if (not isinstance(value, dict) or value != counts | {"last_error": None, "finished": finished}
            or any(type(value.get(key)) is not int for key in counts)
            or value.get("finished") is not finished):
        raise ValueError("Critical optional reader was not suppressed/joined")


def validate_cases(directory, cases):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, cases, report.PHASES)
    metadata = collector["metadata"]
    raw_policy = metadata["native_critical_policy_json"]
    raw_inputs = metadata["native_critical_inputs_json"]
    if (not isinstance(raw_policy, str) or not isinstance(raw_inputs, str)
            or hashlib.sha256(raw_policy.encode()).hexdigest() != result["artifacts"]["policy_sha256"]):
        raise ValueError("Critical raw policy/hash mismatch")
    policy = json.loads(raw_policy, object_pairs_hook=pressure_report.unique_object)
    inputs = json.loads(raw_inputs, object_pairs_hook=pressure_report.unique_object)
    if (not isinstance(policy, dict) or set(policy) != pressure_report.POLICY_FIELDS
            or any(not integer(v, 1) for v in policy.values())
            or not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or not 2 <= policy["max_cleanup_inflight"] <= policy["max_operations"]
            or policy["tail_growth_bytes"] < 65 * 1024**2
            or policy["pressure_max_wave_entries"] != 1):
        raise ValueError("invalid Critical single-entry policy")
    protected = policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
    if protected > policy["recovery_available_bytes"]:
        raise ValueError("invalid Critical protected bounds")
    if (not isinstance(inputs, dict) or set(inputs) != {
            "snapshot_path", "snapshot_memory_mb", "prefetch_overhead_bytes"}
            or not isinstance(inputs["snapshot_path"], str)
            or not pathlib.PurePosixPath(inputs["snapshot_path"]).is_absolute()
            or pathlib.PurePosixPath(inputs["snapshot_path"]).name != "memory.bin"
            or ".." in pathlib.PurePosixPath(inputs["snapshot_path"]).parts
            or type(inputs["snapshot_memory_mb"]) is not int or inputs["snapshot_memory_mb"] != 4096
            or not integer(inputs["prefetch_overhead_bytes"], 1024**2)):
        raise ValueError("invalid Critical original snapshot inputs")
    size = metadata["native_critical_snapshot_bytes"]
    if (type(size) is not int or size != 4096 * 1024**2
            or protected + 4096 * 1024**2 + inputs["prefetch_overhead_bytes"] > policy["host_total_bytes"]):
        raise ValueError("Critical declared read does not fit supplied bounds")
    witnesses = {case: [] for case in cases}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure_report.unique_object)
        if (not isinstance(event, dict) or event.get("case") not in cases
                or type(event.get("version")) is not int or event["version"] != 1
                or not integer(event.get("monotonic_ns"), 1) or not integer(event.get("unix_ns"), 1)):
            raise ValueError("invalid Critical witness")
        witnesses[event["case"]].append(event)
    sandbox_ids = {events[1]["sandbox_id"] for events in terminals.values()}
    generations = {events[1]["backing_generation"] for events in terminals.values()}
    limit = policy["max_sample_age_millis"] * 1_000_000
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered Critical witnesses")
        identity = (terminal[1]["sandbox_id"], terminal[1]["backing_generation"])
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("Critical original identity/ordering changed")
        initial, unknown, critical = [e["evidence"] for e in events[:3]]
        blanks = initial.get("blanks")
        if not isinstance(blanks, list) or len(blanks) != 2:
            raise ValueError("Critical original blank cohort missing")
        for blank in blanks:
            if not isinstance(blank, dict) or set(blank) != {"sandbox_id", "backing_generation"}:
                raise ValueError("invalid Critical blank identity")
            for key, seen in (("sandbox_id", sandbox_ids), ("backing_generation", generations)):
                value = blank[key]
                if not isinstance(value, str) or str(uuid.UUID(value)) != value or value in seen:
                    raise ValueError("Critical blank physical generation was reused")
                seen.add(value)
        expected = {"policy": policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                    "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"],
                    "snapshot_bytes": size, "snapshot_memory_mb": 4096,
                    "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
                    "blanks": blanks, "allocated": [6, 12288, 3], "profile_can_fit": True}
        if json.dumps(initial, sort_keys=True) != json.dumps(expected, sort_keys=True):
            raise ValueError("Critical input identity/full leases changed")
        if (set(unknown) != {"state", "reads", "registered_operations", "tracked_tasks"}
                or unknown["state"] != "Unknown" or unknown["registered_operations"] != 0
                or type(unknown["registered_operations"]) is not int
                or unknown["tracked_tasks"] != 0 or type(unknown["tracked_tasks"]) is not int):
            raise ValueError("Critical initial Unknown had physical work")
        no_reads(unknown["reads"], False)
        if (set(critical) != {"state", "available_bytes", "wave_inflight", "reads"}
                or critical["state"] != "Critical" or type(critical["wave_inflight"]) is not bool):
            raise ValueError("Critical classification absent")
        no_reads(critical["reads"], False)
        waves = events[3:6]
        for index, event in enumerate(waves, 1):
            wave = event["evidence"]
            counts = {"index": index, "selected": 1, "completed": 1, "uncertain": 0,
                      "not_started": 0, "skipped": 0}
            expected = counts | {"stop": None, "status_error": False, "resolved": True,
                "state": "Critical", "available_bytes": wave.get("available_bytes"),
                "completion_observed_ns": wave.get("completion_observed_ns"),
                "allocated": [2*(3-index), 4096*(3-index), 3-index], "reads": wave.get("reads")}
            if (json.dumps(wave, sort_keys=True) != json.dumps(expected, sort_keys=True)
                    or any(type(wave.get(k)) is not int for k in counts)):
                raise ValueError("Critical wave was oversized/incomplete or lost full leases")
            no_reads(wave["reads"], False)
            if (not integer(wave["completion_observed_ns"], 1)
                    or not events[index+1]["monotonic_ns"] < wave["completion_observed_ns"] < event["monotonic_ns"]):
                raise ValueError("Critical completion observation clock missing")
        joined = events[-1]["evidence"]
        exits = [{"backing_generation": b["backing_generation"], "exit_confirmed": True} for b in blanks]
        expected = {"waves": 3, "reads": joined.get("reads"), "prefetch_drained": True,
            "pressure_stopped": True, "producer_lost": False, "wave_inflight": False,
            "blank_exits": exits, "allocated": [0, 0, 0], "inventory_empty": True,
            "registered_operations": 0, "tracked_tasks": 0, "snapshot_reverified": True,
            "samples": joined.get("samples")}
        if json.dumps(joined, sort_keys=True) != json.dumps(expected, sort_keys=True):
            raise ValueError("Critical physical/logical producer joins incomplete")
        no_reads(joined["reads"], True)
        samples = joined["samples"]
        if not isinstance(samples, list) or len(samples) < 3:
            raise ValueError("Critical independent actual samples missing")
        previous = -1
        for sample in samples:
            if (not isinstance(sample, dict) or set(sample) != {"started_ns", "finished_ns",
                    "read_start_offset_ns", "available_bytes", "age_ns", "read_duration_ns"}
                    or any(not integer(v) for v in sample.values())
                    or not sample["started_ns"] < sample["finished_ns"] < events[-1]["monotonic_ns"]
                    or sample["read_start_offset_ns"] <= previous
                    or not sample["read_duration_ns"] <= sample["age_ns"] < limit
                    or sample["age_ns"] > sample["finished_ns"] - sample["started_ns"]
                    or sample["available_bytes"] > policy["host_total_bytes"]):
                raise ValueError("Critical actual source clock/age invalid")
            previous = sample["read_start_offset_ns"]
        active_samples = [s for s in samples if s["started_ns"] > events[1]["monotonic_ns"]]
        if (len(active_samples) < 3 or any(s["available_bytes"] > policy["critical_available_bytes"] for s in active_samples)):
            raise ValueError("Critical real supplied-policy condition absent")
        for event in (events[2], *waves):
            available = event["evidence"]["available_bytes"]
            fresh = [s for s in active_samples if s["finished_ns"] <= event["monotonic_ns"]
                     and s["age_ns"] + event["monotonic_ns"] - s["finished_ns"] < limit
                     and s["available_bytes"] == available]
            if not integer(available) or available > policy["critical_available_bytes"] or not fresh:
                raise ValueError("Critical decision lacks fresh actual source evidence")
            if event["phase"] == "wave_completed" and not any(
                    s["started_ns"] > event["evidence"]["completion_observed_ns"] for s in fresh):
                raise ValueError("Critical wave reused a pre-completion observation")
        if waves[-1]["monotonic_ns"] <= terminal[4]["monotonic_ns"]:
            raise ValueError("Critical final wave preceded original durable tail")
        result["cases"][case]["critical"] = {"witnesses": events,
            "supplied_policy_classification_only": True, "numerical_shortage_or_relief_proven": False}
    result["remaining_parent_gate"] = "40297 startup/foreground/heartbeat/provider cancellation and late results; 39998/higher provenance/residency/envelopes"
    return {"format": "native-critical-phase-report-v1", "native_critical_multiwave_complete": True, **result}


def validate(directory):
    return validate_cases(directory, CASES)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
