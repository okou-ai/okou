"""Codex catalog framing tests through mitmproxy's real hook pipeline."""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

import brotli  # type: ignore[import-untyped]
from h2 import events as h2_events
from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer, HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import (
    ResponseData,
    ResponseEndOfMessage,
    ResponseHeaders,
)
from mitmproxy.proxy.layers.http._hooks import (
    HttpRequestHeadersHook,
    HttpRequestHook,
    HttpResponseHeadersHook,
    HttpResponseHook,
)
from mitmproxy.test import taddons, tutils

import auth
import codex_model_catalog_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
from tests.codex_model_catalog_cache_helpers import catalog_flow
from tests.firewall_auth_helpers import firewall_auth_response
from tests.flow_helpers import header_map, response_stream
from tests.mitmproxy_http_framing_helpers import CLIENT_IP, start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


def _write_codex_firewall_registry(tmp_path: Path) -> Path:
    firewall_name = "model-provider:codex-oauth-token"
    return _write_registry(
        tmp_path,
        client_ip=CLIENT_IP,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-catalog-state-machine",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://chatgpt.com/backend-api/codex",
                "auth": {
                    "headers": {
                        "Authorization": "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
                        "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
                    }
                },
                "permissions": [
                    {
                        "name": "codex:api",
                        "rules": ["GET /{path*}", "POST /{path*}"],
                    }
                ],
            },
            network_policy={
                "allow": ["codex:api"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={
                "captureNetworkBodies": True,
                "cliAgentType": "codex",
            },
        ),
    )


