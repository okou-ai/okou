"""Request-header field-count and field-name admission integration tests."""

import pytest
from mitmproxy import connection
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
)
from mitmproxy.test import taddons

import connector_intent
import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.mitmproxy_http_framing_helpers import PLACEHOLDER_HOST, start_http_layer
from tests.requestheaders_helpers import _assert_no_request_stream

_MAX_REQUEST_HEADER_FIELDS = 2048
_MAX_REQUEST_HEADER_NAME_BYTES = 4096
_BROWSER_USER_AGENT = (
    b"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    b"(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


class _LowerGuardHeaderName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("over-budget request header name must not be lowercased")


async def test_requestheaders_rejects_over_budget_field_count_before_header_processing(real_flow):
    guarded_name = _LowerGuardHeaderName(b"X")
    flow = real_flow(
        with_response=False,
        request_headers=mitm_addon.http.Headers(
            [(guarded_name, b"y")] * (_MAX_REQUEST_HEADER_FIELDS + 1)
        ),
    )

    assert mitm_addon.requestheaders(flow) is None

    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.response is None
    assert flow.request.headers.fields == ()
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    _assert_no_request_stream(flow)

    await mitm_addon.request(flow)

    assert flow.request.headers.fields == ()
    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


async def test_requestheaders_rejects_over_budget_names_before_header_processing(real_flow):
    retained_fields = (
        (b"Host", b"example.com"),
        (b"Expect", b"100-continue"),
        (b"X-Trace", b"first"),
        (b"x-trace", b"second"),
        (b"x-VM0-Connector-Intent", b"primary"),
        (b"x-Okou-Codex-Model-Catalog-Prefetch", b"1"),
    )
    flow = real_flow(
        with_response=False,
        request_headers=mitm_addon.http.Headers(
            [
                *retained_fields,
                (
                    _LowerGuardHeaderName(b"X" * (_MAX_REQUEST_HEADER_NAME_BYTES + 1)),
                    b"rejected",
                ),
                (b"Y" * (_MAX_REQUEST_HEADER_NAME_BYTES + 2), b"also-rejected"),
            ]
        ),
    )

    assert mitm_addon.requestheaders(flow) is None

    assert flow.response is not None
    assert flow.response.status_code == 431
    assert flow.response.content == b""
    assert flow.request.headers.fields == retained_fields
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    _assert_no_request_stream(flow)

    await mitm_addon.request(flow)

    assert flow.request.headers.fields == retained_fields
    assert connector_intent.from_flow(flow) == connector_intent.ABSENT
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


@pytest.mark.parametrize(
    "body_field",
    [
        (b"cOnTeNt-LeNgTh", b"0"),
        (b"TrAnSfEr-EnCoDiNg", b"chunked"),
    ],
)
async def test_requestheaders_accepts_name_budget_and_preserves_existing_header_behavior(
    registry_file,
    real_flow,
    mitm_ctx,
    body_field,
):
    boundary_name = b"X" * _MAX_REQUEST_HEADER_NAME_BYTES
    repeated_fields = (
        (b"X-Trace", b"first"),
        (b"x-trace", b"second"),
    )
    fixed_fields = (
        (b"hOsT", b"example.com"),
        body_field,
        (b"uSeR-aGeNt", _BROWSER_USER_AGENT),
        *repeated_fields,
        (boundary_name, b"accepted"),
        (b"x-VM0-Connector-Intent", b"primary"),
        (b"x-Okou-Codex-Model-Catalog-Prefetch", b"1"),
    )
    padding_fields = ((b"X-Padding", b""),) * (_MAX_REQUEST_HEADER_FIELDS - len(fixed_fields))
    flow = real_flow(
        with_response=False,
        request_headers=mitm_addon.http.Headers((*fixed_fields, *padding_fields)),
    )
    assert len(flow.request.headers.fields) == _MAX_REQUEST_HEADER_FIELDS

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

    assert flow.response is None
    assert (boundary_name, b"accepted") in flow.request.headers.fields
    assert all(field in flow.request.headers.fields for field in repeated_fields)
    assert (b"hOsT", b"example.com") in flow.request.headers.fields
    assert body_field in flow.request.headers.fields
    assert (b"uSeR-aGeNt", _BROWSER_USER_AGENT) in flow.request.headers.fields
    assert all(
        name
        not in (
            b"x-VM0-Connector-Intent",
            b"x-Okou-Codex-Model-Catalog-Prefetch",
        )
        for name, _value in flow.request.headers.fields
    )
    assert connector_intent.from_flow(flow) == connector_intent.ConnectorIntent(
        "present", "primary"
    )
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert flow.metadata["_codex_model_catalog_prefetch_request"] is True
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_http1_over_budget_field_count_kills_before_expect_and_body_processing() -> None:
    request_head = (
        (
            f"POST / HTTP/1.1\r\nHost: {PLACEHOLDER_HOST}\r\n"
            "Expect: 100-continue\r\nContent-Length: 1\r\n"
        ).encode()
        + b"X: y\r\n" * (_MAX_REQUEST_HEADER_FIELDS - 2)
        + b"\r\n"
    )

    with taddons.context(Proxyserver(), mitm_addon) as addon_context:
        client, http_layer = start_http_layer(addon_context, alpn=b"http/1.1")
        initial_commands = list(http_layer.handle_event(events.DataReceived(client, request_head)))
        request_headers_hook = next(
            command for command in initial_commands if isinstance(command, HttpRequestHeadersHook)
        )
        assert len(request_headers_hook.flow.request.headers.fields) == (
            _MAX_REQUEST_HEADER_FIELDS + 1
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        flow = request_headers_hook.flow
        header_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        error_hook = next(
            command for command in header_commands if isinstance(command, HttpErrorHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, error_hook)
        terminal_commands = list(http_layer.handle_event(events.HookCompleted(error_hook, None)))

    assert flow.error is not None
    assert flow.error.msg == Error.KILLED_MESSAGE
    assert flow.request.headers.fields == ()
    assert flow.request.raw_content is None
    assert not any(isinstance(command, HttpRequestHook) for command in header_commands)
    assert any(
        isinstance(command, commands.CloseConnection) and command.connection is flow.client_conn
        for command in terminal_commands
    )
    assert not any(
        isinstance(command, commands.SendData) and command.connection is flow.client_conn
        for command in terminal_commands
    )
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in (*header_commands, *terminal_commands)
    )
