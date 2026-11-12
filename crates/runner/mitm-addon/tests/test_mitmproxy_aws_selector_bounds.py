"""AWS selector work bounds through genuine native HTTP request hooks."""

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import auth
import aws_sigv4_body_admission
import aws_sigv4_flow
import matching
import mitm_addon
from tests.aws_sigv4_helpers import aws_sigv4_authorization, aws_sigv4_header_auth_headers
from tests.firewall_aws_sigv4_helpers import aws_api_entry
from tests.firewall_helpers import firewall_permission
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry

_HOST = "s3.example.com"


@pytest.mark.parametrize(
    "case",
    ["target-exact", "target-over", "dense-query", "headers-exact", "headers-over"],
)
async def test_mixed_aws_rules_respect_raw_inspection_bounds(tmp_path: Path, case: str) -> None:
    api = dict(aws_api_entry(base=f"https://{_HOST}"))
    api["permissions"] = [
        firewall_permission("ordinary", "GET /files/a"),
        firewall_permission("restricted", "GET /files/%61 AWS sigv4=s3"),
    ]
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="aws",
            api_entry=api,
            network_policy={
                "allow": ["ordinary"],
                "deny": ["restricted"],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    target = b"/files/a?X-Amz-Security-Token=padding"
    if case.startswith("target-"):
        size = aws_sigv4_flow.MAX_AWS_SIGV4_REQUEST_TARGET_BYTES + int(case.endswith("over"))
        target += b"x" * (size - len(target))
        assert len(target) == size
    elif case == "dense-query":
        target = b"/files/a?" + b"&".join([b"x=1"] * 262_144)

    fields = [
        (name.encode(), value.encode())
        for name, value in aws_sigv4_header_auth_headers(
            host=_HOST, authorization=aws_sigv4_authorization(service="s3")
        )
    ]
    fields.append((b"Content-Length", b"0"))
    overhead = aws_sigv4_flow.AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES
    if case.startswith("headers-"):
        size = aws_sigv4_flow.MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES + int(case.endswith("over"))
        used = sum(len(name) + len(value) + overhead for name, value in fields)
        fields.append((b"X-Padding", b"x" * (size - used - len(b"X-Padding") - overhead)))
        assert sum(len(name) + len(value) + overhead for name, value in fields) == size
    available = case.endswith("exact")
    auth_fetch = AsyncMock()
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        patch.object(auth, "get_firewall_headers", auth_fetch),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        client, native = start_http_layer(context, alpn=b"http/1.1", host=_HOST)
        head = (
            b"GET https://"
            + _HOST.encode()
            + target
            + b" HTTP/1.1\r\n"
            + b"".join(name + b": " + value + b"\r\n" for name, value in fields)
            + b"\r\n"
        )
        history = []
        for offset in range(0, len(head), 16 * 1024):
            history.extend(
                native.handle_event(events.DataReceived(client, head[offset : offset + 16 * 1024]))
            )
        [hook] = [command for command in history if isinstance(command, HttpRequestHeadersHook)]
        flow = hook.flow
        assert flow.request.data.path == target
        original_headers = flow.request.headers.fields
        # Observe real selector allocations only after the native parser has
        # constructed the request. The signing parser has its own bounded work.
        with patch.object(matching, "parse_qsl", wraps=matching.parse_qsl) as selector_parse:
            await context.master.addons.invoke_addon(mitm_addon, hook)
            assert selector_parse.call_count == int(available)
            auth_fetch.assert_not_awaited()
            assert flow.request.data.path == target
            assert flow.request.headers.fields == original_headers
            if not available:
                # Ordinary matching stays allowed at this checkpoint; stop
                # before body-complete auth/signing with a fixture-owned reply.
                assert flow.response is None
                flow.response = http.Response.make(200, b"local checkpoint")
            pending = list(native.handle_event(events.HookCompleted(hook)))
            while pending:
                command = pending.pop(0)
                history.append(command)
                if isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    pending.extend(native.handle_event(events.HookCompleted(command)))
            if available:
                # A matching denied alias must still reject the ordinary route.
                assert any(isinstance(command, HttpRequestHook) for command in history)
                assert flow.response is not None
                assert flow.response.status_code == 403
                assert flow.response.json()["reason"] == "unsafe_path"
            else:
                assert selector_parse.call_count == 0
        auth_fetch.assert_not_awaited()
        assert not any(
            isinstance(command, (commands.OpenConnection, commands.SendData))
            and isinstance(command.connection, connection.Server)
            for command in history
        )
        client_bytes = b"".join(
            command.data
            for command in history
            if isinstance(command, commands.SendData) and command.connection is client
        )
        assert client_bytes.startswith(b"HTTP/1.1 403" if available else b"HTTP/1.1 200")
        assert not native.streams
        assert flow.live is False
        assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
