#!/usr/bin/env python3
"""Validate native terminal receipts and correlate their real P1 sample windows."""

import argparse
import json
import pathlib
import re
import uuid

PREFIX = "NATIVE_TERMINAL_RECEIPT "
SCOPES = (
    "Batch(Exact)", "Batch(All)", "CallerOwned", "SpeculativeGuestFailure",
    "FinalizingParked", "FinalizingRunning",
)
CASES = {f"{scope}-{mode}" for scope in SCOPES for mode in ("fresh", "snapshot")}
PHASES = (
    "case_started", "terminal_started", "backing_exit_confirmed",
    "required_tail_started", "required_tail_completed", "case_completed",
)


def positive_integer(value):
    return type(value) is int and value > 0


def window(samples, start, end):
    selected = [s for s in samples if start <= s["monotonic_ns"] <= end]
    if not selected:
        raise ValueError("native phase has no actual P1 samples")
    rss, pss, unavailable = [], [], 0
    for sample in selected:
        processes = sample["processes"]
        if not processes:
            raise ValueError("phase sample has no owned process observations")
        known_rss = [p["rss_bytes"] for p in processes if p["rss_bytes"] is not None]
        known_pss = [p["pss_bytes"] for p in processes if p["pss_bytes"] is not None]
        if not known_rss or not known_pss:
            raise ValueError("native phase residency is entirely unknown")
        missing = len(known_rss) != len(processes) or len(known_pss) != len(processes)
        unavailable += missing
        rss.append(sum(known_rss))
        pss.append(sum(known_pss))
    return {
        "samples": len(selected),
        "rss_peak_lower_bound_bytes": max(rss),
        "pss_peak_lower_bound_bytes": max(pss),
        "residency_complete": unavailable == 0,
        "samples_with_unknown_residency": unavailable,
        "minimum_host_available_bytes": min(s["mem_available_bytes"] for s in selected),
        "maximum_sample_age_ns": max(s["sample_age_ns"] for s in selected),
        "maximum_host_read_duration_ns": max(s["read_duration_ns"] for s in selected),
    }


