#!/usr/bin/env python3
"""Validate retained native uncertainty; the original driver result stays failed."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess

import batch_aba_report as batch
import cleanup_report as cleanup
import progress_report as foreground
import later_parking_report as later
import pressure_report as pressure
import report
import status_failure_report as status
from snapshot_report import exact

PREFIX = "NATIVE_CLAIM_PRODUCER_WITNESS "
PHASES = ("original_data_durable", "claim_waiting", "claim_wait_progress", "producer_joined",
          "sticky_uncertainty", "uncertain_owners_retained")
CASES = {f"ClaimProducerLost-{observer}-{mode}" for observer in ("observed", "cancelled")
         for mode in ("fresh", "snapshot")}


def regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("original evidence must be a regular file")
        raw = stream.read(limit+1)
    if len(raw) > limit:
        raise ValueError("original evidence exceeded its bound")
    return raw


def validate(directory):
    directory = pathlib.Path(directory)
    collector = json.loads(regular(directory/"report.json", 1024**2), object_pairs_hook=pressure.unique_object)
    if (collector.get("format") != "runner-memory-calibration-v2" or collector.get("success") is not False
            or type(collector.get("driver_exit_code")) is not int or collector["driver_exit_code"] != 101
            or collector.get("driver_wait_confirmed") is not True
            or collector.get("cleanup_confirmed") is not True
            or type(collector.get("cleanup_intervened")) is not bool
            or collector.get("remaining_children") != [] or collector.get("errors") != []
            or any(collector.get(key) is not False for key in
                   ("timed_out", "headroom_stop", "logs_truncated", "calibrated", "native_vm_exit_confirmed"))):
        raise ValueError("lost producer's original failed driver/collector outcome was changed")
    log = regular(directory/"stdout.log", 16*1024**2).decode()
    stderr = regular(directory/"stderr.log", 16*1024**2).decode()
    if "test result: FAILED" not in log or "Error: ProducerLost" not in stderr:
        raise ValueError("original native ProducerLost failure missing")
    artifacts, samples = report._load_measurement_inputs(directory, collector)
    policy = cleanup.supplied_policy(collector, {"artifacts": artifacts}, "native_claim_producer_policy_json")
    terminals, events = [], []
    for line in log.splitlines():
        if line.startswith(PREFIX):
            events.append(json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object))
        elif line.startswith(report.PREFIX):
            terminals.append(json.loads(line[len(report.PREFIX):], object_pairs_hook=pressure.unique_object))
    if len(terminals) != 2 or tuple(e["phase"] for e in terminals) != ("case_started", "terminal_started"):
        raise ValueError("retained uncertainty became successful terminal saving or lost original phases")
    case = terminals[0]["case"]
    if case not in CASES or tuple(e["phase"] for e in events) != PHASES:
        raise ValueError("missing duplicate or unordered producer uncertainty phases")
    if terminals[0]["evidence"] != {"artifacts": artifacts}:
        raise ValueError("producer loss source/artifact binding changed")
    identity = tuple(later.identifier(terminals[1][key]) for key in ("sandbox_id", "backing_generation"))
    if identity[0] == identity[1]:
        raise ValueError("producer loss conflated sandbox and backing generation")
    ordered = [terminals[0], events[0], terminals[1], *events[1:]]
    fields = {"version", "case", "phase", "monotonic_ns", "unix_ns", "sandbox_id", "backing_generation", "evidence"}
    for event in ordered:
        if (not isinstance(event, dict) or set(event) != fields or type(event["version"]) is not int
                or event["version"] != 1 or event["case"] != case or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])):
            raise ValueError("malformed native producer-loss receipt")
    if any(tuple(e[key] for key in ("sandbox_id", "backing_generation")) != identity for e in ordered[1:]):
        raise ValueError("producer uncertainty changed original physical ownership")
    for clock in ("monotonic_ns", "unix_ns"):
        if any(a[clock] >= b[clock] for a, b in zip(ordered, ordered[1:])):
            raise ValueError("producer uncertainty clocks were replayed or unordered")
    durable, waiting, progress, joined, sticky, retained = [e["evidence"] for e in events]
    history, run = later.identifier(waiting.get("history_run_id")), later.identifier(waiting.get("claim_run_id"))
    if len({*identity, history, run}) != 4 or waiting.get("reuse_key") != "thread:native-guarded-"+history:
        raise ValueError("producer claim lost the original run/history/reuse binding")
    payload = (history.encode()*((65536+len(history)-1)//len(history)))[:65536]
    exact(durable, {"history_run_id": history, "payload_sha256": hashlib.sha256(payload).hexdigest(),
          "payload_bytes": 65536, "original_private_and_home_verified": True, "guest_sync_completed": True},
          "original required bytes were not verified and durable before producer fault")
    accepted = waiting.get("producer", {})
    accepted_ns = batch.clock(accepted.get("accepted_ns"), terminals[1]["monotonic_ns"], events[1]["monotonic_ns"])
    exact(accepted, {"run_id": run, "history_run_id": history, "reuse_key": waiting["reuse_key"],
          "profile": "vm0/default", "accepted_ns": accepted_ns, "boundary": "JobProvider::claim", "accepted_calls": 1},
          "lost producer was not the one accepted real JobProvider call")
    restore = waiting.get("restore", {})
    restored_ns = batch.clock(restore.get("completed_ns"), terminals[1]["monotonic_ns"], events[1]["monotonic_ns"])
    exact(restore, {"sandbox_id": identity[0], "backing_generation": identity[1],
          "completed_ns": restored_ns, "actual_restore_rpc_completed": True}, "actual native restore missing")
    exact(waiting, {"policy": policy, "history_run_id": history, "claim_run_id": run,
          "reuse_key": "thread:native-guarded-"+history, "producer": accepted, "restore": restore,
          "preparation_polled_pending": True, "original_full_lease_active": True,
          "original_exit_polled_pending": True, "allocated": [2,4096,1]}, "held producer lost native ownership")
    held = batch.clock(progress.get("pool_held_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
    pending = batch.clock(progress.get("heartbeat_pending_ns"), held, events[2]["monotonic_ns"])
    foreground.observer(progress.get("observer"), pending, events[2]["monotonic_ns"])
    released = batch.clock(progress.get("pool_released_ns"), progress["observer"]["completed_ns"], events[2]["monotonic_ns"])
    runner, generation = foreground.heartbeat(progress.get("heartbeat"), 1, released, events[2]["monotonic_ns"], (2,4096))
    if runner in {*identity, history, run} or generation != 1:
        raise ValueError("producer uncertainty heartbeat identity changed")
    sample_after = batch.clock(progress.get("sample_after_ns"), progress["heartbeat"]["completed_ns"], events[2]["monotonic_ns"])
    sampled = batch.clock(progress.get("p1_sample_ns"), sample_after, events[2]["monotonic_ns"])
    if not any(sample["monotonic_ns"] == sampled for sample in samples):
        raise ValueError("held native claim lacks its acknowledged original P1 sample")
    exact(progress, {"pool_held_ns": held, "heartbeat_pending_ns": pending, "observer": progress["observer"],
          "pool_released_ns": released, "heartbeat": progress["heartbeat"], "producer_still_held": True,
          "original_full_lease_active": True, "allocated": [2,4096,1], "sample_after_ns": sample_after,
          "p1_sample_ns": sampled}, "held claim progress or custody missing")
    release = batch.clock(joined.get("release_requested_ns"), events[2]["monotonic_ns"], events[3]["monotonic_ns"])
    cancelled = "-cancelled-" in case
    cancelled_at = joined.get("response_observer_cancelled_ns")
    if cancelled:
        batch.clock(cancelled_at, events[2]["monotonic_ns"], release)
    elif cancelled_at is not None:
        raise ValueError("unexpected observer cancellation")
    producer = joined.get("producer", {})
    unwind = batch.clock(producer.get("unwind_ns"), release, events[3]["monotonic_ns"])
    exact(producer, accepted | {"unwind_ns": unwind}, "producer outcome was not the accepted unwind")
    finished = batch.clock(joined.get("joined_ns"), unwind, events[3]["monotonic_ns"])
    exact(joined, {"cancelled": cancelled, "response_observer_cancelled_ns": cancelled_at,
          "release_requested_ns": release, "joined_ns": finished, "producer": producer,
          "tracker_joined": True, "actual_native_restore_completed": True,
          "original_full_lease_active": True, "allocated": [2,4096,1]}, "lost producer/native work did not join")
    home = sticky.get("original_home", {})
    path = home.get("path")
    if (not isinstance(path, str) or not pathlib.PurePosixPath(path).is_absolute() or ".." in pathlib.PurePosixPath(path).parts
            or pathlib.PurePosixPath(path).parts[-3:] != ("workspaces", identity[0], "home.ext4")
            or str(pathlib.PurePosixPath(path)) != path
            or not isinstance(home.get("filesystem_uuid"), str) or not re.fullmatch(r"[0-9a-f]{32}", home["filesystem_uuid"])
            or not isinstance(home.get("superblock_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", home["superblock_sha256"])):
        raise ValueError("retained original home identity/path missing")
    exact(home, {"path": path, "bytes": report.NATIVE_HOME_BYTES, "filesystem_uuid": home["filesystem_uuid"],
          "superblock_sha256": home["superblock_sha256"]}, "retained original home profile changed")
    attempt_run, attempt_sandbox = (later.identifier(sticky.get(key)) for key in
                                  ("promotion_probe_run_id", "promotion_probe_sandbox_id"))
    if len({*identity, history, run, runner, attempt_run, attempt_sandbox}) != 7:
        raise ValueError("promotion contention probe reused an original identity")
    published = sticky.get("published_status")
    status.status(published)
    exact(sticky, {"first_receipt": "ProducerLost", "second_receipt": "Consumed", "later_wait": "ProducerLost",
          "commit_refused": True, "rollback_refused": True, "required_cleanup_conversion_still_refused": True,
          "pool_empty": True, "promotion_lock_busy": True, "promotion_probe_run_id": attempt_run,
          "promotion_probe_sandbox_id": attempt_sandbox, "original_home": home, "published_status": published,
          "original_full_lease_active": True, "original_exit_polled_pending": True, "allocated": [2,4096,1],
          "returned_completion_authorizations": 0, "completion_reports": 0,
          "required_saving_complete": False, "cleanup_complete": False}, "receipt take cleared uncertainty or lost custody")
    accounting = dict.fromkeys(cleanup.COUNTS, 0) | {"closed": True}
    exact(retained, {"claim_producer_joined": True, "tracker_joined": True, "accounting_joined": True,
          "heartbeat_joined": True, "heartbeat_provider_joined": True, "peer_joined": True,
          "admission_retained": True, "backing_wait_retained_pending": True, "original_full_lease_active": True,
          "allocated": [2,4096,1], "accounting": accounting, "original_home": home,
          "original_outcome": "ProducerLost", "required_saving_complete": False, "cleanup_complete": False,
          "physical_relief_proven": False, "memory_credit": False}, "uncertain owners were released or reclassified")
    image = directory/"retained-home.ext4"
    fd = os.open(image, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or os.fstat(stream.fileno()).st_size != home["bytes"]:
            raise ValueError("original retained home file is missing or partial")
        stream.seek(1024)
        block = stream.read(1024)
    if (block[56:58] != b"\x53\xef" or block[104:120].hex() != home["filesystem_uuid"]
            or hashlib.sha256(block).hexdigest() != home["superblock_sha256"]):
        raise ValueError("original retained home superblock binding changed")
    # This is the home filesystem, mounted at /home/user by the Guest; debugfs
    # addresses its contents relative to the image root, not the Guest root.
    for image_path, expected in (("/guarded-idle-payload", payload),
            ("/guarded-idle-ordinary", b"native ordinary home bytes"),
            (f"/.vm0/guest-agent/runs/{history}/fixture-private", b"fixture private bytes")):
        extracted = subprocess.run(["/usr/sbin/debugfs", "-R", "cat "+image_path, str(image)], capture_output=True, timeout=30)
        if extracted.returncode != 0 or extracted.stdout != expected:
            raise ValueError("original retained native required bytes were lost")
    return {"format": "native-claim-producer-custody-v1", "artifacts": artifacts, "case": case,
            "native_producer_loss_custody_observed": True, "original_driver_exit_code": 101,
            "original_collector_success": False, "collector_cleanup_intervened": collector["cleanup_intervened"],
            "native_uncertainty": report.window(samples, terminals[1]["monotonic_ns"], events[-1]["monotonic_ns"]),
            "retained_original_data_verified": True, "required_saving_complete": False, "cleanup_complete": False,
            "physical_relief_proven": False, "memory_credit": False, "production_protection_proven": False,
            "api_claim_arbitration_proven": False, "api_provider_panic_proven": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
