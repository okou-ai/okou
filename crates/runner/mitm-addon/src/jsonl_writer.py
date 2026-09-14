"""Bounded asynchronous JSONL writer for mitmproxy hook paths."""

import os
import queue
import threading
import time
from collections import defaultdict
from dataclasses import dataclass

import addon_process_logging

MAX_PENDING_JSONL_WRITES = 4096
MAX_PENDING_JSONL_BYTES = 32 * 1024 * 1024
MAX_JSONL_IOVECS = os.sysconf("SC_IOV_MAX")
SHUTDOWN_JOIN_TIMEOUT_SECONDS = 1.0
APPEND_FAILURE_WARNING_INTERVAL_SECONDS = 60.0


@dataclass(frozen=True)
class _WriteItem:
    log_path: str
    line: bytes
    log_name: str
    sequence: int


_STOP = object()
_lock = threading.Lock()
_condition = threading.Condition(_lock)
_queue: queue.SimpleQueue[_WriteItem | object] = queue.SimpleQueue()
_worker: threading.Thread | None = None
_shutdown = False
_stop_enqueued = False
_accepted_by_path: defaultdict[str, int] = defaultdict(int)
_completed_by_path: defaultdict[str, int] = defaultdict(int)
_flush_waiters_by_path: defaultdict[str, int] = defaultdict(int)
_pending_bytes = 0
_queued_writes = 0
_drop_warning_logged = False
_last_append_failure_at: float | None = None
_last_append_failure_warning_at: float | None = None


def write_jsonl_line(log_path: str, line: bytes, log_name: str) -> None:
    """Queue caller-framed bytes for best-effort append without blocking hook latency.

    When accepted, ``line`` is passed to the append worker without transformation.
    The caller owns JSON serialization and the terminating newline; this function
    validates neither JSON nor record boundaries. Before a nonempty batch, the
    worker adds a newline if the existing file tail is unterminated, isolating
    subsequent records from a previous incomplete append.

    The call returns no admission or durability result. An empty ``log_path``,
    writer shutdown, pending-write or pending-byte saturation, or failure to start
    the worker can leave the entry unaccepted. ``log_name`` supplies warning context,
    but not every rejection emits one.

    Flush operations wait only for writes that were accepted, so they can succeed
    even if this call was rejected. Processing an accepted write, including a failed
    append attempt, does not guarantee persistence.
    """
    global _pending_bytes, _queued_writes

    if not log_path:
        return

    dropped = False
    with _condition:
        if _shutdown:
            return
        line_size = len(line)
        if (
            _queued_writes >= MAX_PENDING_JSONL_WRITES
            or _pending_bytes + line_size > MAX_PENDING_JSONL_BYTES
        ):
            dropped = True
        elif not _ensure_worker_locked():
            _warn(
                f"Failed to start JSONL writer for {log_name} log",
            )
            return
        else:
            sequence = _accepted_by_path.get(log_path, 0) + 1
            item = _WriteItem(
                log_path=log_path,
                line=line,
                log_name=log_name,
                sequence=sequence,
            )
            _queue.put_nowait(item)
            _accepted_by_path[log_path] = sequence
            _pending_bytes += line_size
            _queued_writes += 1

    if dropped:
        _warn_drop_once(log_name)


def flush_log_path(log_path: str, *, timeout: float | None = None) -> bool:
    """Wait until writes accepted so far for ``log_path`` have been processed.

    Processing includes append attempts that fail. Those failures are reported
    through addon process events and do not affect the return value. Return
    ``False`` only when a configured timeout expires with accepted writes still
    pending; ``True`` does not confirm that every line was persisted.
    """
    if not log_path:
        return True

    with _condition:
        target = _accepted_by_path.get(log_path, 0)
        deadline = None if timeout is None else time.monotonic() + timeout
        _increment_flush_waiter_locked(log_path)
        try:
            while _completed_by_path.get(log_path, 0) < target:
                if deadline is None:
                    _condition.wait()
                    continue

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                _condition.wait(remaining)
            return True
        finally:
            _decrement_flush_waiter_locked(log_path)
            _prune_completed_path_locked(log_path)


