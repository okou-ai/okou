#!/usr/bin/env python3
"""Require accepted File custody through genuine observation expiry and recovery."""

import argparse
import hashlib
import json
import pathlib

import critical_report
import foreground_report as foreground
import pressure_report as pressure
import read_cancellation_report as cancellation
import report
import shared_reads_report as shared
import startup_report as startup

PREFIX = "NATIVE_READ_REVOCATION_WITNESS "
CASES = {f"ReadRevocation-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "initial_unknown", "both_accepted", "observation_held",
          "stale_unknown", "stale_wait_progress", "recovered_ready", "fresh_accepted",
          "fresh_joined", "first_joined", "second_joined", "producers_joined")


def ready(value, end, begin, policy, growth, readers, after=0):
    actual = value.get("samples")
    cancellation.samples(actual, begin, end, policy)
    fresh = pressure.sustained_ready_samples(actual, end, policy, after)
    available = value.get("available_bytes")
    required = policy["operating_floor_bytes"]+policy["cleanup_reserve_bytes"]+readers*growth
    if (not pressure.integer(available, max(required, policy["recovery_available_bytes"]))
            or not any(v["available_bytes"] == available for v in fresh)):
        raise ValueError("revoked readers lack actual sustained Ready/full aggregate headroom")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_read_revocation")
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
            raise ValueError("invalid read revocation witness")
        witnesses[event["case"]].append(event)
    growth = startup.BYTES+inputs["prefetch_overhead_bytes"]
    runners = set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered read revocation phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[2]["monotonic_ns"]]
        if (any(a >= b for a,b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("revocation lost original identity/joins before saving")
        values = [e["evidence"] for e in events]
        initial, unknown, accepted, held, stale, waiting, recovered, fresh, *_, done = values
        begin = events[0]["monotonic_ns"]
        startup.exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "checkpoint_bytes": cancellation.CHUNK, "production_startup_integrated": False,
            "checkpoint_models_stalled_storage": False, "allocated": [2,4096,1]}, "revocation original inputs/limits changed")
        for key in ("first", "second"):
            critical_report.no_reads(unknown.get(key), False)
        shared.accounting(unknown.get("accounting"), 0, growth)
        startup.exact(unknown, {"state": "Unknown", "first": unknown["first"], "second": unknown["second"],
            "accounting": unknown["accounting"]}, "revocation bypassed initial Unknown")
        ready(accepted, events[2]["monotonic_ns"], begin, policy, growth, 2)
        shared.accounting(accepted.get("accounting"), 2, growth)
        for key in ("first", "second"):
            shared.read(accepted.get(key), "held")
        startup.exact(accepted, {"state": "Ready", "available_bytes": accepted["available_bytes"],
            "samples": accepted["samples"], "first": accepted["first"], "second": accepted["second"],
            "accounting": accepted["accounting"], "checkpoint_bytes": [cancellation.CHUNK]*2,
            "release_bytes_withheld": True, "allocated": [2,4096,1]}, "old readers were not held after real bytes")
        frozen = held.get("samples")
        cancellation.samples(frozen, begin, events[3]["monotonic_ns"], policy)
        if not frozen or any(s not in frozen for s in accepted["samples"]):
            raise ValueError("held observation lost original actual samples")
        for index in (3,4,5,6,7):
            value = values[index]
            readers = 3 if index == 7 else 2
            shared.accounting(value.get("accounting"), readers, growth)
            for key in ("first", "second"):
                startup.exact(value.get(key), accepted[key], "old held reader revived before release")
            expected = {"first": accepted["first"], "second": accepted["second"], "samples": value.get("samples"),
                "accounting": value["accounting"], "release_bytes_withheld": True,
                "explicit_old_cancel_requested": False, "allocated": [2,4096,1]}
            if index < 6:
                startup.exact(value.get("samples"), frozen, "held observation returned or renewed a sample")
            if index in (4,5):
                expected.update(state="Unknown", reason="Stale")
                if any(s["age_ns"]+events[index]["monotonic_ns"]-s["finished_ns"] < policy["max_sample_age_millis"]*1_000_000 for s in frozen):
                    raise ValueError("Unknown did not follow real observation expiry")
            if index == 5:
                order = [events[4]["monotonic_ns"], *(waiting.get(k) for k in
                    ("first_drain_dropped_ns", "second_pending_ns", "peer_pending_ns")), events[5]["monotonic_ns"]]
                if any(not report.positive_integer(n) for n in order) or any(a >= b for a,b in zip(order,order[1:])):
                    raise ValueError("revocation drain observers lack positive Pending order")
                foreground.observer(waiting.get("observer"), order[3], order[4])
                runner = foreground.heartbeat(waiting.get("heartbeat"), 1, order[3], order[4])
                if runner in runners:
                    raise ValueError("revocation heartbeat generation replayed")
                runners.add(runner)
                expected.update(first_drain_dropped_ns=order[1], second_pending_ns=order[2],
                    peer_pending_ns=order[3], peer_drain_pending=True,
                    first_drain_pending=True, first_drain_dropped=True, second_drain_pending=True,
                    heartbeat=waiting["heartbeat"], observer=waiting["observer"])
            if index >= 6:
                resumed = recovered.get("resumed_ns")
                if not report.positive_integer(resumed) or not events[5]["monotonic_ns"] < resumed < events[6]["monotonic_ns"]:
                    raise ValueError("actual recovery source resume boundary missing")
                ready(value, events[index]["monotonic_ns"], begin, policy, growth, readers, resumed)
                if any(s not in value["samples"] for s in frozen):
                    raise ValueError("recovery replaced original samples")
                expected.update(state="Ready", available_bytes=value["available_bytes"])
                if index == 6:
                    expected["resumed_ns"] = resumed
                else:
                    shared.read(value.get("fresh"), "held")
                    expected.update(fresh=value["fresh"], checkpoint_bytes=[cancellation.CHUNK]*3)
            startup.exact(value, expected, "revocation custody/state/progress contract changed")
        previous_samples = fresh["samples"]
        for index, remaining in ((8,2),(9,1),(10,0)):
            value = values[index]
            for key, outcome in (("fresh","complete"), ("first","held" if index == 8 else "cancelled"),
                    ("second","cancelled" if index == 10 else "held")):
                shared.read(value.get(key), outcome)
            shared.accounting(value.get("accounting"), remaining, growth)
            released, joined = value.get("release_ns"), value.get("joined_ns")
            if (not all(report.positive_integer(n) for n in (released,joined))
                    or not events[index-1]["monotonic_ns"] < released < joined < events[index]["monotonic_ns"]):
                raise ValueError("revoked physical release/join order changed")
            actual = value.get("samples")
            cancellation.samples(actual, begin, events[index]["monotonic_ns"], policy)
            ready(value, events[index]["monotonic_ns"], begin, policy, growth, remaining, recovered["resumed_ns"])
            release_available = value.get("release_available_bytes")
            if (not pressure.integer(release_available, policy["recovery_available_bytes"])
                    or not any(s["available_bytes"] == release_available and s["finished_ns"] <= released
                        and s["age_ns"]+released-s["finished_ns"] < policy["max_sample_age_millis"]*1_000_000 for s in actual)):
                raise ValueError("old read release lacks actual recovered Ready evidence")
            if any(s not in actual for s in previous_samples):
                raise ValueError("physical join replaced actual recovery samples")
            if not any(released < s["started_ns"] < s["finished_ns"] <= joined
                    and s["age_ns"]+joined-s["finished_ns"] < policy["max_sample_age_millis"]*1_000_000 for s in actual):
                raise ValueError("physical join lacks an actual fresh post-release observation")
            startup.exact(value, {"first": value["first"], "second": value["second"], "fresh": value["fresh"],
                "release_ns": released, "joined_ns": joined, "physical_drain_joined": True,
                "release_state": "Ready", "release_available_bytes": release_available,
                "state": "Ready", "available_bytes": value["available_bytes"],
                "samples": actual, "accounting": value["accounting"], "explicit_old_cancel_requested": False,
                "allocated": [2,4096,1]}, "old cancellation or fresh physical completion changed")
            previous_samples = actual
        last = values[10]
        startup.exact(done, {"first": last["first"], "second": last["second"], "fresh": last["fresh"],
            "explicit_old_cancel_requested": False, "readers_drained": True, "pressure_stopped": True,
            "heartbeat_joined": True, "provider_joined": True, "peer_joined": True, "snapshot_reverified": True,
            "accounting": last["accounting"], "allocated": [2,4096,1]}, "revocation dependencies did not join")
        result["cases"][case]["read_revocation"] = events
    result.update(format="native-read-revocation-report-v1", native_read_revocation_complete=True,
        production_startup_integrated=False, checkpoint_models_stalled_storage=False,
        remaining_parent_gate="Production startup/P2 installation remains partial; P4 and provenance/resource/race limits remain")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
