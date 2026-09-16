"""Tests for the asynchronous JSONL writer state machine."""

import threading
from collections.abc import Callable
from unittest.mock import patch

import jsonl_writer
from tests.thread_helpers import ThreadUnderTest


def test_control_prefix_excludes_later_writes_and_survives_path_pruning(tmp_path):
    path = str(tmp_path / "network.jsonl")
    first_started = threading.Event()
    second_started = threading.Event()
    release_first = threading.Event()
    release_second = threading.Event()
    original = jsonl_writer.os.writev

    def writev(fd, buffers):
        if not first_started.is_set():
            first_started.set()
            assert release_first.wait(3)
        else:
            second_started.set()
            assert release_second.wait(3)
        return original(fd, buffers)

    with patch.object(jsonl_writer.os, "writev", side_effect=writev):
        try:
            jsonl_writer.write_jsonl_line(path, b"first\n", "network")
            assert first_started.wait(1)
            boundary = jsonl_writer.capture_flush_boundary(path)
            assert boundary is not None
            assert boundary.pending_count() == 1
            jsonl_writer.write_jsonl_line(path, b"second\n", "network")
            release_first.set()
            assert second_started.wait(1)
            assert boundary.pending_count() == 0
            assert (tmp_path / "network.jsonl").read_bytes() == b"first\n"
            assert not jsonl_writer.flush_log_path(path, timeout=0)
        finally:
            release_first.set()
            release_second.set()
            assert jsonl_writer.flush_log_path(path, timeout=2)
    # Once accounting prunes the quiescent path, the completed ticket remains
    # a stable result, not a lookup into a new path sequence epoch.
    assert boundary.pending_count() == 0
    jsonl_writer.write_jsonl_line(path, b"third\n", "network")
    assert jsonl_writer.flush_log_path(path, timeout=1)
    assert boundary.pending_count() == 0


def test_worker_start_failure_does_not_publish_or_consume_retry_capacity(tmp_path, mitm_ctx):
    log_path = tmp_path / "proxy.jsonl"
    line = b'{"message":"retry"}\n'

    with (
        patch.object(jsonl_writer, "MAX_PENDING_JSONL_WRITES", 1),
        patch.object(jsonl_writer, "MAX_PENDING_JSONL_BYTES", len(line)),
        mitm_ctx() as log,
    ):
        with patch.object(
            jsonl_writer.threading.Thread,
            "start",
            side_effect=RuntimeError("can't start new thread"),
        ):
            jsonl_writer.write_jsonl_line(str(log_path), line, "proxy")

        assert jsonl_writer.flush_log_path(str(log_path), timeout=0)
        assert jsonl_writer._worker is None
        assert not log_path.exists()

        jsonl_writer.write_jsonl_line(str(log_path), line, "proxy")
        assert jsonl_writer.flush_log_path(str(log_path), timeout=1)

        log.warn.assert_called_once_with("Failed to start JSONL writer for proxy log")
        assert log_path.read_bytes() == line


def test_writer_appends_vectored_batch_across_partial_writes(tmp_path, mitm_ctx):
    log_path = str(tmp_path / "network.jsonl")
    gate_started = threading.Event()
    release_gate = threading.Event()
    writev_calls: list[tuple[bytes, ...]] = []
    original_writev = jsonl_writer.os.writev

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        writev_calls.append(tuple(bytes(buffer) for buffer in buffers))
        if not gate_started.is_set():
            gate_started.set()
            release_gate.wait()

        remaining = 3
        limited_buffers: list[memoryview] = []
        for buffer in buffers:
            if not buffer:
                continue
            chunk_size = min(len(buffer), remaining)
            limited_buffers.append(memoryview(buffer)[:chunk_size])
            remaining -= chunk_size
            if remaining == 0:
                break
        return original_writev(fd, limited_buffers)

    with (
        patch.object(jsonl_writer, "MAX_JSONL_IOVECS", 2),
        patch.object(jsonl_writer.os, "writev", side_effect=writev),
        mitm_ctx() as log,
    ):
        try:
            jsonl_writer.write_jsonl_line(log_path, b"gate\n", "network")
            assert gate_started.wait(timeout=1)

            jsonl_writer.write_jsonl_line(log_path, b"first\n", "network")
            jsonl_writer.write_jsonl_line(log_path, b"", "network")
            jsonl_writer.write_jsonl_line(log_path, b"second\n", "network")
            jsonl_writer.write_jsonl_line(log_path, b"third\n", "network")
        finally:
            release_gate.set()

        assert jsonl_writer.flush_log_path(log_path, timeout=1)

    assert (tmp_path / "network.jsonl").read_bytes() == b"gate\nfirst\nsecond\nthird\n"
    assert all(len(buffers) <= 2 for buffers in writev_calls)
    assert any(len(buffers) == 2 and all(buffers) for buffers in writev_calls)
    log.warn.assert_not_called()


