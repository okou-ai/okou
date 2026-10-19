"""Informational response sequences through real forwarding and auth mapping."""

from unittest.mock import AsyncMock, patch

import h11
import pytest

import auth
import auth_base_forwarder as forwarder
import auth_base_transport as transport
import flow_metadata_keys as metadata_keys
from tests.auth_base_forwarder_helpers import (
    FakeResponseFile,
    FakeSocket,
    fake_forwarder_upstream,
    http_response,
)
from tests.firewall_auth_helpers import handle_firewall_request_without_upstream_admission
from tests.firewall_rewrite_helpers import make_forwarding_rewrite_inputs

_INFORMATIONAL_SEQUENCES = [
    pytest.param((), id="final-only"),
    pytest.param((100,), id="continue"),
    pytest.param((102,), id="processing"),
    pytest.param((103,), id="early-hints"),
    pytest.param((103, 102, 100, 103, 199), id="mixed-repeated-and-unassigned"),
]


def _informational_responses(statuses: tuple[int, ...]) -> bytes:
    return b"".join(
        http_response(
            status=status,
            body=b"",
            headers=[
                ("X-Interim-Only", "discard"),
                ("Set-Cookie", "interim=1"),
                ("Connection", "close"),
            ],
        )
        for status in statuses
    )


@pytest.mark.parametrize("statuses", _INFORMATIONAL_SEQUENCES)
@pytest.mark.parametrize("final_status", [200, 503])
@pytest.mark.parametrize("framing", ["fixed", "chunked", "eof"])
async def test_returns_complete_final_response_without_resending(
    statuses: tuple[int, ...], final_status: int, framing: str
):
    payload = b'{"ok":1}'
    final_headers = [
        ("Content-Type", "application/json"),
        ("Set-Cookie", "a=1"),
        ("Set-Cookie", "b=2"),
        ("Connection", "X-Remove"),
        ("X-Remove", "discard"),
    ]
    wire_body = payload
    if framing == "fixed":
        final_headers.append(("Content-Length", str(len(payload))))
    elif framing == "chunked":
        final_headers.append(("Transfer-Encoding", "chunked"))
        wire_body = b"8\r\n" + payload + b"\r\n0\r\n\r\n"
    wire = _informational_responses(statuses) + http_response(
        status=final_status, body=wire_body, headers=final_headers
    )

    with fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream:
        status, body, headers = await forwarder.forward_request(
            "https://example.com/hook", "POST", [("Content-Type", "application/json")], b"{}"
        )

    assert status == final_status
    assert body == payload
    assert headers.get_all("Set-Cookie") == ["a=1", "b=2"]
    assert headers["Content-Type"] == "application/json"
    assert "X-Interim-Only" not in headers
    assert "X-Remove" not in headers
    assert "Transfer-Encoding" not in headers
    assert len(upstream.sockets) == 1
    assert upstream.socket.request_text().count("POST /hook HTTP/1.1\r\n") == 1
    assert upstream.socket.request_text().endswith("\r\n\r\n{}")
    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("statuses", _INFORMATIONAL_SEQUENCES)
@pytest.mark.parametrize("final_status", [200, 503])
async def test_auth_mapping_exposes_final_response(
    statuses: tuple[int, ...], final_status: int, real_flow, mitm_ctx, tmp_path
):
    payload = b'{"ok":1}'
    wire = _informational_responses(statuses) + http_response(
        status=final_status,
        body=payload,
        headers=[
            ("Content-Length", str(len(payload))),
            ("Content-Type", "application/json"),
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
        ],
    )
    flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
        real_flow, tmp_path, method="POST", request_body=b"{}"
    )
    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        mitm_ctx(),
    ):
        result = await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

    assert result is auth.FirewallAuthHandlingResult.INLINE_PROVIDER_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == final_status
    assert flow.response.content == payload
    assert flow.response.headers.get_all("Set-Cookie") == ["a=1", "b=2"]
    assert flow.response.headers["Content-Length"] == str(len(payload))
    assert "X-Interim-Only" not in flow.response.headers
    assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
    assert len(upstream.sockets) == 1
    assert upstream.socket.request_text().count("POST ") == 1
    assert upstream.socket.request_text().endswith("\r\n\r\n{}")
    assert upstream.socket.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize(("method", "final_status"), [("HEAD", 200), ("GET", 204), ("GET", 304)])
async def test_informational_response_preserves_final_bodyless_semantics(
    method: str, final_status: int
):
    wire = _informational_responses((103,)) + http_response(
        status=final_status, body=b"", headers=[("Content-Length", "123")]
    )
    with fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream:
        status, body, _headers = await forwarder.forward_request(
            "https://example.com", method, [], None
        )

    assert status == final_status
    assert body == b""
    assert upstream.socket.closed


@pytest.mark.parametrize("statuses", [(100,), (102,), (103,), (103, 102, 100)])
async def test_eof_before_final_response_fails_and_releases_resources(statuses: tuple[int, ...]):
    wire = _informational_responses(statuses)
    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        pytest.raises(h11.RemoteProtocolError),
    ):
        await forwarder.forward_request("https://example.com/hook", "POST", [], b"{}")

    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("statuses", [(), (103,)])
async def test_upgrade_is_rejected_without_waiting_for_a_final_response(statuses: tuple[int, ...]):
    wire = _informational_responses(statuses) + http_response(
        status=101, body=b"", headers=[("Connection", "Upgrade"), ("Upgrade", "websocket")]
    )
    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        pytest.raises(h11.RemoteProtocolError),
    ):
        await forwarder.forward_request("https://example.com", "GET", [], None)

    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("failure", ["eof", "upgrade"])
