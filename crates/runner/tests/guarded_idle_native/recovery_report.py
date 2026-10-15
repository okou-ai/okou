#!/usr/bin/env python3
"""Accept source-bound native observation-gap/recovery and complete-read evidence."""

import argparse
import hashlib
import json
import pathlib

import pressure_report
import report

PREFIX = "NATIVE_RECOVERY_WITNESS "
CASES = {f"Recovery-{mode}" for mode in ("fresh", "snapshot")}
PHASES = (
    "inputs_verified", "initial_unknown", "initial_recovering", "initial_ready",
    "stale_admission_wait", "waited_grant_revoked", "cadence_refused", "burst_armed",
    "burst_recovering", "burst_expired", "sustained_started", "sustained_recovering",
    "sustained_ready", "read_accepted", "read_accepted", "producers_joined",
)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    metadata = collector["metadata"]
    raw_policy = metadata["native_recovery_policy_json"]
    raw_inputs = metadata["native_recovery_inputs_json"]
    if not isinstance(raw_policy, str) or not isinstance(raw_inputs, str):
        raise ValueError("recovery raw inputs missing")
    if hashlib.sha256(raw_policy.encode()).hexdigest() != result["artifacts"]["policy_sha256"]:
        raise ValueError("recovery policy hash differs")
    policy = json.loads(raw_policy, object_pairs_hook=pressure_report.unique_object)
    inputs = json.loads(raw_inputs, object_pairs_hook=pressure_report.unique_object)
    if (not isinstance(policy, dict) or set(policy) != pressure_report.POLICY_FIELDS
            or any(not integer(v, 1) for v in policy.values())
            or not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or policy["max_cleanup_inflight"] < 2
            or policy["max_cleanup_inflight"] > policy["max_operations"]
            or policy["tail_growth_bytes"] < 65 * 1024**2):
        raise ValueError("invalid recovery policy")
    if (not isinstance(inputs, dict) or set(inputs) != {
            "snapshot_path", "snapshot_memory_mb", "prefetch_overhead_bytes"}
            or not isinstance(inputs["snapshot_path"], str)
            or not pathlib.PurePosixPath(inputs["snapshot_path"]).is_absolute()
            or pathlib.PurePosixPath(inputs["snapshot_path"]).name != "memory.bin"
            or ".." in pathlib.PurePosixPath(inputs["snapshot_path"]).parts
            or type(inputs["snapshot_memory_mb"]) is not int
            or inputs["snapshot_memory_mb"] != 4096
            or not integer(inputs["prefetch_overhead_bytes"], 1024**2)):
        raise ValueError("invalid original recovery snapshot")
    size = metadata["native_recovery_snapshot_bytes"]
    if not integer(size, 1) or size > inputs["snapshot_memory_mb"] * 1024**2:
        raise ValueError("recovery original byte length invalid")
    required = (policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
                + inputs["snapshot_memory_mb"] * 1024**2 + inputs["prefetch_overhead_bytes"])
    if required > policy["host_total_bytes"]:
        raise ValueError("recovery read cannot fit supplied bounds")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure_report.unique_object)
        if (event.get("case") not in CASES or type(event.get("version")) is not int
                or event["version"] != 1 or not integer(event.get("monotonic_ns"), 1)
                or not integer(event.get("unix_ns"), 1)):
            raise ValueError("invalid recovery witness")
        witnesses[event["case"]].append(event)
    age_limit = policy["max_sample_age_millis"] * 1_000_000
    sustain = policy["pressure_recovery_sustain_millis"] * 1_000_000
    cadence = policy["pressure_optional_start_interval_millis"] * 1_000_000
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered recovery witnesses")
        identity = (terminal[1]["sandbox_id"], terminal[1]["backing_generation"])
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events),
                  terminal[2]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("recovery changed original generation or phase clocks")
        by_phase = {e["phase"]: e for e in events}
        proofs = {e["phase"]: e["evidence"] for e in events}
        expected = {"policy": policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                    "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"],
                    "snapshot_bytes": size, "snapshot_memory_mb": 4096,
                    "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
                    "distinct_verified_copies": 2, "allocated": [2, 4096, 1]}
        if (json.dumps(proofs["inputs_verified"], sort_keys=True) != json.dumps(expected, sort_keys=True)):
            raise ValueError("recovery original inputs/hash/budget differ")
        for phase, state in (
                ("initial_unknown", "Unknown"), ("initial_recovering", "Recovering"),
                ("initial_ready", "Ready"), ("stale_admission_wait", "Unknown"),
                ("burst_armed", "Unknown"), ("burst_recovering", "Recovering"),
                ("burst_expired", "Unknown"), ("sustained_recovering", "Recovering"),
                ("sustained_ready", "Ready")):
            value = proofs[phase]
            if (set(value) != {"state", "available_bytes", "unknown", "wave_inflight"}
                    or value["state"] != state or value["wave_inflight"] is not False):
                raise ValueError("invalid actual recovery decision")
            if state == "Unknown":
                reason = "NotObserved" if phase == "initial_unknown" else "Stale"
                if value["available_bytes"] is not None or value["unknown"] != f"Observation({reason})":
                    raise ValueError("unknown recovery decision lost actual reason")
            elif (value["unknown"] is not None or not integer(value["available_bytes"])
                  or not policy["recovery_available_bytes"] <= value["available_bytes"] <= policy["host_total_bytes"]):
                raise ValueError("recovery decision lacks actual fitting observation")
        refused = proofs["cadence_refused"]
        if (set(refused) != {"elapsed_ns", "fresh_read_since_offer", "second_offer"}
                or not integer(refused["elapsed_ns"], 1) or refused["elapsed_ns"] >= cadence
                or not 0 <= by_phase["cadence_refused"]["monotonic_ns"] - by_phase["initial_ready"]["monotonic_ns"] - refused["elapsed_ns"] < age_limit
                or refused["fresh_read_since_offer"] is not True or refused["second_offer"] is not False):
            raise ValueError("shared cadence refusal missing")
        if (proofs["waited_grant_revoked"] != {"fresh_grant_joined": True,
                "old_offer_valid": False, "physical_work_started": False, "recovered_ready": True}
                or any(type(v) is not bool for v in proofs["waited_grant_revoked"].values())):
            raise ValueError("waited fresh grant revived old opportunity")
        if (proofs["sustained_started"] != {"accepted": 0, "registered_operations": 0, "tracked_tasks": 0}
                or any(type(v) is not int for v in proofs["sustained_started"].values())):
            raise ValueError("read started before sustained recovery")
        accepted = [e for e in events if e["phase"] == "read_accepted"]
        for count, event in enumerate(accepted, 1):
            value = event["evidence"]
            if (set(value) != {"accepted", "completed", "read_bytes"}
                    or type(value["accepted"]) is not int or value["accepted"] != count
                    or not integer(value["completed"]) or value["completed"] >= count
                    or not integer(value["read_bytes"]) or value["read_bytes"] != value["completed"] * size):
                raise ValueError("missing separate actual read acceptance")
        joined = proofs["producers_joined"]
        expected_join = {"accepted": 2, "completed": 2, "cancelled": 0, "failed": 0,
                         "uncertain": 0, "deferred": 0, "last_error": None,
                         "read_bytes": 2*size, "finished": True,
                         "prefetch_drained": True, "pressure_stopped": True,
                         "producer_lost": False, "admission_joined": True, "copies_reverified": True}
        if (set(joined) != set(expected_join) | {"samples"}
                or any(type(joined[k]) is not type(v) or joined[k] != v for k, v in expected_join.items())):
            raise ValueError("complete recovery read and physical producer joins missing")
        samples = joined["samples"]
        previous = 0
        for sample in samples:
            if (set(sample) != {"started_ns", "finished_ns", "read_start_offset_ns", "available_bytes", "age_ns", "read_duration_ns"}
                    or any(not integer(sample[k], 1) for k in ("started_ns", "finished_ns", "available_bytes"))
                    or not integer(sample["read_start_offset_ns"], 1)
                    or sample["read_start_offset_ns"] <= previous
                    or sample["finished_ns"] <= sample["started_ns"]
                    or not integer(sample["age_ns"]) or not integer(sample["read_duration_ns"])
                    or not sample["read_duration_ns"] <= sample["age_ns"] < age_limit
                    or sample["age_ns"] > sample["finished_ns"] - sample["started_ns"]
                    or not required <= sample["available_bytes"] <= policy["host_total_bytes"]
                    or sample["finished_ns"] >= by_phase["producers_joined"]["monotonic_ns"]):
                raise ValueError("invalid actual source observation clocks/headroom")
            previous = sample["read_start_offset_ns"]
        def observations(start, end):
            return [s for s in samples if by_phase[start]["monotonic_ns"] < s["started_ns"]
                    and s["finished_ns"] < by_phase[end]["monotonic_ns"]]
        if not observations("initial_ready", "cadence_refused"):
            raise ValueError("cadence refusal has no distinct fresh source read")
        for start, end in (("initial_unknown", "initial_ready"),
                           ("stale_admission_wait", "waited_grant_revoked"),
                           ("sustained_started", "sustained_ready")):
            selected = observations(start, end)
            if (len(selected) < 2 or selected[-1]["read_start_offset_ns"] - selected[0]["read_start_offset_ns"] < sustain
                    or any(not 0 < b["read_start_offset_ns"] - a["read_start_offset_ns"] < age_limit for a, b in zip(selected, selected[1:]))):
                raise ValueError("recovery lacks sustained distinct fresh observations")
        burst = observations("burst_armed", "burst_expired")
        if (len(burst) != 1 or by_phase["burst_expired"]["monotonic_ns"] - burst[0]["started_ns"] < age_limit):
            raise ValueError("short recovery burst did not expire without new reads")
        stale = [s for s in samples if s["finished_ns"] < by_phase["stale_admission_wait"]["monotonic_ns"]]
        if (not stale or by_phase["stale_admission_wait"]["monotonic_ns"] - stale[-1]["started_ns"] < age_limit):
            raise ValueError("admission wait did not establish an actual stale gap")
        if not observations("stale_admission_wait", "waited_grant_revoked"):
            raise ValueError("revocation lacks the joined fresh admission observation")
        result["cases"][case]["recovery"] = {"source_reads": len(samples), "snapshot_bytes_per_read": size,
            "complete_runtime_reads": 2, "shared_cadence_refused": True,
            "physical_acceptance_observation_ns": [e["monotonic_ns"] for e in accepted],
            "physical_acceptance_clocks_are_offer_clocks": False}
    result["remaining_parent_gate"] = "Critical/startup/foreground/provider integration #40231; #39998/higher/P4 provenance, residency and envelopes"
    return {"format": "native-recovery-phase-report-v1", "native_observation_recovery_complete": True, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
