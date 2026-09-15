"""Control lifecycle, strict messages and independent bounded real socket I/O."""

import json
import struct
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path

import pytest

import runner_control
from tests.control_helpers import (
    assert_closed,
    control_connection,
    exchange,
    frame,
    read_reply,
    receive,
    status_request,
)


@pytest.fixture
def control(tmp_path: Path) -> Iterator[runner_control.ControlServer]:
    server = runner_control.ControlServer(tmp_path, "generation-1")
    server.start()
    try:
        yield server
    finally:
        server.stop()


def test_status_is_correlated_and_observational(tmp_path, control):
    expected = {
        "requestId": "request-1",
        "generation": "generation-1",
        "type": "result",
        "data": {"state": "running"},
    }
    assert exchange(tmp_path) == expected
    assert exchange(tmp_path) == expected


@pytest.mark.parametrize(
    ("updates", "code"),
    [
        ({"generation": "previous-generation"}, "stale_generation"),
        ({"method": "not.available"}, "unknown_method"),
        ({"params": {"path": "/untrusted"}}, "invalid_request"),
        ({"extra": True}, "invalid_request"),
        ({"params": []}, "invalid_request"),
        ({"method": "x" * 65}, "invalid_request"),
    ],
)
def test_rejects_invalid_or_stale_request_without_affecting_status(
    tmp_path, control, updates, code
):
    request = status_request() | updates
    assert exchange(tmp_path, request) == {
        "requestId": "request-1",
        "generation": "generation-1",
        "type": "error",
        "code": code,
    }
    assert exchange(tmp_path)["type"] == "result"


@pytest.mark.parametrize(
    "payload",
    [
        b"{",
        b"\xff",
        b"[]",
        b'{"requestId":"a","requestId":"b"}',
        b"NaN",
        json.dumps(status_request()).encode("utf-16"),
    ],
)
def test_malformed_json_is_rejected(tmp_path, control, payload):
    with control_connection(tmp_path) as connection:
        connection.sendall(frame(payload))
        assert read_reply(connection)["code"] == "invalid_request"


@pytest.mark.parametrize("size", [0, 64 * 1024 + 1, 2**32 - 1])
def test_bad_length_closes_before_waiting_for_payload(tmp_path, control, size):
    with control_connection(tmp_path) as connection:
        connection.sendall(struct.pack("!I", size))
        assert connection.recv(1) == b""
    assert exchange(tmp_path)["type"] == "result"


def test_partial_client_cannot_block_status_and_expires(tmp_path, control):
    with control_connection(tmp_path) as connection:
        connection.sendall(b"\x00")
        # The caller thread is blocked on real socket I/O; control must run
        # independently instead of depending on a main-thread event loop.
        assert exchange(tmp_path)["type"] == "result"
        assert connection.recv(1) == b""


def test_admission_is_bounded_and_recovers_after_clients_finish(tmp_path, control):
    with ExitStack() as stack:
        clients = [stack.enter_context(control_connection(tmp_path)) for _ in range(16)]
        for connection in clients:
            connection.sendall(b"\x00")
        with control_connection(tmp_path) as overflow:
            assert overflow.recv(1) == b""
        for connection in clients:
            connection.sendall(b"\x00\x00\x00")
            assert connection.recv(1) == b""
    assert exchange(tmp_path)["type"] == "result"


def test_one_request_per_connection(tmp_path, control):
    with control_connection(tmp_path) as connection:
        payload = frame(json.dumps(status_request()).encode())
        connection.sendall(payload + payload)
        size = struct.unpack("!I", receive(connection, 4))[0]
        assert json.loads(receive(connection, size))["type"] == "result"
        assert_closed(connection)


def test_exclusive_bind_preserves_the_live_owner(tmp_path, control):
    competitor = runner_control.ControlServer(tmp_path, "generation-2")
    with pytest.raises(OSError, match="Address already in use"):
        competitor.start()
    assert exchange(tmp_path)["generation"] == "generation-1"


def test_stop_reclaims_clients_but_leaves_endpoint_to_runner(tmp_path, control):
    with control_connection(tmp_path) as connection:
        connection.sendall(b"\x00")
        control.stop()
        assert_closed(connection)
    assert (tmp_path / "control.sock").is_socket()
    with pytest.raises(ConnectionRefusedError), control_connection(tmp_path):
        pass


def test_new_launch_rejects_previous_generation(tmp_path, control):
    control.stop()
    replacement_dir = tmp_path / "replacement"
    replacement_dir.mkdir(mode=0o700)
    replacement = runner_control.ControlServer(replacement_dir, "generation-2")
    replacement.start()
    try:
        assert exchange(replacement_dir)["code"] == "stale_generation"
        assert exchange(replacement_dir, status_request("generation-2"))["type"] == "result"
    finally:
        replacement.stop()


def test_private_directory_required(tmp_path):
    tmp_path.chmod(0o755)
    server = runner_control.ControlServer(tmp_path, "generation-1")
    with pytest.raises(PermissionError):
        server.start()
    assert not (tmp_path / "control.sock").exists()


def test_symlink_directory_cannot_select_another_owner(tmp_path):
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    alias = tmp_path / "alias"
    alias.symlink_to(private, target_is_directory=True)
    server = runner_control.ControlServer(alias, "generation-1")
    with pytest.raises(NotADirectoryError):
        server.start()
    assert not (private / "control.sock").exists()


def test_long_directory_path_remains_usable(tmp_path):
    directory = tmp_path / ("launch-" * 24)
    directory.mkdir(mode=0o700)
    server = runner_control.ControlServer(directory, "generation-1")
    server.start()
    try:
        assert exchange(directory)["type"] == "result"
    finally:
        server.stop()
