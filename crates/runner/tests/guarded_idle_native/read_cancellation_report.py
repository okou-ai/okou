#!/usr/bin/env python3
"""Validate accepted actual File reads retained through cancellation and drain."""

import argparse
import hashlib
import json
import pathlib

import foreground_report as foreground
import logical_report
import pressure_report as pressure
import report
import startup_report as startup

PREFIX = "NATIVE_READ_CANCELLATION_WITNESS "
CASES = {f"ReadCancellation-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "startup_accepted", "startup_cancel_wait", "startup_joined",
          "runtime_accepted", "runtime_cancel_wait", "runtime_joined", "producers_joined")
CHUNK = 1024**2


def read(value, guarded, joined):
    expected = {"accepted": 1, "completed": 0, "cancelled": int(joined), "failed": 0,
                "read_bytes": CHUNK if joined else 0, "last_error": None}
    if guarded:
        expected.update(uncertain=0, deferred=0, finished=joined)
    startup.exact(value, expected, "actual accepted/cancelled read bytes or outcome changed")


def accounting(value, growth):
    tracked = value.get("tracked_tasks") if isinstance(value, dict) else None
    if not pressure.integer(tracked, 1 if growth else 0) or (not growth and tracked != 0):
        raise ValueError("accepted physical read lost its tracked P2 owner")
    startup.exact(value, {"registered_operations": int(growth > 0), "started": int(growth > 0),
        "ordinary_growth_bytes": growth, "tracked_tasks": tracked, "cleanup_growth_bytes": 0,
        "uncertain": 0}, "original accepted read allowance/registration changed")