def test_writer_warns_and_retires_batch_when_writev_returns_zero(tmp_path, mitm_ctx):
    log_path = str(tmp_path / "network.jsonl")

    with (
        patch.object(jsonl_writer.os, "writev", return_value=0),
        mitm_ctx() as log,
    ):
        jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
        assert jsonl_writer.flush_log_path(log_path, timeout=1)

    log.warn.assert_called_once_with("Failed to write network log: OSError: write returned 0 bytes")
    assert (tmp_path / "network.jsonl").read_bytes() == b""


def test_writer_rate_limits_append_failures_until_stable_recovery(tmp_path, mitm_ctx):
    missing_dir = tmp_path / "missing"
    failing_path = missing_dir / "network.jsonl"
    first_failing_path = tmp_path / "missing-0" / "network.jsonl"
    healthy_path = tmp_path / "healthy.jsonl"
    now = 0.0

    def monotonic() -> float:
        return now

    def write_and_flush(path: str, line: bytes) -> None:
        jsonl_writer.write_jsonl_line(path, line, "network")
        assert jsonl_writer.flush_log_path(path)

    with (
        patch.object(jsonl_writer.time, "monotonic", side_effect=monotonic),
        mitm_ctx() as log,
    ):
        for index in range(1000):
            path = tmp_path / f"missing-{index}" / "network.jsonl"
            write_and_flush(str(path), b"{}\n")

        assert log.warn.call_count == 1

        now = 59.0
        write_and_flush(str(healthy_path), b"healthy-before-interval\n")
        assert log.warn.call_count == 1

        now = 60.0
        write_and_flush(str(failing_path), b"{}\n")
        assert log.warn.call_count == 2

        now = 119.0
        write_and_flush(str(healthy_path), b"healthy-before-recovery\n")
        assert log.warn.call_count == 2

        missing_dir.mkdir()
        now = 120.0
        write_and_flush(str(failing_path), b"recovered\n")
        assert failing_path.read_bytes() == b"recovered\n"
        assert log.warn.call_args_list[2].args == ("JSONL log writes recovered",)

        failing_path.unlink()
        missing_dir.rmdir()
        write_and_flush(str(failing_path), b"{}\n")

    assert log.warn.call_count == 4
    for warning_index, expected_path in (
        (0, first_failing_path),
        (1, failing_path),
        (3, failing_path),
    ):
        warning = log.warn.call_args_list[warning_index].args[0]
        assert warning.startswith("Failed to write network log: FileNotFoundError: ")
        assert str(expected_path) in warning
    assert healthy_path.read_bytes() == b"healthy-before-interval\nhealthy-before-recovery\n"
    assert jsonl_writer._pending_bytes == 0
    assert jsonl_writer._queued_writes == 0
    assert not jsonl_writer._accepted_by_path
    assert not jsonl_writer._completed_by_path
    assert not jsonl_writer._flush_waiters_by_path


