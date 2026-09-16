"""Tests for runner flush request marker contracts."""

import json
import os
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

import runner_flush_request
import usage
from tests.thread_helpers import ThreadUnderTest

_RUNNER_USAGE_STATE_ID = "runner-state"
_DEFAULT_USAGE_FLUSH_REQUEST_ID = "request-1"
_REQUESTED_AT_MS = 1_770_000_000_000


@dataclass(frozen=True)
class RunnerFlushRequestFiles:
    usage_flush_request_path: Path

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


@pytest.fixture
def runner_flush_request_files(tmp_path: Path) -> Iterator[RunnerFlushRequestFiles]:
    files = RunnerFlushRequestFiles(
        usage_flush_request_path=tmp_path / "usage-flush-request",
    )
    usage.set_pending_path(
        str(tmp_path / "usage-pending"),
        usage_state_id=_RUNNER_USAGE_STATE_ID,
    )
    try:
        yield files
    finally:
        usage.set_pending_path("")


class TestRunnerFlushRequest:
    """Tests for the usage flush marker envelope."""

    @pytest.mark.filterwarnings("error::pytest.PytestUnhandledThreadExceptionWarning")
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
        marker_bytes: bytes | None,
    ) -> None:
        marker_path = runner_flush_request_files.usage_flush_request_path
        if marker_bytes is not None:
            assert len(marker_bytes) <= runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES
            marker_path.write_bytes(marker_bytes)

        assert usage.read_usage_flush_request_id() is None

    @pytest.mark.parametrize("file_state", ["symlink", "fifo", "directory", "oversized"])
    def test_flush_request_consumers_reject_unsafe_state_file(
        self,
        runner_flush_request_files: RunnerFlushRequestFiles,
        file_state: str,
    ) -> None:
        marker_path = runner_flush_request_files.usage_flush_request_path

        if file_state == "symlink":
            runner_flush_request_files.write_usage_flush_request()
            target_path = marker_path.with_name(f"{marker_path.name}-target")
            marker_path.replace(target_path)
            marker_path.symlink_to(target_path)
        elif file_state == "fifo":
            os.mkfifo(marker_path)
        elif file_state == "directory":
            marker_path.mkdir()
        else:
            runner_flush_request_files.write_usage_flush_request()
            marker = json.loads(marker_path.read_text())
            marker["padding"] = "x" * runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES
            marker_path.write_text(json.dumps(marker))
            assert marker_path.stat().st_size > runner_flush_request.MAX_RUNNER_FLUSH_REQUEST_BYTES

        def consume_marker() -> None:
            assert usage.read_usage_flush_request_id() is None

        consumer_thread = ThreadUnderTest(target=consume_marker, daemon=True)
        consumer_thread.start()
        consumer_thread.join_and_raise(timeout=1)
