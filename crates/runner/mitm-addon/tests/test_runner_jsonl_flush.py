"""Tests for runner-triggered JSONL flush requests."""

import json
import os
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import pytest

import jsonl_writer
import logging_utils
import runner_flush_lifecycle
import runner_flush_request
import state_file
import usage
from tests.process_log_helpers import capture_addon_process_events

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_JSONL_FLUSH_REQUEST_ID = "jsonl-request-1"
_REQUESTED_AT_MS = 1_770_000_000_000


@dataclass(frozen=True)
class RunnerJsonlFlushFiles:
    tmp_path: Path
    jsonl_flush_request_path: Path
    jsonl_flush_state_path: Path
    network_log_path: Path
    lifecycle_file: Path

    def write_jsonl_flush_request(
        self,
        *,
        flush_request_id: str = _DEFAULT_JSONL_FLUSH_REQUEST_ID,
        log_path: Path | None = None,
    ) -> Path:
        target_log_path = log_path or self.network_log_path
        self.jsonl_flush_request_path.write_text(
            json.dumps(
                {
                    "usageStateId": _RUNNER_USAGE_STATE_ID,
                    "flushRequestId": flush_request_id,
                    "requestedAtMs": _REQUESTED_AT_MS,
                    "path": str(target_log_path),
                }
            )
        )
        return target_log_path


@pytest.fixture
def runner_jsonl_flush_files(tmp_path: Path) -> Iterator[RunnerJsonlFlushFiles]:
    files = RunnerJsonlFlushFiles(
        tmp_path=tmp_path,
        jsonl_flush_request_path=tmp_path / "jsonl-flush-request",
        jsonl_flush_state_path=tmp_path / "jsonl-flush-state",
        network_log_path=tmp_path / "network.jsonl",
        lifecycle_file=tmp_path / "runner_flush_lifecycle.py",
    )
    usage.set_pending_path(
        str(tmp_path / "usage-pending"),
        usage_state_id=_RUNNER_USAGE_STATE_ID,
    )
    try:
        yield files
    finally:
        usage.set_pending_path("")