def validate(directory):
    directory = pathlib.Path(directory)
    collector = json.loads((directory / "report.json").read_text())
    if (collector.get("format") != "runner-memory-calibration-v1"
            or collector.get("success") is not True
            or collector.get("cleanup_confirmed") is not True
            or collector.get("driver_wait_confirmed") is not True
            or type(collector.get("driver_exit_code")) is not int
            or collector["driver_exit_code"] != 0
            or collector.get("remaining_children") != []
            or collector.get("errors") != []
            or any(collector.get(k) is not False for k in (
                "cleanup_intervened", "timed_out", "headroom_stop", "logs_truncated",
                "calibrated", "native_vm_exit_confirmed",
            ))):
        raise ValueError("P1 collector did not positively complete its own bounded workload")
    expected = collector["metadata"]["native_terminal_artifacts"]
    if not isinstance(expected, dict) or set(expected) != {
            "source_sha", "test_binary_sha256", "firecracker_sha256", "kernel_sha256",
            "rootfs_sha256", "snapshot_id", "snapshot_files", "policy_sha256", "profile",
            "required_fixture_tail_bytes"}:
        raise ValueError("incomplete native artifact manifest")
    if not isinstance(expected["source_sha"], str) or not re.fullmatch(r"[0-9a-f]{40}", expected["source_sha"]):
        raise ValueError("invalid native source identity")
    hashes = [expected[k] for k in (
        "test_binary_sha256", "firecracker_sha256", "kernel_sha256", "rootfs_sha256", "policy_sha256")]
    if not isinstance(expected["snapshot_id"], str) or not re.fullmatch(
            r"[A-Za-z0-9_.-]{1,70}", expected["snapshot_id"]) or expected["snapshot_id"] in (".", ".."):
        raise ValueError("invalid native snapshot creation identity")
    snapshot = expected["snapshot_files"]
    if not isinstance(snapshot, dict) or not {
            "snapshot.bin", "memory.bin", "cow.img", "cow.img.bitmap", ".snapshot-complete"
    }.issubset(snapshot) or any(
            not isinstance(name, str) or pathlib.PurePosixPath(name).name != name
            or name in ("", ".", "..") for name in snapshot):
        raise ValueError("invalid native snapshot manifest")
    hashes.extend(snapshot.values())
    if any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in hashes):
        raise ValueError("invalid native artifact hash")
    if (expected["profile"] != {"vcpu": 2, "memory_mib": 4096, "home_mib": 16384}
            or expected["required_fixture_tail_bytes"] != 64 * 1024 * 1024):
        raise ValueError("wrong native workload profile")
    samples = [json.loads(line) for line in (directory / "samples.jsonl").read_text().splitlines()]
    previous = -1
    for sample in samples:
        if (not positive_integer(sample.get("monotonic_ns"))
                or sample["monotonic_ns"] <= previous
                or not positive_integer(sample.get("mem_available_bytes"))):
            raise ValueError("invalid or unordered P1 sample clocks")
        previous = sample["monotonic_ns"]
        for key in ("sample_age_ns", "read_duration_ns"):
            if type(sample.get(key)) is not int or sample[key] < 0:
                raise ValueError("invalid P1 sample age or read duration")
        for process in sample["processes"]:
            if not positive_integer(process["pid"]) or not positive_integer(process["start_ticks"]):
                raise ValueError("process observation has no original kernel generation")
            for key in ("rss_bytes", "pss_bytes"):
                value = process[key]
                if value is not None and (type(value) is not int or value < 0):
                    raise ValueError("invalid residency observation")
    receipts = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):])
        if type(event.get("version")) is not int or event["version"] != 1 or event.get("case") not in CASES:
            raise ValueError("unexpected native corpus or receipt version")
        if not positive_integer(event.get("monotonic_ns")) or not positive_integer(event.get("unix_ns")):
            raise ValueError("native phase is missing real clocks")
        receipts[event["case"]].append(event)
    results = {}
    sandbox_ids, backing_generations = set(), set()
    for case, events in sorted(receipts.items()):
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError(f"missing, duplicate or unordered native phases: {case}")
        if events[0]["evidence"].get("artifacts") != expected:
            raise ValueError("native source/artifact/input identity mismatch")
        times = [e["monotonic_ns"] for e in events]
        if any(a >= b for a, b in zip(times, times[1:])):
            raise ValueError("native phase clocks do not positively order the work")
        identity = (events[1]["sandbox_id"], events[1]["backing_generation"])
        for value in identity:
            if str(uuid.UUID(value)) != value:
                raise ValueError("native identity is not one canonical original generation")
        if identity[0] in sandbox_ids or identity[1] in backing_generations or any(
                (e["sandbox_id"], e["backing_generation"]) != identity for e in events[2:]):
            raise ValueError("native backing was reused or changed across phases")
        sandbox_ids.add(identity[0])
        backing_generations.add(identity[1])
        if events[2]["evidence"].get("positive_owned_wait") is not True:
            raise ValueError("generic completion cannot substitute for native backing wait")
        if events[3]["evidence"] != {
                "bytes": 64 * 1024 * 1024, "full_logical_lease": [2, 4096, 1]}:
            raise ValueError("required physical tail did not retain its complete lease")
        if events[4]["evidence"].get("written_and_verified_bytes") != 64 * 1024 * 1024:
            raise ValueError("required post-exit IO is incomplete")
        complete = events[5]["evidence"]
        if any(complete.get(k) is not True for k in (
                "original_home_restored", "private_runtime_removed",
                "required_cleanup_joined", "full_lease_released_after_cleanup")) \
                or complete.get("home_payload_bytes") != 65536:
            raise ValueError("native original data/cleanup/lease proof is incomplete")
        results[case] = {
            "sandbox_id": identity[0], "backing_generation": identity[1],
            "live_saving": window(samples, times[1], times[2]),
            "required_post_exit_io": window(samples, times[2], times[4]),
            "fixture_post_exit_io": window(samples, times[3], times[4]),
        }
    return {
        "format": "native-terminal-phase-report-v1", "native_terminal_corpus_complete": True,
        "artifacts": expected, "cases": results,
        "residency_complete": all(w["residency_complete"] for c in results.values()
                                  for w in (c["live_saving"], c["required_post_exit_io"])),
        "memory_envelope_calibrated": False, "production_protection_proven": False,
        "measurement_scope": "owned sampled residency lower bounds and host availability; unknown samples retained",
        "remaining_parent_gate": "complete native pressure/foreground/session-history/optional/race corpus in P3d2",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2))