def test_writer_does_not_recover_from_mixed_path_batch(tmp_path, mitm_ctx):
    initial_failure_path = tmp_path / "initial-missing" / "network.jsonl"
    gate_path = tmp_path / "gate.jsonl"
    healthy_path = tmp_path / "healthy.jsonl"
    mixed_failure_path = tmp_path / "mixed-missing" / "network.jsonl"
    gate_started = threading.Event()
    release_gate = threading.Event()
    mixed_batch_started = threading.Event()
    release_mixed_batch = threading.Event()
    original_writev = jsonl_writer.os.writev
    writev_calls = 0
    now = 0.0

    def monotonic() -> float:
        return now

    def write_and_flush(path: str, line: bytes) -> None:
        jsonl_writer.write_jsonl_line(path, line, "network")
        assert jsonl_writer.flush_log_path(path)

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        nonlocal writev_calls

        writev_calls += 1
        if writev_calls == 1:
            gate_started.set()
            release_gate.wait()
        elif writev_calls == 2:
            mixed_batch_started.set()
            release_mixed_batch.wait()
        return original_writev(fd, buffers)

    with (
        patch.object(jsonl_writer.time, "monotonic", side_effect=monotonic),
        mitm_ctx() as log,
    ):
        write_and_flush(str(initial_failure_path), b"{}\n")
        assert log.warn.call_count == 1

        now = 59.0
        with patch.object(jsonl_writer.os, "writev", side_effect=writev):
            try:
                jsonl_writer.write_jsonl_line(str(gate_path), b"gate\n", "network")
                assert gate_started.wait(timeout=1)

                jsonl_writer.write_jsonl_line(str(healthy_path), b"healthy\n", "network")
                jsonl_writer.write_jsonl_line(str(mixed_failure_path), b"{}\n", "network")
                release_gate.set()
                assert mixed_batch_started.wait(timeout=1)

                now = 60.0
                release_mixed_batch.set()
                assert jsonl_writer.flush_log_path(str(healthy_path))
                assert jsonl_writer.flush_log_path(str(mixed_failure_path))
            finally:
                release_gate.set()
                release_mixed_batch.set()

        assert gate_path.read_bytes() == b"gate\n"
        assert healthy_path.read_bytes() == b"healthy\n"
        assert log.warn.call_count == 2
        mixed_failure_warning = log.warn.call_args_list[1].args[0]
        assert mixed_failure_warning.startswith("Failed to write network log: FileNotFoundError: ")
        assert str(mixed_failure_path) in mixed_failure_warning

        now = 120.0
        write_and_flush(str(healthy_path), b"recovered\n")
        assert log.warn.call_args_list[2].args == ("JSONL log writes recovered",)


