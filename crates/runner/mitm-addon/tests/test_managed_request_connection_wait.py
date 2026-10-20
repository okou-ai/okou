"""The upload reader must wait for native connection/TLS acquisition."""

import asyncio
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, RequestHeaders
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("outcome", ["connected", "failed"])
async def test_reader_waits_until_native_upstream_headers_or_terminal_error(
    tmp_path,
    fake_firewall_headers,
    outcome,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    raw = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as auth,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        initial = []
        stream, flow = await begin_upload(
            context,
            len(raw),
            connect=False,
            commands_out=initial,
        )
        auth.assert_awaited_once()
        acquire = next(c for c in initial if isinstance(c, GetHttpConnection))
        stored = managed_request_body.get(flow)
        assert stored is not None
        assert stored.header_ready.is_set()
        assert not any(isinstance(c, SendHttp) for c in initial)
        sending = asyncio.create_task(stored.wait_ready())
        try:
            turn = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(turn.set_result, None)
            await turn
            assert not sending.done(), "connection/TLS wait must backpressure further body reads"
            assert stored.received == 0
            assert not stream.request_body_buf
            result = (
                (flow.server_conn, None)
                if outcome == "connected"
                else (None, "synthetic connection failure")
            )
            sent = await finish_hooks(
                context, stream, stream.handle_event(GetHttpConnectionCompleted(acquire, result))
            )
            await asyncio.wait_for(sending, 5)
            if outcome == "failed":
                assert flow.error is not None
                assert not any(
                    isinstance(c, SendHttp) and isinstance(c.event, RequestHeaders) for c in sent
                )
            else:
                assert any(
                    isinstance(c, SendHttp) and isinstance(c.event, RequestHeaders) for c in sent
                )
                sent.extend(
                    await finish_hooks(context, stream, stream.handle_event(RequestData(1, raw)))
                )
                sent.extend(
                    await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
                )
                assert (
                    b"".join(
                        c.event.data
                        for c in sent
                        if isinstance(c, SendHttp) and isinstance(c.event, RequestData)
                    )
                    == raw
                )
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)
            mitm_addon.error(flow)
