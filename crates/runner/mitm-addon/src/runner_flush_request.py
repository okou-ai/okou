"""Common runner flush request marker envelope parsing."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

import state_file

MAX_RUNNER_FLUSH_REQUEST_BYTES = 64 * 1024


class RunnerFlushRequest(NamedTuple):
    marker: dict[str, object]
    flush_request_id: str


def read_runner_flush_request(
    marker_path: Path,
    *,
    get_usage_state_id: Callable[[], str],
) -> RunnerFlushRequest | None:
    """Read a runner flush request for the expected addon generation."""
    try:
        with state_file.open_state_file(
            marker_path,
            description="runner flush request marker",
        ) as opened_file:
            marker_bytes = opened_file.read_bytes(MAX_RUNNER_FLUSH_REQUEST_BYTES)
    except OSError:
        return None

    try:
        marker: object = json.loads(marker_bytes.decode("utf-8"))
    except ValueError:
        # Includes invalid UTF-8/JSON and the decoder's integer conversion limit.
        return None

    if not isinstance(marker, dict):
        return None
    if marker.get("usageStateId") != get_usage_state_id():
        return None
    flush_request_id = marker.get("flushRequestId")
    if not isinstance(flush_request_id, str) or not flush_request_id:
        return None
    return RunnerFlushRequest(marker=marker, flush_request_id=flush_request_id)
