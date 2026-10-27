"""Presence-only body admission must leave ignored header values untouched."""

import pytest
from mitmproxy import http
from mitmproxy.net.http import http1, validate

import flow_metadata_keys as metadata_keys
import managed_upload
import mitm_addon
from tests.managed_openrouter_helpers import sandbox
from tests.request_handler_helpers import _sandbox_without_firewalls, _write_registry


class _IgnoredHeaderValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("decoded an ignored header value")

    def __bytes__(self) -> bytes:
        raise AssertionError("copied an ignored header value")

    def __bool__(self) -> bool:
        raise AssertionError("tested an ignored header value's truthiness")

    def lower(self) -> bytes:
        raise AssertionError("lowercased an ignored header value")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("stripped an ignored header value")

    def replace(self, old: bytes, new: bytes, count: int = -1) -> bytes:
        raise AssertionError("normalized an ignored header value")


@pytest.mark.parametrize(
    "check",
    [mitm_addon._auth_base_body_header_check, mitm_addon._aws_sigv4_body_header_check],
    ids=["auth-base", "aws-sigv4"],
)
@pytest.mark.parametrize(
    "transfer_fields",
    [
        pytest.param((), id="absent"),
        pytest.param(((b"Transfer-Encoding", b""),), id="present-empty"),
        pytest.param(((b"Transfer-Encoding", b"chunked"),), id="present"),
        pytest.param(((b"tRaNsFeR-EnCoDiNg", b"gzip,chunked"),), id="mixed-case"),
        pytest.param(
            ((b"Transfer-Encoding", b""), (b"transfer-encoding", b"chunked")),
            id="repeated-empty-first",
        ),
        pytest.param(
            ((b"transfer-encoding", b"chunked"), (b"Transfer-Encoding", b"")),
            id="repeated-empty-last",
        ),
    ],
)
def test_buffered_auth_checks_use_only_header_names(real_flow, check, transfer_fields):
    # Empty/repeated Transfer-Encoding is a helper contract, not valid H1 framing.
    fields = (
        (b"X-Unrelated", _IgnoredHeaderValue(b"ignored")),
        (b"Content-Length", b"4"),
        *((name, _IgnoredHeaderValue(value)) for name, value in transfer_fields),
    )
    flow = real_flow(
        with_response=False,
        method="POST",
        request_headers=http.Headers(fields),
    )

    result = check(flow, request_end_stream=False)

    if transfer_fields:
        assert result.kind == "length_required"
        assert result.reason == "transfer_encoding"
        assert result.observed_size == 0
    else:
        assert result.kind == "ok"
        assert result.reason == ""
        assert result.observed_size == 4
    assert flow.request.headers.fields == fields
    assert flow.request.raw_content is None


def _native_valid_http1_flow(real_flow, *, host: str, path: str):
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host=host)
    value = b"gzip" + b" " * (1_048_576 - len(b"gzip,chunked")) + b",chunked"
    flow.request = http1.read_request_head(
        [
            f"POST https://{host}{path} HTTP/1.1".encode(),
            f"Host: {host}".encode(),
            b"Content-Type: application/json",
            b"tRaNsFeR-EnCoDiNg: " + value,
            b"Authorization: Bearer sandbox-placeholder",
        ]
    )
    validate.validate_headers(flow.request)
    assert http1.expected_http_body_size(flow.request) is None
    # Native framing owns value parsing. Guard equal bytes only after validation.
    original_fields = flow.request.headers.fields
    flow.request.headers.fields = tuple(
        (name, _IgnoredHeaderValue(raw) if name.lower() == b"transfer-encoding" else raw)
        for name, raw in original_fields
    )
    assert flow.request.headers.fields == original_fields
    return flow


async def test_native_valid_transfer_encoding_reaches_managed_rejection_without_conversion(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = _native_valid_http1_flow(
        real_flow, host="openrouter.ai", path="/api/v1/chat/completions"
    )
    fields = flow.request.headers.fields

    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
        fetch.assert_not_called()
        assert flow.error is not None
        assert flow.error.msg == "Connection killed."
        assert flow.response is None
        assert flow.request.stream is False
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "managed_openrouter_request_rejected"
        assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
        assert managed_upload.get(flow) is None
        mitm_addon.error(flow)

    assert flow.request.headers.fields == fields
    assert flow.request.raw_content is None
    assert managed_upload.get(flow) is None


async def test_native_valid_transfer_encoding_preserves_ordinary_upload_streaming(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = _native_valid_http1_flow(real_flow, host="example.com", path="/upload")
    fields = flow.request.headers.fields

    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        assert mitm_addon.requestheaders(flow) is None
        stream = flow.request.stream
        assert callable(stream)
        body = b"unchanged streamed upload"
        assert stream(body) == body
        assert stream(b"") == b""
        await mitm_addon.request(flow)
        fetch.assert_not_called()
        assert flow.error is None
        assert flow.response is None
        assert flow.request.headers.fields == fields
        assert flow.request.raw_content is None
        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
