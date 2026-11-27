"""Shared setup for the Guarded Idle status and custody report fixtures."""

import copy
import hashlib
import json
import uuid

import batch_replacement_report as replacement
import cleanup_report as cleanup
import native_unpark_report as native
import report
import report_test
import speculative_fault_report as fault
import status_failure_report as failure
from progress_report_fixture import (
    foreground_heartbeat,
    joined_observer,
    memory_read_receipt,
)


def prepare_status_failure(test):
    report_test.prepare_native_report_fixture(test)
    test.policy = report_test.pressure_policy_fixture()
    raw = json.dumps(test.policy)
    test.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
    test.collector["metadata"]["native_status_failure_policy_json"] = raw
    originals, sample = test.events, test.samples[0]
    test.events, test.samples, test.witnesses = [], [], []
    for index, case in enumerate(sorted(failure.CASES)):
        base = 10_000_000_000 * (index + 1)
        at = lambda offset: base + offset * 1_000_000
        terminal = copy.deepcopy(originals[index * 6 : index * 6 + 6])
        for event, clock in zip(terminal, (0, 1, 2, 3, 20, 50)):
            event.update(case=case, monotonic_ns=at(clock), unix_ns=at(clock) + 1000)
            test.samples.append(report_test.residency_sample_at(sample, at(clock) + 1))
        test.events.extend(terminal)
        accounts = {k: 0 for k in cleanup.COUNTS} | {"closed": True}
        active = accounts | {
            "registered_operations": 1,
            "started": 1,
            "cleanup_growth_bytes": test.policy["tail_growth_bytes"],
            "tracked_tasks": 1,
        }
        covered = {
            "allocated": [2, 4096, 1],
            "accounting": active,
            "original_lease_active": True,
            "io_release_withheld": True,
        }
        first = copy.deepcopy(covered)
        first["accounting"]["closed"] = False
        runner = str(uuid.uuid4())
        baseline = {
            "mode": "starting",
            "max_concurrent": 1,
            "active_runs": [],
            "started_at": "2026-10-18T16:00:00Z",
            "updated_at": "2026-10-18T16:00:10Z",
            "idle_sandboxes": [
                {
                    "reuse_key": "thread:native-guarded-" + str(uuid.uuid4()),
                    "sandbox_id": terminal[1]["sandbox_id"],
                }
            ],
        }
        retried = {k: v for k, v in baseline.items() if k != "idle_sandboxes"}
        retried["updated_at"] = "2026-10-18T16:00:20Z"
        status_path = str(test.root / f"case-{index}" / "status.json")
        values = (
            {
                "policy": test.policy,
                "published_status": baseline,
                "status_path": status_path,
                "receiver_polled_pending": True,
                "coverage": first,
            },
            {
                "pool_held_ns": at(6),
                "status_held_ns": at(7),
                "heartbeat_pending_ns": at(8),
                "heartbeat_polled_pending": True,
                "observer": joined_observer(at(9), at(10)),
                "tracker_shutdown_pending": True,
                "accounting_shutdown_pending": True,
                "coverage": covered,
            },
            {
                "pool_released_ns": at(13),
                "status_held_ns": at(7),
                "heartbeat": foreground_heartbeat(runner, 1, at(14), at(15), (2, 4096)),
                "receiver_polled_pending": True,
                "tracker_shutdown_pending": True,
                "accounting_shutdown_pending": True,
                "coverage": covered,
            },
            {
                "io_released_ns": at(17),
                "status_held_ns": at(7),
                "status_wait_polled_ns": at(21),
                "status_waits_before": 0,
                "status_waits_after": 1,
                "receiver_polled_pending": True,
                "tracker_shutdown_pending": True,
                "accounting_joined": True,
                "accounting": accounts,
                "allocated": [0, 0, 0],
                "heartbeat": foreground_heartbeat(runner, 2, at(22), at(23), (0, 0)),
                "fault_injected_ns": at(24),
                "status_destination_directory": True,
            },
            {
                "status_released_ns": at(26),
                "batch_joined_ns": at(27),
                "selected": 1,
                "completed": 1,
                "uncertain": 0,
                "not_started": 0,
                "is_complete": False,
                "status_error_kind": "write",
                "status_error_path": status_path,
                "status_destination_directory": True,
            },
            {
                "retry_started_ns": at(32),
                "retry_completed_ns": at(33),
                "published_status": retried,
                "regular_file": True,
                "original_batch_complete": False,
            },
            {
                "batch_joined": True,
                "tracker_joined": True,
                "accounting_joined": True,
                "heartbeat_joined": True,
                "provider_joined": True,
                "peer_joined": True,
                "remaining_activation_owners": 0,
                "remaining_finalizing_owners": 0,
                "allocated": [0, 0, 0],
                "accounting": accounts,
            },
        )
        for phase, value, clock in zip(
            failure.PHASES, values, (4, 12, 16, 25, 30, 40, 45)
        ):
            test.witnesses.append(
                report_test.witness_receipt(
                    case,
                    phase,
                    monotonic_ns=at(clock),
                    unix_ns=at(clock) + 1000,
                    sandbox_id=terminal[1]["sandbox_id"],
                    backing_generation=terminal[1]["backing_generation"],
                    evidence=copy.deepcopy(value),
                )
            )


