"""Tests for runner flush request marker contracts."""

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import pytest

import logging_utils
import runner_flush_lifecycle
import runner_flush_request
import usage
from tests.thread_helpers import ThreadUnderTest

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_USAGE_FLUSH_REQUEST_ID = "request-1"
_DEFAULT_JSONL_FLUSH_REQUEST_ID = "jsonl-request-1"
_REQUESTED_AT_MS = 1_770_000_000_000


@dataclass(frozen=True)
class RunnerFlushRequestFiles:
    usage_flush_request_path: Path
    jsonl_flush_request_path: Path
    jsonl_flush_state_path: Path
    network_log_path: Path
    lifecycle_file: Path

    def write_usage_flush_request(self) -> None:
        self.usage_flush_request_path.write_text(
            json.dumps(
                {
                    "usageStateId": _RUNNER_USAGE_STATE_ID,
                    "flushRequestId": _DEFAULT_USAGE_FLUSH_REQUEST_ID,
                    "requestedAtMs": _REQUESTED_AT_MS,
                }
            )
        )

    def write_jsonl_flush_request(self) -> None:
        self.jsonl_flush_request_path.write_text(
            json.dumps(
                {
                    "usageStateId": _RUNNER_USAGE_STATE_ID,
                    "flushRequestId": _DEFAULT_JSONL_FLUSH_REQUEST_ID,
                    "requestedAtMs": _REQUESTED_AT_MS,
                    "path": str(self.network_log_path),
                }
            )
        )


@pytest.fixture
def runner_flush_request_files(tmp_path: Path) -> Iterator[RunnerFlushRequestFiles]:
    files = RunnerFlushRequestFiles(
        usage_flush_request_path=tmp_path / "usage-flush-request",
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


@contextmanager
def running_jsonl_flush_worker(files: RunnerFlushRequestFiles) -> Iterator[None]:
    with patch.object(runner_flush_lifecycle, "__file__", str(files.lifecycle_file)):
        runner_flush_lifecycle.start_runner_jsonl_flush_worker()
        try:
            yield
        finally:
            runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()


class TestRunnerFlushRequest:
    """Tests for the marker envelope shared by runner flush consumers."""

    @pytest.mark.filterwarnings("error::pytest.PytestUnhandledThreadExceptionWarning")
    @pytest.mark.parametrize("consumer", ["usage", "jsonl"])
    @pytest.mark.parametrize(
        "marker_bytes",
        [
            pytest.param(None, id="missing"),
            pytest.param(b"\xff", id="invalid-utf8"),
            pytest.param(b"not-json", id="invalid-json"),
            pytest.param(
                b'{"requestedAtMs":' + b"1" * 5000 + b"}",
                id="overlong-integer",
            ),
            pytest.param(b"[]", id="non-object"),
            pytest.param(
                json.dumps(
                    {
                        "usageStateId": "previous-runner-state",
                        "flushRequestId": "request-1",
                    }
                ).encode(),
                id="stale-generation",
            ),
            pytest.param(
                json.dumps({"usageStateId": _RUNNER_USAGE_STATE_ID}).encode(),
                id="missing-request-id",
            ),
            pytest.param(
                json.dumps(
                    {
                        "usageStateId": _RUNNER_USAGE_STATE_ID,
                        "flushRequestId": "",
                    }
                ).encode(),
                id="empty-request-id",
            ),
            pytest.param(
                json.dumps(
                    {
                        "usageStateId": _RUNNER_USAGE_STATE_ID,
                        "flushRequestId": 123,
                    }
                ).encode(),
                id="non-string-request-id",
            ),
        ],
    )
    def test_flush_request_consumers_ignore_malformed_envelope(
        self,
        runner_flush_request_files: RunnerFlushRequestFiles,
        consumer: str,
        marker_bytes: bytes | None,
    ) -> None:
        marker_path = (
            runner_flush_request_files.usage_flush_request_path
            if consumer == "usage"
            else runner_flush_request_files.jsonl_flush_request_path
        )
        if marker_bytes is not None:
            assert len(marker_bytes) <= runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES
            marker_path.write_bytes(marker_bytes)

        if consumer == "usage":
            assert usage.read_usage_flush_request_id() is None
            return

        with (
            patch.object(logging_utils, "flush_log_path") as flush_log_path,
            running_jsonl_flush_worker(runner_flush_request_files),
        ):
            pass

        flush_log_path.assert_not_called()
        assert not runner_flush_request_files.jsonl_flush_state_path.exists()

    @pytest.mark.parametrize("consumer", ["usage", "jsonl"])
    @pytest.mark.parametrize("file_state", ["symlink", "fifo", "directory", "oversized"])
    def test_flush_request_consumers_reject_unsafe_state_file(
        self,
        runner_flush_request_files: RunnerFlushRequestFiles,
        consumer: str,
        file_state: str,
    ) -> None:
        marker_path = (
            runner_flush_request_files.usage_flush_request_path
            if consumer == "usage"
            else runner_flush_request_files.jsonl_flush_request_path
        )

        def write_valid_marker() -> None:
            if consumer == "usage":
                runner_flush_request_files.write_usage_flush_request()
            else:
                runner_flush_request_files.write_jsonl_flush_request()

        if file_state == "symlink":
            write_valid_marker()
            target_path = marker_path.with_name(f"{marker_path.name}-target")
            marker_path.replace(target_path)
            marker_path.symlink_to(target_path)
        elif file_state == "fifo":
            os.mkfifo(marker_path)
        elif file_state == "directory":
            marker_path.mkdir()
        else:
            write_valid_marker()
            marker = json.loads(marker_path.read_text())
            marker["padding"] = "x" * runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES
            marker_path.write_text(json.dumps(marker))
            assert marker_path.stat().st_size > runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES

        def consume_marker() -> None:
            if consumer == "usage":
                assert usage.read_usage_flush_request_id() is None
                return

            runner_flush_lifecycle._flush_jsonl_for_runner_request(
                runner_flush_request_files.jsonl_flush_request_path,
                runner_flush_request_files.jsonl_flush_state_path,
            )

            assert not runner_flush_request_files.jsonl_flush_state_path.exists()

        consumer_thread = ThreadUnderTest(target=consume_marker, daemon=True)
        consumer_thread.start()
        consumer_thread.join_and_raise(timeout=1)
