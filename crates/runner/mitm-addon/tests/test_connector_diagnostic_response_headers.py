"""Discarded upstream header work through connector diagnostic HTTP hooks."""

import json

import pytest
from mitmproxy import http, options
from mitmproxy.proxy import events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import (
    RequestHeaders,
    ResponseData,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._http1 import Http1Client
from mitmproxy.test import tutils

import mitm_addon
from tests.connector_diagnostic_helpers import write_connector_diagnostic_capture_registry
from tests.flow_helpers import header_map, response_stream


class _DiscardedValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("discarded response header value must not be decoded")

    def __bytes__(self) -> bytes:
        raise AssertionError("discarded response header value must not be copied")

    def __str__(self) -> str:
        raise AssertionError("discarded response header value must not be converted")


def _complete_diagnostic(flow: http.HTTPFlow, *, streamed: bool) -> bytes:
    assert flow.response is not None
    if streamed:
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        assert stream(b"{}") == ()
        emitted = stream(b"")
        assert isinstance(emitted, bytes)
        assert stream(b"") == ()
        # Trailers can arrive after responseheaders cleared the original set.
        flow.response.trailers = header_map({"X-Late-Trailer": "discarded"})
    else:
        emitted = None

    assert mitm_addon.response(flow) is None
    content = flow.response.content
    assert content is not None
    assert flow.response.trailers is None
    assert flow.response.stream is False
    assert flow.response.headers["Content-Type"] == "application/json"
    assert flow.response.headers.get_all("Content-Encoding") == []
    assert flow.response.headers.get_all("Transfer-Encoding") == []
    if streamed:
        assert content == emitted
    if flow.request.method == "HEAD":
        assert content == b""
        assert flow.response.headers.get_all("Content-Length") == []
    else:
        diagnostic = json.loads(content)
        assert diagnostic["error"] == "connector_not_configured_for_run"
        assert diagnostic["connector"] == "fal"
        assert diagnostic["upstreamStatus"] == flow.response.status_code
        assert flow.response.headers.get_all("Content-Length") == [str(len(content))]

    final_fields = flow.response.headers.fields
    assert mitm_addon.response(flow) is None
    assert flow.response.content == content
    assert flow.response.headers.fields == final_fields
    return content


@pytest.mark.parametrize("streamed", [False, True], ids=["buffered", "streamed"])
@pytest.mark.parametrize("upstream_status", [401, 403])
@pytest.mark.parametrize("value_size", [512, 64 * 1024, 1024 * 1024])
async def test_native_http1_large_discarded_encoding(
    tmp_path, real_flow, mitm_ctx, streamed, upstream_status, value_size
):
    registry_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )
    value = b"identity," + b" " * (value_size - 17) + b"identity"
    wire = (
        f"HTTP/1.1 {upstream_status} Unauthorized\r\n".encode()
        + b"Content-Length: 2\r\nContent-Type: text/plain\r\n"
        + b"Content-Encoding: "
        + value
        + b"\r\nX-Upstream: preserved\r\n\r\n{}"
    )

    with mitm_ctx(registry_path=str(registry_path)):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
        assert flow.response is None

        context = Context(flow.client_conn, options.Options())
        context.server.address = ("fal.run", 443)
        upstream = Http1Client(context)
        list(upstream.handle_event(events.Start()))
        list(upstream.handle_event(RequestHeaders(1, flow.request, end_stream=True)))
        received = [
            command.event
            for command in upstream.handle_event(events.DataReceived(context.server, wire))
            if isinstance(command, ReceiveHttp)
        ]
        response = next(event.response for event in received if isinstance(event, ResponseHeaders))
        assert (
            b"".join(event.data for event in received if isinstance(event, ResponseData)) == b"{}"
        )
        assert any(isinstance(event, ResponseEndOfMessage) for event in received)
        assert response.headers.fields[2] == (b"Content-Encoding", value)

        # Instrument only after native parsing, so parser work stays independent.
        response.headers.fields = tuple(
            (name, _DiscardedValue(raw_value)) if name == b"Content-Encoding" else (name, raw_value)
            for name, raw_value in response.headers.fields
        )
        response.raw_content = b"{}" if not streamed else None
        flow.response = response
        _complete_diagnostic(flow, streamed=streamed)

    assert response.status_code == upstream_status
    assert response.headers["X-Upstream"] == "preserved"


@pytest.mark.parametrize("streamed", [False, True], ids=["buffered", "streamed"])
@pytest.mark.parametrize("method", ["POST", "HEAD"])
@pytest.mark.parametrize("discarded_fields", ["absent", "empty", "duplicates"])
async def test_raw_discarded_fields_preserve_diagnostic_framing(
    tmp_path, real_flow, mitm_ctx, streamed, method, discarded_fields
):
    registry_path = write_connector_diagnostic_capture_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method=method,
    )
    # Keep duplicate/opaque upstream fields byte-for-byte, including their order.
    retained = (
        (b"X-Upstream", b"first\xff"),
        (b"X-" + b"N" * (64 * 1024), b"large name"),
        (b"x-upstream", b"second"),
    )
    discarded = ()
    if discarded_fields != "absent":
        value = _DiscardedValue(b"" if discarded_fields == "empty" else b"x" * (1024 * 1024))
        discarded = tuple(
            (name, value) for name in (b"cOnTeNt-EnCoDiNg", b"CONTENT-LENGTH", b"Transfer-Encoding")
        )
        if discarded_fields == "duplicates":
            discarded += tuple((name.lower(), _DiscardedValue(b"")) for name, _ in discarded)

    with mitm_ctx(registry_path=str(registry_path)):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
        assert flow.response is None
        response = tutils.tresp(
            status_code=403,
            headers=http.Headers(
                (
                    retained[0],
                    *discarded,
                    retained[1],
                    (b"Content-Type", b"text/plain"),
                    retained[2],
                )
            ),
            content=b"{}",
        )
        flow.response = response
        response.trailers = header_map({"X-Original-Trailer": "discarded"})
        _complete_diagnostic(flow, streamed=streamed)

    assert response.status_code == 403
    assert (
        tuple(
            field
            for field in response.headers.fields
            if field[0].lower() not in (b"content-type", b"content-length")
        )
        == retained
    )
