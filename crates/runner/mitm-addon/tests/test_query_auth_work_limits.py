"""Ordinary query-auth work admission through public and native HTTP hooks."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse

import pytest
from mitmproxy import connection, http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook, HttpRequestHook
from mitmproxy.test import taddons

import auth
import firewall_auth_cache
import flow_metadata_keys as metadata_keys
import managed_upload
import mitm_addon
from tests.firewall_auth_helpers import firewall_auth_success
from tests.mitmproxy_http_framing_helpers import CLIENT_IP, start_http_layer
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_HOST = "api.example.com"
_RESOLVED_HEADERS = {"Authorization": "Bearer synthetic-resolved"}
_RESOLVED_QUERY = {"api_key": "synthetic-resolved"}


def _query_registry(tmp_path: Path, *, query_auth: bool = True) -> Path:
    auth_config: dict = {"headers": {"Authorization": "Bearer ${{ secrets.TOKEN }}"}}
    if query_auth:
        auth_config["query"] = {"api_key": "${{ secrets.TOKEN }}"}
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": f"https://{_HOST}",
                "auth": auth_config,
                "permissions": [{"name": "read", "rules": ["GET /{path+}"]}],
            },
            network_policy={"allow": ["read"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )


@pytest.fixture
def query_io(monkeypatch):
    """Observe the real dependency allocation/writeback boundary, never replace it."""
    counts = [0, 0]
    original_get = http.Request._get_query
    original_set = http.Request._set_query

    def get_query(request):
        counts[0] += 1
        return original_get(request)

    def set_query(request, values):
        counts[1] += 1
        return original_set(request, values)

    monkeypatch.setattr(http.Request, "_get_query", get_query)
    monkeypatch.setattr(http.Request, "_set_query", set_query)
    return counts


def _budget_target(case: str) -> bytes:
    if case.startswith("target-"):
        prefix = b"/items?q="
        size = auth.MAX_QUERY_AUTH_REQUEST_TARGET_BYTES + int(case.endswith("over"))
        remaining = size - len(prefix)
        value = (
            b"\xc3\xa9" * (remaining // 2) + b"x" * (remaining % 2)
            if "utf8" in case
            else b"x" * remaining
        )
        return prefix + value
    if case == "no-client-query":
        return b"/items"
    if case == "empty-client-query":
        return b"/items?"
    if case == "separator-data":
        return b"/items?q=" + b";%26" * auth.MAX_QUERY_AUTH_QUERY_PAIRS
    if case == "fragment-separators":
        return b"/items?x=1#" + b"&" * auth.MAX_QUERY_AUTH_QUERY_PAIRS
    if case == "dense-query":
        return b"/items?" + b"&".join([b"x=1"] * 262_144)
    client_pairs = (
        auth.MAX_QUERY_AUTH_QUERY_PAIRS
        - 1
        + int(case.endswith("over") or case == "incomplete-upload")
    )
    query = (
        b"api%5Fkey=client" + b"&" * (client_pairs - 1)
        if case.startswith("empty-shadowed-")
        else b"&".join([b"x=1"] * client_pairs)
    )
    return b"/items?" + query


@pytest.mark.parametrize(
    ("hook_phase", "case"),
    [
        (hook_phase, case)
        for hook_phase in ("requestheaders", "request")
        for case in (
            "target-exact",
            "target-over",
            "target-utf8-exact",
            "target-utf8-over",
            "pairs-exact",
            "pairs-over",
            "empty-shadowed-exact",
            "empty-shadowed-over",
            "no-client-query",
            "empty-client-query",
            "separator-data",
            "fragment-separators",
            "dense-query",
        )
    ]
    + [("requestheaders", "incomplete-upload")],
)
async def test_native_query_auth_work_boundary(tmp_path, real_flow, query_io, hook_phase, case):
    registry_path = _query_registry(tmp_path)
    auth_fetch = AsyncMock(
        return_value=firewall_auth_success(headers=_RESOLVED_HEADERS, query=_RESOLVED_QUERY)
    )
    target = _budget_target(case)
    rejected = case.endswith("over") or case in ("dense-query", "incomplete-upload")
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        patch.object(firewall_auth_cache, "fetch_firewall_headers", auth_fetch),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry_path)
        )
        # Warm the actual cache through a public hook. The measured native
        # request must not need a second external credential fetch.
        warm = real_flow(with_response=False, client_ip=CLIENT_IP, host=_HOST, path="/items?warm=1")
        await mitm_addon.request(warm)
        assert warm.response is None
        assert warm.request.headers["Authorization"] == _RESOLVED_HEADERS["Authorization"]
        assert warm.metadata[metadata_keys.AUTH_CACHE_HIT] is False
        warm.response = http.Response.make(200, b"ok")
        mitm_addon.response(warm)
        query_io[:] = [0, 0]

        client, native = start_http_layer(context, alpn=b"http/1.1", host=_HOST)
        framing = b"Content-Length: 0\r\n" if hook_phase == "request" else b""
        if case == "incomplete-upload":
            # No upload bytes or EOF will arrive. The header policy must still
            # deliver its 414 and release the flow rather than falling back.
            framing = b"Content-Length: 1048576\r\n"
        head = (
            b"GET https://"
            + _HOST.encode()
            + target
            + b" HTTP/1.1\r\nHost: "
            + _HOST.encode()
            + b"\r\nAuthorization: client-value\r\n"
            + framing
            + b"\r\n"
        )
        history = []
        for offset in range(0, len(head), 16 * 1024):
            history.extend(
                native.handle_event(events.DataReceived(client, head[offset : offset + 16 * 1024]))
            )
        [headers_hook] = [cmd for cmd in history if isinstance(cmd, HttpRequestHeadersHook)]
        flow = headers_hook.flow
        assert flow.request.data.path == target
        original_headers = flow.request.headers.fields
        await context.master.addons.invoke_addon(mitm_addon, headers_hook)
        subject_hook = headers_hook
        if hook_phase == "request":
            assert query_io == [0, 0]
            pending = list(native.handle_event(events.HookCompleted(headers_hook)))
            history.extend(pending)
            [subject_hook] = [cmd for cmd in pending if isinstance(cmd, HttpRequestHook)]
            await context.master.addons.invoke_addon(mitm_addon, subject_hook)

        auth_fetch.assert_awaited_once()
        if rejected:
            assert query_io == [0, 0]
            assert flow.request.data.path == target
            assert flow.request.headers.fields == original_headers
            assert flow.response is not None
            assert flow.response.status_code == 414
            error_code = (
                "query_auth_request_target_too_large"
                if case.startswith("target-") or case == "dense-query"
                else "query_auth_query_too_many_pairs"
            )
            assert flow.response.content is not None
            assert json.loads(flow.response.content)["error"] == error_code
        else:
            assert flow.response is None
            assert query_io == [1, 1]
            assert flow.metadata[metadata_keys.AUTH_CACHE_HIT] is True
            assert flow.request.headers["Authorization"] == _RESOLVED_HEADERS["Authorization"]
            assert flow.request.query["api_key"] == _RESOLVED_QUERY["api_key"]
            if case == "pairs-exact":
                assert flow.request.query.get_all("x") == ["1"] * (
                    auth.MAX_QUERY_AUTH_QUERY_PAIRS - 1
                )
            # Stop accepted cases at the admission boundary with a local reply;
            # no real provider is involved in this native parser regression.
            flow.response = http.Response.make(200, b"ok")

        pending = list(native.handle_event(events.HookCompleted(subject_hook)))
        while pending:
            command = pending.pop(0)
            history.append(command)
            if isinstance(command, commands.StartHook):
                await context.master.addons.invoke_addon(mitm_addon, command)
                pending.extend(native.handle_event(events.HookCompleted(command)))
        client_bytes = b"".join(
            command.data
            for command in history
            if isinstance(command, commands.SendData) and command.connection is client
        )
        assert client_bytes.startswith(b"HTTP/1.1 414" if rejected else b"HTTP/1.1 200")
        assert not any(
            isinstance(command, (commands.OpenConnection, commands.SendData))
            and isinstance(command.connection, connection.Server)
            for command in history
        )
        assert flow.live is False
        assert flow.error is None
        assert managed_upload.get(flow) is None
        assert not native.streams
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        if rejected and hook_phase == "requestheaders":
            assert flow.request.raw_content is None
            assert flow.request.stream is False
            assert not any(isinstance(cmd, HttpRequestHook) for cmd in history)
        auth_fetch.assert_awaited_once()


@pytest.mark.parametrize("hook_phase", ["requestheaders", "request"])
async def test_public_query_auth_preserves_dependency_semantics(
    tmp_path, real_flow, mitm_ctx, query_io, hook_phase
):
    registry_path = _query_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=CLIENT_IP,
        host=_HOST,
        path=(
            "/items;matrix=1?api%5Fkey=old&keep=1&api_key=stale"
            "&repeat=one&repeat=two&empty=&bare&semi=a;b&encoded=a%26b%3Bc"
            "&plus+key=old&plus%20key=stale&%FF=old#fragment&api_key=fragment"
        ),
    )
    resolved_query = {
        **_RESOLVED_QUERY,
        "new_first": "first",
        "plus key": "new value",
        "\udcff": "raw-byte-key",
        "new_last": "",
    }
    with (
        mitm_ctx(registry_path=str(registry_path)),
        patch.object(
            firewall_auth_cache,
            "fetch_firewall_headers",
            AsyncMock(
                return_value=firewall_auth_success(headers=_RESOLVED_HEADERS, query=resolved_query)
            ),
        ),
    ):
        if hook_phase == "requestheaders":
            await await_requestheaders_result(mitm_addon.requestheaders(flow))
        else:
            await mitm_addon.request(flow)
        assert flow.response is None
        assert query_io == [1, 1]
        assert list(flow.request.query.items(multi=True)) == [
            ("api_key", "synthetic-resolved"),
            ("keep", "1"),
            ("repeat", "one"),
            ("repeat", "two"),
            ("empty", ""),
            ("bare", ""),
            ("semi", "a;b"),
            ("encoded", "a&b;c"),
            ("plus key", "new value"),
            ("\udcff", "raw-byte-key"),
            ("new_first", "first"),
            ("new_last", ""),
        ]
        parsed = urlparse(flow.request.url)
        assert parsed.params == "matrix=1"
        assert parsed.fragment == "fragment&api_key=fragment"
        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)


async def test_cancelled_header_auth_restores_raw_non_ascii_target(
    tmp_path, real_flow, mitm_ctx, query_io
):
    registry_path = _query_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=CLIENT_IP,
        host=_HOST,
        path="/items?q=café",
    )
    original_target = (
        flow.request.data.scheme,
        flow.request.data.host,
        flow.request.data.port,
        flow.request.data.authority,
        flow.request.data.path,
    )
    original_headers = flow.request.headers.fields
    started = asyncio.Event()

    async def blocked_fetch(*_args, **_kwargs):
        started.set()
        await asyncio.Future()

    with (
        mitm_ctx(registry_path=str(registry_path)),
        patch.object(firewall_auth_cache, "fetch_firewall_headers", blocked_fetch),
    ):
        task = asyncio.create_task(await_requestheaders_result(mitm_addon.requestheaders(flow)))
        try:
            await started.wait()
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert (
            flow.request.data.scheme,
            flow.request.data.host,
            flow.request.data.port,
            flow.request.data.authority,
            flow.request.data.path,
        ) == original_target
        assert flow.request.headers.fields == original_headers
        assert flow.response is None
        assert flow.request.stream is False
        assert query_io == [0, 0]


@pytest.mark.parametrize("hook_phase", ["requestheaders", "request"])
@pytest.mark.parametrize("resolved_query", [None, {}], ids=["absent", "empty"])
async def test_public_header_only_auth_does_not_apply_query_limits(
    tmp_path, real_flow, mitm_ctx, query_io, hook_phase, resolved_query
):
    registry_path = _query_registry(tmp_path, query_auth=False)
    flow = real_flow(
        with_response=False,
        client_ip=CLIENT_IP,
        host=_HOST,
        path=_budget_target("dense-query").decode(),
    )
    original_target = flow.request.data.path
    with (
        mitm_ctx(registry_path=str(registry_path)),
        patch.object(
            firewall_auth_cache,
            "fetch_firewall_headers",
            AsyncMock(
                return_value=firewall_auth_success(headers=_RESOLVED_HEADERS, query=resolved_query)
            ),
        ),
    ):
        if hook_phase == "requestheaders":
            await await_requestheaders_result(mitm_addon.requestheaders(flow))
        else:
            await mitm_addon.request(flow)
        assert flow.response is None
        assert query_io == [0, 0]
        assert flow.request.data.path == original_target
        assert flow.request.headers["Authorization"] == _RESOLVED_HEADERS["Authorization"]
        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)
