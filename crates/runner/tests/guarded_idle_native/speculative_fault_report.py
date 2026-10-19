#!/usr/bin/env python3
"""Validate callback-boundary drop/panic, native uncertainty and required saving."""

import argparse
import hashlib
import json
import pathlib

import batch_aba_report as batch
import foreground_report as foreground
import later_parking_report as later
import pressure_report as pressure
import report
import status_failure_report as failure
from cleanup_report import accounting, coverage, supplied_policy
from startup_report import exact

PREFIX = "NATIVE_SPECULATIVE_FAULT_WITNESS "
CASES = {f"Speculative{fault}-{mode}" for fault in ("Drop", "Panic") for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "callback_waiting", "preparation_lost", "tail_blocked",
          "pool_wait_progress", "tail_wait_progress", "saving_joined", "status_wait_progress",
          "status_published", "producers_joined")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_speculative_fault_policy_json")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event["case"] not in CASES or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid speculative fault witness")
        witnesses[event["case"]].append(event)
    identities = {events[1][key] for events in terminals.values() for key in ("sandbox_id", "backing_generation")}
    paths, runners = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(event["phase"] for event in events) != PHASES:
            raise ValueError("missing duplicate or reordered speculative fault phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((event["sandbox_id"], event["backing_generation"]) != identity for event in events):
            raise ValueError("speculative fault changed original physical owner")
        ordered = [terminal[1], *events[:3], terminal[2], terminal[3], *events[3:6],
                   terminal[4], *events[6:], terminal[5]]
        for field in ("monotonic_ns", "unix_ns"):
            if any(a[field] >= b[field] for a, b in zip(ordered, ordered[1:])):
                raise ValueError("speculative fault phase clocks lost ordering")
        initial, waiting, lost, tail, pool, progress, saved, status, published, joined = [event["evidence"] for event in events]
        mode = "panic" if case.startswith("SpeculativePanic-") else "drop"
        path = initial.get("status_path")
        if (not isinstance(path, str) or not pathlib.PurePosixPath(path).is_absolute()
                or str(pathlib.PurePosixPath(path)) != path or ".." in pathlib.PurePosixPath(path).parts
                or pathlib.PurePosixPath(path).name != "status.json" or path in paths):
            raise ValueError("invalid or replayed speculative private status path")
        paths.add(path)
        baseline = initial.get("published_status")
        failure.status(baseline, sandbox=identity[0])
        exact(initial, {"policy": policy, "status_path": path, "published_status": baseline,
                        "regular_file": True}, "speculative fault changed original inputs")
        history = later.identifier(waiting.get("history_run_id"))
        operation = later.identifier(waiting.get("operation_run_id"))
        if history == operation or history in identities or operation in identities:
            raise ValueError("speculative callback replayed run or resource identity")
        identities.update((history, operation))
        reuse = "thread:native-guarded-"+history
        exact(baseline["idle_sandboxes"], [{"reuse_key": reuse, "sandbox_id": identity[0]}],
              "speculative callback lost original history/reuse binding")
        started = batch.clock(waiting.get("prepare_started_ns"), events[0]["monotonic_ns"], events[1]["monotonic_ns"])
        rpc = batch.clock(waiting.get("rpc_completed_ns"), started, events[1]["monotonic_ns"])
        raw = history.encode()
        digest = hashlib.sha256((raw * (65536//len(raw)+1))[:65536]).hexdigest()
        exact(waiting, {"mode": mode, "history_run_id": history, "operation_run_id": operation,
            "reuse_key": reuse, "prepare_started_ns": started, "rpc_completed_ns": rpc,
            "payload_sha256": digest, "payload_bytes": 65536, "production_restore_completed": True,
            "private_marker_verified": True, "ordinary_home_verified": True, "callback_polled_pending": True,
            "callback_release_withheld": True, "pool_empty": True, "original_full_lease_active": True,
            "original_exit_polled_pending": True, "allocated": [2,4096,1]},
            "callback boundary lacks actual complete original RPC/full ownership")
        requested = batch.clock(lost.get("failure_requested_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
        finished = batch.clock(lost.get("failure_joined_ns"), requested, events[2]["monotonic_ns"])
        exact(lost, {"failure_requested_ns": requested, "failure_joined_ns": finished,
            "mode": mode, "panic_caught": mode == "panic", "state": "Uncertain",
            "commit_refused": True, "repark_refused": True, "incoming_refused": True,
            "original_metadata_preserved": True, "original_full_lease_active": True,
            "original_exit_polled_pending": True, "pool_empty": True, "allocated": [2,4096,1]},
            "callback loss did not preserve uncertain original/reuse refusal")
        coverage(tail.get("coverage"), policy, False)
        exact(tail, {"original_exit_confirmed": True, "receiver_polled_pending": True,
                     "coverage": tail["coverage"]}, "speculative required saving lost original exit/custody")
        held = batch.clock(pool.get("pool_held_ns"), events[3]["monotonic_ns"], events[4]["monotonic_ns"])
        status_held = batch.clock(pool.get("status_held_ns"), held, events[4]["monotonic_ns"])
        polled = batch.clock(pool.get("heartbeat_pending_ns"), status_held, events[4]["monotonic_ns"])
        foreground.observer(pool.get("observer"), polled, events[4]["monotonic_ns"])
        coverage(pool.get("coverage"), policy, False)
        exact(pool, {"pool_held_ns": held, "status_held_ns": status_held, "heartbeat_pending_ns": polled,
            "heartbeat_polled_pending": True, "observer": pool["observer"], "coverage": pool["coverage"]},
            "speculative held-pool progress/custody missing")
        released = batch.clock(progress.get("pool_released_ns"), events[4]["monotonic_ns"], events[5]["monotonic_ns"])
        runner = foreground.heartbeat(progress.get("heartbeat"), 1, released, events[5]["monotonic_ns"], (2,4096))
        if runner in runners or runner[0] in identities:
            raise ValueError("speculative heartbeat Runner generation replayed")
        runners.add(runner)
        identities.add(runner[0])
        coverage(progress.get("coverage"), policy, False)
        exact(progress, {"pool_released_ns": released, "status_held_ns": status_held,
            "heartbeat": progress["heartbeat"], "receiver_polled_pending": True,
            "coverage": progress["coverage"]}, "speculative held-IO/status heartbeat/custody missing")
        released = batch.clock(saved.get("io_released_ns"), events[5]["monotonic_ns"], terminal[4]["monotonic_ns"])
        finished = batch.clock(saved.get("saving_joined_ns"), terminal[4]["monotonic_ns"], events[6]["monotonic_ns"])
        accounting(saved.get("accounting"), True)
        exact(saved, {"io_released_ns": released, "saving_joined_ns": finished, "home_cache_promoted": True,
            "original_lease_released": True, "allocated": [0,0,0], "accounting": saved["accounting"]},
            "speculative required data/lease/accounting did not join")
        polled = batch.clock(status.get("status_wait_polled_ns"), events[6]["monotonic_ns"], events[7]["monotonic_ns"])
        before, after = status.get("status_waits_before"), status.get("status_waits_after")
        if not pressure.integer(before) or not pressure.integer(after) or after != before+1:
            raise ValueError("speculative final status wait not positively observed")
        if foreground.heartbeat(status.get("heartbeat"), 2, polled, events[7]["monotonic_ns"], (0,0)) != runner:
            raise ValueError("speculative final heartbeat changed Runner identity")
        exact(status, {"status_wait_polled_ns": polled, "status_waits_before": before,
            "status_waits_after": after, "heartbeat": status["heartbeat"],
            "publication_polled_pending": True, "allocated": [0,0,0]}, "speculative status wait lost progress")
        released = batch.clock(published.get("status_released_ns"), events[7]["monotonic_ns"], events[8]["monotonic_ns"])
        finished = batch.clock(published.get("publication_joined_ns"), released, events[8]["monotonic_ns"])
        later.current_status(published.get("published_status"), baseline)
        exact(published, {"status_released_ns": released, "publication_joined_ns": finished,
            "published_status": published["published_status"], "regular_file": True, "allocated": [0,0,0]},
            "speculative final current status retained inventory")
        accounting(joined.get("accounting"), True)
        exact(joined, {"tracker_joined": True, "accounting_joined": True, "heartbeat_joined": True,
            "provider_joined": True, "peer_joined": True, "remaining_activation_owners": 0,
            "remaining_finalizing_owners": 0, "allocated": [0,0,0], "accounting": joined["accounting"]},
            "speculative callback producers remain owned")
    return {**result, "format": "native-speculative-fault-report-v1",
            "native_speculative_callback_loss_complete": True,
            "fault_boundary": "borrowed restore callback after joined actual production restore and original-data RPC",
            "inflight_unpark_or_guest_rpc_cancellation_proven": False,
            "api_claim_arbitration_proven": False, "full_supervisor_shutdown_proven": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
