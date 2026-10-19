"""Response framing and allocation bounds through the real auth.base forwarder."""

import gc
import tracemalloc

import h11
import pytest

import auth_base_forwarder as forwarder
import auth_base_transport as transport
from tests.auth_base_forwarder_helpers import FakeSocket, fake_forwarder_upstream, http_response


def _response(payload: bytes, framing: str) -> bytes:
    if framing == "chunked":
        body = f"{len(payload):x}\r\n".encode() + payload + b"\r\n" if payload else b""
        return http_response(
            body=body + b"0\r\n\r\n",
            headers=[("Transfer-Encoding", "chunked")],
        )
    headers = [("Content-Length", str(len(payload)))] if framing == "fixed" else []
    return http_response(body=payload, headers=headers)


@pytest.mark.parametrize("framing", ["fixed", "chunked", "eof"])
@pytest.mark.parametrize("size", [0, 32 * 1024 * 1024, 32 * 1024 * 1024 + 1])
async def test_response_body_bounds_across_read_buffers(framing: str, size: int):
    payload = (bytes(range(256)) * ((size + 255) // 256))[:size]
    raw_response = _response(payload, framing)
    with fake_forwarder_upstream(socket_factory=lambda: FakeSocket(raw_response)) as upstream:
        if size > 32 * 1024 * 1024:
            with pytest.raises(transport.ForwardedResponseTooLargeError):
                await forwarder.forward_request("https://example.com", "GET", [], None)
        else:
            status, body, _headers = await forwarder.forward_request(
                "https://example.com", "GET", [], None
            )
            assert status == 200
            assert body == payload

    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert upstream.socket.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("framing", ["fixed", "missing-last-chunk", "invalid-size", "short-chunk"])
async def test_rejects_truncated_response_after_multiple_read_buffers(framing: str):
    payload = b"x" * (128 * 1024 + 7)
    if framing == "fixed":
        raw_response = http_response(
            body=payload, headers=[("Content-Length", str(len(payload) + 3))]
        )
    else:
        suffix = {
            "missing-last-chunk": b"",
            "invalid-size": b"invalid\r\n",
            "short-chunk": b"5\r\nxy",
        }[framing]
        raw_response = http_response(
            body=f"{len(payload):x}\r\n".encode() + payload + b"\r\n" + suffix,
            headers=[("Transfer-Encoding", "chunked")],
        )

    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(raw_response)) as upstream,
        pytest.raises(h11.RemoteProtocolError),
    ):
        await forwarder.forward_request("https://example.com", "GET", [], None)

    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert upstream.socket.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("size", [256 * 1024, 1024 * 1024])
async def test_tiny_chunks_keep_peak_allocations_comparable_to_fixed_length(size: int):
    payload = b"x" * size
    responses = {
        "fixed": _response(payload, "fixed"),
        "tiny-chunks": http_response(
            body=b"1\r\nx\r\n" * size + b"0\r\n\r\n",
            headers=[("Transfer-Encoding", "chunked")],
        ),
    }
    peaks: dict[str, int] = {}
    for framing, raw_response in responses.items():
        with fake_forwarder_upstream(
            socket_factory=lambda raw=raw_response: FakeSocket(raw)
        ) as upstream:
            gc.collect()
            tracemalloc.start()
            try:
                status, body, _headers = await forwarder.forward_request(
                    "https://example.com", "GET", [], None
                )
                peaks[framing] = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()

        assert status == 200
        assert body == payload
        assert upstream.socket.response_file is not None
        assert upstream.socket.response_file.closed
        assert upstream.socket.closed
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    # Allow aggregate growth, its immutable result, a bounded read buffer and
    # facade overhead. Wire chunk count must not add body-wide bookkeeping.
    assert peaks["fixed"] < 3 * size + 512 * 1024, peaks
    assert peaks["tiny-chunks"] < 3 * size + 512 * 1024, peaks
    assert peaks["tiny-chunks"] < peaks["fixed"] + size + 512 * 1024, peaks
