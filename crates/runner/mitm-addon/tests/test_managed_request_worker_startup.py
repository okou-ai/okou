"""Failed worker startup cannot leave queued operations holding closed body files."""

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("error_type", [OSError, RuntimeError])
async def test_worker_start_failure_has_no_abandoned_file_operation_and_recovers(
    tmp_path,
    fake_firewall_headers,
    error_type,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    raw = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    files, writes = [], []
    real_file = managed_request_body.tempfile.TemporaryFile
    start_thread = threading.Thread.start
    loop = asyncio.get_running_loop()
    default_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="managed-startup-probe")
    loop.set_default_executor(default_pool)

    class ObservedFile:
        def __init__(self, file):
            self.file = file

        def write(self, data):
            writes.append(self.file.closed)
            return self.file.write(data)

        def read(self, size):
            return self.file.read(size)

        def seek(self, offset):
            return self.file.seek(offset)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_file(*args, **kwargs) as file:
            files.append(file)
            yield ObservedFile(file)

    def fail_start(thread):
        if thread.name.startswith(("managed-startup-probe", "managed-request-io")):
            raise error_type("synthetic-worker-start-canary")
        start_thread(thread)

    try:
        with (
            patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
            patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file),
            taddons.context(Proxyserver(), mitm_addon) as context,
            fake_firewall_headers() as auth_fetch,
        ):
            context.options.update(
                okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
            )
            stream, flow = await begin_upload(context, len(raw))
            with patch.object(threading.Thread, "start", fail_start):
                await finish_hooks(context, stream, stream.handle_event(RequestData(1, raw)))
            await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
            assert flow.response is not None
            assert flow.response.status_code == 503
            assert b"synthetic-worker-start-canary" not in (flow.response.raw_content or b"")
            auth_fetch.assert_not_called()
            assert all(file.closed for file in files)
            assert managed.admission_state_for_tests() == (0, 0)

            # Starting a later worker must not execute an inaccessible write
            # queued before Thread.start raised in the earlier request.
            await loop.run_in_executor(default_pool, lambda: None)
            assert writes == []

            recovered, recovered_flow = await begin_upload(context, len(raw))
            await finish_hooks(context, recovered, recovered.handle_event(RequestData(1, raw)))
            pending = await finish_hooks(
                context, recovered, recovered.handle_event(RequestEndOfMessage(1))
            )
            acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
            sent = await finish_hooks(
                context,
                recovered,
                recovered.handle_event(
                    GetHttpConnectionCompleted(acquire, (recovered_flow.server_conn, None))
                ),
            )
            assert (
                b"".join(
                    command.event.data
                    for command in sent
                    if isinstance(command, SendHttp) and isinstance(command.event, RequestData)
                )
                == raw
            )
            auth_fetch.assert_awaited_once()
            assert writes == [False]
            assert all(file.closed for file in files)
            assert managed.admission_state_for_tests() == (0, 0)
            mitm_addon.error(recovered_flow)
    finally:
        default_pool.shutdown(wait=True, cancel_futures=True)


async def test_addon_shutdown_joins_an_accepted_write_before_closing_its_file(
    tmp_path,
    fake_firewall_headers,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    raw = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    real_file = managed_request_body.tempfile.TemporaryFile
    shutdown_pool = ThreadPoolExecutor.shutdown
    loop = asyncio.get_running_loop()
    started, release = asyncio.Event(), threading.Event()
    files, shutdown_files = [], []

    class GatedFile:
        def __init__(self, file):
            self.file = file

        def write(self, data):
            loop.call_soon_threadsafe(started.set)
            release.wait()
            assert not self.file.closed
            return self.file.write(data)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_file(*args, **kwargs) as file:
            files.append(file)
            yield GatedFile(file)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(raw))
        receiving = asyncio.create_task(
            finish_hooks(context, stream, stream.handle_event(RequestData(1, raw)))
        )
        try:
            await asyncio.wait_for(started.wait(), 5)
            stored = managed_request_body.get(flow)
            assert stored is not None
            executor = managed_request_body._executor
            assert executor is not None

            def observe_shutdown(pool, *args, **kwargs):
                if pool is executor:
                    assert stored.closed
                    assert managed.admission_state_for_tests() == (1, len(raw))
                    shutdown_files.append(files[0].closed)
                    release.set()
                return shutdown_pool(pool, *args, **kwargs)

            with patch.object(ThreadPoolExecutor, "shutdown", observe_shutdown):
                mitm_addon.done()
            assert shutdown_files == [False]
            assert files[0].closed
            assert managed.admission_state_for_tests() == (0, 0)
            await asyncio.wait_for(receiving, 5)
            auth_fetch.assert_not_called()
        finally:
            release.set()
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)
            mitm_addon.error(flow)