def prepare_speculative_fault(test):
    prepare_status_failure(test)
    raw = test.collector["metadata"].pop("native_status_failure_policy_json")
    test.collector["metadata"]["native_speculative_fault_policy_json"] = raw
    original, sample = test.events[:6], test.samples[0]
    test.events, test.samples, test.witnesses = [], [], []
    for index, case in enumerate(sorted(fault.CASES)):
        at = lambda offset: 10_000_000_000 * (index + 1) + offset * 1_000_000
        old, backing, history, operation, runner = [str(uuid.uuid4()) for _ in range(5)]
        terminal = copy.deepcopy(original)
        for event, offset in zip(terminal, (0, 1, 40, 41, 70, 100)):
            event.update(
                case=case,
                sandbox_id=old,
                backing_generation=backing,
                monotonic_ns=at(offset),
                unix_ns=at(offset) + 1000,
            )
            test.samples.append(report_test.residency_sample_at(sample, at(offset) + 1))
        test.events.extend(terminal)
        mode = "panic" if case.startswith("SpeculativePanic-") else "drop"
        reuse = "thread:native-guarded-" + history
        initial = {
            "mode": "starting",
            "max_concurrent": 1,
            "active_runs": [],
            "started_at": "2026-10-19T01:00:00Z",
            "updated_at": "2026-10-19T01:00:01Z",
            "idle_sandboxes": [{"reuse_key": reuse, "sandbox_id": old}],
        }
        empty = {k: v for k, v in initial.items() if k != "idle_sandboxes"}
        empty["updated_at"] = "2026-10-19T01:00:02Z"
        zero = dict.fromkeys(cleanup.COUNTS, 0) | {"closed": True}
        active = zero | {
            "registered_operations": 1,
            "started": 1,
            "tracked_tasks": 1,
            "cleanup_growth_bytes": test.policy["tail_growth_bytes"],
            "closed": False,
        }
        coverage = {
            "allocated": [2, 4096, 1],
            "accounting": active,
            "original_lease_active": True,
            "io_release_withheld": True,
        }
        raw = history.encode()
        digest = hashlib.sha256((raw * (65536 // len(raw) + 1))[:65536]).hexdigest()
        values = (
            {
                "policy": test.policy,
                "status_path": str(test.root / f"case-{index}" / "status.json"),
                "published_status": initial,
                "regular_file": True,
            },
            {
                "mode": mode,
                "history_run_id": history,
                "operation_run_id": operation,
                "reuse_key": reuse,
                "prepare_started_ns": at(5),
                "rpc_completed_ns": at(10),
                "payload_sha256": digest,
                "payload_bytes": 65536,
                "production_restore_completed": True,
                "private_marker_verified": True,
                "ordinary_home_verified": True,
                "callback_polled_pending": True,
                "callback_release_withheld": True,
                "pool_empty": True,
                "original_full_lease_active": True,
                "original_exit_polled_pending": True,
                "allocated": [2, 4096, 1],
            },
            {
                "failure_requested_ns": at(14),
                "failure_joined_ns": at(16),
                "mode": mode,
                "panic_caught": mode == "panic",
                "state": "Uncertain",
                "commit_refused": True,
                "repark_refused": True,
                "incoming_refused": True,
                "original_metadata_preserved": True,
                "original_full_lease_active": True,
                "original_exit_polled_pending": True,
                "pool_empty": True,
                "allocated": [2, 4096, 1],
            },
            {
                "original_exit_confirmed": True,
                "receiver_polled_pending": True,
                "coverage": coverage,
            },
            {
                "pool_held_ns": at(46),
                "status_held_ns": at(47),
                "heartbeat_pending_ns": at(48),
                "heartbeat_polled_pending": True,
                "observer": joined_observer(at(49), at(50)),
                "coverage": coverage,
            },
            {
                "pool_released_ns": at(56),
                "status_held_ns": at(47),
                "heartbeat": foreground_heartbeat(runner, 1, at(57), at(58), (2, 4096)),
                "receiver_polled_pending": True,
                "coverage": coverage,
            },
            {
                "io_released_ns": at(66),
                "saving_joined_ns": at(72),
                "home_cache_promoted": True,
                "original_lease_released": True,
                "allocated": [0, 0, 0],
                "accounting": zero,
            },
            {
                "status_wait_polled_ns": at(76),
                "status_waits_before": 0,
                "status_waits_after": 1,
                "heartbeat": foreground_heartbeat(runner, 2, at(78), at(79), (0, 0)),
                "publication_polled_pending": True,
                "allocated": [0, 0, 0],
            },
            {
                "status_released_ns": at(86),
                "publication_joined_ns": at(87),
                "published_status": empty,
                "regular_file": True,
                "allocated": [0, 0, 0],
            },
            {
                "tracker_joined": True,
                "accounting_joined": True,
                "heartbeat_joined": True,
                "provider_joined": True,
                "peer_joined": True,
                "remaining_activation_owners": 0,
                "remaining_finalizing_owners": 0,
                "allocated": [0, 0, 0],
                "accounting": zero,
            },
        )
        for phase, value, offset in zip(
            fault.PHASES, values, (3, 12, 20, 45, 55, 65, 75, 85, 90, 95)
        ):
            test.witnesses.append(
                report_test.witness_receipt(
                    case,
                    phase,
                    monotonic_ns=at(offset),
                    unix_ns=at(offset) + 1000,
                    sandbox_id=old,
                    backing_generation=backing,
                    evidence=copy.deepcopy(value),
                )
            )


def prepare_native_unpark(test):
    prepare_speculative_fault(test)
    test.collector["metadata"]["native_unpark_policy_json"] = test.collector[
        "metadata"
    ].pop("native_speculative_fault_policy_json")
    original, template, sample = (
        copy.deepcopy(test.events[:6]),
        copy.deepcopy(test.witnesses[:10]),
        test.samples[0],
    )
    old_base = template[0]["monotonic_ns"] - 3_000_000
    old, backing = original[1]["sandbox_id"], original[1]["backing_generation"]
    old_history = template[1]["evidence"]["history_run_id"]
    old_runner = template[5]["evidence"]["heartbeat"]["receipt"]["state"]["runnerId"]
    test.events, test.samples, test.witnesses = [], [], []
    for index, case in enumerate(sorted(native.CASES)):
        at = lambda offset: 10_000_000_000 * (index + 1) + offset * 1_000_000
        owner, generation, history, operation, runner = [
            str(uuid.uuid4()) for _ in range(5)
        ]
        tokens = {
            old: owner,
            backing: generation,
            old_history: history,
            old_runner: runner,
            template[0]["case"]: case,
        }

        def remap(value):
            if isinstance(value, dict):
                return {key: remap(item) for key, item in value.items()}
            if isinstance(value, list):
                return [remap(item) for item in value]
            if isinstance(value, str):
                for before, after in tokens.items():
                    value = value.replace(before, after)
                return value
            if type(value) is int and old_base <= value < old_base + 1_000_000_000:
                return at(0) + value - old_base
            return value

        terminal = remap(copy.deepcopy(original))
        for event, offset in zip(terminal, (0, 1, 40, 41, 70, 100)):
            event.update(
                case=case,
                sandbox_id=owner,
                backing_generation=generation,
                monotonic_ns=at(offset),
                unix_ns=at(offset) + 1000,
            )
            test.samples.append(report_test.residency_sample_at(sample, at(offset) + 1))
        test.events.extend(terminal)
        initial = remap(copy.deepcopy(template[0]["evidence"]))
        initial["status_path"] = str(test.root / f"case-{index}" / "status.json")
        raw = 'PATCH /vm HTTP/1.1\r\nContent-Length: 19\r\n\r\n{"state":"Resumed"}'
        response = "HTTP/1.1 204 No Content\r\n\r\n"
        request_sha, response_sha = [
            hashlib.sha256(value.encode()).hexdigest() for value in (raw, response)
        ]
        mode = case.rsplit("-", 1)[0]
        values = (
            initial,
            {
                "mode": mode,
                "history_run_id": history,
                "operation_run_id": operation,
                "reuse_key": "thread:native-guarded-" + history,
                "prepare_started_ns": at(5),
                "capture_observed_ns": at(7),
                "request_raw": raw,
                "request_sha256": request_sha,
                "backend_socket": "/run/vm0/sock/" + owner + "/api.sock",
                "front_socket": "/run/vm0/sock/" + owner + "/unpark-proof.sock",
                "backend_dispatched": False,
                "restore_callback_reached": False,
                "original_full_lease_active": True,
                "allocated": [2, 4096, 1],
            },
            {
                "backend_response_observed_ns": at(10),
                "backend_status": 204,
                "response_raw": response,
                "response_sha256": response_sha,
                "public_unpark_polled_pending": True,
                "response_delivery_withheld": True,
                "restore_callback_reached": False,
                "internal_vmm_inflight_claimed": False,
                "original_full_lease_active": True,
                "original_exit_polled_pending": True,
                "allocated": [2, 4096, 1],
            },
            {
                "cancel_requested_ns": at(14),
                "observation_dropped_ns": at(16),
                "observer_unwound": mode == "UnparkObserverUnwind",
                "state": "Uncertain",
                "commit_refused": True,
                "repark_refused": True,
                "incoming_refused": True,
                "original_metadata_preserved": True,
                "original_full_lease_active": True,
                "original_exit_polled_pending": True,
                "pool_empty": True,
                "allocated": [2, 4096, 1],
            },
            {
                "pool_held_ns": at(23),
                "heartbeat_pending_ns": at(24),
                "pool_released_ns": at(27),
                "observer": joined_observer(at(25), at(26)),
                "heartbeat": foreground_heartbeat(runner, 1, at(28), at(29), (2, 4096)),
                "terminal_unpark_polled_pending": True,
                "response_delivery_withheld": True,
                "additional_full_profile_refused": True,
                "original_full_lease_active": True,
                "allocated": [2, 4096, 1],
            },
            {
                "response_released_ns": at(36),
                "producer_joined_ns": at(38),
                "producer_joined": True,
                "producer_unwound": mode == "UnparkProducerUnwind",
                "backend_status": 204,
                "joined_request_sha256": None
                if mode == "UnparkProducerUnwind"
                else request_sha,
                "accepted_response_before_cancellation": True,
                "internal_vmm_inflight_claimed": False,
            },
        )
        for phase, value, offset in zip(native.PHASES, values, (3, 8, 12, 20, 35, 39)):
            test.witnesses.append(
                report_test.witness_receipt(
                    case,
                    phase,
                    monotonic_ns=at(offset),
                    unix_ns=at(offset) + 1000,
                    sandbox_id=owner,
                    backing_generation=generation,
                    evidence=value,
                )
            )
        saved = remap(copy.deepcopy(template[3:]))
        for event in saved:
            heartbeat = event["evidence"].get("heartbeat")
            if heartbeat:
                heartbeat["receipt"]["state"]["snapshotSequence"] += 1
        test.witnesses.extend(saved)


def prepare_batch_replacement(test, cases):
    prepare_status_failure(test)
    raw = json.dumps(test.policy)
    test.collector["metadata"].pop("native_status_failure_policy_json")
    test.collector["metadata"]["native_batch_replacement_policy_json"] = raw
    test.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
    original, sample = test.events[:6], test.samples[0]
    test.events, test.samples, test.witnesses = [], [], []
    for index, case in enumerate(sorted(cases)):
        at = lambda offset: 10_000_000_000 * (index + 1) + offset * 1_000_000
        old, backing, new, new_backing, operation, runner = [
            str(uuid.uuid4()) for _ in range(6)
        ]
        terminal = copy.deepcopy(original)
        for event, offset in zip(terminal, (0, 1, 9, 10, 26, 65)):
            event.update(
                case=case,
                sandbox_id=old,
                backing_generation=backing,
                monotonic_ns=at(offset),
                unix_ns=at(offset) + 1000,
            )
            test.samples.append(report_test.residency_sample_at(sample, at(offset) + 1))
        test.events.extend(terminal)
        zero = dict.fromkeys(cleanup.COUNTS, 0) | {"closed": False}
        active = zero | {
            "registered_operations": 3,
            "queued": 2,
            "started": 1,
            "tracked_tasks": 1,
            "cleanup_growth_bytes": test.policy["tail_growth_bytes"],
        }
        coverage = {
            "allocated": [4, 8192, 2],
            "accounting": active,
            "original_lease_active": True,
            "io_release_withheld": True,
        }
        reuse = "thread:native-guarded-" + str(uuid.uuid4())
        initial = {
            "mode": "starting",
            "max_concurrent": 1,
            "active_runs": [],
            "started_at": "2026-10-19T01:00:00Z",
            "updated_at": "2026-10-19T01:00:01Z",
            "idle_sandboxes": [{"reuse_key": reuse, "sandbox_id": old}],
        }
        current = copy.deepcopy(initial)
        current.update(
            updated_at="2026-10-19T01:00:02Z",
            idle_sandboxes=[{"reuse_key": reuse, "sandbox_id": new}],
        )
        empty = {k: v for k, v in current.items() if k != "idle_sandboxes"}
        empty["updated_at"] = "2026-10-19T01:00:03Z"
        reads = [
            memory_read_receipt(at(offset), at(offset) + 1000, offset * 1_000_000)
            for offset in (7, 8, 33)
        ]
        values = (
            {
                "policy": test.policy,
                "status_path": str(test.root / f"case-{index}" / "status.json"),
                "published_status": initial,
                "selected_revision": 1,
                "preparation": {
                    "sandbox_id": new,
                    "backing_generation": new_backing,
                    "operation_id": operation,
                    "grant_started_ns": at(2),
                    "grant_finished_ns": at(3),
                    "prepared_ns": at(4),
                    "guest_rpc_completed": True,
                    "phase_settled": True,
                    "separate_incoming_lease": True,
                },
                "same_reuse_key": reuse,
                "source_read_blocked": True,
                "receiver_polled_pending": True,
                "accounting": zero | {"registered_operations": 2, "queued": 2},
                "allocated": [4, 8192, 2],
                "original_full_lease_active": True,
                "original_exit_polled_pending": True,
                "incoming_exit_polled_pending": True,
            },
            {
                "insertion_started_ns": at(6),
                "revision": 2,
                "original_exit_confirmed": True,
                "receiver_polled_pending": True,
                "coverage": coverage,
            },
            {
                "pool_held_ns": at(13),
                "heartbeat_pending_ns": at(14),
                "heartbeat_polled_pending": True,
                "observer": joined_observer(at(15), at(16)),
                "coverage": coverage,
            },
            {
                "pool_released_ns": at(19),
                "heartbeat": foreground_heartbeat(runner, 1, at(20), at(21), (4, 8192)),
                "receiver_polled_pending": True,
                "coverage": coverage,
            },
            {
                "io_released_ns": at(24),
                "retirement_joined_ns": at(27),
                "home_cache_promoted": True,
                "original_exit_confirmed": True,
                "original_lease_released": True,
                "incoming_exit_polled_pending": True,
                "receiver_polled_pending": True,
                "allocated": [2, 4096, 1],
            },
            {
                "status_held_ns": at(31),
                "source_resumed_ns": at(32),
                "status_wait_polled_ns": at(34),
                "status_waits_before": 0,
                "status_waits_after": 1,
                "heartbeat": foreground_heartbeat(runner, 2, at(35), at(36), (2, 4096)),
                "accounting": zero,
                "samples": reads,
                "receiver_polled_pending": True,
                "allocated": [2, 4096, 1],
            },
            {
                "status_released_ns": at(39),
                "batch_joined_ns": at(40),
                "selected": 1,
                "completed": 0,
                "uncertain": 0,
                "not_started": 1,
                "status_error": False,
                "is_complete": False,
                "refused_sandbox_id": old,
                "refused_reuse_key": reuse,
                "error": "AccountingChanged",
                "revision": 2,
                "published_status": current,
                "regular_file": True,
                "incoming_exit_polled_pending": True,
                "allocated": [2, 4096, 1],
            },
            {
                "started_ns": at(43),
                "joined_ns": at(44),
                "selected": 1,
                "completed": 1,
                "uncertain": 0,
                "not_started": 0,
                "status_error": False,
                "is_complete": True,
                "incoming_exit_confirmed": True,
                "published_status": empty,
                "allocated": [0, 0, 0],
            },
            {
                "old_batch_joined": True,
                "replacement_joined": True,
                "incoming_batch_joined": True,
                "tracker_joined": True,
                "accounting_joined": True,
                "heartbeat_joined": True,
                "provider_joined": True,
                "peer_joined": True,
                "remaining_activation_owners": 0,
                "remaining_finalizing_owners": 0,
                "allocated": [0, 0, 0],
                "accounting": zero | {"closed": True},
            },
        )
        for phase, value, offset in zip(
            replacement.PHASES, values, (5, 12, 18, 23, 29, 38, 42, 46, 50)
        ):
            test.witnesses.append(
                report_test.witness_receipt(
                    case,
                    phase,
                    monotonic_ns=at(offset),
                    unix_ns=at(offset) + 1000,
                    sandbox_id=old,
                    backing_generation=backing,
                    evidence=copy.deepcopy(value),
                )
            )


def write_batch_replacement(test):
    report_test.write_report_fixture(
        test.root,
        test.collector,
        test.samples,
        [(report.PREFIX, test.events), (replacement.PREFIX, test.witnesses)],
    )


def assert_unpark_witness_refusals(test, changes):
    original = copy.deepcopy(test.witnesses)
    report_test.assert_indexed_witness_refusals(test, original, changes)
    test.witnesses = original
    test.validate()