def test_writer_publishes_backlog_completion_once_per_batch(tmp_path):
    class ObservedCondition:
        def __init__(self) -> None:
            self._condition = threading.Condition()
            self.acquisitions = 0
            self.notifications = 0
            self.accepted_by_path: dict[str, int] = {}
            self.completed_by_path: dict[str, int] = {}
            self.flush_waiters_by_path: dict[str, int] = {}
            self.pending_bytes = 0
            self.queued_writes = 0

        def __enter__(self) -> "ObservedCondition":
            self.acquisitions += 1
            self._condition.acquire()
            return self

        def __exit__(self, *_args: object) -> None:
            self._condition.release()

        def wait(self, timeout: float | None = None) -> bool:
            return self._condition.wait(timeout)

        def wait_for(
            self,
            predicate: Callable[[], bool],
            timeout: float | None = None,
        ) -> bool:
            return self._condition.wait_for(predicate, timeout)

        def reset_observations(self) -> None:
            with self._condition:
                self.acquisitions = 0
                self.notifications = 0
                self.accepted_by_path = {}
                self.completed_by_path = {}
                self.flush_waiters_by_path = {}
                self.pending_bytes = 0
                self.queued_writes = 0

        def notify_all(self) -> None:
            self.notifications += 1
            self.accepted_by_path = dict(jsonl_writer._accepted_by_path)
            self.completed_by_path = dict(jsonl_writer._completed_by_path)
            self.flush_waiters_by_path = dict(jsonl_writer._flush_waiters_by_path)
            self.pending_bytes = jsonl_writer._pending_bytes
            self.queued_writes = jsonl_writer._queued_writes
            self._condition.notify_all()

    gate_path = str(tmp_path / "gate.jsonl")
    pruned_path = str(tmp_path / "pruned.jsonl")
    waiter_path = str(tmp_path / "waiter.jsonl")
    later_write_path = str(tmp_path / "later.jsonl")
    gate_started = threading.Event()
    release_gate = threading.Event()
    target_batch_started = threading.Event()
    release_target_batch = threading.Event()
    later_batch_started = threading.Event()
    release_later_batch = threading.Event()
    condition = ObservedCondition()
    waiter_thread: ThreadUnderTest | None = None
    later_line = b"later-2\n"
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, lines: list[bytes]) -> None:
        if path == gate_path:
            gate_started.set()
            release_gate.wait()
        elif path == pruned_path:
            target_batch_started.set()
            release_target_batch.wait()
        elif path == later_write_path and lines == [later_line]:
            later_batch_started.set()
            release_later_batch.wait()
        original_append_lines(path, lines)

    def flush_waiter_path() -> None:
        assert jsonl_writer.flush_log_path(waiter_path)

    with (
        patch.object(jsonl_writer, "_condition", condition),
        patch.object(jsonl_writer, "_append_lines", side_effect=append_lines),
    ):
        try:
            jsonl_writer.write_jsonl_line(gate_path, b"gate\n", "proxy")
            assert gate_started.wait(timeout=1)

            jsonl_writer.write_jsonl_line(pruned_path, b"pruned-1\n", "proxy")
            jsonl_writer.write_jsonl_line(pruned_path, b"pruned-2\n", "proxy")
            jsonl_writer.write_jsonl_line(waiter_path, b"waiter-1\n", "proxy")
            jsonl_writer.write_jsonl_line(waiter_path, b"waiter-2\n", "proxy")
            jsonl_writer.write_jsonl_line(later_write_path, b"later-1\n", "proxy")

            waiter_thread = ThreadUnderTest(target=flush_waiter_path, daemon=True)
            waiter_thread.start()
            with condition:
                waiter_registered = condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(waiter_path, 0) == 1,
                    timeout=1,
                )
            if not waiter_registered:
                waiter_thread.raise_if_failed()
            assert waiter_registered

            release_gate.set()
            assert target_batch_started.wait(timeout=1)

            jsonl_writer.write_jsonl_line(later_write_path, later_line, "proxy")
            condition.reset_observations()
            release_target_batch.set()
            assert later_batch_started.wait(timeout=1)

            assert condition.acquisitions == 1
            assert condition.notifications == 1
            assert pruned_path not in condition.accepted_by_path
            assert pruned_path not in condition.completed_by_path
            assert condition.accepted_by_path[waiter_path] == 2
            assert condition.completed_by_path[waiter_path] == 2
            assert condition.flush_waiters_by_path[waiter_path] == 1
            assert condition.accepted_by_path[later_write_path] == 2
            assert condition.completed_by_path[later_write_path] == 1
            assert condition.pending_bytes == len(later_line)
            assert condition.queued_writes == 1

            release_later_batch.set()
            waiter_thread.join_and_raise(timeout=1)
            jsonl_writer.flush_all_logs()

            assert (tmp_path / "pruned.jsonl").read_bytes() == b"pruned-1\npruned-2\n"
            assert (tmp_path / "waiter.jsonl").read_bytes() == b"waiter-1\nwaiter-2\n"
            assert (tmp_path / "later.jsonl").read_bytes() == b"later-1\nlater-2\n"
        finally:
            release_gate.set()
            release_target_batch.set()
            release_later_batch.set()
            if waiter_thread is not None:
                waiter_thread.join(timeout=1)
            jsonl_writer.shutdown_writer(timeout=None)


def test_completed_write_prunes_path_state_without_explicit_flush(tmp_path):
    log_path = str(tmp_path / "proxy.jsonl")

    def path_state_pruned() -> bool:
        return log_path not in jsonl_writer._accepted_by_path and jsonl_writer._pending_bytes == 0

    jsonl_writer.write_jsonl_line(log_path, b'{"message":"done"}\n', "proxy")
    with jsonl_writer._condition:
        assert jsonl_writer._condition.wait_for(path_state_pruned, timeout=1)

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0
    assert (tmp_path / "proxy.jsonl").read_bytes().splitlines()