def wait_for_jsonl_flush_state(
    files: RunnerJsonlFlushFiles,
    *,
    flush_request_id: str = _DEFAULT_JSONL_FLUSH_REQUEST_ID,
    pending: int | None = None,
    timeout: float = 1.0,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while True:
        try:
            state = json.loads(files.jsonl_flush_state_path.read_text())
        except (OSError, json.JSONDecodeError):
            state = None
        if (
            isinstance(state, dict)
            and state.get("flushRequestId") == flush_request_id
            and (pending is None or state.get("pending") == pending)
        ):
            return state

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError(f"JSONL flush state did not acknowledge {flush_request_id}")
        time.sleep(min(0.005, remaining))


@contextmanager
def running_jsonl_flush_worker(files: RunnerJsonlFlushFiles) -> Iterator[None]:
    with patch.object(runner_flush_lifecycle, "__file__", str(files.lifecycle_file)):
        runner_flush_lifecycle.start_runner_jsonl_flush_worker()
    try:
        yield
    finally:
        runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()


class TestRunnerJsonlFlush:
    """Tests for the independently polled JSONL flush protocol."""

    @pytest.mark.filterwarnings("error::pytest.PytestUnhandledThreadExceptionWarning")
    def test_jsonl_watcher_recovers_from_overlong_integer(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ) -> None:
        files = runner_jsonl_flush_files
        digit_count = 5000
        assert 0 < sys.get_int_max_str_digits() < digit_count
        marker_bytes = b'{"requestedAtMs":' + b"1" * digit_count + b"}"
        assert len(marker_bytes) < runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES
        # The typed Rust producer cannot create this corrupt local state file.
        files.jsonl_flush_request_path.write_bytes(marker_bytes)
        malformed_marker_read = threading.Event()
        original_read_bytes = state_file.OpenedStateFile.read_bytes

        def observe_marker_read(opened_file: state_file.OpenedStateFile, max_bytes: int) -> bytes:
            data = original_read_bytes(opened_file, max_bytes)
            if opened_file.path == files.jsonl_flush_request_path and data == marker_bytes:
                # Observe captured bytes without replacing the reader or decoder.
                malformed_marker_read.set()
            return data

        with (
            patch.object(state_file.OpenedStateFile, "read_bytes", new=observe_marker_read),
            patch.object(
                logging_utils, "flush_log_path", wraps=logging_utils.flush_log_path
            ) as flush_log_path,
            capture_addon_process_events(),
            running_jsonl_flush_worker(files),
        ):
            assert malformed_marker_read.wait(timeout=1)
            worker = runner_flush_lifecycle._jsonl_flush_worker
            assert worker is not None
            flush_log_path.assert_not_called()
            assert not files.jsonl_flush_state_path.exists()

            logging_utils.log_network_entry(str(files.network_log_path), {"action": "ALLOW"})
            state_file.AtomicJsonPublisher().publish(
                files.jsonl_flush_request_path,
                {
                    "usageStateId": _RUNNER_USAGE_STATE_ID,
                    "flushRequestId": _DEFAULT_JSONL_FLUSH_REQUEST_ID,
                    "requestedAtMs": _REQUESTED_AT_MS,
                    "path": str(files.network_log_path),
                },
            )
            state = wait_for_jsonl_flush_state(files, pending=0)
            assert runner_flush_lifecycle._jsonl_flush_worker is worker
            assert worker.is_alive()

        flush_log_path.assert_called_once_with(
            str(files.network_log_path),
            timeout=runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS,
        )
        assert state["usageStateId"] == _RUNNER_USAGE_STATE_ID
        assert state["flushRequestId"] == _DEFAULT_JSONL_FLUSH_REQUEST_ID
        assert state["path"] == str(files.network_log_path)
        assert state["pending"] == 0
        assert json.loads(files.network_log_path.read_text())["action"] == "ALLOW"

    def test_jsonl_watcher_acknowledges_request_in_startup_directory(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.network_log_path
        logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})

        with (
            capture_addon_process_events(),
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            runner_jsonl_flush_files.write_jsonl_flush_request()
            state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)

        entry = json.loads(log_path.read_text().strip())
        assert entry["action"] == "ALLOW"
        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 0,
        }

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("flushRequestId", "../jsonl-request-1", id="unsafe-request-id"),
            pytest.param("path", "", id="empty-path"),
            pytest.param("path", 123, id="non-string-path"),
        ],
    )
    def test_jsonl_flush_request_rejects_protocol_specific_fields(
        self,
        runner_jsonl_flush_files: RunnerJsonlFlushFiles,
        field: str,
        value: object,
    ) -> None:
        runner_jsonl_flush_files.write_jsonl_flush_request()
        marker = json.loads(runner_jsonl_flush_files.jsonl_flush_request_path.read_text())
        marker[field] = value
        runner_jsonl_flush_files.jsonl_flush_request_path.write_text(json.dumps(marker))

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            pass

        flush_log_path.assert_not_called()
        assert not runner_jsonl_flush_files.jsonl_flush_state_path.exists()

    def test_jsonl_flush_exception_writes_pending_state(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        with (
            patch.object(logging_utils, "flush_log_path", side_effect=RuntimeError("secret")),
            capture_addon_process_events() as log,
        ):
            runner_flush_lifecycle._flush_jsonl_for_runner_request(
                runner_jsonl_flush_files.jsonl_flush_request_path,
                runner_jsonl_flush_files.jsonl_flush_state_path,
            )

        state = json.loads(runner_jsonl_flush_files.jsonl_flush_state_path.read_text())
        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 1,
        }
        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "RuntimeError" in warning
        assert "secret" not in warning

    def test_jsonl_flush_timeout_writes_pending_state_and_does_not_reprocess_request(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        append_started = threading.Event()
        release_append = threading.Event()
        original_append_lines = jsonl_writer._append_lines

        def append_lines(path: str, lines: list[bytes]) -> None:
            append_started.set()
            release_append.wait()
            original_append_lines(path, lines)

        with (
            patch.object(
                runner_flush_lifecycle, "__file__", str(runner_jsonl_flush_files.lifecycle_file)
            ),
            patch.object(jsonl_writer, "_append_lines", side_effect=append_lines),
            patch.object(
                runner_flush_lifecycle,
                "RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS",
                0.01,
            ),
            patch.object(
                logging_utils,
                "flush_log_path",
                wraps=logging_utils.flush_log_path,
            ) as flush_log_path,
            capture_addon_process_events() as log,
        ):
            try:
                logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
                assert append_started.wait(timeout=1)

                runner_flush_lifecycle.start_runner_jsonl_flush_worker()
                state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)
                runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()
            finally:
                runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()
                release_append.set()
                jsonl_writer.reset_for_tests()

        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 1,
        }
        flush_log_path.assert_called_once_with(str(log_path), timeout=0.01)
        log.warn.assert_called_once_with("JSONL flush did not complete before timeout")

    def test_jsonl_watcher_does_not_reprocess_acknowledged_request(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            capture_addon_process_events(),
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            wait_for_jsonl_flush_state(runner_jsonl_flush_files)

        flush_log_path.assert_called_once_with(
            str(log_path),
            timeout=runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS,
        )

    def test_jsonl_flush_exception_is_retried_by_watcher(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()

        with (
            capture_addon_process_events(),
            patch.object(
                logging_utils,
                "flush_log_path",
                side_effect=(RuntimeError("flush failed"), True),
            ) as flush_log_path,
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            state = wait_for_jsonl_flush_state(runner_jsonl_flush_files, pending=0)

        assert flush_log_path.call_count == 2
        for flush_call in flush_log_path.call_args_list:
            assert flush_call.args == (str(log_path),)
            assert flush_call.kwargs == {
                "timeout": runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS
            }
        assert state["pending"] == 0

    def test_jsonl_flush_acknowledgement_write_failure_is_retryable(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        state_path = runner_jsonl_flush_files.jsonl_flush_state_path
        original_replace = Path.replace
        failed_tmp_paths: list[Path] = []

        def fail_first_state_replace(
            source: Path,
            target: str | os.PathLike[str],
        ) -> Path:
            if Path(target) == state_path and not failed_tmp_paths:
                failed_tmp_paths.append(source)
                raise OSError("state replace failed")
            return original_replace(source, target)

        with (
            patch.object(
                logging_utils,
                "flush_log_path",
                wraps=logging_utils.flush_log_path,
            ) as flush_log_path,
            capture_addon_process_events() as log,
            patch.object(state_file.Path, "replace", new=fail_first_state_replace),
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)

        assert len(failed_tmp_paths) == 1
        assert flush_log_path.call_count == 2
        assert state == {
            "pid": state["pid"],
            "usageStateId": "runner-state",
            "updatedAtMs": state["updatedAtMs"],
            "flushRequestId": "jsonl-request-1",
            "path": str(log_path),
            "pending": 0,
        }
        assert not failed_tmp_paths[0].exists()
        assert list(runner_jsonl_flush_files.tmp_path.glob(f"{state_path.name}.*.tmp")) == []
        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert _DEFAULT_JSONL_FLUSH_REQUEST_ID in warning
        assert "(OSError)" in warning
        assert "Error: state replace failed" in warning
        assert "Subsequent failures for this request will be silent" in warning

    def test_persistent_jsonl_acknowledgement_write_failure_logs_once_per_request(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        state_path = runner_jsonl_flush_files.jsonl_flush_state_path
        log_path = runner_jsonl_flush_files.write_jsonl_flush_request(
            flush_request_id="baseline-request"
        )
        runner_flush_lifecycle._flush_jsonl_for_runner_request(
            runner_jsonl_flush_files.jsonl_flush_request_path,
            state_path,
        )
        baseline_state = state_path.read_text()
        original_replace = Path.replace
        failed_tmp_paths: list[Path] = []

        def fail_state_replace(
            source: Path,
            target: str | os.PathLike[str],
        ) -> Path:
            if Path(target) == state_path:
                failed_tmp_paths.append(source)
                raise OSError("persistent state replace failure")
            return original_replace(source, target)

        runner_jsonl_flush_files.write_jsonl_flush_request(flush_request_id="failed-request-1")
        with (
            patch.object(logging_utils, "flush_log_path", return_value=True) as flush_log_path,
            capture_addon_process_events() as log,
            patch.object(state_file.Path, "replace", new=fail_state_replace),
        ):
            for _ in range(2):
                runner_flush_lifecycle._flush_jsonl_for_runner_request(
                    runner_jsonl_flush_files.jsonl_flush_request_path,
                    state_path,
                )

            runner_jsonl_flush_files.write_jsonl_flush_request(flush_request_id="failed-request-2")
            for _ in range(2):
                runner_flush_lifecycle._flush_jsonl_for_runner_request(
                    runner_jsonl_flush_files.jsonl_flush_request_path,
                    state_path,
                )

        assert flush_log_path.call_count == 4
        assert len(failed_tmp_paths) == 4
        assert len(set(failed_tmp_paths)) == 4
        assert state_path.read_text() == baseline_state
        assert all(not tmp_path.exists() for tmp_path in failed_tmp_paths)
        assert list(runner_jsonl_flush_files.tmp_path.glob(f"{state_path.name}.*.tmp")) == []
        assert log.warn.call_count == 2
        warnings = [call.args[0] for call in log.warn.call_args_list]
        assert "failed-request-1" in warnings[0]
        assert "failed-request-2" in warnings[1]
        assert all("persistent state replace failure" in warning for warning in warnings)
        assert all(
            "Subsequent failures for this request will be silent" in warning for warning in warnings
        )

        runner_jsonl_flush_files.write_jsonl_flush_request(flush_request_id="recovered-request")
        runner_flush_lifecycle._flush_jsonl_for_runner_request(
            runner_jsonl_flush_files.jsonl_flush_request_path,
            state_path,
        )
        recovered_state = json.loads(state_path.read_text())
        assert recovered_state["flushRequestId"] == "recovered-request"
        assert recovered_state["path"] == str(log_path)
        assert recovered_state["pending"] == 0

    def test_jsonl_watcher_acknowledges_rapid_sequential_paths(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        first_path = runner_jsonl_flush_files.write_jsonl_flush_request()
        second_path = runner_jsonl_flush_files.tmp_path / "network-2.jsonl"

        with (
            patch.object(logging_utils, "flush_log_path", return_value=True) as flush_log_path,
            running_jsonl_flush_worker(runner_jsonl_flush_files),
        ):
            first_state = wait_for_jsonl_flush_state(runner_jsonl_flush_files)
            runner_jsonl_flush_files.write_jsonl_flush_request(
                flush_request_id="jsonl-request-2",
                log_path=second_path,
            )
            second_state = wait_for_jsonl_flush_state(
                runner_jsonl_flush_files,
                flush_request_id="jsonl-request-2",
            )

        assert first_state["path"] == str(first_path)
        assert first_state["pending"] == 0
        assert second_state["path"] == str(second_path)
        assert second_state["pending"] == 0
        assert [flush_call.args for flush_call in flush_log_path.call_args_list] == [
            (str(first_path),),
            (str(second_path),),
        ]

    def test_jsonl_watcher_final_observation_processes_published_marker(
        self, runner_jsonl_flush_files: RunnerJsonlFlushFiles
    ):
        with patch.object(
            runner_flush_lifecycle, "__file__", str(runner_jsonl_flush_files.lifecycle_file)
        ):
            runner_flush_lifecycle.start_runner_jsonl_flush_worker()
            log_path = runner_jsonl_flush_files.write_jsonl_flush_request()
            runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()

        state = json.loads(runner_jsonl_flush_files.jsonl_flush_state_path.read_text())
        assert state["flushRequestId"] == _DEFAULT_JSONL_FLUSH_REQUEST_ID
        assert state["path"] == str(log_path)
        assert state["pending"] == 0
