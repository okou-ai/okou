"""Authority framing tests through mitmproxy's real hook pipeline."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.net.http import http1
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_authority
from tests.mitmproxy_http_framing_helpers import (
    PLACEHOLDER_HOST,
    start_http2_request,
    start_http_layer,
)
from tests.request_handler_helpers import _write_github_firewall_registry


def _start_transparent_http1_absolute_request(
    addon_context: taddons.context,
    *,
    authority: str,
    host: str = "api.github.com",
    original_host: str = "203.0.113.10",
    port: int = 443,
    path: str = "/repos",
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = start_http_layer(
        addon_context,
        alpn=b"http/1.1",
        host=host,
        server_host=original_host,
        server_port=port,
        mode=HTTPMode.transparent,
    )

    commands = list(
        http_layer.handle_event(
            events.DataReceived(
                client,
                f"GET https://{authority}{path} HTTP/1.1\r\nHost: {host}\r\n\r\n".encode(),
            )
        )
    )
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook


async def test_over_budget_http1_host_is_rejected_in_both_hooks_without_string_access(
    tmp_path: Path,
    fake_firewall_headers,
) -> None:
    registry_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    oversized_host = (b"a." * 2048) + b"a"
    assert len(oversized_host) == 4097

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-secret"}) as get_headers,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http_layer = start_http_layer(
            addon_context,
            alpn=b"http/1.1",
            host="api.github.com",
            server_host="203.0.113.10",
            mode=HTTPMode.transparent,
        )
        initial_commands = list(
            http_layer.handle_event(
                events.DataReceived(
                    client,
                    b"GET /repos HTTP/1.1\r\nHost: " + oversized_host + b"\r\n\r\n",
                )
            )
        )
        request_headers_hook = next(
            command for command in initial_commands if isinstance(command, HttpRequestHeadersHook)
        )
        flow = request_headers_hook.flow
        original_headers = tuple(flow.request.headers.fields)
        original_head = http1.assemble_request_head(flow.request)
        assert flow.request.host == "203.0.113.10"
        assert flow.request.port == 443
        assert flow.client_conn.sni == "api.github.com"
        assert [
            value for name, value in flow.request.headers.fields if name.lower() == b"host"
        ] == [oversized_host]

        real_get_all = http.Headers.get_all
        real_normalize_hostname = request_authority.normalize_hostname

        def reject_host_string_access(headers: http.Headers, name: str) -> list[str]:
            if name.lower() == "host":
                raise AssertionError("over-budget Host must not reach string access")
            return real_get_all(headers, name)

        def normalize_trusted_sni(host: str) -> str:
            assert host == "api.github.com"
            return real_normalize_hostname(host)

        with (
            patch.object(http.Headers, "get_all", reject_host_string_access),
            patch.object(
                request_authority,
                "normalize_hostname",
                side_effect=normalize_trusted_sni,
            ),
        ):
            await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
            get_headers.assert_not_awaited()
            assert flow.response is None
            assert tuple(flow.request.headers.fields) == original_headers
            assert http1.assemble_request_head(flow.request) == original_head

            header_commands = list(
                http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
            )
            request_hook = next(
                command for command in header_commands if isinstance(command, HttpRequestHook)
            )
            await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
            request_commands = list(
                http_layer.handle_event(events.HookCompleted(request_hook, None))
            )

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.content is not None
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["host_header"] is None
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert tuple(flow.request.headers.fields) == original_headers
    assert http1.assemble_request_head(flow.request) == original_head
    assert "Authorization" not in flow.request.headers
    get_headers.assert_not_awaited()
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in request_commands
    )


async def test_http2_duplicate_host_is_rejected_before_auth_or_http1_downgrade(
    tmp_path: Path,
    fake_firewall_headers,
) -> None:
    registry_path = _write_github_firewall_registry(
        tmp_path,
        base=f"https://{PLACEHOLDER_HOST}",
        sandbox_fields={"captureNetworkBodies": True},
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-secret"}) as get_headers,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = start_http2_request(
            addon_context,
            method="GET",
            end_stream=True,
            regular_headers=(
                (b"host", b"attacker.example.com"),
                (b"host", PLACEHOLDER_HOST.encode()),
            ),
        )
        flow = request_headers_hook.flow
        original_headers = tuple(flow.request.headers.fields)
        original_path = flow.request.path

        assert flow.request.host_header == PLACEHOLDER_HOST
        assert flow.request.headers.get_all("Host") == [
            "attacker.example.com",
            PLACEHOLDER_HOST,
        ]

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)

        get_headers.assert_not_awaited()
        assert tuple(flow.request.headers.fields) == original_headers
        assert flow.request.path == original_path

        header_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        request_hook = next(
            command for command in header_commands if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

        request_commands = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.content is not None
    assert json.loads(flow.response.content)["error"] == "invalid_authority"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.path == original_path
    get_headers.assert_not_awaited()
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in request_commands
    )


@pytest.mark.parametrize(
    ("port", "authority", "expected_reason", "expected_original_url"),
    [
        pytest.param(
            443,
            "attacker.example",
            "authority_mismatch",
            "https://api.github.com/repos",
            id="host-mismatch",
        ),
        pytest.param(
            8443,
            "api.github.com",
            "authority_port_mismatch",
            "https://api.github.com:8443/repos",
            id="implicit-default-port-mismatch",
        ),
    ],
)
async def test_http1_absolute_form_authority_is_rejected_before_auth_or_forwarding(
    tmp_path: Path,
    fake_firewall_headers,
    port: int,
    authority: str,
    expected_reason: str,
    expected_original_url: str,
) -> None:
    firewall_base = "https://api.github.com" if port == 443 else f"https://api.github.com:{port}"
    registry_path = _write_github_firewall_registry(
        tmp_path,
        base=firewall_base,
        sandbox_fields={"captureNetworkBodies": True},
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-secret"}) as get_headers,
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = _start_transparent_http1_absolute_request(
            addon_context,
            authority=authority,
            port=port,
        )
        flow = request_headers_hook.flow
        original_head = http1.assemble_request_head(flow.request)

        assert flow.request.scheme == "https"
        assert flow.request.host == "203.0.113.10"
        assert flow.request.port == port
        assert flow.request.host_header == "api.github.com"
        assert flow.request.authority == authority

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)

        get_headers.assert_not_awaited()
        assert http1.assemble_request_head(flow.request) == original_head

        header_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        request_hook = next(
            command for command in header_commands if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

        request_commands = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.response.content is not None
    assert json.loads(flow.response.content)["error"] == expected_reason
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_reason
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == expected_original_url
    assert http1.assemble_request_head(flow.request) == original_head
    assert "Authorization" not in flow.request.headers
    get_headers.assert_not_awaited()
    assert not any(
        isinstance(command, (commands.OpenConnection, commands.SendData))
        and isinstance(command.connection, connection.Server)
        for command in request_commands
    )


async def test_matching_http1_absolute_form_authority_is_forwardable_with_auth(
    tmp_path: Path,
    fake_firewall_headers,
) -> None:
    registry_path = _write_github_firewall_registry(
        tmp_path,
        base="https://api.github.com",
        sandbox_fields={"captureNetworkBodies": True},
    )

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers(headers={"Authorization": "Bearer managed-secret"}),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        http_layer, request_headers_hook = _start_transparent_http1_absolute_request(
            addon_context,
            authority="API.GITHUB.COM.:443",
        )
        flow = request_headers_hook.flow

        assert flow.request.host == "203.0.113.10"
        assert flow.request.host_header == "api.github.com"
        assert flow.request.authority == "API.GITHUB.COM.:443"

        await addon_context.master.addons.invoke_addon(mitm_addon, request_headers_hook)
        header_commands = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        request_hook = next(
            command for command in header_commands if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)
        request_commands = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))

    assert flow.response is None
    assert flow.error is None
    open_connections = [
        command for command in request_commands if isinstance(command, commands.OpenConnection)
    ]
    assert len(open_connections) == 1
    assert open_connections[0].connection.address == ("203.0.113.10", 443)
    assert flow.request.authority == "API.GITHUB.COM.:443"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert flow.request.headers["Authorization"] == "Bearer managed-secret"
    forwarded_head = http1.assemble_request_head(flow.request)
    assert forwarded_head.startswith(b"GET https://API.GITHUB.COM.:443/repos HTTP/1.1\r\n")
    assert b"Host: api.github.com\r\n" in forwarded_head
    assert b"Authorization: Bearer managed-secret\r\n" in forwarded_head