def _start_http2_request_with_client(
    addon_context: taddons.context,
    *,
    host: str,
    path: str,
) -> tuple[connection.Client, H2Connection, HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = start_http_layer(addon_context, alpn=b"h2", host=host)
    http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
    http2.initiate_connection()
    http2.send_headers(
        1,
        [
            (b":method", b"GET"),
            (b":scheme", b"https"),
            (b":authority", host.encode()),
            (b":path", path.encode()),
        ],
        end_stream=True,
    )
    layer_commands = list(
        http_layer.handle_event(events.DataReceived(client, http2.data_to_send()))
    )
    request_headers_hook = next(
        command for command in layer_commands if isinstance(command, HttpRequestHeadersHook)
    )
    return client, http2, http_layer, request_headers_hook


async def test_http2_fresh_catalog_hit_completes_without_provider_connection(
    tmp_path: Path,
    real_flow,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_url = f"https://chatgpt.com{catalog_path}"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'
    resolved_headers = {
        "Authorization": "Bearer resolved-access",
        "ChatGPT-Account-ID": "resolved-account",
    }

    seed_flow = real_flow(
        with_response=False,
        host="chatgpt.com",
        method="GET",
        path=catalog_path,
        request_headers=header_map(
            {
                "Host": "chatgpt.com",
                "Content-Length": "0",
                **resolved_headers,
            }
        ),
    )
    seed_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-catalog-seed"
    seed_flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    seed_flow.metadata[metadata_keys.ORIGINAL_URL] = catalog_url
    await codex_model_catalog_cache.prepare_request(seed_flow, request_end_stream=True)
    seed_flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "Content-Type": "application/json",
                "Content-Length": str(len(catalog_body)),
                "ETag": '"catalog-v1"',
            }
        ),
        content=catalog_body,
    )
    mitm_addon.responseheaders(seed_flow)
    assert response_stream(seed_flow)(catalog_body) == catalog_body
    finalization = codex_model_catalog_cache.finalize_response(seed_flow)
    assert finalization is not None
    await finalization
    codex_model_catalog_cache.release_flow_state(seed_flow)
    response_streaming.release_response_stream_state(seed_flow)

    registry_path = _write_codex_firewall_registry(tmp_path)
    token_meta = firewall_auth_response(
        headers=resolved_headers,
    )
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=token_meta)),
    ):
        addon_context.options.update(
            okou_api_url="https://api.okou.ai",
            okou_proxy_registry_path=str(registry_path),
        )
        client, http2, http_layer, request_headers_hook = _start_http2_request_with_client(
            addon_context,
            host="chatgpt.com",
            path=catalog_path,
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            request_headers_hook,
        )
        flow = request_headers_hook.flow
        assert flow.response is not None
        assert flow.response.content == catalog_body

        all_commands: list[commands.Command] = []
        after_request_headers = list(
            http_layer.handle_event(events.HookCompleted(request_headers_hook, None))
        )
        all_commands.extend(after_request_headers)
        request_hook = next(
            command for command in after_request_headers if isinstance(command, HttpRequestHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, request_hook)

        after_request = list(http_layer.handle_event(events.HookCompleted(request_hook, None)))
        all_commands.extend(after_request)
        response_headers_hook = next(
            command for command in after_request if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        response = flow.response
        assert response is not None
        assert response.stream is False

        after_response_headers = list(
            http_layer.handle_event(events.HookCompleted(response_headers_hook, None))
        )
        all_commands.extend(after_response_headers)
        response_hook = next(
            command for command in after_response_headers if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)

        after_response = list(http_layer.handle_event(events.HookCompleted(response_hook, None)))
        all_commands.extend(after_response)

    assert not any(isinstance(command, commands.OpenConnection) for command in all_commands)
    client_bytes = b"".join(
        command.data
        for command in all_commands
        if isinstance(command, commands.SendData) and command.connection is client
    )
    response_events = http2.receive_data(client_bytes)
    assert any(
        isinstance(event, h2_events.ResponseReceived) and dict(event.headers)[b":status"] == b"200"
        for event in response_events
    )
    assert (
        b"".join(
            event.data for event in response_events if isinstance(event, h2_events.DataReceived)
        )
        == catalog_body
    )
    assert any(isinstance(event, h2_events.StreamEnded) for event in response_events)


async def _catalog_http_stream(
    addon_context: taddons.context,
    *,
    catalog_path: str,
    prefetch: bool = False,
) -> tuple[HttpStream, http.HTTPFlow]:
    _, http_layer = start_http_layer(
        addon_context,
        alpn=b"h2",
        host="chatgpt.com",
    )
    stream = HttpStream(http_layer.context.fork(), 1)
    list(stream.handle_event(events.Start()))

    request = tutils.treq(
        scheme=b"https",
        method=b"GET",
        host=b"chatgpt.com",
        port=443,
        path=catalog_path.encode(),
        content=b"",
        headers=header_map(
            {
                "Host": "chatgpt.com",
                "Content-Length": "0",
                "Authorization": "Bearer resolved-access",
                "ChatGPT-Account-ID": "resolved-account",
                "Accept-Encoding": "identity",
            }
        ),
    )
    flow = http.HTTPFlow(stream.context.client, stream.context.server)
    flow.request = request
    flow.live = True
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-catalog-state-machine"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = ""
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:codex-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = f"https://chatgpt.com{catalog_path}"
    if prefetch:
        flow.request.headers["X-Okou-Codex-Model-Catalog-Prefetch"] = "1"
        codex_model_catalog_cache.capture_and_strip_prefetch_marker(flow)
    await codex_model_catalog_cache.prepare_request(flow, request_end_stream=True)
    assert flow.request.headers["Accept-Encoding"] == ("br" if prefetch else "identity")
    assert "X-Okou-Codex-Model-Catalog-Prefetch" not in flow.request.headers
    assert "If-None-Match" not in flow.request.headers

    stream.flow = flow
    stream.client_state = stream.state_done
    stream.server_state = stream.state_wait_for_response_headers
    return stream, flow


async def test_http2_prefetch_brotli_catalog_is_streamed_unchanged_while_cached(
    tmp_path: Path,
    real_flow,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'
    compressed_body = brotli.compress(catalog_body)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
            prefetch=True,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert callable(flow.response.stream)
        assert flow.response.headers["Content-Encoding"] == "br"
        assert "Content-Length" not in flow.response.headers

        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        assert any(
            isinstance(command, SendHttp)
            and isinstance(command.event, ResponseHeaders)
            and command.event.response.status_code == 200
            for command in after_headers
        )

        follower = catalog_flow(
            real_flow,
            version="0.145.0",
            auth_value="resolved-access",
            account="resolved-account",
        )
        follower_prepare = asyncio.create_task(
            codex_model_catalog_cache.prepare_request(follower, request_end_stream=True)
        )
        await asyncio.sleep(0)
        assert not follower_prepare.done()
        assert follower.request.headers["Accept-Encoding"] == "identity"

        body_commands = list(stream.handle_event(ResponseData(1, compressed_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == compressed_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        assert flow.response.status_code == 200
        assert flow.response.headers["Content-Encoding"] == "br"
        assert "Content-Length" not in flow.response.headers

        await asyncio.wait_for(follower_prepare, timeout=0.1)
        assert follower.response is not None
        assert follower.response.content == catalog_body
        assert "Content-Encoding" not in follower.response.headers
        follower_telemetry: dict[str, object] = {}
        codex_model_catalog_cache.add_network_log_fields(follower, follower_telemetry)
        assert follower_telemetry["model_catalog_prefetch_role"] == "inflight_consumer"

        cache_hit = catalog_flow(
            real_flow,
            version="0.145.0",
            auth_value="resolved-access",
            account="resolved-account",
        )
        await codex_model_catalog_cache.prepare_request(cache_hit, request_end_stream=True)
        assert cache_hit.response is not None
        assert cache_hit.response.content == catalog_body
        codex_model_catalog_cache.release_flow_state(follower)
        codex_model_catalog_cache.release_flow_state(cache_hit)

        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert any(
        isinstance(event, ResponseHeaders)
        and event.response.status_code == 200
        and event.response.headers["Content-Encoding"] == "br"
        for event in client_events
    )
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == compressed_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


async def test_http2_ordinary_identity_catalog_is_streamed_unchanged_while_cached(
    tmp_path: Path,
    real_flow,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_headers_hook)
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert callable(flow.response.stream)
        assert "Content-Encoding" not in flow.response.headers
        assert "Content-Length" not in flow.response.headers

        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        body_commands = list(stream.handle_event(ResponseData(1, catalog_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == catalog_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

        cache_hit = catalog_flow(
            real_flow,
            version="0.145.0",
            auth_value="resolved-access",
            account="resolved-account",
        )
        await codex_model_catalog_cache.prepare_request(cache_hit, request_end_stream=True)
        assert cache_hit.response is not None
        assert cache_hit.response.content == catalog_body
        codex_model_catalog_cache.release_flow_state(cache_hit)

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert any(
        isinstance(event, ResponseHeaders)
        and event.response.status_code == 200
        and "Content-Encoding" not in event.response.headers
        for event in client_events
    )
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == catalog_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


async def test_http2_ordinary_catalog_rejects_unsolicited_brotli_before_body(
    tmp_path: Path,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    compressed_body = brotli.compress(b'{"models":[{"slug":"gpt-test"}]}')

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(compressed_body)),
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_headers_hook)
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert "Content-Encoding" not in flow.response.headers

        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        body_commands = list(stream.handle_event(ResponseData(1, compressed_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == b""
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert any(
        isinstance(event, ResponseHeaders)
        and event.response.status_code == 502
        and "Content-Encoding" not in event.response.headers
        for event in client_events
    )
    assert b"".join(event.data for event in client_events if isinstance(event, ResponseData)) == b""
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


async def test_http2_invalid_brotli_catalog_passes_through_without_cache_rewrite(
    tmp_path: Path,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    catalog_body = b'{"models":[{"slug":"gpt-test"}]}'
    truncated_body = brotli.compress(catalog_body)[:-1]

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
            prefetch=True,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(truncated_body)),
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        response = flow.response
        assert response is not None
        assert response.status_code == 200
        assert callable(response.stream)
        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        assert any(
            isinstance(command, SendHttp)
            and isinstance(command.event, ResponseHeaders)
            and command.event.response.status_code == 200
            for command in after_headers
        )

        body_commands = list(stream.handle_event(ResponseData(1, truncated_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == truncated_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )

        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        assert flow.response is not None
        assert flow.response.status_code == 200
        assert flow.response.headers["Content-Encoding"] == "br"
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert any(
        isinstance(event, ResponseHeaders) and event.response.status_code == 200
        for event in client_events
    )
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == truncated_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)


async def test_http2_unbounded_brotli_catalog_is_passed_through_but_not_retained(
    tmp_path: Path,
) -> None:
    catalog_path = "/backend-api/codex/models?client_version=0.145.0"
    oversized_body = b"x" * (codex_model_catalog_cache.MAX_ENTRY_BYTES + 1)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
    ):
        stream, flow = await _catalog_http_stream(
            addon_context,
            catalog_path=catalog_path,
            prefetch=True,
        )
        upstream_response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "Content-Type": "application/json",
                    "Content-Encoding": "br",
                    "ETag": '"catalog-v1"',
                }
            ),
        )
        response_header_commands = list(
            stream.handle_event(ResponseHeaders(1, upstream_response, end_stream=False))
        )
        response_headers_hook = next(
            command
            for command in response_header_commands
            if isinstance(command, HttpResponseHeadersHook)
        )
        await addon_context.master.addons.invoke_addon(
            mitm_addon,
            response_headers_hook,
        )
        response = flow.response
        assert response is not None
        assert response.status_code == 200
        assert callable(response.stream)

        after_headers = list(stream.handle_event(events.HookCompleted(response_headers_hook, None)))
        assert any(
            isinstance(command, SendHttp)
            and isinstance(command.event, ResponseHeaders)
            and command.event.response.status_code == 200
            for command in after_headers
        )

        body_commands = list(stream.handle_event(ResponseData(1, oversized_body)))
        assert (
            b"".join(
                command.event.data
                for command in body_commands
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == oversized_body
        )

        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        response_hook = next(
            command for command in end_commands if isinstance(command, HttpResponseHook)
        )
        await addon_context.master.addons.invoke_addon(mitm_addon, response_hook)
        after_response = list(stream.handle_event(events.HookCompleted(response_hook, None)))

    client_commands = [*after_headers, *body_commands, *end_commands, *after_response]
    client_events = [command.event for command in client_commands if isinstance(command, SendHttp)]
    assert (
        b"".join(event.data for event in client_events if isinstance(event, ResponseData))
        == oversized_body
    )
    assert any(isinstance(event, ResponseEndOfMessage) for event in client_events)
