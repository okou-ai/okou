#!/usr/bin/env python3
"""Validate fixed native batch completion with positively retained later inventory."""

import argparse
import datetime
import json
import pathlib
import uuid

import progress_report as foreground
import pressure_report as pressure
import report
import status_failure_report as failure
from cleanup_report import COUNTS, accounting, supplied_policy
from snapshot_report import exact

PREFIX = "NATIVE_LATER_PARKING_WITNESS "
CASES = {f"Later{kind}-{mode}" for kind in ("Exact", "Blank") for mode in ("fresh", "snapshot")}
PHASES = ("tail_blocked", "pool_wait_progress", "tail_wait_progress", "status_wait_progress",
          "original_completed", "later_retired", "producers_joined")


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("later parking identity is not canonical")
    return value


def clock(value, begin, end):
    if not report.positive_integer(value) or not begin < value < end:
        raise ValueError("later parking phase clocks lost ordering")
    return value


def covered(value, policy):
    if not isinstance(value, dict):
        raise ValueError("missing later parking coverage")
    accounting(value.get("accounting"), False, policy)
    exact(value, {"allocated": [4, 8192, 2], "accounting": value["accounting"],
                  "original_lease_active": True, "io_release_withheld": True},
          "original or separate incoming full lease lost")


def current_status(value, initial, sandbox=None, reuse=None, blank=False):
    if not isinstance(value, dict):
        raise ValueError("current status missing")
    for field in ("started_at", "updated_at"):
        text = value.get(field)
        if not isinstance(text, str) or datetime.datetime.fromisoformat(text).utcoffset() is None:
            raise ValueError("invalid current status timestamp")
    expected = {"mode": "starting", "max_concurrent": 1, "active_runs": [],
                "started_at": initial["started_at"], "updated_at": value["updated_at"]}
    if datetime.datetime.fromisoformat(value["updated_at"]) < datetime.datetime.fromisoformat(initial["updated_at"]):
        raise ValueError("current status predates initial publication")
    if sandbox:
        expected["blank_sandboxes" if blank else "idle_sandboxes"] = (
            [{"sandbox_id": sandbox}] if blank else [{"reuse_key": reuse, "sandbox_id": sandbox}])
    exact(value, expected, "current status lost later inventory or resurrected original")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_later_parking_policy_json")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event.get("case") not in CASES or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid later parking witness")
        witnesses[event["case"]].append(event)
    identities = {e[1][k] for e in terminals.values() for k in ("sandbox_id", "backing_generation")}
    runners, paths, operations, reuse_keys = set(), set(), set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered later parking phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        for field in ("monotonic_ns", "unix_ns"):
            clocks = [terminal[3][field], *(e[field] for e in events), terminal[-1][field]]
            if any(a >= b for a, b in zip(clocks, clocks[1:])):
                raise ValueError("later parking changed terminal phase ordering")
        if any((e["sandbox_id"], e["backing_generation"]) != identity for e in events):
            raise ValueError("later parking changed original owner")
        blocked, pool, tail, waiting, complete, retired, joined = [e["evidence"] for e in events]
        path = blocked.get("status_path")
        if (not isinstance(path, str) or not pathlib.PurePosixPath(path).is_absolute()
                or str(pathlib.PurePosixPath(path)) != path or ".." in pathlib.PurePosixPath(path).parts
                or pathlib.PurePosixPath(path).name != "status.json" or path in paths):
            raise ValueError("private status path changed")
        paths.add(path)
        initial = blocked.get("published_status")
        failure.status(initial, sandbox=identity[0])
        preparation = blocked.get("preparation")
        if not isinstance(preparation, dict):
            raise ValueError("missing actual incoming preparation")
        new, backing, operation = [identifier(preparation.get(k)) for k in (
            "sandbox_id", "backing_generation", "operation_id")]
        if new == backing or new in identities or backing in identities or operation in operations:
            raise ValueError("incoming preparation reused an owner or operation")
        identities.update((new, backing)); operations.add(operation)
        begin = clock(preparation.get("grant_started_ns"), terminal[1]["monotonic_ns"], terminal[2]["monotonic_ns"])
        granted = clock(preparation.get("grant_finished_ns"), begin, terminal[2]["monotonic_ns"])
        prepared = clock(preparation.get("prepared_ns"), granted, terminal[2]["monotonic_ns"])
        exact(preparation, {"sandbox_id": new, "backing_generation": backing, "operation_id": operation,
            "grant_started_ns": begin, "grant_finished_ns": granted, "prepared_ns": prepared,
            "guest_rpc_completed": True, "phase_settled": True, "separate_incoming_lease": True},
            "incoming actual RPC/park/settlement missing")
        reuse = blocked.get("later_reuse_key")
        prefix = "thread:native-later-"
        if not isinstance(reuse, str) or not reuse.startswith(prefix):
            raise ValueError("later exact reuse identity missing")
        identifier(reuse[len(prefix):])
        if reuse in reuse_keys or reuse == initial["idle_sandboxes"][0]["reuse_key"]:
            raise ValueError("later parking reuses original key")
        reuse_keys.add(reuse)
        blank = case.startswith("LaterBlank-")
        covered(blocked.get("coverage"), policy)
        exact(blocked, {"policy": policy, "published_status": initial, "status_path": path,
            "receiver_polled_pending": True, "preparation": preparation, "later_reuse_key": reuse,
            "blank": blank, "profile_name": "vm0/default", "coverage": blocked["coverage"]},
            "original tail or incoming custody missing")
        inserted = clock(pool.get("inserted_ns"), events[0]["monotonic_ns"], events[1]["monotonic_ns"])
        held = clock(pool.get("pool_held_ns"), inserted, events[1]["monotonic_ns"])
        status_held = clock(pool.get("status_held_ns"), held, events[1]["monotonic_ns"])
        polled = clock(pool.get("heartbeat_pending_ns"), status_held, events[1]["monotonic_ns"])
        revision = pool.get("revision")
        if not pressure.integer(revision, 1):
            raise ValueError("later pool revision missing")
        foreground.observer(pool.get("observer"), polled, events[1]["monotonic_ns"])
        covered(pool.get("coverage"), policy)
        exact(pool, {"inserted_ns": inserted, "revision": revision, "pool_held_ns": held,
            "status_held_ns": status_held, "heartbeat_pending_ns": polled, "heartbeat_polled_pending": True,
            "observer": pool["observer"], "coverage": pool["coverage"]}, "independent pool wait progress absent")
        released = clock(tail.get("pool_released_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
        first = foreground.heartbeat(tail.get("heartbeat"), 1, released, events[2]["monotonic_ns"], (4, 8192))
        covered(tail.get("coverage"), policy)
        exact(tail, {"pool_released_ns": released, "heartbeat": tail["heartbeat"],
            "receiver_polled_pending": True, "coverage": tail["coverage"]}, "held IO lost custody/progress")
        io_released = clock(waiting.get("io_released_ns"), events[2]["monotonic_ns"], terminal[4]["monotonic_ns"])
        polled = clock(waiting.get("status_wait_polled_ns"), terminal[4]["monotonic_ns"], events[3]["monotonic_ns"])
        before, after = waiting.get("status_waits_before"), waiting.get("status_waits_after")
        if not pressure.integer(before) or not pressure.integer(after) or after != before + 1:
            raise ValueError("final status wait not positively observed")
        second = foreground.heartbeat(waiting.get("heartbeat"), 2, polled, events[3]["monotonic_ns"])
        if first != second or first in runners:
            raise ValueError("heartbeat runner changed or replayed")
        runners.add(first)
        exact(waiting.get("accounting"), dict.fromkeys(COUNTS, 0) | {"closed": False}, "open accounting not settled")
        exact(waiting, {"io_released_ns": io_released, "status_wait_polled_ns": polled,
            "status_waits_before": before, "status_waits_after": after, "receiver_polled_pending": True,
            "original_exit_confirmed": True, "original_lease_released": True, "later_exit_polled_pending": True,
            "allocated": [2,4096,1], "accounting": waiting["accounting"], "heartbeat": waiting["heartbeat"]},
            "original lease or later backing custody changed")
        released = clock(complete.get("status_released_ns"), events[3]["monotonic_ns"], events[4]["monotonic_ns"])
        completed = clock(complete.get("batch_joined_ns"), released, events[4]["monotonic_ns"])
        current_status(complete.get("published_status"), initial, new, reuse, blank)
        exact(complete, {"status_released_ns": released, "batch_joined_ns": completed,
            "selected": 1, "completed": 1, "uncertain": 0, "not_started": 0, "status_error": False,
            "is_complete": True, "revision": revision, "published_status": complete["published_status"],
            "regular_file": True, "later_exit_polled_pending": True, "allocated": [2,4096,1]},
            "original batch recaptured later inventory or lost current publication")
        started = clock(retired.get("started_ns"), events[4]["monotonic_ns"], events[5]["monotonic_ns"])
        finished = clock(retired.get("joined_ns"), started, events[5]["monotonic_ns"])
        current_status(retired.get("published_status"), complete["published_status"])
        exact(retired, {"started_ns": started, "joined_ns": finished, "selected": 1, "completed": 1,
            "uncertain": 0, "not_started": 0, "status_error": False, "is_complete": True,
            "later_exit_confirmed": True, "published_status": retired["published_status"], "allocated": [0,0,0]},
            "separate later batch did not complete")
        accounting(joined.get("accounting"), True)
        exact(joined, {"batch_joined": True, "later_batch_joined": True, "tracker_joined": True,
            "accounting_joined": True, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
            "allocated": [0,0,0], "accounting": joined["accounting"]}, "later parking producers remain owned")
    return {"format": "native-later-parking-report-v1", "native_later_parking_complete": True, **result,
            "later_parking_scope": "fixed original selection; current exact/blank inventory; separate later retirement"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2, sort_keys=True))
