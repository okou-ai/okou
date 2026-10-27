#!/usr/bin/env python3
"""Verify complete native saving, explicit status-write refusal and current retry."""

import argparse
import datetime
import json
import pathlib
import uuid

import progress_report as foreground
import pressure_report as pressure
import report
from cleanup_report import accounting, coverage, supplied_policy
from snapshot_report import exact

PREFIX = "NATIVE_STATUS_FAILURE_WITNESS "
CASES = {f"StatusFailure-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("tail_blocked", "pool_wait_progress", "tail_wait_progress", "status_wait_progress",
          "status_failed", "status_retried", "producers_joined")


def status(value, sandbox=None, previous=None):
    if not isinstance(value, dict):
        raise ValueError("status publication has no original JSON")
    for field in ("started_at", "updated_at"):
        text = value.get(field)
        if not isinstance(text, str) or datetime.datetime.fromisoformat(text).utcoffset() is None:
            raise ValueError("status publication has invalid original timestamps")
    expected = {"mode": "starting", "max_concurrent": 1, "active_runs": [],
                "started_at": value["started_at"], "updated_at": value["updated_at"]}
    if sandbox is not None:
        entries = value.get("idle_sandboxes")
        if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
            raise ValueError("original parked status was not positively published")
        reuse = entries[0].get("reuse_key")
        prefix = "thread:native-guarded-"
        if (not isinstance(reuse, str) or not reuse.startswith(prefix)
                or str(uuid.UUID(reuse[len(prefix):])) != reuse[len(prefix):]):
            raise ValueError("original status reuse identity changed")
        expected["idle_sandboxes"] = [{"reuse_key": reuse, "sandbox_id": sandbox}]
    if previous is not None and value["started_at"] != previous["started_at"]:
        raise ValueError("status retry changed original tracker")
    exact(value, expected, "status publication resurrected inventory or changed its shape")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_status_failure_policy_json")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or not isinstance(event["case"], str) or event["case"] not in CASES
                or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"]) or not isinstance(event["evidence"], dict)):
            raise ValueError("invalid status-failure witness")
        witnesses[event["case"]].append(event)
    runners, paths = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered status-failure phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[3]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("status failure changed original identity or tail ordering")
        blocked, pool, tail, waiting, failed, retried, joined = [e["evidence"] for e in events]
        status_path = blocked.get("status_path")
        if (not isinstance(status_path, str) or not pathlib.PurePosixPath(status_path).is_absolute()
                or str(pathlib.PurePosixPath(status_path)) != status_path
                or pathlib.PurePosixPath(status_path).name != "status.json"
                or ".." in pathlib.PurePosixPath(status_path).parts or status_path in paths):
            raise ValueError("status-failure private destination identity changed")
        paths.add(status_path)
        status(blocked.get("published_status"), sandbox=identity[0])
        coverage(blocked.get("coverage"), policy, False)
        exact(blocked, {"policy": policy, "published_status": blocked["published_status"],
                        "status_path": status_path, "receiver_polled_pending": True,
                        "coverage": blocked["coverage"]}, "original status or accepted saving missing")
        held, status_held, heartbeat_pending = [pool.get(k) for k in (
            "pool_held_ns", "status_held_ns", "heartbeat_pending_ns")]
        if (not all(report.positive_integer(t) for t in (held, status_held, heartbeat_pending))
                or not events[0]["monotonic_ns"] < held <= status_held < heartbeat_pending < events[1]["monotonic_ns"]):
            raise ValueError("status-failure original pool/status contention absent")
        foreground.observer(pool.get("observer"), heartbeat_pending, events[1]["monotonic_ns"])
        coverage(pool.get("coverage"), policy, True)
        exact(pool, {"pool_held_ns": held, "status_held_ns": status_held,
                     "heartbeat_pending_ns": heartbeat_pending, "heartbeat_polled_pending": True,
                     "observer": pool["observer"], "tracker_shutdown_pending": True,
                     "accounting_shutdown_pending": True, "coverage": pool["coverage"]},
              "independent observation or retained shutdown custody missing")
        released = tail.get("pool_released_ns")
        if (not report.positive_integer(released)
                or not events[1]["monotonic_ns"] < released < events[2]["monotonic_ns"]):
            raise ValueError("original pool release missing")
        first = foreground.heartbeat(tail.get("heartbeat"), 1, released, events[2]["monotonic_ns"])
        coverage(tail.get("coverage"), policy, True)
        exact(tail, {"pool_released_ns": released, "status_held_ns": status_held,
                     "heartbeat": tail["heartbeat"], "receiver_polled_pending": True,
                     "tracker_shutdown_pending": True, "accounting_shutdown_pending": True,
                     "coverage": tail["coverage"]}, "saving or heartbeat progress lost under held IO/status")
        io_released, polled, injected = [waiting.get(k) for k in (
            "io_released_ns", "status_wait_polled_ns", "fault_injected_ns")]
        before, after = waiting.get("status_waits_before"), waiting.get("status_waits_after")
        if (not all(report.positive_integer(t) for t in (io_released, polled, injected))
                or not events[2]["monotonic_ns"] < io_released < terminal[4]["monotonic_ns"]
                < polled < injected < events[3]["monotonic_ns"]
                or not pressure.integer(before) or not pressure.integer(after) or after != before + 1):
            raise ValueError("status fault was not after complete IO and a positive final wait")
        second = foreground.heartbeat(waiting.get("heartbeat"), 2, polled, injected, (0, 0))
        if first != second or first in runners:
            raise ValueError("status-failure heartbeat changed or replayed its runner")
        runners.add(first)
        accounting(waiting.get("accounting"), True)
        exact(waiting, {"io_released_ns": io_released, "status_held_ns": status_held,
                        "status_wait_polled_ns": polled, "status_waits_before": before,
                        "status_waits_after": after, "receiver_polled_pending": True,
                        "tracker_shutdown_pending": True, "accounting_joined": True,
                        "accounting": waiting["accounting"], "allocated": [0, 0, 0],
                        "heartbeat": waiting["heartbeat"], "fault_injected_ns": injected,
                        "status_destination_directory": True}, "pending final status or settled physical custody missing")
        status_released, batch_joined = failed.get("status_released_ns"), failed.get("batch_joined_ns")
        if (not all(report.positive_integer(t) for t in (status_released, batch_joined))
                or not events[3]["monotonic_ns"] < status_released < batch_joined < events[4]["monotonic_ns"]):
            raise ValueError("original failed batch was not positively joined")
        exact(failed, {"status_released_ns": status_released, "batch_joined_ns": batch_joined,
                       "selected": 1, "completed": 1, "uncertain": 0, "not_started": 0,
                       "is_complete": False, "status_error_kind": "write", "status_error_path": status_path,
                       "status_destination_directory": True}, "physical completion hid or replaced status-write refusal")
        started, finished = retried.get("retry_started_ns"), retried.get("retry_completed_ns")
        if (not all(report.positive_integer(t) for t in (started, finished))
                or not events[4]["monotonic_ns"] < started < finished < events[5]["monotonic_ns"]):
            raise ValueError("current status retry was not completed after the joined write failure")
        status(retried.get("published_status"), previous=blocked["published_status"])
        exact(retried, {"retry_started_ns": started, "retry_completed_ns": finished,
                        "published_status": retried["published_status"], "regular_file": True,
                        "original_batch_complete": False}, "retry lost current publication or rewrote the failed report")
        accounting(joined.get("accounting"), True)
        exact(joined, {"batch_joined": True, "tracker_joined": True, "accounting_joined": True,
                       "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
                       "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
                       "allocated": [0, 0, 0], "accounting": joined["accounting"]},
              "status-failure producers or physical custody remain unresolved")
    return {"format": "native-cleanup-status-failure-report-v1",
            "native_cleanup_status_failure_complete": True, **result,
            "status_failure_scope": "complete required saving; explicit final Write refusal; current-state retry"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2, sort_keys=True))
