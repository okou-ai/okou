"""Each removed threshold is exercised without retaining fixture upload bodies."""

import hashlib
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.test import taddons

import managed_upload
import mitm_addon
import request_streaming
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_wire_helpers import WireSession
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("http2", [False, True])
@pytest.mark.parametrize("capture", [False, True])
@pytest.mark.parametrize(
    ("count", "size"), [(1, 40 * 1024 * 1024), (20, 64), (5, 30 * 1024 * 1024)]
)
async def test_independent_removed_limits_over_native_wire(
    tmp_path, fake_firewall_headers, dialect, http2, capture, count, size
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = capture
    registry = _write_registry(tmp_path, sandbox_info=info)
    key = b"messages" if dialect == "openai-completions" else b"input"
    prefix = b'{"model":"' + PRESET.encode() + b'","' + key + b'":[{"content":"'
    tail = "🙂".encode() + b'"}]}'
    length = len(prefix) + size + len(tail)
    slab = b"x" * 16_384
    expected = hashlib.sha256(prefix)
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer fresh-limit"}),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        sessions = [WireSession(context, client_h2=http2, provider_h2=http2) for _ in range(count)]
        try:
            for peer in sessions:
                await peer.start(length, dialect)
                assert peer.request_headers[b"authorization"] == b"Bearer fresh-limit"
            for peer in sessions:
                await peer.write(prefix)
            for offset in range(0, size, len(slab)):
                piece = slab[: min(len(slab), size - offset)]
                expected.update(piece)
                for peer in sessions:
                    await peer.write(piece)
                    assert peer.flow.request.raw_content is None
            expected.update(tail)
            for peer in sessions:
                await peer.write(tail[:1])
                await peer.write(tail[1:], final=True)
                assert peer.upstream_ended
                assert peer.received == length
                assert peer.digest.digest() == expected.digest()
                assert request_streaming.streamed_request_size(peer.flow) == length
                await peer.respond()
            assert all(peer.flow.live and peer.flow.error is None for peer in sessions)
            for peer in sessions:
                upload = managed_upload.get(peer.flow)
                assert upload is not None
                assert upload.validator is None
                assert upload.tail == b""
                assert not upload.transport_pending
                assert peer.flow.request.raw_content is None
                captured = request_streaming.captured_request_stream_body(peer.flow)
                if capture:
                    assert captured is not None
                    assert len(captured.buffer) <= 65_536
                    assert captured.truncated == (length > 65_536)
                else:
                    assert captured is None
                assert b"data: {}" in peer.response
                await peer.respond(first=False, final=True)
                assert not peer.flow.live
                assert not peer.native.streams
                assert managed_upload.get(peer.flow) is None
        finally:
            for peer in sessions:
                peer.close()
