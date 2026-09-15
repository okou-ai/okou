"""Real host-side peers for the addon-private control protocol."""

import json
import os
import socket
import struct
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path


@contextmanager
def control_connection(directory: Path) -> Iterator[socket.socket]:
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(7)
            connection.connect(f"/proc/self/fd/{directory_fd}/control.sock")
            yield connection
    finally:
        os.close(directory_fd)


def frame(payload: bytes) -> bytes:
    return struct.pack("!I", len(payload)) + payload


def receive(connection: socket.socket, length: int) -> bytes:
    result = bytearray()
    while len(result) < length:
        chunk = connection.recv(length - len(result))
        if not chunk:
            raise EOFError("control peer closed before its terminal reply")
        result.extend(chunk)
    return bytes(result)


def read_reply(connection: socket.socket) -> dict[str, object]:
    length = struct.unpack("!I", receive(connection, 4))[0]
    assert 0 < length <= 64 * 1024
    result = json.loads(receive(connection, length))
    assert isinstance(result, dict)
    assert connection.recv(1) == b""
    return result


def assert_closed(connection: socket.socket) -> None:
    # Closing with unread bytes (partial/pipelined requests) may reset.
    with suppress(ConnectionResetError):
        assert connection.recv(1) == b""


def status_request(generation: str = "generation-1") -> dict[str, object]:
    return {
        "requestId": "request-1",
        "generation": generation,
        "method": "proxy.status",
        "params": {},
    }


def exchange(directory: Path, request: dict[str, object] | None = None) -> dict[str, object]:
    with control_connection(directory) as connection:
        connection.sendall(
            frame(json.dumps(status_request() if request is None else request).encode())
        )
        return read_reply(connection)