def test_flush_prunes_completed_path_state(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    append_started = threading.Event()
    release_append = threading.Event()
    flush_thread: ThreadUnderTest | None = None
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, lines: list[bytes]) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, lines)

    def flush_log_path() -> None:
        jsonl_writer.flush_log_path(log_path)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            flush_thread = ThreadUnderTest(
                target=flush_log_path,
                daemon=True,
            )
            flush_thread.start()

            with jsonl_writer._condition:
                flush_waiter_registered = jsonl_writer._condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 1,
                    timeout=1,
                )
            if not flush_waiter_registered:
                flush_thread.raise_if_failed()
            assert flush_waiter_registered
        finally:
            release_append.set()
            if flush_thread is not None:
                flush_thread.join(timeout=1)

    assert flush_thread is not None
    flush_thread.join_and_raise(timeout=0)
    assert not flush_thread.is_alive()

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0


def test_out_of_order_concurrent_flushes_prune_after_final_waiter(tmp_path):
    class DelayedWaitCondition:
        def __init__(self, delayed_thread_name: str) -> None:
            self._condition = threading.Condition()
            self._delayed_thread_name = delayed_thread_name
            self.delayed_waiter_woke = threading.Event()
            self.release_delayed_waiter = threading.Event()

        def __enter__(self) -> "DelayedWaitCondition":
            self._condition.acquire()
            return self

        def __exit__(self, *_args: object) -> None:
            self._condition.release()

        def wait(self, timeout: float | None = None) -> bool:
            notified = self._condition.wait(timeout)
            if threading.current_thread().name == self._delayed_thread_name:
                self.delayed_waiter_woke.set()
                self._condition.release()
                try:
                    self.release_delayed_waiter.wait()
                finally:
                    self._condition.acquire()
            return notified

        def wait_for(
            self,
            predicate: Callable[[], bool],
            timeout: float | None = None,
        ) -> bool:
            return self._condition.wait_for(predicate, timeout)

        def notify_all(self) -> None:
            self._condition.notify_all()

    gate_path = str(tmp_path / "gate.jsonl")
    log_path = str(tmp_path / "net.jsonl")
    gate_write_started = threading.Event()
    release_gate_write = threading.Event()
    condition = DelayedWaitCondition("target-1-flush")
    flush_threads: list[ThreadUnderTest] = []
    original_writev = jsonl_writer.os.writev

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        if not gate_write_started.is_set():
            gate_write_started.set()
            release_gate_write.wait()
        return original_writev(fd, buffers)

    def flush_log_path() -> None:
        assert jsonl_writer.flush_log_path(log_path)

    with (
        patch.object(jsonl_writer, "_condition", condition),
        patch.object(jsonl_writer.os, "writev", side_effect=writev),
    ):
        try:
            jsonl_writer.write_jsonl_line(gate_path, b"gate\n", "network")
            assert gate_write_started.wait(timeout=1)

            jsonl_writer.write_jsonl_line(log_path, b"first\n", "network")
            first_flush = ThreadUnderTest(
                target=flush_log_path,
                name="target-1-flush",
                daemon=True,
            )
            flush_threads.append(first_flush)
            first_flush.start()

            with condition:
                first_waiter_registered = condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 1,
                    timeout=1,
                )
            if not first_waiter_registered:
                first_flush.raise_if_failed()
            assert first_waiter_registered

            jsonl_writer.write_jsonl_line(log_path, b"second\n", "network")
            second_flush = ThreadUnderTest(
                target=flush_log_path,
                name="target-2-flush",
                daemon=True,
            )
            flush_threads.append(second_flush)
            second_flush.start()

            with condition:
                flush_waiters_registered = condition.wait_for(
                    lambda: jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 2,
                    timeout=1,
                )
            if not flush_waiters_registered:
                for thread in flush_threads:
                    thread.raise_if_failed()
            assert flush_waiters_registered

            release_gate_write.set()
            assert condition.delayed_waiter_woke.wait(timeout=1)

            second_flush.join_and_raise(timeout=1)
            assert first_flush.is_alive()
            with condition:
                assert jsonl_writer._accepted_by_path[log_path] == 2
                assert jsonl_writer._completed_by_path[log_path] == 2
                assert jsonl_writer._flush_waiters_by_path[log_path] == 1

            condition.release_delayed_waiter.set()
            first_flush.join_and_raise(timeout=1)
        finally:
            release_gate_write.set()
            condition.release_delayed_waiter.set()
            for thread in flush_threads:
                thread.join(timeout=1)

    for thread in flush_threads:
        thread.join_and_raise(timeout=0)
        assert not thread.is_alive()

    assert log_path not in jsonl_writer._accepted_by_path
    assert log_path not in jsonl_writer._completed_by_path
    assert log_path not in jsonl_writer._flush_waiters_by_path
    assert jsonl_writer._pending_bytes == 0
    assert jsonl_writer._queued_writes == 0
    assert (tmp_path / "net.jsonl").read_bytes() == b"first\nsecond\n"


