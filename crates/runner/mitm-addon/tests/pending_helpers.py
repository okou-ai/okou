"""Shared pending-state assertions for mitm-addon tests."""

import json
import os
from pathlib import Path

import usage


def _pending_state(path: Path) -> dict:
    return json.loads(path.read_text())


def assert_pending(
    path: Path,
    *,
    flows: int,
    buffered: int,
    reports: int,
    flush_request_id: str | None = None,
) -> dict:
    """Assert a usage pending-state JSON snapshot.

    ``flows``, ``buffered``, and ``reports`` map directly to the JSON fields
    with the same names.  ``flows`` is the number of admitted in-flight usage
    flows, including billable model-provider and connector flows.

    ``buffered`` counts original usage source records in live stores, pending
    or retry flushes, and delivering flushes, plus retained unadmitted
    diagnostic reports. Usage is counted in source records, not webhook batches
    or aggregated payload events. Admission alone does not remove usage:
    delivering flushes remain counted while admitted callbacks are unresolved.
    Successful or permanent outcomes leave the buffer when delivery ownership
    ends. Retryable or unadmitted batches return to pending unless the retry
    budget drops them. See ``usage.buffer.state`` for the ownership contract.

    Diagnostic reports stop contributing to ``buffered`` at admission or
    terminal discard, eviction, or reset, as defined by
    ``usage.counters.BufferedReportLease``. ``reports`` is the number of pending
    webhook report deliveries.

    When ``flush_request_id`` is provided, the snapshot must include a matching
    ``flushRequestId`` field.  When it is omitted, ``flushRequestId`` must be
    absent from the snapshot.
    """
    state = _pending_state(path)
    expected_fields = {
        "pid",
        "usageStateId",
        "updatedAtMs",
        "flows",
        "buffered",
        "reports",
    }
    if flush_request_id is not None:
        expected_fields.add("flushRequestId")
    assert set(state) == expected_fields
    assert state["pid"] == os.getpid()
    assert state["usageStateId"]
    assert isinstance(state["updatedAtMs"], int)
    assert state["flows"] == flows
    assert state["buffered"] == buffered
    assert state["reports"] == reports
    if flush_request_id is not None:
        assert state["flushRequestId"] == flush_request_id
    return state


def assert_current_pending(
    path: Path,
    *,
    flows: int,
    buffered: int,
    reports: int,
    flush_request_id: str | None = None,
) -> dict:
    """Write and assert the current runner-facing pending-state snapshot."""
    usage.write_pending_snapshot(flush_request_id=flush_request_id)
    return assert_pending(
        path,
        flows=flows,
        buffered=buffered,
        reports=reports,
        flush_request_id=flush_request_id,
    )
