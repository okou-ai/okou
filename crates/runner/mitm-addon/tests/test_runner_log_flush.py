"""Real control requests observe bounded writer prefixes without owning disk I/O."""

import json
import threading
from contextlib import ExitStack, contextmanager
from typing import cast
from unittest.mock import patch
from uuid import uuid4

import pytest

import jsonl_writer
import runner_control
import runner_flush_lifecycle
from tests.control_helpers import (
    control_connection,
    exchange,
    frame,
    log_flush_request,
)


@pytest.fixture
def control(tmp_path):
    server = runner_control.ControlServer(tmp_path, "generation-1")
    server.start()
    try:
        yield server
    finally:
        server.stop()


@contextmanager
def blocked_write(path):
    started = threading.Event()
    release = threading.Event()
    original = jsonl_writer.os.writev

    def writev(fd, buffers):
        started.set()
        assert release.wait(10), "test did not release the filesystem gate"
        return original(fd, buffers)

    with patch.object(jsonl_writer.os, "writev", side_effect=writev):
        try:
            jsonl_writer.write_jsonl_line(str(path), b'{"action":"ALLOW"}\n', "network")
            assert started.wait(2)
            yield release
        finally:
            release.set()
            assert jsonl_writer.flush_log_path(str(path), timeout=2)


def _mapping(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    return cast(dict[str, object], value)


def test_flush_progresses_with_delivery_owner_blocked_and_no_main_loop(tmp_path, control):
    run_id = str(uuid4())
    path = tmp_path / f"network-{run_id}.jsonl"
    # The same owner lock held by a running billing drain. The calling thread
    # has no running asyncio reactor and blocks on the actual control socket.
    with runner_flush_lifecycle._usage_flush_signal_lock:
        jsonl_writer.write_jsonl_line(str(path), b'{"action":"ALLOW"}\n', "network")
        result = exchange(tmp_path, log_flush_request(path, run_id))
        data = _mapping(result["data"])
        assert data["state"] == "processed"
        assert data["pending"] == 0
        assert path.read_bytes() == b'{"action":"ALLOW"}\n'


def test_cancelled_clients_retain_bounded_prefix_capacity(tmp_path, control):
    run_id = str(uuid4())
    path = tmp_path / f"network-{run_id}.jsonl"
    request = log_flush_request(path, run_id)
    with blocked_write(path) as release:
        with ExitStack() as clients:
            for _ in range(8):
                connection = clients.enter_context(control_connection(tmp_path))
                connection.sendall(frame(json.dumps(request).encode()))
            assert exchange(tmp_path, request)["code"] == "busy"
        # Every peer has disconnected, but the actual append still owns all
        # eight prefixes. Short reads remain independent of those operations.
        assert exchange(tmp_path)["data"] == {"state": "running"}
        assert exchange(tmp_path, request)["code"] == "busy"
        release.set()
        assert jsonl_writer.flush_log_path(str(path), timeout=2)
        assert _mapping(exchange(tmp_path, request)["data"])["state"] == "processed"


def test_deadline_reports_exact_pending_boundary_and_retains_slot(tmp_path, control):
    run_id = str(uuid4())
    path = tmp_path / f"network-{run_id}.jsonl"
    request = log_flush_request(path, run_id)
    with blocked_write(path), patch.object(runner_control, "LOG_FLUSH_TIMEOUT_SECONDS", 0.01):
        for _ in range(8):
            assert exchange(tmp_path, request)["data"] == {
                "runId": run_id,
                "path": str(path),
                "boundary": 1,
                "pending": 1,
                "state": "deadline",
            }
        assert exchange(tmp_path, request)["code"] == "busy"


def test_shutdown_closes_clients_without_releasing_stalled_writer_prefixes(tmp_path, control):
    run_id = str(uuid4())
    path = tmp_path / f"network-{run_id}.jsonl"
    request = log_flush_request(path, run_id)
    with blocked_write(path):
        with ExitStack() as clients:
            connections = [clients.enter_context(control_connection(tmp_path)) for _ in range(8)]
            for connection in connections:
                connection.sendall(frame(json.dumps(request).encode()))
            assert exchange(tmp_path, request)["code"] == "busy"
            control.stop()
            for connection in connections:
                assert connection.recv(1) == b""
        # New listener, same process/writer: no abandoned-op capacity leak.
        replacement = tmp_path / "replacement"
        replacement.mkdir(mode=0o700)
        server = runner_control.ControlServer(replacement, "generation-2")
        server.start()
        try:
            assert (
                exchange(replacement, log_flush_request(path, run_id, "generation-2"))["code"]
                == "busy"
            )
        finally:
            server.stop()


@pytest.mark.parametrize("defect", ["generation", "run", "path", "relative", "parent", "extra"])
def test_stale_or_invalid_target_cannot_flush_another_run(tmp_path, control, defect):
    run_id = str(uuid4())
    path = tmp_path / f"network-{run_id}.jsonl"
    request = log_flush_request(path, run_id)
    if defect == "generation":
        request["generation"] = "previous-generation"
    elif defect == "run":
        _mapping(request["params"])["runId"] = str(uuid4())
    elif defect == "path":
        _mapping(request["params"])["path"] = str(tmp_path / "proxy.jsonl")
    elif defect == "relative":
        _mapping(request["params"])["path"] = path.name
    elif defect == "parent":
        _mapping(request["params"])["path"] = f"{tmp_path}/../{path.name}"
    else:
        _mapping(request["params"])["sourceIp"] = "10.200.0.2"
    with blocked_write(path):
        assert exchange(tmp_path, request)["code"] == (
            "stale_generation" if defect == "generation" else "invalid_request"
        )
        another_id = str(uuid4())
        other = tmp_path / f"network-{another_id}.jsonl"
        assert (
            _mapping(exchange(tmp_path, log_flush_request(other, another_id))["data"])["state"]
            == "processed"
        )
        assert not other.exists()  # Observing an empty prefix does not open a file.


def test_processed_prefix_is_not_a_persistence_acknowledgement(tmp_path, control, mitm_ctx):
    run_id = str(uuid4())
    path = tmp_path / "missing" / f"network-{run_id}.jsonl"
    with mitm_ctx() as log:
        jsonl_writer.write_jsonl_line(str(path), b'{"action":"ALLOW"}\n', "network")
        result = exchange(tmp_path, log_flush_request(path, run_id))
        data = _mapping(result["data"])
        assert data["state"] == "processed"
        assert data["pending"] == 0
        assert not path.exists()
        assert log.warn.call_count == 1
