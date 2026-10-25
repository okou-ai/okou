#!/usr/bin/env python3
"""Validate real native Fresh/reuse progress and original saving through held waits."""

import argparse
import hashlib
import json
import pathlib
import uuid

import critical_report
import pressure_report
import report
import startup_report as startup

PREFIX = "NATIVE_FOREGROUND_WITNESS "
CASES = {f"Foreground{kind}-{mode}" for kind in ("Fresh", "Reuse") for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "pool_wait_progress", "status_wait_progress", "foreground_prepared",
          "physical_io_wait_progress", "producers_joined")


def identifier(value):
    return isinstance(value, str) and str(uuid.UUID(value)) == value


def observer(value, begin, end):
    if (not isinstance(value, dict) or set(value) != {"started_ns", "completed_ns", "available_bytes",
            "age_ns", "read_duration_ns", "joined"} or value["joined"] is not True
            or any(not pressure_report.integer(value[k]) for k in value if k != "joined")
            or not begin < value["started_ns"] < value["completed_ns"] < end
            or not 0 < value["available_bytes"]
            or not value["read_duration_ns"] <= value["age_ns"] <= value["completed_ns"]-value["started_ns"]
            or value["age_ns"] >= 5_000_000_000):
        raise ValueError("foreground observer did not complete a new joined real read inside the held wait")


def heartbeat(value, sequence, begin, end, allocated=(2, 4096)):
    if (not isinstance(value, dict) or set(value) != {"receipt", "send_joined", "completed_ns"}
            or value["send_joined"] is not True or not report.positive_integer(value["completed_ns"])):
        raise ValueError("foreground heartbeat send was not positively joined")
    receipt = value["receipt"]
    if (not isinstance(receipt, dict) or set(receipt) != {"received_ns", "acknowledgement_status", "state"}
            or type(receipt["acknowledgement_status"]) is not int or receipt["acknowledgement_status"] != 204
            or not report.positive_integer(receipt["received_ns"])
            or not begin < receipt["received_ns"] < value["completed_ns"] < end):
        raise ValueError("foreground heartbeat request/acknowledgement is outside the held wait")
    state = receipt["state"]
    if (not isinstance(state, dict) or not identifier(state.get("runnerId"))
            or not pressure_report.integer(state.get("snapshotGeneration"), 1)
            or type(state.get("snapshotSequence")) is not int or state["snapshotSequence"] != sequence
            or state.get("group") != "native-foreground" or state.get("mode") != "running"
            or type(state.get("allocatedVcpu")) is not int or state["allocatedVcpu"] != allocated[0]
            or type(state.get("allocatedMemoryMb")) is not int or state["allocatedMemoryMb"] != allocated[1]):
        raise ValueError("foreground heartbeat lost its original generation/sequence/full lease")
    return state["runnerId"], state["snapshotGeneration"]


