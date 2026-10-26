"""Bound managed Content-Type work through real admission and request hooks."""

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

_CONTENT_TYPE_LIMIT = 512


class _ConversionGuard(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("rejected Content-Type must not be decoded")

    def lower(self) -> bytes:
        raise AssertionError("rejected Content-Type must not be lowercased")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("rejected Content-Type must not be stripped")

    def replace(self, old: bytes, new: bytes, count: int = -1) -> bytes:
        raise AssertionError("rejected Content-Type must not be normalized")


def _set_content_types(flow, values):
    fields = tuple(
        (name, value)
        for name, value in flow.request.headers.fields
        if name.lower() != b"content-type"
    )
    flow.request.headers.fields = tuple((b"cOnTeNt-TyPe", value) for value in values) + fields


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("phase", ["requestheaders", "request"])
@pytest.mark.parametrize(
    "values",
    [
        pytest.param((), id="missing"),
        pytest.param((b"text/plain",), id="unsupported-media-type"),
        pytest.param((b"application/json;charset=ascii",), id="unsupported-charset"),
        pytest.param((b"application/json;x=utf-8",), id="unsupported-parameter"),
        pytest.param((b"\tapplication/json\t",), id="tabs-remain-unsupported"),
        pytest.param(
            (
                _ConversionGuard(
                    b"application/json"
                    + b" " * (_CONTENT_TYPE_LIMIT + 1 - len(b"application/json"))
                ),
            ),
            id="supported-form-padded-to-first-over-budget-byte",
        ),
        pytest.param((_ConversionGuard(b"x" * 65_536),), id="oversized-unsupported"),
        pytest.param(
            (_ConversionGuard(b"application/json"), _ConversionGuard(b"application/json")),
            id="early-duplicate-supported-values",
        ),
        pytest.param(
            (_ConversionGuard(b"application/json"), _ConversionGuard(b"x" * 1_048_576)),
            id="early-duplicate-oversized-value",
        ),
    ],
)
async def test_content_type_rejection_precedes_credentials_and_upload_retention(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, phase, values
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    flow = request(real_flow, dialect=dialect)
    _set_content_types(flow, values)
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
            mitm_addon.error(flow)
        else:
            await mitm_addon.request(flow)
            assert flow.error is None
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert flow.response.json()["reason"] == "content_type"
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
    "value",
    [
        b"application/json",
        b"Application/JSON; Charset = UTF-8",
        b' aPPlication / jSoN ; CHARSET = "uTf-8" ',
        b"application/json" + b" " * (_CONTENT_TYPE_LIMIT - len(b"application/json")),
    ],
)
async def test_in_budget_content_types_preserve_streamed_request_and_terminal_cleanup(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, value
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    flow = request(real_flow, dialect=dialect)
    _set_content_types(flow, (value,))
    body, flow.request.raw_content = flow.request.raw_content, None

    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as fetch:
        await authorize_headers(flow)
        fetch.assert_awaited_once()
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
        assert (b"cOnTeNt-TyPe", value) in flow.request.headers.fields
        flow.response = http.Response.make(200, b"{}", {"Content-Type": "application/json"})
        mitm_addon.response(flow)

    assert managed_upload.get(flow) is None


async def test_oversized_http1_head_reaches_managed_rejection_without_value_conversion(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
    value = b"application/json;x=" + b"x" * (1_048_576 - len(b"application/json;x="))
    flow.request = http1.read_request_head(
        [
            b"POST https://openrouter.ai/api/v1/chat/completions HTTP/1.1",
            b"Host: openrouter.ai",
            b"Content-Type: " + value,
            b"Content-Length: 13",
            b"Authorization: Bearer sandbox-placeholder",
        ]
    )
    assert http1.expected_http_body_size(flow.request) == 13
    _set_content_types(flow, (_ConversionGuard(value),))
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


async def test_request_revalidates_content_type_changed_after_header_admission(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow)
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
        _set_content_types(
            flow,
            (
                _ConversionGuard(
                    b"application/json"
                    + b" " * (_CONTENT_TYPE_LIMIT + 1 - len(b"application/json"))
                ),
            ),
        )
        await mitm_addon.request(flow)
        fetch.assert_awaited_once()
        assert flow.response is None
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "managed_openrouter_request_rejected"
        upload = managed_upload.get(flow)
        assert upload is not None
        assert upload.failure == "content_type"
        assert upload.validator is None
        assert upload.tail == b""
        flow.error = Error("client disconnected after request rejection")
        mitm_addon.error(flow)
        assert managed_upload.get(flow) is None