async def test_auth_mapping_rejects_incomplete_or_upgraded_responses(
    failure: str, real_flow, mitm_ctx, tmp_path
):
    wire = _informational_responses((103,))
    if failure == "upgrade":
        wire += http_response(
            status=101, body=b"", headers=[("Connection", "Upgrade"), ("Upgrade", "websocket")]
        )
    flow, allow, sandbox_info, token_meta = make_forwarding_rewrite_inputs(
        real_flow, tmp_path, method="POST", request_body=b"{}"
    )
    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
        mitm_ctx(),
    ):
        result = await handle_firewall_request_without_upstream_admission(flow, allow, sandbox_info)

    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
    assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("framing", ["fixed", "chunked", "eof"])
async def test_final_body_limit_applies_after_informational_response(framing: str):
    final_headers = []
    wire_body = b"12345"
    if framing == "fixed":
        final_headers = [("Content-Length", "5")]
    elif framing == "chunked":
        final_headers = [("Transfer-Encoding", "chunked")]
        wire_body = b"5\r\n12345\r\n0\r\n\r\n"
    wire = _informational_responses((103, 102)) + http_response(
        body=wire_body, headers=final_headers
    )
    with (
        patch.object(transport, "MAX_AUTH_BASE_RESPONSE_BODY_BYTES", 4),
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        pytest.raises(transport.ForwardedResponseTooLargeError),
    ):
        await forwarder.forward_request("https://example.com", "GET", [], None)

    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


async def test_truncated_final_body_fails_after_informational_response():
    wire = _informational_responses((103,)) + http_response(
        body=b"123", headers=[("Content-Length", "4")]
    )
    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        pytest.raises(h11.RemoteProtocolError),
    ):
        await forwarder.forward_request("https://example.com", "GET", [], None)

    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    "interim_headers",
    [b"X-Long: " + b"x" * 65536 + b"\r\n", b"X-Many: x\r\n" * 101],
    ids=["line-length", "header-count"],
)
async def test_informational_headers_retain_parser_limits(interim_headers: bytes):
    wire = b"HTTP/1.1 103 Early Hints\r\n" + interim_headers + b"\r\n" + http_response()
    with (
        fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream,
        pytest.raises(h11.RemoteProtocolError),
    ):
        await forwarder.forward_request("https://example.com", "GET", [], None)

    assert upstream.socket.closed
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("chunk_size", [1, 7])
async def test_fragmented_response_and_binary_request_keep_one_complete_exchange(chunk_size: int):
    wire = _informational_responses((103, 102, 100, 199)) + (
        b"HTTP/1.1 503 Unavailable\r\n"
        b"Transfer-Encoding: chunked\r\n"
        b"X-Bytes: caf\xe9\r\n"
        b"Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n"
        b"5\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: discarded\r\n\r\n"
    )

    class FragmentedFile(FakeResponseFile):
        def readinto(self, buffer) -> int:
            return super().readinto(memoryview(buffer)[:chunk_size])

    class FragmentedSocket(FakeSocket):
        def makefile(self, *_args, **_kwargs) -> FakeResponseFile:
            self.response_file = FragmentedFile(wire)
            return self.response_file

    request_body = b"\x00\xffrequest-data"
    with fake_forwarder_upstream(socket_factory=lambda: FragmentedSocket(wire)) as upstream:
        status, body, headers = await forwarder.forward_request(
            "https://example.com/hook",
            "POST",
            [("X-Repeat", "one"), ("X-Repeat", "two")],
            request_body,
        )

    assert status == 503
    assert body == b"hello world"
    assert headers.fields == (
        (b"X-Bytes", b"caf\xe9"),
        (b"Set-Cookie", b"a=1"),
        (b"Set-Cookie", b"b=2"),
    )
    assert upstream.socket.request_header_values("X-Repeat") == ["one", "two"]
    assert upstream.socket.request_header_values("Content-Length") == [str(len(request_body))]
    assert bytes(upstream.socket.sent).split(b"\r\n\r\n", 1)[1] == request_body
    assert upstream.socket.request_text().count("POST /hook HTTP/1.1\r\n") == 1
    assert upstream.socket.response_file is not None
    assert upstream.socket.response_file.closed
    assert upstream.socket.closed
    assert forwarder.forward_request_admission_state_for_tests() == (0, 0)


@pytest.mark.parametrize("budget", ["line-bytes", "header-lines"])
async def test_accepts_response_at_existing_header_budget(budget: str):
    if budget == "line-bytes":
        prefix = b"X-Large: "
        header_bytes = prefix + b"x" * (65536 - len(prefix) - 2) + b"\r\n"
    else:
        # 99 fields plus the blank terminator fit the existing 100-line cap.
        header_bytes = b"X-Budget: ok\r\n" * 98
    wire = (
        _informational_responses((103,))
        + b"HTTP/1.1 200 OK\r\n"
        + header_bytes
        + b"Content-Length: 2\r\n\r\nok"
    )
    with fake_forwarder_upstream(socket_factory=lambda: FakeSocket(wire)) as upstream:
        status, body, headers = await forwarder.forward_request(
            "https://example.com", "GET", [], None
        )

    assert status == 200
    assert body == b"ok"
    if budget == "header-lines":
        assert headers.get_all("X-Budget") == ["ok"] * 98
    else:
        assert len(headers["X-Large"]) == 65536 - len(b"X-Large: ") - 2
    assert upstream.socket.closed
