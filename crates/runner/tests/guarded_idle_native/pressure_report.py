#!/usr/bin/env python3
"""Validate source-bound policy-pressure or logical-substitution native evidence."""

import argparse
import hashlib
import json
import pathlib
import uuid

import report

PREFIX = "NATIVE_PRESSURE_WITNESS "
SCOPES = {"physical": "Pressure", "logical": "Logical"}
PHASES = ("case_started", "scenario_observed", *report.PHASES[1:])
POLICY_FIELDS = {
    "host_total_bytes", "operating_floor_bytes", "cleanup_reserve_bytes",
    "critical_available_bytes", "recovery_available_bytes", "live_growth_bytes",
    "tail_growth_bytes", "replacement_preparation_bytes", "max_sample_age_millis",
    "max_operations", "max_cleanup_inflight", "pressure_sample_period_millis",
    "pressure_recovery_sustain_millis", "pressure_wave_cooldown_millis",
    "pressure_optional_start_interval_millis", "pressure_max_wave_entries",
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate native pressure policy field")
        result[key] = value
    return result


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**64 - 1


def sustained_ready_samples(samples, end, policy, after=0):
    """Replay validated reads, returning fresh high-watermark evidence for Ready.

    Recovery history need not still be fresh at the decision. Each observation
    must have been fresh when observed, with distinct bounded read-start gaps.
    Callers retain their sample-shape, witness-order and headroom checks.
    """
    max_age = policy["max_sample_age_millis"] * 1_000_000
    sustain = policy["pressure_recovery_sustain_millis"] * 1_000_000
    previous, since, latest = None, None, None
    recovered, high = False, []
    epoch_lower, epoch_upper = 0, None
    for sample in samples:
        if sample["finished_ns"] >= end:
            continue
        offset = sample["read_start_offset_ns"]
        if previous is not None and offset <= previous:
            raise ValueError("actual pressure read was replayed or reordered")
        # One source epoch must place each read start inside its real interval.
        epoch_lower = max(epoch_lower, sample["started_ns"] - offset)
        upper = sample["finished_ns"] - offset
        epoch_upper = upper if epoch_upper is None else min(epoch_upper, upper)
        if epoch_lower > epoch_upper:
            raise ValueError("actual pressure read offsets contradict their monotonic windows")
        if previous is not None and offset - previous >= max_age:
            recovered, since, high = False, None, []
        previous, latest = offset, sample
        available = sample["available_bytes"]
        if (sample["started_ns"] <= after or available is None
                or sample["age_ns"] >= max_age
                or available <= policy["critical_available_bytes"]):
            recovered, since, high = False, None, []
        elif available >= policy["recovery_available_bytes"]:
            if since is None:
                since = offset
            if offset - since >= sustain:
                recovered = True
            high.append(sample)
        else:
            # Completed recovery survives the hysteresis band, as in the owner.
            since = None
            if not recovered:
                high = []
    if (not recovered or latest is None
            or not integer(latest["available_bytes"], policy["recovery_available_bytes"])
            or latest["age_ns"] + end - latest["finished_ns"] >= max_age):
        return []
    return [sample for sample in high
            if sample["age_ns"] + end - sample["finished_ns"] < max_age]


def validate(directory):
    directory = pathlib.Path(directory)
    metadata = json.loads((directory / "report.json").read_text())["metadata"]
    kind = metadata["native_pressure_kind"]
    if not isinstance(kind, str) or kind not in SCOPES:
        raise ValueError("unexpected native pressure corpus")
    cases = {f"{SCOPES[kind]}-{mode}" for mode in ("fresh", "snapshot")}
    result, _, receipts = report._validate_cases(directory, cases, PHASES)
    raw_policy = metadata["native_pressure_policy_json"]
    if not isinstance(raw_policy, str) or hashlib.sha256(raw_policy.encode()).hexdigest() != \
            result["artifacts"]["policy_sha256"]:
        raise ValueError("native pressure raw policy/hash mismatch")
    policy = json.loads(raw_policy, object_pairs_hook=unique_object)
    if not isinstance(policy, dict) or set(policy) != POLICY_FIELDS or any(
            not integer(value, 1) for value in policy.values()):
        raise ValueError("invalid native pressure policy")
    protected = policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
    if (protected >= policy["host_total_bytes"]
            or not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or policy["recovery_available_bytes"] < protected
            or policy["tail_growth_bytes"] < 65 * 1024 * 1024
            or policy["max_cleanup_inflight"] < 2):
        raise ValueError("invalid native pressure bounds")
    witnesses = {case: [] for case in cases}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        witness = json.loads(line[len(PREFIX):])
        if (type(witness.get("version")) is not int or witness["version"] != 1
                or witness.get("case") not in cases
                or not report.positive_integer(witness.get("monotonic_ns"))
                or not report.positive_integer(witness.get("unix_ns"))):
            raise ValueError("invalid native pressure witness")
        witnesses[witness["case"]].append(witness)
    incoming_ids = set()
    original_ids = {case["sandbox_id"] for case in result["cases"].values()}
    for case, events in receipts.items():
        condition = events[1]["evidence"]
        allocated = condition.get("allocated")
        available = condition.get("available_bytes")
        age, cost = condition.get("age_ns"), condition.get("read_duration_ns")
        if (set(condition) != {"kind", "policy", "available_bytes", "age_ns",
                               "read_duration_ns", "allocated", "profile_can_fit"}
                or condition["kind"] != kind or json.dumps(condition["policy"], sort_keys=True) != json.dumps(policy, sort_keys=True)
                or allocated != [2, 4096, 1] or any(type(v) is not int for v in allocated)
                or not integer(available) or available > policy["host_total_bytes"]
                or not integer(age) or not integer(cost) or cost > age
                or age >= policy["max_sample_age_millis"] * 1_000_000):
            raise ValueError("invalid native pressure scenario condition")
        if kind == "physical":
            valid = condition["profile_can_fit"] is True and available <= policy["critical_available_bytes"]
            phases = ("wave_completed",)
        else:
            required = protected + 4096 * 1024 * 1024 + policy["replacement_preparation_bytes"]
            valid = condition["profile_can_fit"] is False and available >= max(
                required, policy["recovery_available_bytes"])
            phases = ("different_guest_prepared", "original_join_requested")
        if not valid:
            raise ValueError("actual native pressure condition is absent")
        seen = witnesses[case]
        if tuple(w["phase"] for w in seen) != phases:
            raise ValueError("missing, duplicate or unordered native pressure witnesses")
        previous = events[2]["monotonic_ns"]
        identity = (result["cases"][case]["sandbox_id"], result["cases"][case]["backing_generation"])
        for witness in seen:
            if ((witness["sandbox_id"], witness["backing_generation"]) != identity
                    or not previous < witness["monotonic_ns"] < events[-1]["monotonic_ns"]):
                raise ValueError("native pressure witness lost its original identity/ordering")
            previous = witness["monotonic_ns"]
        if kind == "physical":
            evidence = seen[0]["evidence"]
            counts = {"selected": 1, "completed": 1, "uncertain": 0, "not_started": 0, "skipped": 0}
            flags = {"status_error": False, "resolved": True, "producer_lost": False,
                     "wave_inflight": False, "stopped": True}
            if (evidence != counts | flags or any(type(evidence.get(k)) is not int for k in counts)
                    or any(evidence.get(k) is not v for k, v in flags.items())):
                raise ValueError("native pressure wave/shutdown is incomplete")
        else:
            evidence, joined = seen[0]["evidence"], seen[1]["evidence"]
            incoming = evidence.get("incoming_sandbox_id")
            if (set(evidence) != {"incoming_sandbox_id", "admitted"} or evidence["admitted"] is not True
                    or not isinstance(incoming, str) or str(uuid.UUID(incoming)) != incoming
                    or incoming in original_ids or incoming in incoming_ids
                    or joined != {"retirements": 1} or type(joined["retirements"]) is not int):
                raise ValueError("native logical growth/original join is incomplete")
            incoming_ids.add(incoming)
        result["cases"][case]["scenario"] = condition
        result["cases"][case]["witnesses"] = seen
    result["remaining_parent_gate"] = "complete native continuation/optional/recovery/races, provenance/residency/envelopes"
    return {"format": "native-pressure-phase-report-v1", "native_pressure_corpus_complete": True,
            "kind": kind, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
