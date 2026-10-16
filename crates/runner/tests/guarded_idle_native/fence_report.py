#!/usr/bin/env python3
"""Require native post-wait refusals and the complete original physical proof."""

import argparse
import json
import pathlib

import foreground_report as foreground
import pressure_report
import report
import startup_report as startup

PREFIX = "NATIVE_FENCE_WITNESS "
ERRORS = {
    "stale_permission": "UnknownObservation(Stale)",
    "changed_insertion": "ResourceChanged",
    "foreign_authority": "OwnershipInvariant",
    "changed_envelope": "OwnershipInvariant",
}


def validate(directory):
    directory = pathlib.Path(directory)
    result = foreground.validate(directory)
    _, _, terminals = report._validate_cases(directory, foreground.CASES, report.PHASES)
    witnesses = {case: [] for case in foreground.CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure_report.unique_object)
        if (not isinstance(event, dict) or set(event) != {
                "version", "case", "phase", "monotonic_ns", "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event["case"] not in witnesses or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid native fence witness")
        witnesses[event["case"]].append(event)
    for case, events in witnesses.items():
        if tuple(e["phase"] for e in events) != tuple(ERRORS):
            raise ValueError("missing duplicate or unordered native fences")
        completed = result["cases"][case]
        foreground_start = completed["foreground"]["witnesses"][0]
        policy = foreground_start["evidence"]["policy"]
        identity = completed["sandbox_id"], completed["backing_generation"]
        previous = terminals[case][1]["monotonic_ns"]
        previous_revision = None
        for event in events:
            phase, value = event["phase"], event["evidence"]
            if not isinstance(value, dict):
                raise ValueError("native fence evidence is not an object")
            clocks = [value.get(key) for key in (
                "selected_ns", "granted_ns", "pool_held_ns", "wait_polled_ns", "pool_released_ns", "refused_ns")]
            if (any(not report.positive_integer(clock) for clock in clocks)
                    or any(a >= b for a, b in zip([previous, *clocks], [*clocks, event["monotonic_ns"]]))
                    or event["monotonic_ns"] >= foreground_start["monotonic_ns"]
                    or (event["sandbox_id"], event["backing_generation"]) != identity):
                raise ValueError("native refusal is outside its original positively polled wait")
            selected, granted, held, polled, released, refused = clocks
            if phase == "stale_permission" and released - granted < policy["max_sample_age_millis"] * 1_000_000:
                raise ValueError("native stale grant did not actually expire")
            foreground.observer(value.get("observer"), polled, released)
            samples = value.get("samples")
            if not isinstance(samples, list) or len(samples) != 2:
                raise ValueError("native fence lacks both actual original grant reads")
            last, last_offset = selected, -1
            for sample in samples:
                if (not isinstance(sample, dict) or set(sample) != {
                        "started_ns", "finished_ns", "read_start_offset_ns", "available_bytes", "age_ns", "read_duration_ns"}
                        or any(not pressure_report.integer(sample[k]) for k in sample)
                        or not last < sample["started_ns"] < sample["finished_ns"] < granted
                        or sample["read_start_offset_ns"] <= last_offset
                        or not sample["read_duration_ns"] <= sample["age_ns"] <= sample["finished_ns"] - sample["started_ns"]
                        or sample["age_ns"] >= policy["max_sample_age_millis"] * 1_000_000
                        or not 0 < sample["available_bytes"] <= policy["host_total_bytes"]):
                    raise ValueError("native fence original grant read timing or availability changed")
                last, last_offset = sample["finished_ns"], sample["read_start_offset_ns"]
            revisions = [value.get(k) for k in ("selected_revision", "ready_revision", "refused_revision")]
            if (any(not pressure_report.integer(r) for r in revisions)
                    or revisions[1] != revisions[0] + (2 if phase == "changed_insertion" else 0)
                    or revisions[1] != revisions[2]
                    or previous_revision is not None and revisions[0] != previous_revision):
                raise ValueError("native refusal changed or replaced original inventory")
            startup.exact(value, {
                "policy": policy, "expected_error": ERRORS[phase], "error": ERRORS[phase],
                "selected_ns": selected, "granted_ns": granted, "pool_held_ns": held,
                "wait_polled_ns": polled, "pool_released_ns": released, "refused_ns": refused,
                "selected_revision": revisions[0], "ready_revision": revisions[1], "refused_revision": revisions[2],
                "same_insertion": phase != "changed_insertion", "pool_wait_polled_pending": True,
                "observer": value["observer"], "samples": samples, "paired_grants": 2,
                "registered_after": 0, "started_after": 0, "tracked_after": 0,
                "foreign_closed": True, "foreign_registered": 0, "foreign_started": 0, "foreign_tracked": 0,
                "original_sandbox_id": identity[0], "original_backing_generation": identity[1],
                "full_original_lease": [2, 4096, 1], "allocated": [2, 4096, 1],
                "original_retained": True, "cleanup_accepted": False,
            }, "native refusal lost original authority coverage physical identity or full custody")
            previous, previous_revision = event["monotonic_ns"], revisions[2]
        completed["retirement_fences"] = events
    result["format"] = "native-retirement-fence-report-v1"
    result["native_retirement_fences_complete"] = True
    result["remaining_parent_gate"] = "40514 successful inventory growth and remaining Critical composition; 40355 accepted cancellation/late results and final reconciliation"
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