def flush_all_logs() -> None:
    """Wait until writes accepted so far for every path have been processed.

    Processing includes append attempts that fail. Those failures are reported
    through addon process events, and returning does not confirm that every line
    was persisted.
    """
    with _condition:
        targets = dict(_accepted_by_path)
        for path in targets:
            _increment_flush_waiter_locked(path)
        try:
            while any(_completed_by_path.get(path, 0) < target for path, target in targets.items()):
                _condition.wait()
        finally:
            for path in targets:
                _decrement_flush_waiter_locked(path)
            for path in targets:
                _prune_completed_path_locked(path)


def shutdown_writer(*, timeout: float | None = SHUTDOWN_JOIN_TIMEOUT_SECONDS) -> bool:
    """Stop accepting entries and wait for the writer to process accepted entries.

    When another thread owns the writer, the default wait is
    ``SHUTDOWN_JOIN_TIMEOUT_SECONDS`` (one second), while ``timeout=None`` waits
    without a deadline. Return ``False`` only when that writer remains alive
    after the deadline. In that case, accepted entries may still be pending,
    and the worker and stop-signal state remain registered so a later call can
    wait for the same shutdown. Return ``True`` otherwise.
    """
    global _worker, _shutdown, _stop_enqueued

    with _condition:
        worker = _worker
        if worker is None:
            _shutdown = True
            return True
        _shutdown = True
        should_signal_stop = not _stop_enqueued
        if should_signal_stop:
            _queue.put_nowait(_STOP)
            _stop_enqueued = True

    if worker is not threading.current_thread():
        worker.join(timeout=timeout)
        if worker.is_alive():
            _warn("JSONL writer shutdown timed out")
            return False

    with _condition:
        if _worker is worker:
            _worker = None
            _stop_enqueued = False
        _condition.notify_all()
    return True


def reset_for_tests() -> None:
    """Reset writer state between tests."""
    global _queue, _worker, _shutdown, _stop_enqueued, _accepted_by_path, _completed_by_path
    global _flush_waiters_by_path, _pending_bytes, _queued_writes, _drop_warning_logged
    global _last_append_failure_at, _last_append_failure_warning_at

    shutdown_writer(timeout=None)
    with _condition:
        _queue = queue.SimpleQueue()
        _worker = None
        _shutdown = False
        _stop_enqueued = False
        _accepted_by_path = defaultdict(int)
        _completed_by_path = defaultdict(int)
        _flush_waiters_by_path = defaultdict(int)
        _pending_bytes = 0
        _queued_writes = 0
        _drop_warning_logged = False
        _last_append_failure_at = None
        _last_append_failure_warning_at = None
        _condition.notify_all()


def _ensure_worker_locked() -> bool:
    global _worker

    if _worker is not None and _worker.is_alive():
        return True

    worker = threading.Thread(
        target=_run_writer,
        name="jsonl-writer",
        daemon=True,
    )
    try:
        worker.start()
    except RuntimeError:
        return False
    _worker = worker
    return True


def _run_writer() -> None:
    # Each call owns its batch references so they are released before the next wait.
    while _write_next_batch():
        pass


def _write_next_batch() -> bool:
    item = _queue.get()
    if item is _STOP:
        return False

    batch = [item]
    should_stop = False
    while True:
        try:
            next_item = _queue.get_nowait()
        except queue.Empty:
            break
        if next_item is _STOP:
            should_stop = True
            break
        batch.append(next_item)

    _write_batch(batch)
    _complete_batch(batch)
    return not should_stop


def _write_batch(items: list[object]) -> None:
    batches: dict[str, list[_WriteItem]] = {}
    for item in items:
        if isinstance(item, _WriteItem):
            batches.setdefault(item.log_path, []).append(item)

    append_succeeded = False
    append_failed = False
    for log_path, path_items in batches.items():
        if not path_items:
            continue
        try:
            _append_lines(log_path, [item.line for item in path_items])
            append_succeeded = True
        except Exception as exc:
            append_failed = True
            log_name = path_items[0].log_name
            _report_append_failure(log_name, exc)

    if append_succeeded and not append_failed:
        _report_append_recovery()


