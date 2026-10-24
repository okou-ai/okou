#!/usr/bin/env python3
"""Require two guarded File producers' original aggregate custody and independent joins."""

import argparse
import hashlib
import json
import pathlib

import critical_report
import foreground_report as foreground
import pressure_report as pressure
import read_cancellation_report as cancellation
import report
import startup_report as startup

PREFIX = "NATIVE_SHARED_READS_WITNESS "
CASES = {f"SharedReads-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "initial_unknown", "both_accepted", "cancel_wait",
          "first_joined", "second_joined", "producers_joined")


def read(value, outcome):
    if not isinstance(value, dict) or not pressure.integer(value.get("deferred")):
        raise ValueError("shared read diagnostics missing")
    error = value.get("last_error")
    if error is not None and (not isinstance(error, str) or not error or value["deferred"] == 0):
        raise ValueError("shared read has an unexplained error")
    startup.exact(value, {"accepted": 1, "completed": int(outcome == "complete"),
        "cancelled": int(outcome == "cancelled"), "failed": 0, "uncertain": 0,
        "deferred": value["deferred"], "last_error": error, "finished": outcome != "held",
        "read_bytes": startup.BYTES if outcome == "complete" else cancellation.CHUNK if outcome == "cancelled" else 0},
        "shared File bytes/outcome or physical completion changed")


def accounting(value, readers, growth):
    tracked = value.get("tracked_tasks") if isinstance(value, dict) else None
    if not pressure.integer(tracked, readers) or readers == 0 and tracked != 0:
        raise ValueError("shared physical work owner missing")
    startup.exact(value, {"registered_operations": readers, "started": readers,
        "ordinary_growth_bytes": readers*growth, "tracked_tasks": tracked,
        "cleanup_growth_bytes": 0, "uncertain": 0}, "shared original aggregate allowance changed")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_shared_reads")
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
            raise ValueError("invalid shared read witness")
        witnesses[event["case"]].append(event)
    growth = startup.BYTES+inputs["prefetch_overhead_bytes"]
    runners = set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(event["phase"] for event in events) != PHASES:
            raise ValueError("missing duplicate or unordered shared read phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[2]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("shared original identity or join-before-saving changed")
        initial, unknown, accepted, waiting, first, second, done = [e["evidence"] for e in events]
        startup.exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "checkpoint_bytes": cancellation.CHUNK, "production_startup_integrated": False,
            "checkpoint_models_stalled_storage": False, "allocated": [2, 4096, 1]}, "shared original inputs or claim boundary changed")
        for key in ("first", "second"):
            critical_report.no_reads(unknown.get(key), False)
            read(accepted.get(key), "held")
        accounting(unknown.get("accounting"), 0, growth)
        startup.exact(unknown, {"state": "Unknown", "first": unknown["first"], "second": unknown["second"],
            "accounting": unknown["accounting"]}, "shared readers bypassed initial Unknown")
        actual = accepted.get("samples")
        cancellation.samples(actual, events[0]["monotonic_ns"], events[2]["monotonic_ns"], policy)
        fresh = pressure.sustained_ready_samples(actual, events[2]["monotonic_ns"], policy)
        available = accepted.get("available_bytes")
        required = policy["operating_floor_bytes"]+policy["cleanup_reserve_bytes"]+2*growth
        if (not pressure.integer(available, max(required, policy["recovery_available_bytes"]))
                or not any(v["available_bytes"] == available for v in fresh)):
            raise ValueError("shared reads lack sustained fresh Ready/aggregate headroom")
        accounting(accepted.get("accounting"), 2, growth)
        startup.exact(accepted, {"state": "Ready", "available_bytes": available, "samples": actual,
            "first": accepted["first"], "second": accepted["second"], "accounting": accepted["accounting"],
            "checkpoint_bytes": [cancellation.CHUNK]*2, "release_bytes_withheld": True, "allocated": [2,4096,1]},
            "two actual File producers were not concurrently held")
        ordered = [events[2]["monotonic_ns"], *(waiting.get(k) for k in
            ("cancelled_ns", "first_drain_dropped_ns", "second_pending_ns")), events[3]["monotonic_ns"]]
        if any(not report.positive_integer(n) for n in ordered) or any(a >= b for a,b in zip(ordered,ordered[1:])):
            raise ValueError("shared cancelled drain did not positively poll Pending")
        accounting(waiting.get("accounting"), 2, growth)
        startup.exact(waiting.get("second"), accepted["second"], "cancelling one changed the held peer")
        foreground.observer(waiting.get("observer"), waiting["second_pending_ns"], events[3]["monotonic_ns"])
        runner = foreground.heartbeat(waiting.get("heartbeat"), 1, waiting["second_pending_ns"], events[3]["monotonic_ns"])
        if runner in runners:
            raise ValueError("shared heartbeat generation was replayed")
        runners.add(runner)
        startup.exact(waiting, {**dict(zip(("cancelled_ns", "first_drain_dropped_ns", "second_pending_ns"), ordered[1:4])),
            "first_drain_pending": True, "first_drain_dropped": True, "second_drain_pending": True,
            "release_bytes_withheld": True, "accounting": waiting["accounting"], "second": waiting["second"],
            "heartbeat": waiting["heartbeat"], "observer": waiting["observer"], "allocated": [2,4096,1]},
            "shared drain lost physical custody or independent progress")
        previous_samples = actual
        for index, value, remaining in ((4, first, 1), (5, second, 0)):
            read(value.get("first"), "cancelled")
            read(value.get("second"), "held" if remaining else "complete")
            accounting(value.get("accounting"), remaining, growth)
            released, joined = value.get("release_ns"), value.get("joined_ns")
            if (not all(report.positive_integer(n) for n in (released, joined))
                    or not events[index-1]["monotonic_ns"] < released < joined < events[index]["monotonic_ns"]):
                raise ValueError("shared reader release/positive physical join changed")
            samples = value.get("samples")
            cancellation.samples(samples, events[0]["monotonic_ns"], events[index]["monotonic_ns"], policy)
            if (any(observed not in samples for observed in previous_samples)
                    or not any(released < v["started_ns"] < v["finished_ns"] <= joined
                        and v["age_ns"]+joined-v["finished_ns"] < policy["max_sample_age_millis"]*1_000_000 for v in samples)):
                raise ValueError("shared read settlement lost original or fresh post-release samples")
            expected = {"first": value["first"], "second": value["second"], "release_ns": released,
                "joined_ns": joined, "physical_drain_joined": True, "accounting": value["accounting"],
                "samples": samples, "allocated": [2,4096,1]}
            if remaining:
                expected["second_release_withheld"] = True
                startup.exact(value["second"], accepted["second"], "the held peer changed before release")
            else:
                startup.exact(value["first"], first["first"], "settled cancelled reader changed")
            startup.exact(value, expected, "shared reader did not retain independent original ownership")
            previous_samples = samples
        startup.exact(done, {"first": second["first"], "second": second["second"], "readers_drained": True,
            "pressure_stopped": True, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "snapshot_reverified": True, "accounting": second["accounting"], "allocated": [2,4096,1]},
            "shared accepted producers were not joined before original saving")
        result["cases"][case]["shared_reads"] = events
    result.update(format="native-shared-reads-report-v1", native_shared_reads_complete=True,
        production_startup_integrated=False, checkpoint_models_stalled_storage=False,
        remaining_parent_gate="Production startup/P2 installation remains partial; original P4 and provenance/resource/race limits remain")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
