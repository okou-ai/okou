"""Bound managed Content-Encoding work through real admission and request hooks."""

import pytest
from mitmproxy import http
from mitmproxy.flow import Error
from mitmproxy.net.http import http1

import flow_metadata_keys as metadata_keys
import managed_upload
import mitm_addon
from tests.managed_openrouter_helpers import authorize_headers, request, sandbox
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_CONTENT_ENCODING_LIMIT = 8 * 1024


class _ConversionGuard(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("over-budget Content-Encoding must not be decoded")

    def lower(self) -> bytes:
        raise AssertionError("over-budget Content-Encoding must not be lowercased")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("over-budget Content-Encoding must not be stripped")


def _set_content_encodings(flow, values):
    fields = tuple(
        (name, value)
        for name, value in flow.request.headers.fields
        if name.lower() != b"content-encoding"
    )
    flow.request.headers.fields = tuple((b"cOnTeNt-EnCoDiNg", value) for value in values) + fields


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("phase", ["requestheaders", "request"])
@pytest.mark.parametrize(
    "values",
    [
        pytest.param((b"",), id="present-empty"),
        pytest.param((b" \t",), id="present-whitespace"),
        pytest.param((b"\xffidentity",), id="invalid-bytes"),
        pytest.param((b"gzip",), id="non-identity"),
        pytest.param((b"identity, identity",), id="comma-list"),
        pytest.param((b"identity", b"identity"), id="duplicate-identity"),
        pytest.param((b"", b"identity"), id="empty-and-identity"),
        pytest.param(
            (
                b"identity" + b" " * (_CONTENT_ENCODING_LIMIT // 2 - len(b"identity")),
                b"identity" + b" " * (_CONTENT_ENCODING_LIMIT // 2 - 2 - len(b"identity")),
            ),
            id="duplicate-exact-aggregate-with-separator",
        ),
        pytest.param(
            (
                _ConversionGuard(
                    b"identity" + b" " * (_CONTENT_ENCODING_LIMIT + 1 - len(b"identity"))
                ),
            ),
            id="identity-padded-to-first-over-budget-byte",
        ),
        pytest.param((_ConversionGuard(b"x" * 65_536),), id="oversized-unsupported"),
        pytest.param(
            (_ConversionGuard(b"identity"), _ConversionGuard(b"x" * 1_048_576)),
            id="duplicate-oversized-second-value",
        ),
        pytest.param(
            (_ConversionGuard(b"x" * 1_048_576), _ConversionGuard(b"identity")),
            id="duplicate-oversized-first-value",
        ),
        pytest.param(
            (
                _ConversionGuard(
                    b"identity" + b" " * (_CONTENT_ENCODING_LIMIT // 2 - len(b"identity"))
                ),
                _ConversionGuard(
                    b"identity" + b" " * (_CONTENT_ENCODING_LIMIT // 2 - 1 - len(b"identity"))
                ),
            ),
            id="first-over-aggregate-byte-includes-separator",
        ),
    ],
)
async def test_content_encoding_rejection_precedes_credentials_and_upload_retention(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, phase, values
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    flow = request(real_flow, dialect=dialect)
    _set_content_encodings(flow, values)
    if phase == "requestheaders":
        flow.request.raw_content = None
    original_fields = flow.request.headers.fields
    original_body = flow.request.raw_content

    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        if phase == "requestheaders":
            assert mitm_addon.requestheaders(flow) is None
            await mitm_addon.request(flow)
            assert flow.error is not None
            assert flow.error.msg == "Connection killed."
            assert flow.response is None
            assert managed_upload.get(flow) is None
            mitm_addon.error(flow)
        else:
            await mitm_addon.request(flow)
            assert flow.error is None
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert flow.response.json()["reason"] == "content_encoding"
            assert managed_upload.get(flow) is None
            mitm_addon.response(flow)
        fetch.assert_not_called()

    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "model-provider:openrouter-codex"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "managed_openrouter_request_rejected"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert flow.request.headers.fields == original_fields
    assert flow.request.raw_content == original_body
    assert flow.request.stream is False
    assert managed_upload.get(flow) is None


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize(
    "values",
    [
        pytest.param((), id="missing"),
        pytest.param((b"identity",), id="identity"),
        pytest.param((b"IdEnTiTy",), id="mixed-case"),
        pytest.param((b"\t IDENTITY \t",), id="ascii-whitespace"),
        pytest.param(("\u0085\u00a0\u2003IdEnTiTy\u3000".encode(),), id="unicode-whitespace"),
        pytest.param(
            (b" " * (_CONTENT_ENCODING_LIMIT - len(b"identity")) + b"identity",),
            id="exact-value-budget",
        ),
    ],
)
async def test_in_budget_encodings_preserve_streamed_bytes_and_terminal_cleanup(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, values
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    flow = request(real_flow, dialect=dialect)
    _set_content_encodings(flow, values)
    body, flow.request.raw_content = flow.request.raw_content, None

    with (
        mitm_ctx(registry_path=str(registry)),
        fake_firewall_headers(headers={"Authorization": "Bearer managed-token"}) as fetch,
    ):
        await authorize_headers(flow)
        fetch.assert_awaited_once()
        assert flow.request.headers["Authorization"] == "Bearer managed-token"
        assert flow.error is None
        assert callable(flow.request.stream)
        assert managed_upload.get(flow) is not None
        mark_connected_tls_upstream(
            flow,
            sni="openrouter.ai",
            server_address=("openrouter.ai", 443),
            peername=("104.18.32.47", 443),
        )
        assert flow.request.stream(body) == body[:-1]
        assert flow.request.stream(b"") == body[-1:]
        await mitm_addon.request(flow)
        assert flow.error is None
        assert flow.response is None
        assert flow.request.raw_content is None
        assert (
            tuple(
                value
                for name, value in flow.request.headers.fields
                if name.lower() == b"content-encoding"
            )
            == values
        )
        flow.response = http.Response.make(200, b"{}", {"Content-Type": "application/json"})
        mitm_addon.response(flow)

    assert managed_upload.get(flow) is None


async def test_oversized_http1_head_reaches_managed_rejection_without_value_conversion(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
    value = b"x" * 1_048_576
    flow.request = http1.read_request_head(
        [
            b"POST https://openrouter.ai/api/v1/chat/completions HTTP/1.1",
            b"Host: openrouter.ai",
            b"Content-Type: application/json",
            b"Content-Encoding: " + value,
            b"Content-Length: 13",
            b"Authorization: Bearer sandbox-placeholder",
        ]
    )
    assert http1.expected_http_body_size(flow.request) == 13
    _set_content_encodings(flow, (_ConversionGuard(value),))
    original_fields = flow.request.headers.fields
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        assert mitm_addon.requestheaders(flow) is None
        fetch.assert_not_called()
        assert flow.error is not None
        assert flow.response is None
        assert flow.request.headers.fields == original_fields
        assert flow.request.raw_content is None
        assert managed_upload.get(flow) is None
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "managed_openrouter_request_rejected"
        mitm_addon.error(flow)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
async def test_request_revalidates_encoding_changed_after_header_admission(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    flow = request(real_flow, dialect=dialect)
    body, flow.request.raw_content = flow.request.raw_content, None
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        await authorize_headers(flow)
        fetch.assert_awaited_once()
        assert callable(flow.request.stream)
        mark_connected_tls_upstream(
            flow,
            sni="openrouter.ai",
            server_address=("openrouter.ai", 443),
            peername=("104.18.32.47", 443),
        )
        assert flow.request.stream(body) == body[:-1]
        assert flow.request.stream(b"") == body[-1:]
        _set_content_encodings(
            flow,
            (_ConversionGuard(b"x" * (_CONTENT_ENCODING_LIMIT + 1)),),
        )
        await mitm_addon.request(flow)
        fetch.assert_awaited_once()
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "managed_openrouter_request_rejected"
        upload = managed_upload.get(flow)
        assert upload is not None
        assert upload.failure == "content_encoding"
        assert upload.validator is None
        assert upload.tail == b""
        flow.error = Error("client disconnected after request rejection")
        mitm_addon.error(flow)
        assert managed_upload.get(flow) is None