def _report_append_failure(log_name: str, exc: Exception) -> None:
    global _last_append_failure_at, _last_append_failure_warning_at

    now = time.monotonic()
    _last_append_failure_at = now
    if (
        _last_append_failure_warning_at is not None
        and now - _last_append_failure_warning_at < APPEND_FAILURE_WARNING_INTERVAL_SECONDS
    ):
        return

    _last_append_failure_warning_at = now
    _warn(
        f"Failed to write {log_name} log: {type(exc).__name__}: {exc}",
    )


def _report_append_recovery() -> None:
    global _last_append_failure_at, _last_append_failure_warning_at

    if _last_append_failure_at is None:
        return
    if time.monotonic() - _last_append_failure_at < APPEND_FAILURE_WARNING_INTERVAL_SECONDS:
        return

    _last_append_failure_at = None
    _last_append_failure_warning_at = None
    _warn("JSONL log writes recovered")


def _append_lines(log_path: str, lines: list[bytes]) -> None:
    fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_RDWR, 0o644)
    try:
        if any(lines):
            size = os.fstat(fd).st_size
            if size and os.pread(fd, 1, size - 1) != b"\n":
                # Only append: Rust can also write to the shared network log,
                # so rolling back to an earlier offset could delete its records.
                lines = [b"\n", *lines]

        line_index = 0
        line_offset = 0
        while line_index < len(lines):
            while line_index < len(lines) and not lines[line_index]:
                line_index += 1
            if line_index == len(lines):
                return

            batch_end = min(line_index + MAX_JSONL_IOVECS, len(lines))
            buffers: list[bytes | memoryview] = list(lines[line_index:batch_end])
            if line_offset:
                buffers[0] = memoryview(lines[line_index])[line_offset:]

            written = os.writev(fd, buffers)
            if written == 0:
                raise OSError("write returned 0 bytes")

            while line_index < batch_end:
                remaining = len(lines[line_index]) - line_offset
                if written < remaining:
                    line_offset += written
                    break
                written -= remaining
                line_index += 1
                line_offset = 0
                if written == 0:
                    break
    finally:
        os.close(fd)


def _complete_batch(items: list[object]) -> None:
    global _pending_bytes, _queued_writes

    completed_by_path: dict[str, int] = {}
    completed_bytes = 0
    completed_writes = 0
    for item in items:
        if not isinstance(item, _WriteItem):
            continue
        completed_by_path[item.log_path] = max(
            completed_by_path.get(item.log_path, 0),
            item.sequence,
        )
        completed_bytes += len(item.line)
        completed_writes += 1

    with _condition:
        for log_path, sequence in completed_by_path.items():
            _completed_by_path[log_path] = max(
                _completed_by_path[log_path],
                sequence,
            )
        _pending_bytes = max(0, _pending_bytes - completed_bytes)
        _queued_writes = max(0, _queued_writes - completed_writes)
        for log_path in completed_by_path:
            _prune_completed_path_locked(log_path)
        _condition.notify_all()


def _increment_flush_waiter_locked(log_path: str) -> None:
    _flush_waiters_by_path[log_path] += 1


def _decrement_flush_waiter_locked(log_path: str) -> None:
    current = _flush_waiters_by_path.get(log_path, 0)
    if current <= 1:
        _flush_waiters_by_path.pop(log_path, None)
    else:
        _flush_waiters_by_path[log_path] = current - 1


def _prune_completed_path_locked(log_path: str) -> None:
    if _flush_waiters_by_path.get(log_path, 0) > 0:
        return
    accepted = _accepted_by_path.get(log_path)
    if accepted is not None and _completed_by_path.get(log_path, 0) >= accepted:
        _accepted_by_path.pop(log_path, None)
        _completed_by_path.pop(log_path, None)


def _warn_drop_once(log_name: str) -> None:
    global _drop_warning_logged

    with _condition:
        if _drop_warning_logged:
            return
        _drop_warning_logged = True
    _warn(
        f"Dropping {log_name} log because the JSONL writer backlog is full",
    )


def _warn(message: str) -> None:
    addon_process_logging.emit_addon_process_event(
        "warn",
        message,
    )
