"""A final upstream response wins over an upload read queued behind file I/O."""

import asyncio
import json
from contextlib import contextmanager
from threading import Event
from unittest.mock import patch

from h2.config import H2Configuration
from h2.connection import H2Connection
from h2.events import DataReceived, RequestReceived
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._base import ReceiveHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage, ResponseData
from mitmproxy.proxy.layers.http._http2 import Http2Client
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import payload, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


async def test_final_response_preserved_when_replay_read_waits_for_busy_filesystem_workers(
    tmp_path,
    fake_firewall_headers,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = json.dumps(payload()).encode()
    loop = asyncio.get_running_loop()
    started = [asyncio.Event() for _ in range(4)]
    release = Event()
    files = []
    real_temporary_file = managed_request_body.tempfile.TemporaryFile

    class GatedFile:
        def __init__(self, file, index):
            self.file = file
            self.index = index

        def write(self, data):
            loop.call_soon_threadsafe(started[self.index].set)
            release.wait()
            return self.file.write(data)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_temporary_file(*args, **kwargs) as file:
            index = len(files)
            files.append(file)
            yield GatedFile(file, index)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(),
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body), http2=True)
        await finish_hooks(context, stream, stream.handle_event(RequestData(1, body)))
        pending = await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
        acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
        stored = managed_request_body.get(flow)
        assert stored is not None
        assert stored.file is not None
        spool_file = stored.file
        upstream = Http2Client(stream.context.fork())
        peer = H2Connection(H2Configuration(client_side=False, header_encoding=None))
        peer.initiate_connection()
        headers_received = asyncio.Event()
        received, response = bytearray(), bytearray()

        def deliver(native_commands):
            for command in native_commands:
                if isinstance(command, ReceiveHttp):
                    assert not list(stream.handle_event(command.event))
                elif isinstance(command, commands.SendData):
                    for item in peer.receive_data(command.data):
                        if isinstance(item, RequestReceived):
                            headers_received.set()
                        elif isinstance(item, DataReceived):
                            received.extend(item.data)

        async def relay(pending_commands):
            queue = list(pending_commands)
            while queue:
                command = queue.pop(0)
                if isinstance(command, commands.StartHook):
                    await context.master.addons.invoke_addon(mitm_addon, command)
                    queue.extend(stream.handle_event(events.HookCompleted(command, None)))
                elif isinstance(command, SendHttp):
                    if command.connection == flow.server_conn:
                        deliver(upstream.handle_event(command.event))
                    elif isinstance(command.event, ResponseData):
                        response.extend(command.event.data)

        deliver(upstream.handle_event(events.Start()))
        deliver(upstream.handle_event(events.DataReceived(flow.server_conn, peer.data_to_send())))
        blockers, receiving = [], []
        replay = None
        try:
            with patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file):
                # Real writes occupy all four documented filesystem slots.
                for _ in started:
                    blocker, blocker_flow = await begin_upload(context, len(body))
                    blockers.append(blocker_flow)
                    receiving.append(
                        asyncio.create_task(
                            finish_hooks(
                                context, blocker, blocker.handle_event(RequestData(1, body))
                            )
                        )
                    )
                await asyncio.wait_for(asyncio.gather(*(event.wait() for event in started)), 5)
                replay = asyncio.create_task(
                    relay(
                        stream.handle_event(
                            GetHttpConnectionCompleted(acquire, (flow.server_conn, None))
                        )
                    )
                )
                await asyncio.wait_for(headers_received.wait(), 5)
                pulse = loop.create_future()
                loop.call_soon(pulse.set_result, None)
                await pulse
                assert not replay.done()
                assert not received
                assert stored.worker is None
                assert spool_file.tell() == 0
                peer.send_headers(1, [(b":status", b"429"), (b"content-length", b"3")])
                peer.send_data(1, b"err", end_stream=True)
                deliver(
                    upstream.handle_event(
                        events.DataReceived(flow.server_conn, peer.data_to_send())
                    )
                )
                assert spool_file.closed
                release.set()
                await asyncio.wait_for(asyncio.gather(*receiving), 5)
                await asyncio.wait_for(replay, 5)
                assert flow.error is None
                assert flow.response is not None
                assert flow.response.status_code == 429
                assert response == b"err"
                assert not received
        finally:
            release.set()
            tasks = [*receiving, *([replay] if replay is not None else [])]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for item in [flow, *blockers]:
                mitm_addon.error(item)
        assert all(file.closed for file in files)
        assert managed.admission_state_for_tests() == (0, 0)
