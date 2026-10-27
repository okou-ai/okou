#!/usr/bin/env python3
"""Validate native observer loss without losing accepted saving or progress."""

import argparse
import json
import pathlib

import progress_report as foreground
from cleanup_report import COUNTS, accounting, coverage, supplied_policy
import pressure_report as pressure
import report
from snapshot_report import exact

PREFIX = "NATIVE_OBSERVER_LOSS_WITNESS "
CASES = {f"Observer{kind}-{mode}" for kind in ("Drop", "Panic") for mode in ("fresh", "snapshot")}
PHASES = ("tail_blocked", "observer_lost", "pool_wait_progress", "tail_wait_progress",
          "status_wait_progress", "producers_joined")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_observer_loss_policy_json")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event["case"] not in CASES or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"]) or not isinstance(event["evidence"], dict)):
            raise ValueError("invalid observer-loss witness")
        witnesses[event["case"]].append(event)
    runners = set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered observer-loss phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[3]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("observer loss changed original identity or physical-tail ordering")
        blocked, lost, pool, tail, status, joined = [e["evidence"] for e in events]
        mode = "panic" if case.startswith("ObserverPanic-") else "drop"
        coverage(blocked.get("coverage"), policy, False)
        exact(blocked, {"mode": mode, "policy": policy, "coverage": blocked["coverage"]},
              "observer loss changed original inputs or failure mode")
        pending, observed = lost.get("receiver_pending_ns"), lost.get("observer_joined_ns")
        if (not all(report.positive_integer(t) for t in (pending, observed))
                or not events[0]["monotonic_ns"] < pending < observed < events[1]["monotonic_ns"]):
            raise ValueError("original observer was not positively Pending before loss")
        coverage(lost.get("coverage"), policy, True)
        exact(lost, {"mode": mode, "panic_confirmed": mode == "panic", "observer_joined": True,
                     "receiver_polled_pending": True, "receiver_pending_ns": pending,
                     "observer_joined_ns": observed, "tracker_shutdown_pending": True,
                     "accounting_shutdown_pending": True, "coverage": lost["coverage"]},
              "observer outcome or shutdown custody is incomplete")
        held, status_held, heartbeat_pending = [pool.get(k) for k in (
            "pool_held_ns", "status_held_ns", "heartbeat_pending_ns")]
        if (not all(report.positive_integer(t) for t in (held, status_held, heartbeat_pending))
                or not events[1]["monotonic_ns"] < held <= status_held < heartbeat_pending < events[2]["monotonic_ns"]):
            raise ValueError("observer-loss pool/status contention is absent")
        foreground.observer(pool.get("observer"), heartbeat_pending, events[2]["monotonic_ns"])
        coverage(pool.get("coverage"), policy, True)
        exact(pool, {"pool_held_ns": held, "status_held_ns": status_held,
                     "heartbeat_pending_ns": heartbeat_pending, "heartbeat_polled_pending": True,
                     "observer": pool["observer"], "coverage": pool["coverage"]},
              "independent observation did not progress through held pool")
        released = tail.get("pool_released_ns")
        if (not report.positive_integer(released)
                or not events[2]["monotonic_ns"] < released < events[3]["monotonic_ns"]):
            raise ValueError("observer-loss original pool release missing")
        first = foreground.heartbeat(tail.get("heartbeat"), 1, released, events[3]["monotonic_ns"])
        coverage(tail.get("coverage"), policy, True)
        exact(tail, {"pool_released_ns": released, "status_held_ns": status_held,
                     "heartbeat": tail["heartbeat"], "tracker_shutdown_pending": True,
                     "accounting_shutdown_pending": True, "coverage": tail["coverage"]},
              "heartbeat failed to progress while required IO and status remained held")
        io_released, status_polled = status.get("io_released_ns"), status.get("status_wait_polled_ns")
        before, after = status.get("status_waits_before"), status.get("status_waits_after")
        if (not all(report.positive_integer(t) for t in (io_released, status_polled))
                or not events[3]["monotonic_ns"] < io_released < terminal[4]["monotonic_ns"]
                < status_polled < events[4]["monotonic_ns"]
                or not pressure.integer(before) or not pressure.integer(after) or after != before + 1):
            raise ValueError("final status was not Pending after complete required IO")
        second = foreground.heartbeat(status.get("heartbeat"), 2, status_polled, events[4]["monotonic_ns"], (0, 0))
        if first != second or first in runners:
            raise ValueError("observer-loss heartbeat changed or replayed its runner generation")
        runners.add(first)
        accounting(status.get("accounting"), True)
        exact(status, {"io_released_ns": io_released, "status_held_ns": status_held,
                       "status_wait_polled_ns": status_polled, "status_waits_before": before,
                       "status_waits_after": after, "tracker_shutdown_pending": True,
                       "accounting_joined": True, "heartbeat": status["heartbeat"],
                       "accounting": status["accounting"], "allocated": [0, 0, 0]},
              "final status wait lost joined accounting or independent heartbeat")
        accounting(joined.get("accounting"), True)
        exact(joined, {"tracker_joined": True, "accounting_joined": True, "observer_joined": True,
                       "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
                       "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
                       "allocated": [0, 0, 0], "accounting": joined["accounting"]},
              "observer-loss producers, logical lease or physical custody remain unresolved")
    return {"format": "native-cleanup-observer-loss-report-v1",
            "native_cleanup_observer_loss_complete": True, **result,
            "observer_loss_scope": "external completion observer drop/panic; original required saving retained"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2, sort_keys=True))
