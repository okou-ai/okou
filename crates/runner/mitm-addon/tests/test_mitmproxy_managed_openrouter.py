"""Fresh native wire proof of streamed policy and exact successful bytes."""

import asyncio
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import events
from mitmproxy.test import taddons

import managed_upload
import mitm_addon
from logging_utils import flush_log_path
from tests.managed_openrouter_helpers import PATHS, PRESET, sandbox
from tests.managed_wire_helpers import WireSession
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("client_h2", [False, True])
@pytest.mark.parametrize("provider_h2", [False, True])
@pytest.mark.parametrize(
    "case", ["valid", "routing", "duplicate", "number", "utf8", "incomplete", "trailing", "changed"]
)
async def test_native_stream_validates_before_forwarding_and_finishes_once(
    tmp_path, fake_firewall_headers, dialect, client_h2, provider_h2, case
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = True
    registry = _write_registry(tmp_path, sandbox_info=info)
    key = b"messages" if dialect == "openai-completions" else b"input"
    prefix = b'{"model":"' + PRESET.encode() + b'","' + key + b'":[{"content":"'
    prompt = b"private-prompt-canary" + b"x" * 100_000
    suffix = b'"}]}'
    if case == "routing":
        suffix = b'"}],"provider":{}}'
    elif case == "duplicate":
        suffix = b'"}],"metadata":{"x":1,"\\u0078":2}}'
    elif case == "number":
        suffix = b'"}],"metadata":{"n":1e999}}'
    elif case == "utf8":
        suffix = b"\xff" + suffix
    elif case == "incomplete":
        suffix = suffix[:-1]
    elif case == "trailing":
        suffix += b"[]"
    complete = prefix + prompt + suffix
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer fresh-wire"}) as fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        peer = WireSession(context, client_h2=client_h2, provider_h2=provider_h2)
        await peer.start(len(complete), dialect)
        assert peer.request_headers[b"authorization"] == b"Bearer fresh-wire"
        if client_h2:
            await peer.write(b"")
        await peer.write(prefix)
        await peer.write(prompt)
        assert peer.received == len(prefix) + len(prompt)
        assert peer.flow.request.raw_content is None
        if case == "changed":
            info["piModelConfig"]["model"] = "@preset/changed"
            _write_registry(tmp_path, sandbox_info=info)
        await peer.write(suffix, final=True)
        fetch.assert_awaited_once()
        assert peer.flow.request.raw_content is None
        if case == "valid":
            assert peer.upstream_ended
            assert peer.received == len(complete)
            assert peer.digest.digest() == hashlib.sha256(complete).digest()
            upload = managed_upload.get(peer.flow)
            assert upload is not None
            assert upload.validator is None
            assert upload.tail == b""
            await peer.respond()
            assert peer.flow.live
            assert peer.flow.error is None
            await peer.respond(first=False, final=True)
            assert b"data: {}" in peer.response
            assert peer.flow.response is not None
            assert peer.flow.response.status_code == 200
        else:
            assert not peer.upstream_ended
            assert peer.received < len(complete)
            assert peer.flow.error is not None
            if provider_h2:
                assert peer.upstream_reset
            else:
                assert peer.flow.server_conn in peer.closed
        assert not peer.flow.live
        assert not peer.native.streams
        assert managed_upload.get(peer.flow) is None
        if case == "routing":
            network = Path(info["networkLogPath"])
            assert await asyncio.to_thread(flush_log_path, str(network))
            saved = await asyncio.to_thread(network.read_text)
            [entry] = [json.loads(line) for line in saved.splitlines()]
            assert entry["request_size"] == len(complete)
            assert "request_body" not in entry
            assert "private-prompt-canary" not in saved


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("declared_length", [10, 40 * 1024 * 1024], ids=["small", "large"])
async def test_headers_eof_rejects_nonempty_body_before_credentials(
    tmp_path, fake_firewall_headers, dialect, declared_length
):
    info = sandbox(tmp_path, dialect)
    registry = _write_registry(tmp_path, sandbox_info=info)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        peer = WireSession(context, client_h2=True)
        peer.guest.initiate_connection()
        await peer.drive()
        peer.guest.send_headers(
            1,
            [
                (b":method", b"POST"),
                (b":scheme", b"https"),
                (b":authority", b"openrouter.ai"),
                (b":path", PATHS[dialect].encode()),
                (b"content-type", b"application/json"),
                (b"content-length", str(declared_length).encode()),
            ],
            end_stream=True,
        )
        try:
            await peer.drive(events.DataReceived(peer.client, peer.guest.data_to_send()))
            fetch.assert_not_awaited()
            assert not peer.request_headers
            assert peer.response_status == 403
            assert json.loads(peer.response)["reason"] == "incomplete_body"
            assert peer.response_ended
            assert peer.flow.error is None
            assert not peer.flow.live
            assert not peer.native.streams
            assert managed_upload.get(peer.flow) is None
            proxy = Path(info["proxyLogPath"])
            assert await asyncio.to_thread(flush_log_path, str(proxy))
            saved = await asyncio.to_thread(proxy.read_text)
            [policy] = [
                row
                for line in saved.splitlines()
                if (row := json.loads(line)).get("type") == "managed_model_policy"
            ]
            assert policy["rejection_phase"] == "requestheaders"
        finally:
            peer.close()


@pytest.mark.parametrize("provider_h2", [False, True])
async def test_native_trailers_cannot_release_final_managed_byte(
    tmp_path, fake_firewall_headers, provider_h2
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    raw = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        peer = WireSession(context, client_h2=True, provider_h2=provider_h2)
        await peer.start(len(raw), "openai-completions")
        await peer.write(raw)
        assert peer.received == len(raw) - 1
        assert not peer.upstream_ended
        peer.guest.send_headers(1, [(b"x-openrouter-preset", b"other")], end_stream=True)
        await peer.drive(events.DataReceived(peer.client, peer.guest.data_to_send()))
        assert peer.flow.error is not None
        assert peer.received == len(raw) - 1
        assert not peer.upstream_ended
        assert not peer.flow.live
        assert not peer.native.streams
        assert managed_upload.get(peer.flow) is None


async def test_completed_stream_can_reuse_native_http1_connection(tmp_path, fake_firewall_headers):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    raw = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        peer = WireSession(context)
        for index in range(2):
            if index:
                peer.http1.start_next_cycle()
                peer.digest = hashlib.sha256()
                peer.received = 0
                peer.upstream_ended = False
            await peer.start(len(raw), "openai-completions")
            await peer.write(raw, final=True)
            assert peer.upstream_ended
            assert peer.received == len(raw)
            assert peer.digest.digest() == hashlib.sha256(raw).digest()
            await peer.respond(final=True)
            assert not peer.flow.live
            assert not peer.native.streams
            assert managed_upload.get(peer.flow) is None
        assert not peer.closed


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("client_h2", [False, True])
@pytest.mark.parametrize("provider_h2", [False, True])
@pytest.mark.parametrize("ending", ["response", "request", "authorization"])
async def test_policy_rejection_preserves_an_already_streaming_provider_response(
    tmp_path, fake_firewall_headers, dialect, client_h2, provider_h2, ending
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = True
    registry = _write_registry(tmp_path, sandbox_info=info)
    prefix = b'{"model":"' + PRESET.encode() + b'","messages":[]'
    if dialect == "openai-responses":
        prefix = prefix.replace(b'"messages"', b'"input"')
    rejected = b',"provider":{}' if ending != "authorization" else b""
    remaining = b"}"
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        peer = WireSession(context, client_h2=client_h2, provider_h2=provider_h2)
        try:
            await peer.start(len(prefix) + len(rejected) + len(remaining), dialect)
            await peer.write(prefix)
            await peer.respond()
            assert b"data: {}" in peer.response
            if ending == "authorization":
                info["piModelConfig"]["model"] = "@preset/changed"
                _write_registry(tmp_path, sandbox_info=info)
            else:
                await peer.write(rejected)
            assert peer.received == len(prefix)
            assert not peer.upstream_ended
            if ending == "response":
                await peer.respond(first=False, final=True)
                assert peer.response.count(b"data: {}") == 2
                assert peer.flow.error is None
                observed = len(prefix) + len(rejected)
            else:
                await peer.write(remaining, final=True)
                assert peer.response.count(b"data: {}") == 1
                assert peer.flow.error is not None
                observed = len(prefix) + len(rejected) + len(remaining)
            assert peer.flow.response is not None
            assert peer.flow.response.status_code == 200
            assert not peer.flow.live
            assert not peer.native.streams
            assert managed_upload.get(peer.flow) is None
            network = Path(info["networkLogPath"])
            assert await asyncio.to_thread(flush_log_path, str(network))
            saved = await asyncio.to_thread(network.read_text)
            [entry] = [json.loads(line) for line in saved.splitlines()]
            assert entry["request_size"] == observed
            assert "request_body" not in entry
        finally:
            peer.close()
