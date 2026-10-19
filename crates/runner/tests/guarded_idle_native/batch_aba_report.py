#!/usr/bin/env python3
"""Validate old native insertion-ABA refusal and independently captured recovery."""

import argparse
import json
import pathlib

import foreground_report as foreground
import pressure_report as pressure
import report
import status_failure_report as failure
from cleanup_report import COUNTS, accounting, coverage, supplied_policy
from later_parking_report import current_status
from startup_report import exact

PREFIX = "NATIVE_BATCH_ABA_WITNESS "
CASES = {f"BatchAba-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("admission_blocked", "pool_wait_progress", "admission_wait_progress", "status_wait_progress",
          "batch_refused", "recovery_tail_progress", "recovery_completed", "producers_joined")


def clock(value, begin, end):
    if not report.positive_integer(value) or not begin < value < end:
        raise ValueError("batch ABA clocks lost required ordering")
    return value


def queued(value):
    exact(value, dict.fromkeys(COUNTS, 0) | {"registered_operations": 2, "queued": 2, "closed": False},
          "batch ABA did not preserve its two unused queued claims")


def reads(value, policy, begin, end):
    if not isinstance(value, list) or len(value) < 2:
        raise ValueError("batch ABA lacks original paired fresh reads")
    for sample in value:
        if (not isinstance(sample, dict) or set(sample) != {"started_ns", "finished_ns", "read_start_offset_ns",
                "available_bytes", "age_ns", "read_duration_ns"}
                or any(not pressure.integer(v) for v in sample.values())
                or not begin < sample["started_ns"] < sample["finished_ns"] < end
                or not 0 < sample["available_bytes"] <= policy["host_total_bytes"]
                or not sample["read_duration_ns"] <= sample["age_ns"] <= sample["finished_ns"]-sample["started_ns"]
                or sample["age_ns"] > policy["max_sample_age_millis"]*1_000_000):
            raise ValueError("batch ABA observation was fabricated stale or outside resumed admission")
        begin = sample["finished_ns"]


