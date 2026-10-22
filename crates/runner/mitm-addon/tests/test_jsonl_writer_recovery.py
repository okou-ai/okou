"""Recovery framing through the production JSONL logging entry point."""

import errno
import json
import threading
from pathlib import Path
from unittest.mock import patch

import pytest

import jsonl_writer
import logging_utils


def _write_and_flush(path: Path, record_id: str) -> None:
    logging_utils.log_network_entry(str(path), {"id": record_id})
    assert logging_utils.flush_log_path(str(path), timeout=2)


def _record_ids(path: Path) -> list[str]:
    # The Runner uploader skips malformed physical lines independently.
    records = []
    for line in path.read_bytes().splitlines():
        try:
            records.append(json.loads(line)["id"])
        except json.JSONDecodeError, UnicodeDecodeError:
            continue
    return records


def _assert_drained() -> None:
    assert jsonl_writer._pending_bytes == 0
    assert jsonl_writer._queued_writes == 0
    assert not jsonl_writer._accepted_by_path
    assert not jsonl_writer._completed_by_path
    assert not jsonl_writer._flush_waiters_by_path


@pytest.mark.parametrize("failure_errno", [errno.ENOSPC, errno.EIO, None])
@pytest.mark.parametrize("failure_position", ["first-record", "record-boundary", "second-record"])
def test_partial_batch_failure_preserves_recovered_records(
    tmp_path, mitm_ctx, failure_errno, failure_position
):
    path = tmp_path / "network.jsonl"
    gate_started = threading.Event()
    release_gate = threading.Event()
    original_writev = jsonl_writer.os.writev
    calls = 0

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            gate_started.set()
            release_gate.wait()
            return original_writev(fd, buffers)
        if calls == 2:
            complete_count = 0 if failure_position == "first-record" else 1
            partial_buffers = list(buffers[:complete_count])
            if failure_position != "record-boundary":
                partial_buffers.append(memoryview(buffers[complete_count])[:7])
            return original_writev(fd, partial_buffers)
        if failure_errno is None:
            return 0
        raise OSError(failure_errno, "injected after partial progress")

    with patch.object(jsonl_writer.os, "writev", side_effect=writev), mitm_ctx() as log:
        try:
            logging_utils.log_network_entry(str(path), {"id": "before"})
            assert gate_started.wait(timeout=2)
            for record_id in ("complete", "failed", "unattempted"):
                logging_utils.log_network_entry(str(path), {"id": record_id})
        finally:
            release_gate.set()

        assert logging_utils.flush_log_path(str(path), timeout=2)

    assert calls == 3
    log.warn.assert_called_once()
    _assert_drained()
    failed_bytes = path.read_bytes()
    expected = ["before"]
    if failure_position != "first-record":
        expected.append("complete")
    assert _record_ids(path) == expected

    _write_and_flush(path, "recovered")
    _write_and_flush(path, "later")

    assert path.read_bytes().startswith(failed_bytes)
    assert b"\n\n" not in path.read_bytes()
    assert _record_ids(path) == [*expected, "recovered", "later"]
    _assert_drained()
    assert jsonl_writer.shutdown_writer(timeout=2)
    assert jsonl_writer._worker is None


@pytest.mark.parametrize("failure_errno", [errno.ENOSPC, errno.EIO, None])
def test_repeated_recovery_failure_after_restart_keeps_new_records_out_of_partial_tail(
    tmp_path, mitm_ctx, failure_errno
):
    path = tmp_path / "network.jsonl"
    _write_and_flush(path, "before")
    # A prior process can leave a partial tail without any in-memory writer state.
    with path.open("ab") as file:
        file.write(b'{"id":')
    jsonl_writer.reset_for_tests()
    failed_bytes = path.read_bytes()

    def writev(_fd: int, _buffers: list[bytes | memoryview]) -> int:
        if failure_errno is None:
            return 0
        raise OSError(failure_errno, "injected during recovery")

    with patch.object(jsonl_writer.os, "writev", side_effect=writev), mitm_ctx() as log:
        _write_and_flush(path, "failed-retry-1")
        _write_and_flush(path, "failed-retry-2")

    log.warn.assert_called_once()
    assert path.read_bytes() == failed_bytes
    _assert_drained()

    _write_and_flush(path, "recovered")
    assert path.read_bytes().startswith(failed_bytes + b"\n")
    assert _record_ids(path) == ["before", "recovered"]
    _assert_drained()
    assert jsonl_writer.shutdown_writer(timeout=2)


