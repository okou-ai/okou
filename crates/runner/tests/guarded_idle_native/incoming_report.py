#!/usr/bin/env python3
"""Require six real incoming paths with complete readers and original custody."""

import argparse
import hashlib
import json
import pathlib

import critical_report
import foreground_report as foreground
import logical_report
import pressure_report as pressure
import report
import startup_report as startup

PREFIX = "NATIVE_INCOMING_PROGRESS_WITNESS "
KINDS = ("Replacement", "Restore", "Aged")
CASES = {f"Incoming{kind}-{mode}" for kind in KINDS for mode in ("fresh", "snapshot")}


def phases(kind):
    common = ("inputs_verified", "pool_wait_progress", "status_wait_progress", "physical_io_wait_progress")
    return ((common[0], "guest_creation_started", *common[1:]) if kind != "Aged"
            else (*common, "guest_creation_started")) + ("incoming_completed", "producers_joined")


def ready(value, initial, pool, event, policy, allocated, restored, publication):
    held, released, polled, completed = [value.get(k) for k in (
        "status_held_ns", "pool_released_ns", "status_wait_polled_ns", "runtime_completed_ns")]
    before, after = value.get("status_waits_before"), value.get("status_waits_after")
    if (not all(report.positive_integer(n) for n in (held, released, polled, completed))
            or held != pool["evidence"]["status_held_ns"]
            or not pool["monotonic_ns"] < completed < released < polled < event["monotonic_ns"]
            or not pressure.integer(before) or not pressure.integer(after) or after != before + 1):
        raise ValueError("incoming exact status Pending/runtime-before-pool-release proof missing")
    foreground.runtime(value.get("reads"))
    runner = foreground.heartbeat(value.get("heartbeat"), 1, polled, event["monotonic_ns"], allocated)
    foreground.observer(value.get("observer"), polled, event["monotonic_ns"])
    samples, available = value.get("samples"), value.get("available_bytes")
    if (not isinstance(samples, list) or not pressure.integer(available, policy["recovery_available_bytes"])
            or available > policy["host_total_bytes"]):
        raise ValueError("incoming Ready lacks actual supplied observations")
    offset = -1
    for sample in samples:
        logical_report.sample(sample, pool["monotonic_ns"], event["monotonic_ns"], policy)
        if sample["read_start_offset_ns"] <= offset:
            raise ValueError("incoming Ready replays a pressure observation")
        offset = sample["read_start_offset_ns"]
    fresh = pressure.sustained_ready_samples(samples, event["monotonic_ns"], policy)
    if not pressure.sustained_ready_samples(samples, completed, policy):
        raise ValueError("incoming runtime/status lacks distinct sustained fresh Ready")
    if not any(sample["available_bytes"] == available for sample in fresh):
        raise ValueError("incoming Ready availability is not an actual fresh read")
    startup.exact(value, {"state": "Ready", "available_bytes": available, "reads": value["reads"],
        "runtime_drained": True, "runtime_completed_ns": completed, "pool_released_ns": released,
        "status_held_ns": held, "status_wait_polled_ns": polled, "status_waits_before": before,
        "status_waits_after": after, "actual_idle_snapshot_wait": True,
        "inventory_matches_original_incoming": True, "original_owner_restored": restored,
        "status_publication": publication, "heartbeat": value["heartbeat"], "observer": value["observer"],
        "allocated": allocated, "samples": samples}, "incoming status/original inventory custody changed")
    return runner


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_incoming")
    witnesses = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1 or event["case"] not in CASES
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])
                or not isinstance(event["evidence"], dict)):
            raise ValueError("invalid incoming progress witness")
        witnesses[event["case"]].append(event)
    originals = {events[1]["sandbox_id"] for events in terminals.values()}
    original_backings = {events[1]["backing_generation"] for events in terminals.values()}
    new_ids, new_backings, operations, runners = set(), set(), set(), set()
    for case, events in witnesses.items():
        kind = case.split("-")[0].removeprefix("Incoming")
        aged, restored = kind == "Aged", kind == "Restore"
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != phases(kind):
            raise ValueError("incoming path-specific creation/wait phases missing or unordered")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a, b in zip(clocks, clocks[1:]))
                or any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)):
            raise ValueError("incoming original identity or complete ownership ordering changed")
        by_phase = {event["phase"]: event for event in events}
        initial, creation, pool, status, blocked, finished, joined = [by_phase[k] for k in (
            "inputs_verified", "guest_creation_started", "pool_wait_progress", "status_wait_progress",
            "physical_io_wait_progress", "incoming_completed", "producers_joined")]
        startup.exact(initial["evidence"], {"kind": kind, "policy": policy,
            "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": result["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"],
            "allocated": [2,4096,1], "startup_pressure_guarded": False,
            "physical_credit_from_logical_transfer": False}, "incoming original full inputs/credit changed")
        allocated = [2,4096,1] if aged else [4,8192,2]
        value = pool["evidence"]
        held, status_held, polled = [value.get(k) for k in ("pool_held_ns", "status_held_ns", "pool_wait_polled_ns")]
        if (not all(report.positive_integer(n) for n in (held, status_held, polled))
                or not initial["monotonic_ns"] < held <= status_held < polled < pool["monotonic_ns"]):
            raise ValueError("incoming actual pool Pending proof missing")
        startup.complete(value.get("startup")); critical_report.no_reads(value.get("reads"), False)
        foreground.observer(value.get("observer"), polled, pool["monotonic_ns"])
        startup.exact(value, {"startup": value["startup"], "startup_drained": True, "reads": value["reads"],
            "state": "Unknown", "pool_held_ns": held, "status_held_ns": status_held,
            "pool_wait_polled_ns": polled, "pool_wait_polled_pending": True,
            "observer": value["observer"], "allocated": allocated}, "incoming startup/Unknown/separate leases changed")
        runner = ready(status["evidence"], initial, pool, status, policy, allocated, restored,
            "aged_internal" if aged else "after_insertion")
        value = blocked["evidence"]
        join = value.get("join_polled_ns")
        if (not report.positive_integer(join) or not polled < join < blocked["monotonic_ns"]
                or not terminal[3]["monotonic_ns"] < blocked["monotonic_ns"] < terminal[4]["monotonic_ns"]
                or not aged and not status["monotonic_ns"] < join):
            raise ValueError("incoming accepted join/blocked original physical IO proof missing")
        blocked_allocated = [4,8192,2] if kind == "Replacement" else [2,4096,1]
        begin = max(join, terminal[3]["monotonic_ns"])
        second = foreground.heartbeat(value.get("heartbeat"), 2, begin, blocked["monotonic_ns"], blocked_allocated)
        foreground.observer(value.get("observer"), begin, blocked["monotonic_ns"])
        if runner != second or runner in runners:
            raise ValueError("incoming reporting generation reused or lost")
        runners.add(runner)
        startup.exact(value, {"join_polled_ns": join, "join_kind": "blank_preparation" if aged else "original_cleanup",
            "join_polled_pending": True, "kernel_io_entered": True, "release_byte_withheld": True,
            "full_original_lease": [2,4096,1], "allocated": blocked_allocated,
            "heartbeat": value["heartbeat"], "observer": value["observer"]}, "incoming blocked original lease/reporting changed")
        value = finished["evidence"]
        prepared, grant = value.get("preparation"), value.get("fresh_grant")
        if (not isinstance(prepared, dict) or not isinstance(grant, dict) or set(grant) != {
                "started_ns", "finished_ns", "operation_id", "samples"}
                or not all(report.positive_integer(grant.get(k)) for k in ("started_ns", "finished_ns"))
                or not initial["monotonic_ns"] < grant["started_ns"] < grant["finished_ns"] < pool["monotonic_ns"]
                or not foreground.identifier(grant.get("operation_id")) or grant["operation_id"] in operations
                or not isinstance(grant["samples"], list) or len(grant["samples"]) != 1):
            raise ValueError("incoming actual original Fresh grant missing")
        operations.add(grant["operation_id"])
        sample = grant["samples"][0]
        logical_report.sample(sample, grant["started_ns"], grant["finished_ns"], policy)
        if (not pressure.integer(sample["available_bytes"], policy["operating_floor_bytes"]+policy["cleanup_reserve_bytes"]
                + startup.BYTES + policy["replacement_preparation_bytes"])
                or sample["age_ns"] >= policy["max_sample_age_millis"]*1_000_000):
            raise ValueError("incoming Fresh grant lacks current physical headroom")
        new_id, new_backing, prepared_ns = [prepared.get(k) for k in ("sandbox_id", "backing_generation", "prepared_ns")]
        if (not foreground.identifier(new_id) or new_id in originals | new_ids
                or not foreground.identifier(new_backing) or new_backing in original_backings | new_backings
                or not report.positive_integer(prepared_ns)
                or not grant["finished_ns"] < creation["monotonic_ns"] < prepared_ns < finished["monotonic_ns"]
                or not terminal[4]["monotonic_ns"] < finished["monotonic_ns"]):
            raise ValueError("incoming actual distinct Guest/backing/physical completion missing")
        new_ids.add(new_id); new_backings.add(new_backing)
        startup.exact(creation["evidence"], {"sandbox_id": new_id}, "incoming actual creation identity changed")
        if aged:
            if not terminal[4]["monotonic_ns"] < creation["monotonic_ns"]:
                raise ValueError("aged created its replacement before original required tail completed")
            expected = {"sandbox_id": new_id, "backing_generation": new_backing,
                "operation_id": grant["operation_id"], "prepared_ns": prepared_ns, "phase_settled": True,
                "retired_exact": True, "original_lease_reused": True}
        else:
            if not prepared_ns < held:
                raise ValueError("incoming physical preparation did not precede insertion contention")
            expected = {"sandbox_id": new_id, "backing_generation": new_backing,
                "operation_id": grant["operation_id"], "grant_started_ns": grant["started_ns"],
                "grant_finished_ns": grant["finished_ns"], "prepared_ns": prepared_ns,
                "guest_rpc_completed": True, "phase_settled": True, "separate_incoming_lease": True}
        startup.exact(prepared, expected, "incoming actual preparation/phase/original lease changed")
        startup.exact(value, {"kind": kind, "preparation": prepared, "fresh_grant": grant,
            "incoming_sandbox_id": identity[0] if restored else new_id,
            "incoming_backing_generation": identity[1] if restored else new_backing,
            "new_backing_generation": new_backing, "new_backing_exit_confirmed": True,
            "original_exit_confirmed": True, "original_owner_restored": restored,
            "separate_incoming_lease": not aged, "original_full_lease_retained": True,
            "allocated": [2,4096,1]}, "incoming original restoration/new backing/full lease did not complete")
        value = joined["evidence"]
        startup.complete(value.get("startup")); foreground.runtime(value.get("reads"))
        startup.exact(value, {"startup": value["startup"], "reads": value["reads"], "startup_drained": True,
            "runtime_drained": True, "incoming_work_joined": True, "pressure_stopped": True, "producer_lost": False,
            "wave_inflight": False, "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "snapshot_reverified": True, "original_full_lease_retained": True, "registered_operations": 0,
            "tracked_tasks": 0, "allocated": [2,4096,1], "inventory_empty": True}, "incoming dependencies/lease were not joined")
        result["cases"][case]["incoming_progress"] = events
    result.update(format="native-incoming-progress-report-v1", native_incoming_progress_complete=True,
        startup_pressure_guarded=False, remaining_parent_gate="40597 Critical/mapping; 40355 accepted cancellation/late results")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
