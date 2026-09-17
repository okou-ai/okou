"""Observe real delivery control replies in usage and lifecycle tests."""

from pathlib import Path
from tempfile import TemporaryDirectory

import runner_control
import runner_flush_lifecycle
from tests.control_helpers import exchange, status_request


def result_data(response: dict[str, object]) -> dict:
    assert response["type"] == "result", response
    data = response["data"]
    assert isinstance(data, dict), response
    return data


def delivery_exchange(method: str, root: Path | None = None) -> dict:
    with TemporaryDirectory(dir=root) as directory:
        server = runner_control.ControlServer(
            Path(directory),
            "generation-1",
            delivery_owner=runner_flush_lifecycle.DeliveryControl(),
        )
        server.start()
        try:
            return exchange(Path(directory), status_request() | {"method": method})
        finally:
            server.stop()


def assert_pending(
    control_root: Path,
    *,
    flows: int,
    buffered: int,
    reports: int,
) -> dict:
    """Read the current pending projection through the private socket.

    Buffered usage counts original source records until delivery callbacks settle;
    retained diagnostics contribute until admission or terminal discard. Zero
    outstanding work is independent of cumulative known delivery outcomes.
    """
    control_root.mkdir(parents=True, exist_ok=True)
    reply = delivery_exchange("delivery.status", control_root)
    state = result_data(reply)
    assert set(state) == {
        "flows",
        "buffered",
        "reports",
        "outcomes",
        "workerActive",
        "wakePending",
        "closed",
        "flushFailures",
        "drainActive",
    }
    assert state["flows"] == flows
    assert state["buffered"] == buffered
    assert state["reports"] == reports
    return state
