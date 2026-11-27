"""Shared retained-home fixtures for Guest Preparation report readers."""

import copy
import hashlib
import json
import struct
import subprocess
import uuid

import cleanup_report as cleanup
import continuation_report
import fixed_restore_report as fixed
import report
import report_test
from progress_report_fixture import foreground_heartbeat, joined_observer

_BOOTSTRAP_CASE = "FixedRestore-capture-drop-fresh"


def prepare(test):
    """Build fresh original data and select the common bootstrap case."""
    report_test.prepare_native_report_fixture(test, cases={_BOOTSTRAP_CASE})
    test.policy = report_test.pressure_policy_fixture()
    raw = json.dumps(test.policy)
    test.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
    test.collector["metadata"]["native_fixed_restore_policy_json"] = raw
    test.collector.update(success=False, driver_exit_code=101, cleanup_intervened=True)
    test.ident, test.backing, test.history, test.run, test.runner = [
        str(uuid.uuid4()) for _ in range(5)
    ]
    test.payload = report.history_payload(test.history)
    seed = test.root / "seed"
    private = seed / ".vm0" / "guest-agent" / "runs" / test.history
    private.mkdir(parents=True)
    (private / "fixture-private").write_bytes(b"fixture private bytes")
    (seed / "guarded-idle-ordinary").write_bytes(b"native ordinary home bytes")
    (seed / "guarded-idle-payload").write_bytes(test.payload)
    test.thread = str(uuid.uuid4())
    test.original = b'{"type":"session_meta","payload":{"id":"' + test.thread.encode() + b'"}}\n'
    test.session_path = (
        f"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-{test.thread}.jsonl"
    )
    target = seed / test.session_path.removeprefix("/home/user/")
    target.parent.mkdir(parents=True)
    target.write_bytes(test.original)
    test.image = test.root / "retained-home.ext4"
    with test.image.open("wb") as stream:
        stream.truncate(report.NATIVE_HOME_BYTES)
    subprocess.run(
        [
            "/usr/sbin/mke2fs",
            "-q",
            "-F",
            "-t",
            "ext4",
            "-O",
            "^has_journal",
            "-d",
            str(seed),
            str(test.image),
        ],
        check=True,
        capture_output=True,
    )
    with test.image.open("rb") as stream:
        stream.seek(1024)
        block = stream.read(1024)
    home = {
        "path": f"/var/tmp/native-case/workspaces/{test.ident}/home.ext4",
        "bytes": report.NATIVE_HOME_BYTES,
        "filesystem_uuid": block[104:120].hex(),
        "superblock_sha256": hashlib.sha256(block).hexdigest(),
    }
    at = lambda n: 10_000_000_000 + int(n * 1_000_000)
    test.at = at
    template = copy.deepcopy(test.events[1])
    template.update(sandbox_id=test.ident, backing_generation=test.backing)

    def event(phase, n, value):
        return template | dict(
            phase=phase, monotonic_ns=at(n), unix_ns=at(n) + 1000, evidence=value
        )

    def wire(kind, data):
        raw = struct.pack(">IBI", 5 + len(data), kind, 2) + data
        return dict(
            message_type=kind, sequence=2, raw_hex=raw.hex(), sha256=hashlib.sha256(raw).hexdigest()
        )

    test.request = wire(
        0x1A, struct.pack(">IQIBH", 300000, 10, 5500000, 2, 3) + b"UTC" + bytes(range(256))
    )
    test.response = wire(
        0x1B,
        bytes(5) + struct.pack(">I", 3) + b"\x01\0" + bytes(4) + b"\x01\0" + bytes(4) + bytes(2),
    )
    physical = {
        "path": test.session_path,
        "bytes": len(test.original),
        "sha256": hashlib.sha256(test.original).hexdigest(),
        "raw_hex": test.original.hex(),
    }
    heartbeat = foreground_heartbeat(test.runner, 1, at(16), at(17), (2, 4096))
    heartbeat["receipt"]["state"]["heldSandboxStates"] = []
    test.values = [
        {
            "history_run_id": test.history,
            "thread_id": test.thread,
            "history_hex": test.original.hex(),
            "history_sha256": hashlib.sha256(test.original).hexdigest(),
            "history_bytes": len(test.original),
            "physical_history": physical,
            "final_identity_verified": True,
            "executor_completed": True,
            "exit_code": 0,
        },
        {
            "history_run_id": test.history,
            "payload_sha256": hashlib.sha256(test.payload).hexdigest(),
            "payload_bytes": 65536,
            "original_private_and_home_verified": True,
            "guest_sync_completed": True,
        },
        {
            "history_run_id": test.history,
            "operation_run_id": test.run,
            "prepare_started_ns": at(5),
            "request": test.request,
            "backend_dispatched": False,
            "canonical_fixed_helper": True,
        }
        | fixed.LEASE,
        {
            "boundary": "capture",
            "request": test.request,
            "response": None,
            "public_restore_polled_pending": True,
            "running_helper_observed": False,
        }
        | fixed.LEASE,
        {
            "lost_ns": at(8),
            "observer_unwound": False,
            "state": "Uncertain",
            "commit_refused": True,
            "repark_refused": True,
            "incoming_refused": True,
            "original_metadata_preserved": True,
            "pool_empty": True,
            "original_exit_polled_pending": True,
        }
        | fixed.LEASE,
        {
            "pool_held_ns": at(10),
            "status_held_ns": at(11),
            "heartbeat_pending_ns": at(12),
            "observer": joined_observer(at(13), at(14)),
            "pool_released_ns": at(15),
            "heartbeat": heartbeat,
            "status_released_ns": at(18),
            "sample_after_ns": at(18) + 2,
            "p1_sample_ns": at(19),
            "status_wait_polled_ns": at(11) + 1,
            "status_waits_before": 0,
            "status_waits_after": 1,
            "status_published_ns": at(18) + 1,
            "selected_delivery_withheld": True,
            "additional_full_profile_refused": True,
        }
        | fixed.LEASE,
        {
            "request": test.request,
            "response": test.response,
            "delivery_requested_ns": at(21),
            "joined_ns": at(22),
            "canonical_helper_exited_zero": True,
            "helper_stdin_stderr_joined": True,
            "exchange_joined": True,
            "transport_producer_unwound": False,
            "connection_retained_pending": True,
            "running_helper_observed": False,
            "ordinary_reuse_reopened": False,
        }
        | fixed.LEASE,
        {
            "error": "sandbox home mount failed: normal operations are not available on this connection",
            "normal_operations_not_parkable": True,
            "completed_lease_refused": True,
            "required_saving_complete": False,
            "cleanup_complete": False,
            "original_home": home,
        }
        | fixed.LEASE,
        {
            "original_home": home,
            "promotion_lock_busy": True,
            "promotion_probe_run_id": str(uuid.uuid4()),
            "promotion_probe_sandbox_id": str(uuid.uuid4()),
            "original_capsule_retained": True,
            "original_session_history_retained": True,
            "original_backing_retained": True,
            "original_exit_polled_pending": True,
            "tracker_joined": True,
            "heartbeat_provider_peer_joined": True,
            "accounting": cleanup.zero_accounting(closed=True)
            | {
                "registered_operations": 2,
                "uncertain": 2,
                "cleanup_growth_bytes": test.policy["live_growth_bytes"]
                + test.policy["tail_growth_bytes"],
            },
            "required_saving_complete": False,
            "cleanup_complete": False,
            "physical_relief_proven": False,
            "memory_credit": False,
            "running_helper_boundary": "blocked",
            "preterminal_acceptance_boundary": "blocked",
            "original_cleanup_io_progress": "blocked_not_parkable",
        }
        | fixed.LEASE,
    ]
    test.witnesses = [
        event(phase, n, value)
        for phase, n, value in zip(fixed.PHASES, (2, 3, 6, 7, 9, 20, 23, 24, 25), test.values)
    ]
    test.events = [
        event("case_started", 0, {"artifacts": test.artifacts}),
        event("terminal_started", 4, {}),
    ]
    test.events[0].update(sandbox_id=None, backing_generation=None)
    test.continuation = event(
        "original_executor_completed",
        1,
        {
            "original_run_id": test.history,
            "thread_id": test.thread,
            "original_history_sha256": hashlib.sha256(test.original).hexdigest(),
            "original_history_bytes": len(test.original),
            "exit_code": 0,
            "final_identity_verified": True,
            "full_original_prefix_verified": True,
            "preparation_observed_by_native_process": True,
            "original_full_lease_witness": True,
        },
    )
    sample = test.samples[0]
    test.samples = []
    for n in (6.5, 12, 19, 22, 24.5):
        test.samples.append(report_test.residency_sample_at(sample, at(n)))
    select_case(test, _BOOTSTRAP_CASE, terminal=False)


def select_case(test, case, *, terminal):
    """Apply the case's identity, response boundary and unwind flags."""
    for event in [*test.events, *test.witnesses, test.continuation]:
        event["case"] = case
    test.values[3].update(
        boundary="terminal" if terminal else "capture",
        response=test.response if terminal else None,
    )
    test.values[4]["observer_unwound"] = "-observer-unwind-" in case
    unwind = "-producer-unwind-" in case
    test.values[6].update(
        exchange_joined=not unwind,
        transport_producer_unwound=unwind,
        connection_retained_pending=not unwind,
    )


def write_report(test, *, prefix, uncertainty):
    """Write the common failed transcript with the caller's witness prefix."""
    report_test.write_report_fixture(
        test.root,
        test.collector,
        test.samples,
        [
            (report.PREFIX, [test.events[0]]),
            (continuation_report.PREFIX, [test.continuation]),
            (prefix, test.witnesses[:2]),
            (report.PREFIX, [test.events[1]]),
            (prefix, test.witnesses[2:]),
        ],
        stdout_suffix="\ntest result: FAILED\n",
    )
    (test.root / "stderr.log").write_text(f"Error: {uncertainty}\n")
