#!/usr/bin/env python3
"""Require sampler shutdown and independent accepted File ownership/joins."""

import argparse
import hashlib
import json
import pathlib

import critical_report
import foreground_report as foreground
import pressure_report as pressure
import read_cancellation_report as cancellation
import read_revocation_report as revocation
import report
import shared_reads_report as shared
import startup_report as startup

PREFIX = "NATIVE_READ_STOP_WITNESS "
CASES = {f"ReadStop-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "initial_unknown", "both_accepted", "observation_held",
          "shutdown_wait_progress", "pressure_joined", "first_joined", "second_joined", "producers_joined")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_read_stop")
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
            raise ValueError("invalid read stop witness")
        witnesses[event["case"]].append(event)
    growth = startup.BYTES+inputs["prefetch_overhead_bytes"]
    runners = set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered read stop phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[2]["monotonic_ns"]]
        if (any(a >= b for a,b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("read stop lost original identity or join-before-saving order")
        initial, unknown, accepted, held, waiting, joined, first, second, done = [e["evidence"] for e in events]
        begin = events[0]["monotonic_ns"]
        startup.exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "checkpoint_bytes": cancellation.CHUNK, "production_startup_integrated": False,
            "checkpoint_models_stalled_storage": False, "allocated": [2,4096,1]}, "read stop original inputs/limits changed")
        for key in ("first", "second"):
            critical_report.no_reads(unknown.get(key), False)
            shared.read(accepted.get(key), "held")
        shared.accounting(unknown.get("accounting"), 0, growth)
        startup.exact(unknown, {"state": "Unknown", "first": unknown["first"], "second": unknown["second"],
            "accounting": unknown["accounting"]}, "read stop bypassed initial Unknown")
        revocation.ready(accepted, events[2]["monotonic_ns"], begin, policy, growth, 2)
        shared.accounting(accepted.get("accounting"), 2, growth)
        startup.exact(accepted, {"state": "Ready", "available_bytes": accepted["available_bytes"],
            "samples": accepted["samples"], "first": accepted["first"], "second": accepted["second"],
            "accounting": accepted["accounting"], "checkpoint_bytes": [cancellation.CHUNK]*2,
            "release_bytes_withheld": True, "allocated": [2,4096,1]}, "read stop original readers not accepted/held")
        frozen = held.get("samples")
        cancellation.samples(frozen, begin, events[3]["monotonic_ns"], policy)
        if not frozen or any(s not in frozen for s in accepted["samples"]):
            raise ValueError("read stop lost held actual observation cohort")
        for index, value in ((3,held),(4,waiting),(5,joined)):
            shared.accounting(value.get("accounting"), 2, growth)
            expected = {"samples": value.get("samples"), "first": accepted["first"], "second": accepted["second"],
                "accounting": value["accounting"], "release_bytes_withheld": True,
                "explicit_old_cancel_requested": False, "allocated": [2,4096,1]}
            if index < 5:
                startup.exact(value.get("samples"), frozen, "held sampler returned or renewed observations")
            if index >= 4:
                critical_report.no_reads(value.get("refused"), True)
                expected.update(optional_closed=True, refused=value["refused"])
            if index == 4:
                names = ("shutdown_requested_ns", "shutdown_pending_ns", "readers_pending_ns", "shutdown_still_pending_ns")
                order = [events[3]["monotonic_ns"], *(value.get(k) for k in names), events[4]["monotonic_ns"]]
                if any(not report.positive_integer(v) for v in order) or any(a >= b for a,b in zip(order,order[1:])):
                    raise ValueError("shutdown/reader Pending observations lack positive order")
                foreground.observer(waiting.get("observer"), order[3], order[4])
                runner = foreground.heartbeat(waiting.get("heartbeat"), 1, order[3], order[4])
                if runner in runners:
                    raise ValueError("read stop heartbeat generation replayed")
                runners.add(runner)
                expected.update({k:value[k] for k in names})
                expected.update(shutdown_pending=True, controller_stopped=True, sampler_release_withheld=True,
                    first_drain_pending=True, second_drain_pending=True, drain_observers_dropped=True,
                    heartbeat=value["heartbeat"], observer=value["observer"])
            if index == 5:
                released, completed = value.get("observation_released_ns"), value.get("pressure_joined_ns")
                if (not all(report.positive_integer(v) for v in (released, completed))
                        or not events[4]["monotonic_ns"] < released < completed < events[5]["monotonic_ns"]):
                    raise ValueError("pressure shutdown did not follow actual observation release")
                actual = value.get("samples")
                cancellation.samples(actual, begin, events[5]["monotonic_ns"], policy)
                if any(s not in actual for s in frozen):
                    raise ValueError("joined pressure replaced original source samples")
                if not any(released < s["started_ns"] < s["finished_ns"] <= completed for s in actual):
                    raise ValueError("joined sampler lacks actual post-release observation")
                expected.update(observation_released_ns=released, pressure_joined_ns=completed,
                    controller_joined=True, sampler_joined=True, producer_lost=False, wave_inflight=False)
            startup.exact(value, expected, "shutdown discharged independent accepted File custody")
        previous = joined["samples"]
        for index, value, remaining in ((6,first,1),(7,second,0)):
            shared.read(value.get("read"), "cancelled")
            shared.accounting(value.get("accounting"), remaining, growth)
            released, completed = value.get("release_ns"), value.get("joined_ns")
            if (not all(report.positive_integer(v) for v in (released, completed))
                    or not events[index-1]["monotonic_ns"] < released < completed < events[index]["monotonic_ns"]):
                raise ValueError("stopped File release/physical join order changed")
            actual = value.get("samples")
            cancellation.samples(actual, begin, events[index]["monotonic_ns"], policy)
            if (any(s not in actual for s in previous)
                    or not any(released < s["started_ns"] < s["finished_ns"] <= completed
                        and s["age_ns"]+completed-s["finished_ns"] < policy["max_sample_age_millis"]*1_000_000 for s in actual)):
                raise ValueError("stopped File join lacks original/fresh post-release settlement")
            startup.exact(value, {"read": value["read"], "release_ns": released, "joined_ns": completed,
                "physical_drain_joined": True, "optional_closed": True, "samples": actual,
                "accounting": value["accounting"], "explicit_old_cancel_requested": False,
                "allocated": [2,4096,1]}, "stopped File outcome/accounting contract changed")
            previous = actual
        startup.exact(done, {"first": first["read"], "second": second["read"], "refused": joined["refused"],
            "controller_joined": True, "sampler_joined": True, "readers_drained": True,
            "heartbeat_joined": True, "provider_joined": True, "peer_joined": True, "snapshot_reverified": True,
            "optional_closed": True, "explicit_old_cancel_requested": False,
            "accounting": second["accounting"], "allocated": [2,4096,1]}, "stopped dependencies were not joined before saving")
        result["cases"][case]["read_stop"] = events
    result.update(format="native-read-stop-report-v1", native_read_stop_complete=True,
        production_startup_integrated=False, checkpoint_models_stalled_storage=False,
        remaining_parent_gate="Production startup/P2 installation remains partial; P4 and provenance/resource/race limits remain")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