def validate(directory, *, cases=None, policy_key="native_batch_aba_policy_json"):
    directory = pathlib.Path(directory)
    cases = CASES if cases is None else cases
    result, collector, terminals = report._validate_cases(directory, cases, report.PHASES)
    policy = supplied_policy(collector, result, policy_key)
    witnesses = {case: [] for case in cases}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event.get("case") not in cases or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid batch ABA witness")
        witnesses[event["case"]].append(event)
    runners, paths = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered batch ABA phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((e["sandbox_id"], e["backing_generation"]) != identity for e in events):
            raise ValueError("batch ABA changed its original physical owner")
        ordered = [terminal[1], *events[:5], terminal[2], terminal[3], events[5], terminal[4],
                   events[6], events[7], terminal[5]]
        for field in ("monotonic_ns", "unix_ns"):
            if any(a[field] >= b[field] for a, b in zip(ordered, ordered[1:])):
                raise ValueError("old refusal and new physical recovery ordering changed")
        blocked, pool, admission, waiting, refused, tail, complete, joined = [e["evidence"] for e in events]
        path = blocked.get("status_path")
        if (not isinstance(path, str) or not pathlib.PurePosixPath(path).is_absolute()
                or str(pathlib.PurePosixPath(path)) != path or ".." in pathlib.PurePosixPath(path).parts
                or pathlib.PurePosixPath(path).name != "status.json" or path in paths):
            raise ValueError("batch ABA private status path changed")
        paths.add(path)
        initial = blocked.get("published_status")
        failure.status(initial, sandbox=identity[0])
        reuse = initial["idle_sandboxes"][0]["reuse_key"]
        selected = blocked.get("selected_revision")
        if not pressure.integer(selected, 1):
            raise ValueError("batch ABA selected revision missing")
        queued(blocked.get("accounting"))
        exact(blocked, {"policy": policy, "status_path": path, "published_status": initial,
            "selected_revision": selected, "source_read_blocked": True, "receiver_polled_pending": True,
            "accounting": blocked["accounting"], "allocated": [2,4096,1],
            "original_full_lease_active": True, "original_exit_polled_pending": True},
            "batch ABA pre-admission original custody missing")
        held = clock(pool.get("pool_held_ns"), events[0]["monotonic_ns"], events[1]["monotonic_ns"])
        status_held = clock(pool.get("status_held_ns"), held, events[1]["monotonic_ns"])
        reserved = clock(pool.get("reserved_ns"), status_held, events[1]["monotonic_ns"])
        restored = clock(pool.get("restored_ns"), reserved, events[1]["monotonic_ns"])
        pending = clock(pool.get("heartbeat_pending_ns"), restored, events[1]["monotonic_ns"])
        revision = pool.get("revision")
        if not pressure.integer(revision, selected+1):
            raise ValueError("batch ABA did not advance its original insertion revision")
        foreground.observer(pool.get("observer"), pending, events[1]["monotonic_ns"])
        queued(pool.get("accounting"))
        exact(pool, {"pool_held_ns": held, "status_held_ns": status_held, "reserved_ns": reserved,
            "restored_ns": restored, "revision": revision, "original_sandbox_id": identity[0],
            "original_backing_generation": identity[1], "same_insertion": False, "restored_original": True,
            "heartbeat_pending_ns": pending, "heartbeat_polled_pending": True,
            "observer": pool["observer"], "accounting": pool["accounting"], "allocated": [2,4096,1]},
            "batch ABA replaced its physical original or retained the old insertion")
        released = clock(admission.get("pool_released_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
        first = foreground.heartbeat(admission.get("heartbeat"), 1, released, events[2]["monotonic_ns"])
        queued(admission.get("accounting"))
        exact(admission, {"pool_released_ns": released, "heartbeat": admission["heartbeat"],
            "receiver_polled_pending": True, "source_read_blocked": True,
            "accounting": admission["accounting"], "allocated": [2,4096,1]}, "old admission lost its held wait")
        resumed = clock(waiting.get("source_resumed_ns"), events[2]["monotonic_ns"], events[3]["monotonic_ns"])
        polled = clock(waiting.get("status_wait_polled_ns"), resumed, events[3]["monotonic_ns"])
        before, after = waiting.get("status_waits_before"), waiting.get("status_waits_after")
        if not pressure.integer(before) or not pressure.integer(after) or after != before+1:
            raise ValueError("old batch final status wait was not positively observed")
        reads(waiting.get("samples"), policy, resumed, polled)
        second = foreground.heartbeat(waiting.get("heartbeat"), 2, polled, events[3]["monotonic_ns"])
        exact(waiting.get("accounting"), dict.fromkeys(COUNTS, 0) | {"closed": False}, "unused old claims did not settle")
        exact(waiting, {"source_resumed_ns": resumed, "status_wait_polled_ns": polled,
            "status_waits_before": before, "status_waits_after": after, "accounting": waiting["accounting"],
            "samples": waiting["samples"], "heartbeat": waiting["heartbeat"], "receiver_polled_pending": True,
            "original_full_lease_active": True, "original_exit_polled_pending": True, "allocated": [2,4096,1]},
            "old batch status wait lost its original live owner")
        released = clock(refused.get("status_released_ns"), events[3]["monotonic_ns"], events[4]["monotonic_ns"])
        finished = clock(refused.get("batch_joined_ns"), released, events[4]["monotonic_ns"])
        current_status(refused.get("published_status"), initial, identity[0], reuse)
        exact(refused, {"status_released_ns": released, "batch_joined_ns": finished,
            "selected": 1, "completed": 0, "uncertain": 0, "not_started": 1, "status_error": False,
            "is_complete": False, "refusal_sandbox_id": identity[0], "refusal_reuse_key": reuse,
            "refusal_error": "ResourceChanged", "revision": revision,
            "published_status": refused["published_status"], "regular_file": True,
            "original_exit_polled_pending": True, "original_full_lease_active": True, "allocated": [2,4096,1]},
            "old captured batch did not report its exact incomplete original refusal")
        started = clock(tail.get("recovery_started_ns"), events[4]["monotonic_ns"], terminal[2]["monotonic_ns"])
        entered = clock(tail.get("kernel_io_entered_ns"), terminal[3]["monotonic_ns"], events[5]["monotonic_ns"])
        foreground.observer(tail.get("observer"), entered, events[5]["monotonic_ns"])
        third = foreground.heartbeat(tail.get("heartbeat"), 3, tail["observer"]["completed_ns"], events[5]["monotonic_ns"])
        if first != second or first != third or first in runners:
            raise ValueError("batch ABA heartbeat identity changed or replayed")
        runners.add(first)
        coverage(tail.get("coverage"), policy, False)
        exact(tail, {"recovery_started_ns": started, "kernel_io_entered_ns": entered, "kernel_io_entered": True,
            "receiver_polled_pending": True, "original_exit_confirmed": True,
            "observer": tail["observer"], "heartbeat": tail["heartbeat"], "coverage": tail["coverage"]},
            "new captured batch lost accepted physical custody or progress")
        released = clock(complete.get("io_released_ns"), events[5]["monotonic_ns"], terminal[4]["monotonic_ns"])
        finished = clock(complete.get("batch_joined_ns"), terminal[4]["monotonic_ns"], events[6]["monotonic_ns"])
        current_status(complete.get("published_status"), refused["published_status"])
        exact(complete, {"io_released_ns": released, "batch_joined_ns": finished, "selected": 1,
            "completed": 1, "uncertain": 0, "not_started": 0, "status_error": False, "is_complete": True,
            "original_exit_confirmed": True, "original_lease_released": True,
            "published_status": complete["published_status"], "regular_file": True, "allocated": [0,0,0]},
            "separate guarded recovery did not completely save the original")
        accounting(joined.get("accounting"), True)
        exact(joined, {"old_batch_joined": True, "recovery_batch_joined": True, "tracker_joined": True,
            "accounting_joined": True, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
            "allocated": [0,0,0], "accounting": joined["accounting"]}, "batch ABA producers remain owned")
    return {"format": "native-batch-aba-report-v1", "native_batch_aba_complete": True, **result,
            "batch_aba_scope": "same parked original; changed logical insertion; old refusal; new guarded recovery"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2, sort_keys=True))