def runtime(read):
    startup.exact(read, {"accepted": 1, "completed": 1, "cancelled": 0, "failed": 0,
        "uncertain": 0, "deferred": 0, "read_bytes": startup.BYTES, "last_error": None, "finished": True},
        "foreground runtime did not completely read and drain original bytes")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_foreground")
    witnesses = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure_report.unique_object)
        if (not isinstance(event, dict) or event.get("case") not in CASES
                or type(event.get("version")) is not int or event["version"] != 1
                or not report.positive_integer(event.get("monotonic_ns"))
                or not report.positive_integer(event.get("unix_ns"))):
            raise ValueError("invalid native foreground witness")
        witnesses[event["case"]].append(event)
    runners = set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered foreground phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)
                or not events[3]["monotonic_ns"] < terminal[2]["monotonic_ns"]
                or not terminal[3]["monotonic_ns"] < events[4]["monotonic_ns"] < terminal[4]["monotonic_ns"]
                or not terminal[4]["monotonic_ns"] < events[5]["monotonic_ns"]):
            raise ValueError("foreground original identity/physical ownership ordering changed")
        initial, pool, status, prepared, blocked, joined = [e["evidence"] for e in events]
        kind = "Fresh" if case.startswith("ForegroundFresh-") else "Reuse"
        startup.exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"],
            "snapshot_bytes": startup.BYTES, "snapshot_memory_mb": 4096,
            "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"], "allocated": [2,4096,1],
            "startup_pressure_guarded": False, "kind": kind}, "foreground original inputs/full lease changed")
        startup.complete(pool.get("startup"))
        critical_report.no_reads(pool.get("reads"), False)
        held, status_held, released = pool.get("pool_held_ns"), pool.get("status_held_ns"), status.get("pool_released_ns")
        polled = status.get("status_wait_polled_ns")
        if (not all(report.positive_integer(n) for n in (held, status_held, released, polled))
                or not events[0]["monotonic_ns"] < held <= status_held < events[1]["monotonic_ns"] < released
                or not released < polled < events[2]["monotonic_ns"]
                or status.get("status_held_ns") != status_held):
            raise ValueError("foreground wait ownership clocks missing")
        startup.exact(pool, {"startup": pool["startup"], "startup_drained": True,
            "reads": pool["reads"], "state": "Unknown", "pool_held": True, "status_held": True,
            "heartbeat_received": False, "pool_held_ns": held, "status_held_ns": status_held,
            "foreground_pool_wait_polled": True,
            "observer": pool.get("observer")}, "foreground held pool/Unknown contract changed")
        observer(pool.get("observer"), status_held, events[1]["monotonic_ns"])
        runtime(status.get("reads"))
        first = heartbeat(status.get("heartbeat"), 1, polled, events[2]["monotonic_ns"])
        observer(status.get("observer"), polled, events[2]["monotonic_ns"])
        available = status.get("available_bytes")
        samples = status.get("samples")
        if (not pressure_report.integer(available, policy["recovery_available_bytes"])
                or available > policy["host_total_bytes"] or not isinstance(samples, list)):
            raise ValueError("foreground Ready lacks actual supplied headroom")
        previous, previous_offset = -1, -1
        for sample in samples:
            if (not isinstance(sample, dict) or set(sample) != {"started_ns", "finished_ns", "read_start_offset_ns",
                    "available_bytes", "age_ns", "read_duration_ns"}
                    or any(not pressure_report.integer(sample[k]) for k in sample if k != "available_bytes")
                    or not polled < sample["started_ns"] < sample["finished_ns"] < events[2]["monotonic_ns"]
                    or sample["started_ns"] <= previous or sample["read_start_offset_ns"] <= previous_offset
                    or not sample["read_duration_ns"] <= sample["age_ns"] <= sample["finished_ns"]-sample["started_ns"]
                    or sample["available_bytes"] is not None and (
                        not pressure_report.integer(sample["available_bytes"])
                        or sample["available_bytes"] > policy["host_total_bytes"])):
                raise ValueError("foreground actual pressure read clocks changed")
            previous, previous_offset = sample["started_ns"], sample["read_start_offset_ns"]
        fresh_samples = pressure_report.sustained_ready_samples(samples, events[2]["monotonic_ns"], policy)
        if not any(s["available_bytes"] == available for s in fresh_samples):
            raise ValueError("foreground Ready lacks distinct sustained actual observations")
        startup.exact(status, {"state": "Ready", "available_bytes": available, "status_held": True,
            "heartbeat": status["heartbeat"], "observer": status["observer"], "reads": status["reads"],
            "runtime_drained": True, "status_held_ns": status_held, "pool_released_ns": released,
            "status_wait_polled_ns": polled,
            "foreground_status_wait_polled": True,
            "samples": samples}, "foreground status-wait contract changed")
        if (not identifier(prepared.get("sandbox_id")) or not identifier(prepared.get("run_id"))
                or not identifier(prepared.get("operation_id"))
                or (prepared["sandbox_id"] == identity[0]) != (kind == "Reuse")):
            raise ValueError("foreground Fresh/reuse selected identity changed")
        startup.exact(prepared, {"kind": kind, "sandbox_id": prepared["sandbox_id"], "run_id": prepared["run_id"],
            "operation_id": prepared["operation_id"], "guest_rpc_completed": True, "phase_settled": True,
            "original_owner_preserved": True, "allocated": [2,4096,1]}, "foreground Guest/phase completion missing")
        second = heartbeat(blocked.get("heartbeat"), 2, terminal[3]["monotonic_ns"], events[4]["monotonic_ns"])
        if first != second or first in runners:
            raise ValueError("foreground heartbeat generation was changed or reused")
        runners.add(first)
        observer(blocked.get("observer"), terminal[3]["monotonic_ns"], events[4]["monotonic_ns"])
        startup.exact(blocked, {"kernel_io_entered": True, "release_byte_withheld": True,
            "full_original_lease": [2,4096,1], "allocated": [2,4096,1],
            "heartbeat": blocked["heartbeat"], "observer": blocked["observer"]}, "foreground blocking IO/full lease proof missing")
        startup.complete(joined.get("startup"))
        runtime(joined.get("reads"))
        startup.exact(joined, {"startup": joined["startup"], "reads": joined["reads"],
            "startup_drained": True, "runtime_drained": True, "foreground_joined": True,
            "pressure_stopped": True, "producer_lost": False, "wave_inflight": False,
            "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "snapshot_reverified": True, "allocated": [0,0,0], "registered_operations": 0,
            "tracked_tasks": 0}, "foreground physical producer/dependency joins incomplete")
        result["cases"][case]["foreground"] = {"witnesses": events, "full_production_reactor_proven": False}
    result["remaining_parent_gate"] = "40412 inventory/Critical/stale/post-wait fences; 40355 accepted cancellation/late results and final reconciliation"
    return {"format": "native-foreground-phase-report-v1", "native_foreground_progress_complete": True,
            "startup_pressure_guarded": False, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
