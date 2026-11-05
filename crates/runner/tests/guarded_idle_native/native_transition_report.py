"""Original HTTP and held-wait evidence shared by native transition reports."""

import hashlib
import json

import batch_aba_report as batch
import progress_report as foreground
import report
from snapshot_report import exact


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
