"""Unicode work bounds through real header and request classification hooks."""

import json
import unicodedata
import urllib.parse
from collections import deque
from pathlib import Path
from typing import Literal
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._hooks import (
    HttpErrorHook,
    HttpRequestHeadersHook,
    HttpRequestHook,
)
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.mitmproxy_http_framing_helpers import start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result


@pytest.fixture
def path_firewall_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )


async def _complete_http_hooks(
    addon_context: taddons.context,
    http_layer: HttpLayer,
    event: events.Event,
) -> list[commands.Command]:
    pending = deque(http_layer.handle_event(event))
    observed: list[commands.Command] = []
    while pending:
        command = pending.popleft()
        observed.append(command)
        if isinstance(command, commands.StartHook):
            await addon_context.master.addons.invoke_addon(mitm_addon, command)
            pending.extend(http_layer.handle_event(events.HookCompleted(command, None)))
    return observed


@pytest.mark.parametrize("framing", ["bodyless", "chunked"])
@pytest.mark.parametrize(
    ("segment", "decode_passes"),
    [
        pytest.param("a" + "\u0315\u0300" * 16000, 0, id="long-alternating"),
        pytest.param("a" + "\u0300" * 16000 + "\u0315" * 16000, 0, id="long-ordered"),
        pytest.param("a" + "\u0315\u0300" * 4096, 1, id="long-percent-encoded"),
        pytest.param("\u0300" * 31, 0, id="leading-nonstarters"),
        pytest.param("a" + "\u0344" * 16, 0, id="decomposition-expansion"),
        pytest.param("a" + "\u0f73" * 16, 0, id="class-zero-decomposition"),
        pytest.param("a" + "\uff9e" * 31, 0, id="compatibility-nonstarter"),
        pytest.param("\u00e9" + "\u0300" * 30, 0, id="precomposed-trailing-mark"),
        pytest.param("a" + "\u0315\u0300" * 16, 2, id="nested-percent-encoded"),
        pytest.param("a" + "\u0f73" * 16, 5, id="final-decode-pass"),
        pytest.param("a" + "\u0300" * 15 + "%CC%80" * 16, 0, id="mixed-raw-and-encoded"),
    ],
)
async def test_path_normalization_budget_blocks_before_unbounded_work(
    path_firewall_registry,
    fake_firewall_headers,
    monkeypatch: pytest.MonkeyPatch,
    segment: str,
    decode_passes: int,
    framing: str,
):
    encoded_segment = segment
    for _ in range(decode_passes):
        encoded_segment = urllib.parse.quote(encoded_segment, safe="")
    path = f"/repos/{encoded_segment}"
    assert len(path) < 65536
    normalize = unicodedata.normalize
    rejected_segment = urllib.parse.unquote(segment)
    decomposed_characters = 0

    def bounded_normalize(form: Literal["NFC", "NFD", "NFKC", "NFKD"], text: str) -> str:
        nonlocal decomposed_characters
        if form == "NFKD":
            assert len(text) == 1, "budget checks must only decompose single code points"
            decomposed_characters += 1
        else:
            assert text != rejected_segment, "rejected segments must not reach normalization"
        return normalize(form, text)

    monkeypatch.setattr(unicodedata, "normalize", bounded_normalize)
    with (
        patch.object(mitm_addon, "__file__", str(path_firewall_registry.parent / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        fake_firewall_headers() as auth_fetch,
    ):
        addon_context.options.update(okou_proxy_registry_path=str(path_firewall_registry))
        client, http_layer = start_http_layer(
            addon_context,
            alpn=b"http/1.1",
            host="api.github.com",
            mode=HTTPMode.transparent,
        )
        body_headers = (
            "Transfer-Encoding: chunked\r\nExpect: 100-continue\r\n" if framing == "chunked" else ""
        )
        request_head = (
            f"GET {path} HTTP/1.1\r\nHost: api.github.com\r\n{body_headers}\r\n"
        ).encode()
        observed = list(http_layer.handle_event(events.DataReceived(client, request_head)))
        headers_hook = next(
            command for command in observed if isinstance(command, HttpRequestHeadersHook)
        )
        flow = headers_hook.flow
        await addon_context.master.addons.invoke_addon(mitm_addon, headers_hook)
        header_characters = decomposed_characters
        assert header_characters > 0
        assert "Authorization" not in flow.request.headers

        observed.extend(
            await _complete_http_hooks(
                addon_context, http_layer, events.HookCompleted(headers_hook, None)
            )
        )
        client_bytes = b"".join(
            command.data
            for command in observed
            if isinstance(command, commands.SendData) and command.connection is client
        )
        if framing == "bodyless":
            assert decomposed_characters > header_characters
            assert sum(isinstance(command, HttpRequestHook) for command in observed) == 1
            assert not any(isinstance(command, HttpErrorHook) for command in observed)
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert flow.response.content is not None
            assert json.loads(flow.response.content)["reason"] == "unsafe_path"
            assert client_bytes.startswith(b"HTTP/1.1 403")
        else:
            assert decomposed_characters == header_characters
            assert not any(isinstance(command, HttpRequestHook) for command in observed)
            assert sum(isinstance(command, HttpErrorHook) for command in observed) == 1
            assert flow.error is not None
            assert flow.response is None
            assert flow.request.raw_content is None
            assert any(
                isinstance(command, commands.CloseConnection) and command.connection is client
                for command in observed
            )
            assert client_bytes == b""

    auth_fetch.assert_not_called()
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.request.path == path
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    "segment",
    [
        pytest.param("a" + "\u0315\u0300" * 15, id="at-limit"),
        pytest.param("\u0300" * 30, id="leading-at-limit"),
        pytest.param("a" + "\u0344" * 15, id="expansion-at-limit"),
        pytest.param("a" + "\u0f73" * 15, id="class-zero-at-limit"),
        pytest.param("\u00e9" + "\u0300" * 29, id="precomposed-at-limit"),
        pytest.param(("a" + "\u0315\u0300" * 15) * 1000, id="starter-resets"),
        pytest.param("\u6587" * 32000, id="long-unicode"),
        pytest.param(
            "caf\u00e9/\u6587\u6863/\uac01/\U0001f469\u200d\U0001f4bb", id="ordinary-unicode"
        ),
        pytest.param("caf%C3%A9/%E6%96%87%E6%A1%A3", id="encoded-unicode"),
    ],
)
async def test_path_normalization_budget_preserves_supported_requests(
    path_firewall_registry, real_flow, mitm_ctx, fake_firewall_headers, segment: str
):
    path = f"/repos/{segment}"
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com", path=path)
    with (
        mitm_ctx(registry_path=str(path_firewall_registry)),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    assert flow.request.path == path
