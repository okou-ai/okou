"""Original HTTP and cancellation evidence shared by native transition reports."""

import hashlib
import json

import batch_aba_report as batch
import progress_report as foreground
import report
from report import exact


def wire(value, response=False, state="Resumed"):
    if not isinstance(value, str) or len(value) > 1024 * 1024:
        raise ValueError("missing bounded original HTTP bytes")
    raw = value.encode("ascii")
    head, body = raw.split(b"\r\n\r\n", 1)
    lines = head.split(b"\r\n")
    valid = (
        lines[0].split(b" ", 2)[:2] == [b"HTTP/1.1", b"204"]
        if response
        else lines[0] == b"PATCH /vm HTTP/1.1"
    )
    if not valid:
        raise ValueError("wrong native request or successful backend response")
    headers = {}
    for line in lines[1:]:
        name, val = line.split(b":", 1)
        name = name.strip().lower()
        if name in headers:
            raise ValueError("duplicate HTTP evidence header")
        headers[name] = val.strip()
    if b"transfer-encoding" in headers:
        raise ValueError("unsupported native HTTP transfer encoding")
    length = headers.get(b"content-length", b"0" if response else b"")
    if not length.isdigit() or int(length) != len(body):
        raise ValueError("incomplete native HTTP evidence")
    if response:
        if body:
            raise ValueError("204 response contains a body")
    elif json.loads(body, object_pairs_hook=report.unique_object) != {"state": state}:
        raise ValueError("native transition evidence names another operation")
    return hashlib.sha256(raw).hexdigest()


def validate_preparation_loss(lost, previous_event, current_event, *, observer_unwound):
    """Require the original uncertain owner after the preparation observer drops."""
    requested = batch.clock(
        lost.get("cancel_requested_ns"),
        previous_event["monotonic_ns"],
        current_event["monotonic_ns"],
    )
    dropped = batch.clock(lost.get("observation_dropped_ns"), requested, current_event["monotonic_ns"])
    exact(
        lost,
        {
            "cancel_requested_ns": requested,
            "observation_dropped_ns": dropped,
            "observer_unwound": observer_unwound,
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
        "native cancellation lost original uncertain custody",
    )


def wait_progress(progress, previous_event, current_event):
    """Validate common retained-wait custody and return the joined heartbeat identity."""
    held = batch.clock(
        progress.get("pool_held_ns"),
        previous_event["monotonic_ns"],
        current_event["monotonic_ns"],
    )
    polled = batch.clock(
        progress.get("heartbeat_pending_ns"), held, current_event["monotonic_ns"]
    )
    released = batch.clock(
        progress.get("pool_released_ns"), polled, current_event["monotonic_ns"]
    )
    foreground.observer(progress.get("observer"), polled, released)
    runner = foreground.heartbeat(
        progress.get("heartbeat"), 1, released, current_event["monotonic_ns"], (2, 4096)
    )
    exact(
        progress,
        {
            "pool_held_ns": held,
            "heartbeat_pending_ns": polled,
            "pool_released_ns": released,
            "observer": progress["observer"],
            "heartbeat": progress["heartbeat"],
            "terminal_unpark_polled_pending": True,
            "response_delivery_withheld": True,
            "additional_full_profile_refused": True,
            "original_full_lease_active": True,
            "allocated": [2, 4096, 1],
        },
        "native wait lost independent progress or no-headroom custody",
    )
    return runner


def validate_producer_join(joined, previous_event, current_event, *, producer_unwound, request_sha):
    """Require the observed producer join after release of the accepted response."""
    released = batch.clock(
        joined.get("response_released_ns"),
        previous_event["monotonic_ns"],
        current_event["monotonic_ns"],
    )
    finished = batch.clock(joined.get("producer_joined_ns"), released, current_event["monotonic_ns"])
    exact(
        joined,
        {
            "response_released_ns": released,
            "producer_joined_ns": finished,
            "producer_joined": True,
            "producer_unwound": producer_unwound,
            "backend_status": 204,
            "joined_request_sha256": None if producer_unwound else request_sha,
            "accepted_response_before_cancellation": True,
            "internal_vmm_inflight_claimed": False,
        },
        "accepted request producer was not joined before required cleanup",
    )