def test_written_separator_survives_subsequent_payload_failure(tmp_path, mitm_ctx):
    path = tmp_path / "network.jsonl"
    _write_and_flush(path, "before")
    with path.open("ab") as file:
        file.write(b'{"id":')
    failed_bytes = path.read_bytes()
    original_writev = jsonl_writer.os.writev
    calls = 0

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            return original_writev(fd, buffers)
        raise OSError(errno.EIO, "injected after the separator")

    with (
        patch.object(jsonl_writer, "MAX_JSONL_IOVECS", 1),
        patch.object(jsonl_writer.os, "writev", side_effect=writev),
        mitm_ctx() as log,
    ):
        _write_and_flush(path, "failed-retry")

    assert calls == 2
    log.warn.assert_called_once()
    assert path.read_bytes() == failed_bytes + b"\n"
    _assert_drained()

    _write_and_flush(path, "recovered")
    assert b"\n\n" not in path.read_bytes()
    assert _record_ids(path) == ["before", "recovered"]
    assert jsonl_writer.shutdown_writer(timeout=2)


def test_recovery_preserves_complete_records_from_another_appender(tmp_path, mitm_ctx):
    path = tmp_path / "network.jsonl"
    _write_and_flush(path, "before")
    original_writev = jsonl_writer.os.writev
    calls = 0

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            return original_writev(fd, [memoryview(buffers[0])[:7]])
        raise OSError(errno.ENOSPC, "injected after a partial record")

    with patch.object(jsonl_writer.os, "writev", side_effect=writev), mitm_ctx():
        _write_and_flush(path, "failed")

    assert calls == 2
    # Like the Rust producer, an independent descriptor appends complete JSONL.
    # Its first record joins the damaged line; the next record is already intact.
    with path.open("ab") as file:
        file.write(b'{"id":"embedded"}\n{"id":"external"}\n')
    existing_bytes = path.read_bytes()
    assert _record_ids(path) == ["before", "external"]

    _write_and_flush(path, "recovered")

    assert path.read_bytes().startswith(existing_bytes)
    assert b"\n\n" not in path.read_bytes()
    assert _record_ids(path) == ["before", "external", "recovered"]
    _assert_drained()
    assert jsonl_writer.shutdown_writer(timeout=2)


@pytest.mark.parametrize("operation", ["fstat", "pread"])
def test_tail_inspection_failure_retires_batch_without_appending(tmp_path, mitm_ctx, operation):
    path = tmp_path / "network.jsonl"
    _write_and_flush(path, "before")
    existing_bytes = path.read_bytes()
    failed_fds = []

    def fail_inspection(fd: int, *_args):
        failed_fds.append(fd)
        raise OSError(errno.EIO, "injected while inspecting the tail")

    with patch.object(jsonl_writer.os, operation, side_effect=fail_inspection), mitm_ctx() as log:
        _write_and_flush(path, "failed")

    assert len(failed_fds) == 1
    with pytest.raises(OSError, match=rf"\[Errno {errno.EBADF}\]") as error:
        jsonl_writer.os.fstat(failed_fds[0])
    assert error.value.errno == errno.EBADF
    log.warn.assert_called_once()
    assert path.read_bytes() == existing_bytes
    _assert_drained()

    _write_and_flush(path, "recovered")
    assert _record_ids(path) == ["before", "recovered"]
    assert jsonl_writer.shutdown_writer(timeout=2)
