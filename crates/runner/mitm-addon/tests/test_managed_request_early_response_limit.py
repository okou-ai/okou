"""An early response overflow aborts transport before blocked file I/O finishes."""

import asyncio
import json
from contextlib import contextmanager
from threading import Event
from unittest.mock import patch

import pytest
from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import StreamReset
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage
from mitmproxy.proxy.layers.http._http1 import Http1Client
from mitmproxy.proxy.layers.http._http2 import Http2Client
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import payload, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("http2", [False, True])
async def test_early_response_overflow_aborts_before_a_blocked_read_returns(
    tmp_path, fake_firewall_headers, http2
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = json.dumps(payload()).encode()
    loop = asyncio.get_running_loop()
    reading, release = asyncio.Event(), Event()
    real_temporary_file = managed_request_body.tempfile.TemporaryFile
    files = []

    class GatedFile:
        def __init__(self, file):
            self.file = file

        def write(self, data):
            return self.file.write(data)

        def seek(self, offset):
            return self.file.seek(offset)

        def read(self, size):
            loop.call_soon_threadsafe(reading.set)
            release.wait()
            assert not self.file.closed
            return self.file.read(size)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_temporary_file(*args, **kwargs) as file:
            files.append(file)
            yield GatedFile(file)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body), http2=http2)
        await finish_hooks(context, stream, stream.handle_event(RequestData(1, body)))
        pending = await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
        acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
        upstream = (Http2Client if http2 else Http1Client)(stream.context.fork())
        peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        peer.initiate_connection()
        closed, resets = [], []

        def deliver(native_commands):
            for command in native_commands:
                if isinstance(command, ReceiveHttp):
                    assert not list(stream.handle_event(command.event))
                elif isinstance(command, commands.CloseConnection):
                    closed.append(command.connection)
                elif http2 and isinstance(command, commands.SendData):
                    resets.extend(
                        item.stream_id
                        for item in peer.receive_data(command.data)
                        if isinstance(item, StreamReset)
                    )

        async def relay(pending_commands):
            queue = list(pending_commands)
            while queue:
                command = queue.pop(0)
                if isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    queue.extend(stream.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, SendHttp) and command.connection == flow.server_conn:
                    deliver(upstream.handle_event(command.event))

        deliver(upstream.handle_event(events.Start()))
        if http2:
            deliver(
                upstream.handle_event(events.DataReceived(flow.server_conn, peer.data_to_send()))
            )
        replay = asyncio.create_task(
            relay(
                stream.handle_event(GetHttpConnectionCompleted(acquire, (flow.server_conn, None)))
            )
        )
        try:
            await asyncio.wait_for(reading.wait(), 5)
            assert not replay.done()
            assert not files[0].closed
            if http2:
                peer.send_headers(1, [(b":status", b"200")])
                for _ in range(5):
                    peer.send_data(1, b"e" * 16384)
                    deliver(
                        upstream.handle_event(
                            events.DataReceived(flow.server_conn, peer.data_to_send())
                        )
                    )
                assert resets == [1]
            else:
                deliver(
                    upstream.handle_event(
                        events.DataReceived(
                            flow.server_conn,
                            b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n" + b"e" * 65536,
                        )
                    )
                )
                deliver(upstream.handle_event(events.DataReceived(flow.server_conn, b"e")))
                assert closed == [flow.server_conn]
            assert not replay.done()
            assert not files[0].closed
            stored = managed_request_body.get(flow)
            assert stored is not None
            # The finish checkpoint owns the entire native continuation. A
            # stopped body must not release its client reader while file I/O
            # still keeps that continuation paused.
            assert not stored.upload_done.is_set()
            release.set()
            await asyncio.wait_for(replay, 5)
            assert flow.error is not None
            assert files[0].closed
            assert stored.upload_done.is_set()
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            release.set()
            replay.cancel()
            await asyncio.gather(replay, return_exceptions=True)
            mitm_addon.error(flow)
