"""Addon log records transported to Axiom through the Runner."""

import json
import os
import stat
from typing import Literal

AddonProcessEventLevel = Literal["warn", "error"]

ADDON_PROCESS_EVENT_PREFIX = "VM0_ADDON_EVENT "
ADDON_PROCESS_EVENT_VERSION = 1
MAX_ADDON_PROCESS_EVENT_BYTES = 4096
_MAX_MESSAGE_CHARACTERS = 2048
_TRUNCATION_SUFFIX = "..."
_RESERVED_LOG_FIELDS = frozenset(("version", "level", "message"))


def _serialize_event(payload: dict[str, object]) -> bytes:
    return (
        ADDON_PROCESS_EVENT_PREFIX.encode()
        + json.dumps(
            payload,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode()
        + b"\n"
    )


def _bounded_event(payload: dict[str, object], message: str) -> bytes:
    bounded_message = message[:_MAX_MESSAGE_CHARACTERS]
    payload["message"] = bounded_message
    record = _serialize_event(payload)
    if len(record) <= MAX_ADDON_PROCESS_EVENT_BYTES:
        return record

    payload["message"] = ""
    if len(_serialize_event(payload)) > MAX_ADDON_PROCESS_EVENT_BYTES:
        raise ValueError("addon process event fields exceed the record size limit")

    low = 0
    high = len(bounded_message)
    best = ""
    while low <= high:
        middle = (low + high) // 2
        candidate = bounded_message[:middle] + _TRUNCATION_SUFFIX
        payload["message"] = candidate
        record = _serialize_event(payload)
        if len(record) <= MAX_ADDON_PROCESS_EVENT_BYTES:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1

    payload["message"] = best
    return _serialize_event(payload)


def emit_addon_process_event(
    level: AddonProcessEventLevel,
    message: str,
    /,
    **fields: object,
) -> None:
    """Attempt one bounded, nonblocking record on the Runner's stderr pipe.

    The Runner recognizes only this versioned envelope. Other than the
    transport ``version`` and logger-owned ``level`` and ``message``, fields
    are passed through without an event-specific schema. Values must be JSON
    serializable. Runner-owned Axiom metadata such as time, context, service,
    hostname, and Runner version remains authoritative.

    The complete UTF-8 encoded record, including the prefix, JSON envelope,
    and trailing newline, is limited to ``MAX_ADDON_PROCESS_EVENT_BYTES``
    (4096 bytes). Only ``message`` is automatically shortened; structured
    fields are never truncated. Callers must keep those fields within the
    remaining encoded-record budget. If the record still exceeds the limit
    with an empty message, ``ValueError`` is raised before any write.

    Delivery requires the Linux Runner's piped stderr. Reopening it through
    procfs gives this write independent nonblocking flags without changing
    mitmproxy's fd 2. A full pipe drops the entire record: no queue, retries,
    recursive logging, or shutdown drain. Non-pipe sinks and ``OSError`` are
    best-effort drops. Input validation, serialization, and record-size errors
    still propagate to the caller.
    """
    if level not in ("warn", "error"):
        raise ValueError(f"invalid addon process event level: {level!r}")

    payload: dict[str, object] = {"version": ADDON_PROCESS_EVENT_VERSION}
    payload.update(
        (name, value) for name, value in fields.items() if name not in _RESERVED_LOG_FIELDS
    )
    payload["level"] = level

    record = _bounded_event(payload, message)
    try:
        fd = os.open("/proc/self/fd/2", os.O_WRONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            if not stat.S_ISFIFO(os.fstat(fd).st_mode):
                return
            # One write within PIPE_BUF is all-or-nothing, even with concurrent
            # emitters. Never retry a partial record or change fd 2's flags.
            if len(record) <= os.fpathconf(fd, "PC_PIPE_BUF"):
                os.write(fd, record)
        finally:
            os.close(fd)
    except OSError:
        return
