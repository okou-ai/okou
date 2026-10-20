#!/usr/bin/env python3
"""Validate native terminal receipts and correlate their real P1 sample windows."""

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
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


def validate_snapshot_preparation(directory, artifacts):
    def unique_fields(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError("duplicate field in snapshot preparation record")
            result[name] = value
        return result

    try:
        fd = os.open(directory / "snapshot-preparation.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("snapshot preparation record is not a regular file")
            raw = stream.read(65537)
    except OSError as error:
        raise ValueError("snapshot preparation record is unavailable") from error
    if len(raw) > 65536 or hashlib.sha256(raw).hexdigest() != artifacts["snapshot_preparation_sha256"]:
        raise ValueError("snapshot preparation record hash or size mismatch")
    record = json.loads(raw, object_pairs_hook=unique_fields)
    if not isinstance(record, dict) or set(record) != {
            "format", "inputs", "snapshot_files", "creator_boot_id", "started_monotonic_ns",
            "completed_monotonic_ns", "started_unix_ns", "completed_unix_ns"}:
        raise ValueError("incomplete snapshot preparation record")
    expected_inputs = {key: artifacts[key] for key in (
        "source_sha", "firecracker_sha256", "kernel_sha256", "rootfs_sha256", "snapshot_id", "profile")}
    expected_inputs["producer_test_binary_sha256"] = artifacts["test_binary_sha256"]
    if (record["format"] != "native-snapshot-preparation-v1"
            or record["inputs"] != expected_inputs
            or any(type(value) is not int for value in record["inputs"]["profile"].values())
            or record["snapshot_files"] != artifacts["snapshot_files"]):
        raise ValueError("snapshot preparation input/output binding mismatch")
    for field in ("started_monotonic_ns", "completed_monotonic_ns", "started_unix_ns", "completed_unix_ns"):
        limit = 2**64 if field.endswith("monotonic_ns") else 2**128
        if not positive_integer(record[field]) or record[field] >= limit:
            raise ValueError("invalid snapshot preparation observation clock")
    if record["completed_monotonic_ns"] <= record["started_monotonic_ns"]:
        raise ValueError("unordered snapshot preparation observation clocks")
    boot = record["creator_boot_id"]
    if not isinstance(boot, str) or str(uuid.UUID(boot)) != boot:
        raise ValueError("invalid snapshot preparation creator boot identity")


def positive_integer(value):
    return type(value) is int and value > 0


def validate_residency(sample):
    age = sample.get("sample_age_ns")
    if type(age) is not int or age < 0:
        raise ValueError("invalid residency observation window")
    processes = sample.get("processes")
    if not isinstance(processes, list) or not processes:
        raise ValueError("phase sample has no owned process observations")
    reasons = {
        "measured": {"smaps_rollup"},
        "exited": {"pidfd_exit"},
        "unavailable": {"identity_missing", "identity_changed", "zombie", "smaps_missing",
                        "permission_denied", "smaps_incomplete", "identity_raced"},
    }
    seen = set()
    for process in processes:
        if not isinstance(process, dict) or set(process) != {
                "pid", "start_ticks", "rss_bytes", "pss_bytes", "residency_state",
                "residency_reason", "observed_monotonic_ns", "exit_observed_monotonic_ns"}:
            raise ValueError("incomplete residency diagnostic contract")
        pid, generation = process["pid"], process["start_ticks"]
        if not positive_integer(pid) or not positive_integer(generation) or pid in seen:
            raise ValueError("invalid or duplicate residency identity")
        seen.add(pid)
        state, reason = process["residency_state"], process["residency_reason"]
        if (not isinstance(state, str) or state not in reasons
                or not isinstance(reason, str) or reason not in reasons[state]):
            raise ValueError("invalid residency state or reason")
        observed = process["observed_monotonic_ns"]
        if (not positive_integer(observed)
                or not sample["monotonic_ns"] <= observed <= sample["monotonic_ns"] + age):
            raise ValueError("residency observation escaped its sample window")
        exited = process["exit_observed_monotonic_ns"]
        if state == "exited":
            if not positive_integer(exited) or exited > observed:
                raise ValueError("residency exit lacks positive timed evidence")
        elif exited is not None:
            raise ValueError("non-exited residency carries exit evidence")
        metrics = [process["rss_bytes"], process["pss_bytes"]]
        if state == "measured":
            if any(type(value) is not int or value < 0 for value in metrics):
                raise ValueError("measured residency lacks valid bytes")
        elif metrics != [None, None]:
            raise ValueError("unmeasured residency cannot manufacture bytes")


def window(samples, start, end):
    selected = [s for s in samples if start <= s["monotonic_ns"] <= end]
    if not selected:
        raise ValueError("native phase has no actual P1 samples")
    rss, pss, unavailable, missing_reasons = [], [], 0, {}
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
        for process in processes:
            if process["rss_bytes"] is None or process["pss_bytes"] is None:
                reason = process["residency_reason"]
                missing_reasons[reason] = missing_reasons.get(reason, 0) + 1
        rss.append(sum(known_rss))
        pss.append(sum(known_pss))
    return {
        "samples": len(selected),
        "rss_peak_lower_bound_bytes": max(rss),
        "pss_peak_lower_bound_bytes": max(pss),
        "residency_complete": unavailable == 0,
        "samples_with_unknown_residency": unavailable,
        "missing_residency_reasons": missing_reasons,
        "minimum_host_available_bytes": min(s["mem_available_bytes"] for s in selected),
        "maximum_sample_age_ns": max(s["sample_age_ns"] for s in selected),
        "maximum_host_read_duration_ns": max(s["read_duration_ns"] for s in selected),
    }


def validate(directory):
    result, _, _ = _validate_cases(directory, CASES, PHASES)
    return {"format": "native-terminal-phase-report-v1",
            "native_terminal_corpus_complete": True, **result}


def _validate_cases(directory, cases, phases):
    directory = pathlib.Path(directory)
    collector = json.loads((directory / "report.json").read_text())
    if (collector.get("format") != "runner-memory-calibration-v2"
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
    return _validate_receipts(directory, cases, phases, collector)


def _load_measurement_inputs(directory, collector):
    """Check original artifact/snapshot/sample inputs without rewriting outcomes."""
    expected = collector["metadata"]["native_terminal_artifacts"]
    if not isinstance(expected, dict) or set(expected) != {
            "source_sha", "test_binary_sha256", "firecracker_sha256", "kernel_sha256",
            "rootfs_sha256", "snapshot_id", "snapshot_files", "snapshot_preparation_sha256", "policy_sha256", "profile",
            "required_fixture_tail_bytes"}:
        raise ValueError("incomplete native artifact manifest")
    if not isinstance(expected["source_sha"], str) or not re.fullmatch(r"[0-9a-f]{40}", expected["source_sha"]):
        raise ValueError("invalid native source identity")
    hashes = [expected[k] for k in (
        "test_binary_sha256", "firecracker_sha256", "kernel_sha256", "rootfs_sha256", "policy_sha256",
        "snapshot_preparation_sha256")]
    if not isinstance(expected["snapshot_id"], str) or not re.fullmatch(
            r"[A-Za-z0-9_.-]{1,70}", expected["snapshot_id"]) or expected["snapshot_id"] in (".", ".."):
        raise ValueError("invalid native snapshot creation identity")
    snapshot = expected["snapshot_files"]
    if not isinstance(snapshot, dict) or set(snapshot) != {
            "snapshot.bin", "memory.bin", "cow.img", "cow.img.bitmap", ".snapshot-complete"
    } or any(
            not isinstance(name, str) or pathlib.PurePosixPath(name).name != name
            or name in ("", ".", "..") for name in snapshot):
        raise ValueError("invalid native snapshot manifest")
    hashes.extend(snapshot.values())
    if any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value) for value in hashes):
        raise ValueError("invalid native artifact hash")
    if (expected["profile"] != {"vcpu": 2, "memory_mib": 4096, "home_mib": 16384}
            or any(type(value) is not int for value in expected["profile"].values())
            or expected["required_fixture_tail_bytes"] != 64 * 1024 * 1024):
        raise ValueError("wrong native workload profile")
    validate_snapshot_preparation(directory, expected)
    samples = [json.loads(line) for line in (directory / "samples.jsonl").read_text().splitlines()]
    previous = -1
    generations, exits = {}, {}
    for sample in samples:
        if (not positive_integer(sample.get("monotonic_ns"))
                or sample["monotonic_ns"] <= previous
                or not positive_integer(sample.get("mem_available_bytes"))):
            raise ValueError("invalid or unordered P1 sample clocks")
        previous = sample["monotonic_ns"]
        validate_residency(sample)
        if not generations.keys() <= {process["pid"] for process in sample["processes"]}:
            raise ValueError("captured residency identity disappeared from later sample")
        for key in ("sample_age_ns", "read_duration_ns"):
            if type(sample.get(key)) is not int or sample[key] < 0:
                raise ValueError("invalid P1 sample age or read duration")
        for process in sample["processes"]:
            pid, generation = process["pid"], process["start_ticks"]
            if pid in generations and generations[pid] != generation:
                raise ValueError("residency changed its captured process generation")
            generations[pid] = generation
            exited = process["exit_observed_monotonic_ns"]
            if pid in exits:
                if process["residency_state"] != "exited" or exited != exits[pid]:
                    raise ValueError("residency revoked or changed positive exit evidence")
            elif process["residency_state"] == "exited":
                if exited < sample["monotonic_ns"]:
                    raise ValueError("first residency exit observation escaped its sample window")
                exits[pid] = exited
    return expected, samples


def _validate_receipts(directory, cases, phases, collector):
    expected, samples = _load_measurement_inputs(directory, collector)
    receipts = {case: [] for case in cases}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):])
        if type(event.get("version")) is not int or event["version"] != 1 or event.get("case") not in cases:
            raise ValueError("unexpected native corpus or receipt version")
        if not positive_integer(event.get("monotonic_ns")) or not positive_integer(event.get("unix_ns")):
            raise ValueError("native phase is missing real clocks")
        receipts[event["case"]].append(event)
    results = {}
    sandbox_ids, backing_generations = set(), set()
    for case, events in sorted(receipts.items()):
        if tuple(e["phase"] for e in events) != phases:
            raise ValueError(f"missing, duplicate or unordered native phases: {case}")
        if events[0]["evidence"].get("artifacts") != expected:
            raise ValueError("native source/artifact/input identity mismatch")
        times = [e["monotonic_ns"] for e in events]
        by_phase = {e["phase"]: e for e in events}
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
        if by_phase["backing_exit_confirmed"]["evidence"].get("positive_owned_wait") is not True:
            raise ValueError("generic completion cannot substitute for native backing wait")
        tail = by_phase["required_tail_started"]["evidence"]
        if tail != {
                "bytes": 64 * 1024 * 1024, "full_logical_lease": [2, 4096, 1]} or any(
                    type(value) is not int for value in tail.get("full_logical_lease", [])):
            raise ValueError("required physical tail did not retain its complete lease")
        if by_phase["required_tail_completed"]["evidence"].get("written_and_verified_bytes") != 64 * 1024 * 1024:
            raise ValueError("required post-exit IO is incomplete")
        complete = by_phase["case_completed"]["evidence"]
        if any(complete.get(k) is not True for k in (
                "original_home_restored", "private_runtime_removed",
                "required_cleanup_joined", "full_lease_released_after_cleanup")) \
                or complete.get("home_payload_bytes") != 65536:
            raise ValueError("native original data/cleanup/lease proof is incomplete")
        results[case] = {
            "sandbox_id": identity[0], "backing_generation": identity[1],
            "live_saving": window(samples, by_phase["terminal_started"]["monotonic_ns"],
                                  by_phase["backing_exit_confirmed"]["monotonic_ns"]),
            "required_post_exit_io": window(samples, by_phase["backing_exit_confirmed"]["monotonic_ns"],
                                            by_phase["required_tail_completed"]["monotonic_ns"]),
            "fixture_post_exit_io": window(samples, by_phase["required_tail_started"]["monotonic_ns"],
                                           by_phase["required_tail_completed"]["monotonic_ns"]),
        }
    result = {
        "artifacts": expected, "cases": results,
        "residency_complete": all(w["residency_complete"] for c in results.values()
                                  for w in (c["live_saving"], c["required_post_exit_io"])),
        "memory_envelope_calibrated": False, "production_protection_proven": False,
        "snapshot_creation_inputs_verified": True, "bootstrap_provenance_verified": False,
        "measurement_scope": "owned sampled residency lower bounds and host availability; unknown samples retained",
        "remaining_parent_gate": "complete native pressure/foreground/session-history/optional/race corpus in P3d2",
    }
    return result, collector, receipts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2))