def samples(values, begin, end, policy):
    if not isinstance(values, list):
        raise ValueError("actual read source samples missing")
    previous = -1
    epoch_lower, epoch_upper = 0, None
    for value in values:
        logical_report.sample(value, begin, end, policy)
        if value["read_start_offset_ns"] <= previous:
            raise ValueError("actual read observation was replayed")
        previous = value["read_start_offset_ns"]
        # The source epoch is shared. Each actual read start must fit inside
        # its enclosing CLOCK_MONOTONIC interval, including concurrent reads.
        epoch_lower = max(epoch_lower, value["started_ns"]-previous)
        upper = value["finished_ns"]-previous
        epoch_upper = upper if epoch_upper is None else min(epoch_upper, upper)
        if epoch_lower > epoch_upper:
            raise ValueError("actual read offsets contradict their monotonic windows")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_read_cancellation")
    witnesses = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event["case"] not in CASES or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"]) or not isinstance(event["evidence"], dict)):
            raise ValueError("invalid actual read cancellation witness")
        witnesses[event["case"]].append(event)
    runners = set()
    zero = {"registered_operations": 0, "started": 0, "ordinary_growth_bytes": 0,
            "tracked_tasks": 0, "cleanup_growth_bytes": 0, "uncertain": 0}
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered actual read cancellation phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[2]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("actual read original identity/producer-before-saving order changed")
        startup.exact(events[0]["evidence"], {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "checkpoint_bytes": CHUNK, "startup_pressure_guarded": False,
            "checkpoint_models_stalled_storage": False, "allocated": [2,4096,1]},
            "actual original File input/full lease/checkpoint limits changed")
        growth = startup.BYTES+inputs["prefetch_overhead_bytes"]
        runner = None
        for offset, guarded in ((1, False), (4, True)):
            accepted, waiting, joined = events[offset:offset+3]
            value = accepted["evidence"]
            read(value.get("read"), guarded, False)
            accounting(value.get("accounting"), growth if guarded else 0)
            held = value.get("held_ns")
            if not report.positive_integer(held) or not events[offset-1]["monotonic_ns"] < held < accepted["monotonic_ns"]:
                raise ValueError("actual File checkpoint boundary missing")
            actual = value.get("samples")
            samples(actual, events[0]["monotonic_ns"], accepted["monotonic_ns"], policy)
            available = value.get("available_bytes")
            if guarded:
                fresh = pressure.sustained_ready_samples(actual, accepted["monotonic_ns"], policy)
                if (not pressure.integer(available, policy["recovery_available_bytes"])
                        or not any(v["available_bytes"] == available for v in fresh)):
                    raise ValueError("actual runtime read lacks sustained fresh Ready")
            elif available is not None or actual:
                raise ValueError("unguarded actual startup did not stay Unknown")
            startup.exact(value, {"state": "Ready" if guarded else "Unknown", "available_bytes": available,
                "samples": actual, "held_ns": held, "checkpoint_bytes": CHUNK, "read": value["read"],
                "accounting": value["accounting"], "allocated": [2,4096,1], "release_byte_withheld": True},
                "actual accepted File checkpoint/full custody changed")
            wait = waiting["evidence"]
            ordered = [accepted["monotonic_ns"], *(wait.get(k) for k in ("cancelled_ns", "first_drain_dropped_ns", "second_pending_ns")), waiting["monotonic_ns"]]
            if any(not report.positive_integer(n) for n in ordered) or any(a >= b for a,b in zip(ordered,ordered[1:])):
                raise ValueError("cancelled actual drain observers lack positive Pending order")
            accounting(wait.get("accounting"), growth if guarded else 0)
            foreground.observer(wait.get("observer"), wait["second_pending_ns"], waiting["monotonic_ns"])
            current = foreground.heartbeat(wait.get("heartbeat"), 2 if guarded else 1,
                wait["second_pending_ns"], waiting["monotonic_ns"])
            if runner is None: runner = current
            if current != runner or runner in runners:
                raise ValueError("actual read reporting changed its original generation")
            startup.exact(wait, {"held_ns": held, "cancelled_ns": wait["cancelled_ns"],
                "first_drain_dropped_ns": wait["first_drain_dropped_ns"], "second_pending_ns": wait["second_pending_ns"],
                "first_drain_pending": True, "first_drain_dropped": True, "second_drain_pending": True,
                "release_byte_withheld": True, "checkpoint_bytes": CHUNK, "accounting": wait["accounting"],
                "allocated": [2,4096,1], "heartbeat": wait["heartbeat"], "observer": wait["observer"]},
                "accepted actual IO escaped cancellation/reporting/full lease")
            done = joined["evidence"]
            read(done.get("read"), guarded, True)
            accounting(done.get("accounting"), 0)
            released, drained = done.get("release_ns"), done.get("joined_ns")
            if (not all(report.positive_integer(v) for v in (released, drained))
                    or not waiting["monotonic_ns"] < released < drained < joined["monotonic_ns"]):
                raise ValueError("actual cancelled reader did not release then physically join")
            samples(done.get("samples"), events[0]["monotonic_ns"], joined["monotonic_ns"], policy)
            if any(observed not in done["samples"] for observed in actual):
                raise ValueError("actual accepted source sample changed after cancellation")
            if guarded and not any(released < v["started_ns"] < v["finished_ns"] <= drained
                    and v["age_ns"]+drained-v["finished_ns"] < policy["max_sample_age_millis"]*1_000_000 for v in done["samples"]):
                raise ValueError("actual guarded cancellation lacks fresh post-release settlement")
            if not guarded and done["samples"]:
                raise ValueError("startup source resumed before actual unguarded drain")
            startup.exact(done, {"read": done["read"], "physical_drain_joined": True,
                "accounting": zero, "allocated": [2,4096,1], "release_ns": released,
                "joined_ns": drained, "samples": done["samples"]}, "actual physical read settlement/full lease incomplete")
        runners.add(runner)
        done = events[-1]["evidence"]
        read(done.get("startup"), False, True); read(done.get("runtime"), True, True)
        startup.exact(done, {"startup": done["startup"], "runtime": done["runtime"],
            "startup_drained": True, "runtime_drained": True, "pressure_stopped": True,
            "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "snapshot_reverified": True, "accounting": zero, "allocated": [2,4096,1]},
            "accepted read producers were not joined before original saving/dependency teardown")
        result["cases"][case]["read_cancellation"] = events
    result.update(format="native-read-cancellation-report-v1", native_read_cancellation_complete=True,
        startup_pressure_guarded=False, checkpoint_models_stalled_storage=False,
        remaining_parent_gate="40760 accepted Guest/provider late results and final ancestor reconciliation; production/higher/P4 limits")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
