#!/usr/bin/env python3
"""Require full-budget logical progress and complete original physical custody."""

import argparse
import hashlib
import json
import pathlib

import critical_report
import foreground_report as foreground
import pressure_report as pressure
import report
import startup_report as startup

PREFIX = "NATIVE_LOGICAL_PROGRESS_WITNESS "
CASES = {f"LogicalProgress-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "pool_wait_progress", "status_wait_progress",
          "replacement_prepared", "old_join_polled", "physical_io_wait_progress", "producers_joined")


def sample(value, begin, end, policy):
    if (not isinstance(value, dict) or set(value) != {"started_ns", "finished_ns", "read_start_offset_ns",
            "available_bytes", "age_ns", "read_duration_ns"}
            or any(not pressure.integer(value[k]) for k in value if k != "available_bytes")
            or not begin < value["started_ns"] < value["finished_ns"] < end
            or not value["read_duration_ns"] <= value["age_ns"] <= value["finished_ns"]-value["started_ns"]
            or value["available_bytes"] is not None and (
                not pressure.integer(value["available_bytes"]) or value["available_bytes"] > policy["host_total_bytes"])):
        raise ValueError("logical actual observation timing or availability changed")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_logical")
    witnesses = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1 or event["case"] not in CASES
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid logical progress witness")
        witnesses[event["case"]].append(event)
    runners, incoming_ids, incoming_backings = set(), set(), set()
    originals = {value[1]["sandbox_id"] for value in terminals.values()}
    backings = {value[1]["backing_generation"] for value in terminals.values()}
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered logical progress")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)
                or any(not isinstance(e["evidence"], dict) for e in events)):
            raise ValueError("logical original identity or ownership order changed")
        initial, pool, status, prepared, joining, blocked, joined = [e["evidence"] for e in events]
        grant = initial.get("fresh_grant")
        if (not isinstance(grant, dict) or set(grant) != {"started_ns", "finished_ns", "operation_id", "samples"}
                or not report.positive_integer(grant["started_ns"]) or not report.positive_integer(grant["finished_ns"])
                or not terminal[1]["monotonic_ns"] < grant["started_ns"] < grant["finished_ns"] < events[0]["monotonic_ns"]
                or not foreground.identifier(grant["operation_id"]) or not isinstance(grant["samples"], list)
                or len(grant["samples"]) != 1):
            raise ValueError("logical replacement has no original actual Fresh grant")
        granted = grant["samples"][0]
        sample(granted, grant["started_ns"], grant["finished_ns"], policy)
        if (not pressure.integer(granted["available_bytes"], 1)
                or granted["age_ns"] >= policy["max_sample_age_millis"]*1_000_000):
            raise ValueError("logical original Fresh grant is not fresh")
        startup.exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "allocated": [2,4096,1], "profile_can_fit": False, "startup_pressure_guarded": False,
            "physical_credit_from_logical_transfer": False, "fresh_grant": grant}, "logical full-budget inputs or Fresh credit changed")
        held, status_held, polled = [pool.get(k) for k in ("pool_held_ns", "status_held_ns", "pool_wait_polled_ns")]
        if (not all(report.positive_integer(n) for n in (held, status_held, polled))
                or not events[0]["monotonic_ns"] < held <= status_held < polled < events[1]["monotonic_ns"]):
            raise ValueError("logical actual pool Pending wait missing")
        startup.complete(pool.get("startup"))
        critical_report.no_reads(pool.get("reads"), False)
        foreground.observer(pool.get("observer"), polled, events[1]["monotonic_ns"])
        startup.exact(pool, {"startup": pool["startup"], "startup_drained": True, "reads": pool["reads"],
            "state": "Unknown", "pool_held_ns": held, "status_held_ns": status_held,
            "pool_wait_polled_ns": polled, "pool_wait_polled_pending": True, "observer": pool["observer"],
            "allocated": [2,4096,1]}, "logical startup/Unknown/full original coverage changed")
        released, status_polled = status.get("pool_released_ns"), status.get("status_wait_polled_ns")
        runtime_completed = status.get("runtime_completed_ns")
        before, after = status.get("status_waits_before"), status.get("status_waits_after")
        if (not all(report.positive_integer(n) for n in (released, status_polled, runtime_completed))
                or not pressure.integer(before) or not pressure.integer(after) or after != before + 1
                or not events[1]["monotonic_ns"] < runtime_completed < released < status_polled < events[2]["monotonic_ns"]):
            raise ValueError("logical specific status-lock Pending observation missing")
        foreground.runtime(status.get("reads"))
        first = foreground.heartbeat(status.get("heartbeat"), 1, status_polled, events[2]["monotonic_ns"])
        foreground.observer(status.get("observer"), status_polled, events[2]["monotonic_ns"])
        samples, available = status.get("samples"), status.get("available_bytes")
        if (not isinstance(samples, list) or not pressure.integer(available, policy["recovery_available_bytes"])
                or available > policy["host_total_bytes"]):
            raise ValueError("logical Ready has no actual supplied observations")
        previous, offset = -1, granted["read_start_offset_ns"]
        for value in samples:
            sample(value, events[1]["monotonic_ns"], events[2]["monotonic_ns"], policy)
            if value["started_ns"] <= previous or value["read_start_offset_ns"] <= offset:
                raise ValueError("logical Ready replays an original sample")
            previous, offset = value["started_ns"], value["read_start_offset_ns"]
        fresh = pressure.sustained_ready_samples(samples, events[2]["monotonic_ns"], policy)
        if not any(s["available_bytes"] == available for s in fresh):
            raise ValueError("logical Ready lacks distinct sustained fresh observations")
        before_runtime = pressure.sustained_ready_samples(samples, runtime_completed, policy)
        if not before_runtime:
            raise ValueError("logical runtime completed without actual sustained Ready under the held pool")
        startup.exact(status, {"state": "Ready", "available_bytes": available, "reads": status["reads"],
            "runtime_drained": True, "runtime_completed_ns": runtime_completed,
            "pool_released_ns": released, "status_held_ns": status_held,
            "status_wait_polled_ns": status_polled, "status_waits_before": before, "status_waits_after": after,
            "actual_idle_snapshot_wait": True, "heartbeat": status["heartbeat"], "observer": status["observer"],
            "allocated": [2,4096,1], "logical_lease_transferred": True, "original_full_lease_retained": True,
            "profile_can_fit": False, "inventory_empty": True, "samples": samples}, "logical status/full original transfer changed")
        refresh = prepared.get("refresh")
        if (not isinstance(refresh, dict) or set(refresh) != {"started_ns", "finished_ns", "available_bytes", "age_ns", "read_duration_ns"}
                or any(not pressure.integer(v) for v in refresh.values())
                or not events[2]["monotonic_ns"] < refresh["started_ns"] < refresh["finished_ns"] < events[3]["monotonic_ns"]
                or not 0 < refresh["available_bytes"] <= policy["host_total_bytes"]
                or not refresh["read_duration_ns"] <= refresh["age_ns"] <= refresh["finished_ns"]-refresh["started_ns"]
                or refresh["age_ns"] >= policy["max_sample_age_millis"]*1_000_000
                or not foreground.identifier(prepared.get("sandbox_id")) or prepared["sandbox_id"] in originals | incoming_ids
                or not foreground.identifier(prepared.get("backing_generation")) or prepared["backing_generation"] in backings | incoming_backings):
            raise ValueError("logical replacement lacks post-status Fresh refresh or a distinct physical owner")
        incoming_ids.add(prepared["sandbox_id"])
        incoming_backings.add(prepared["backing_generation"])
        startup.exact(prepared, {"sandbox_id": prepared["sandbox_id"], "backing_generation": prepared["backing_generation"],
            "operation_id": grant["operation_id"], "guest_rpc_completed": True, "phase_settled": True,
            "new_backing_exit_confirmed": True, "allocated": [2,4096,1], "logical_lease_transferred": True,
            "refresh": refresh}, "logical actual replacement/phase/backing completion changed")
        join_polled = joining.get("polled_ns")
        if (not report.positive_integer(join_polled) or not events[3]["monotonic_ns"] < join_polled < events[4]["monotonic_ns"]
                or not terminal[3]["monotonic_ns"] < events[5]["monotonic_ns"] < terminal[4]["monotonic_ns"]
                or not terminal[4]["monotonic_ns"] < events[6]["monotonic_ns"]):
            raise ValueError("logical replacement/join/physical-tail ownership order changed")
        startup.exact(joining, {"polled_ns": join_polled, "retirements": 1, "allocated": [2,4096,1],
            "old_exit_dependency_added": False}, "logical join started before replacement or added old-exit dependency")
        begin = max(join_polled, terminal[3]["monotonic_ns"])
        second = foreground.heartbeat(blocked.get("heartbeat"), 2, begin, events[5]["monotonic_ns"])
        foreground.observer(blocked.get("observer"), begin, events[5]["monotonic_ns"])
        if first != second or first in runners:
            raise ValueError("logical reporting changed/reused its original runner generation")
        runners.add(first)
        startup.exact(blocked, {"old_join_polled_ns": join_polled, "kernel_io_entered": True,
            "release_byte_withheld": True, "full_logical_lease": [2,4096,1], "allocated": [2,4096,1],
            "heartbeat": blocked["heartbeat"], "observer": blocked["observer"]}, "logical blocked physical IO/full lease missing")
        startup.complete(joined.get("startup"))
        foreground.runtime(joined.get("reads"))
        startup.exact(joined, {"startup": joined["startup"], "reads": joined["reads"], "startup_drained": True,
            "runtime_drained": True, "logical_work_joined": True, "pressure_stopped": True, "producer_lost": False,
            "wave_inflight": False, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "snapshot_reverified": True, "original_full_lease_retained": True, "registered_operations": 0,
            "tracked_tasks": 0, "allocated": [2,4096,1], "physical_credit_from_logical_transfer": False},
            "logical physical/read/reporting/dependency owners did not join")
        result["cases"][case]["logical_progress"] = events
    result.update(format="native-logical-progress-report-v1", native_logical_progress_complete=True,
                  startup_pressure_guarded=False,
                  remaining_parent_gate="40595 incoming inventory; 40597 Critical/mapping; 40355 accepted cancellation/late results")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