def test_shutdown_writer_returns_when_normal_write_backlog_is_full(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    line = b'{"action":"ALLOW"}\n'
    append_started = threading.Event()
    release_append = threading.Event()
    shutdown_thread: ThreadUnderTest | None = None
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, lines: list[bytes]) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, lines)

    def shutdown_writer() -> None:
        jsonl_writer.shutdown_writer(timeout=0.01)

    with (
        patch.object(jsonl_writer, "_append_lines", side_effect=append_lines),
    ):
        try:
            jsonl_writer.write_jsonl_line(log_path, line, "network")
            assert append_started.wait(timeout=1)

            for _ in range(jsonl_writer.MAX_PENDING_JSONL_WRITES):
                jsonl_writer.write_jsonl_line(log_path, line, "network")

            assert jsonl_writer._accepted_by_path[log_path] == jsonl_writer.MAX_PENDING_JSONL_WRITES
            assert jsonl_writer._queued_writes == jsonl_writer.MAX_PENDING_JSONL_WRITES
            assert jsonl_writer._pending_bytes == jsonl_writer.MAX_PENDING_JSONL_WRITES * len(line)

            shutdown_thread = ThreadUnderTest(
                target=shutdown_writer,
                daemon=True,
            )
            shutdown_thread.start()
            shutdown_thread.join(timeout=0.5)
            shutdown_thread.raise_if_failed()
            assert not shutdown_thread.is_alive()
        finally:
            release_append.set()
            if shutdown_thread is not None:
                shutdown_thread.join(timeout=2)
            jsonl_writer.reset_for_tests()

    assert len((tmp_path / "net.jsonl").read_bytes().splitlines()) == (
        jsonl_writer.MAX_PENDING_JSONL_WRITES
    )


def test_shutdown_writer_timeout_preserves_state_for_retry(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    accepted_line = b'{"action":"ALLOW"}\n'
    rejected_line = b'{"action":"BLOCK"}\n'
    append_started = threading.Event()
    release_append = threading.Event()
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, lines: list[bytes]) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, lines)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, accepted_line, "network")
            assert append_started.wait(timeout=1)

            worker = jsonl_writer._worker
            assert worker is not None
            assert worker.is_alive()

            assert jsonl_writer.shutdown_writer(timeout=0) is False
            assert jsonl_writer._worker is worker
            assert worker.is_alive()
            assert jsonl_writer._stop_enqueued

            jsonl_writer.write_jsonl_line(log_path, rejected_line, "network")
        finally:
            release_append.set()

        assert jsonl_writer.shutdown_writer(timeout=None) is True

    assert jsonl_writer._worker is None
    assert not jsonl_writer._stop_enqueued
    assert (tmp_path / "net.jsonl").read_bytes() == accepted_line


def test_flush_log_path_timeout_returns_false_and_cleans_waiter(tmp_path):
    log_path = str(tmp_path / "net.jsonl")
    append_started = threading.Event()
    release_append = threading.Event()
    original_append_lines = jsonl_writer._append_lines

    def append_lines(path: str, lines: list[bytes]) -> None:
        append_started.set()
        release_append.wait()
        original_append_lines(path, lines)

    with patch.object(jsonl_writer, "_append_lines", side_effect=append_lines):
        try:
            jsonl_writer.write_jsonl_line(log_path, b'{"action":"ALLOW"}\n', "network")
            assert append_started.wait(timeout=1)

            assert jsonl_writer.flush_log_path(log_path, timeout=0.01) is False
            assert jsonl_writer._flush_waiters_by_path.get(log_path, 0) == 0
            assert jsonl_writer._completed_by_path.get(log_path, 0) == 0
        finally:
            release_append.set()
            jsonl_writer.reset_for_tests()
