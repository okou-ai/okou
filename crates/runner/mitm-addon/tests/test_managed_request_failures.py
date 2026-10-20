"""Framing, filesystem failures and cancellation through production native hooks."""

import asyncio
from contextlib import contextmanager
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage
from mitmproxy.test import taddons

import managed_openrouter as managed
import managed_request_body
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("case", ["short", "long", "capacity", "create", "write", "read"])
async def test_failed_body_or_storage_releases_files_and_fails_closed(
    tmp_path,
    fake_firewall_headers,
    case,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    length = len(body) + (1 if case == "short" else -1 if case == "long" else 0)
    real_temporary_file = managed_request_body.tempfile.TemporaryFile
    files = []

    class FaultyFile:
        def __init__(self, file):
            self.file = file

        def write(self, data):
            if case == "write":
                raise OSError("private-storage-error-canary")
            return self.file.write(data)

        def read(self, size):
            if case == "read":
                raise OSError("private-storage-error-canary")
            return self.file.read(size)

        def seek(self, offset):
            return self.file.seek(offset)

    @contextmanager
    def temporary_file(*args, **kwargs):
        if case == "create":
            raise OSError("private-storage-error-canary")
        with real_temporary_file(*args, **kwargs) as file:
            files.append(file)
            yield FaultyFile(file)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, length)
        with (
            patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file),
            patch.object(
                managed_request_body.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=2 if case == "capacity" else 1_000_000),
            ),
        ):
            await finish_hooks(context, stream, stream.handle_event(RequestData(1, body)))
            pending = await finish_hooks(
                context, stream, stream.handle_event(RequestEndOfMessage(1))
            )
            if case == "read":
                acquire = next(
                    command for command in pending if isinstance(command, GetHttpConnection)
                )
                sent = await finish_hooks(
                    context,
                    stream,
                    stream.handle_event(
                        GetHttpConnectionCompleted(acquire, (flow.server_conn, None))
                    ),
                )
                assert flow.error is not None
                assert not any(
                    isinstance(command, SendHttp) and isinstance(command.event, RequestData)
                    for command in sent
                )
            else:
                auth_fetch.assert_not_called()
                assert not any(isinstance(command, GetHttpConnection) for command in pending)
                assert flow.response is not None
                assert flow.response.status_code == (403 if case in {"short", "long"} else 503)
                assert b"private-storage-error-canary" not in (flow.response.raw_content or b"")
        assert all(file.closed for file in files)
        assert managed.admission_state_for_tests() == (0, 0)


async def test_cancelled_filesystem_worker_is_joined_before_close_and_storage_release(
    tmp_path,
    fake_firewall_headers,
):
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    body = b'{"model":"' + PRESET.encode() + b'","messages":[]}'
    real_temporary_file = managed_request_body.tempfile.TemporaryFile
    loop = asyncio.get_running_loop()
    started, release = asyncio.Event(), Event()
    files = []

    class GatedFile:
        def __init__(self, file):
            self.file = file

        def write(self, data):
            loop.call_soon_threadsafe(started.set)
            release.wait()
            return self.file.write(data)

    @contextmanager
    def temporary_file(*args, **kwargs):
        with real_temporary_file(*args, **kwargs) as file:
            files.append(file)
            yield GatedFile(file)

    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers() as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body))
        with patch.object(managed_request_body.tempfile, "TemporaryFile", temporary_file):
            receiving = asyncio.create_task(
                finish_hooks(context, stream, stream.handle_event(RequestData(1, body)))
            )
            try:
                await asyncio.wait_for(started.wait(), 5)
                receiving.cancel()
                flow.error = Error("client disconnected during filesystem work")
                mitm_addon.error(flow)
                assert not files[0].closed
                assert managed.admission_state_for_tests() == (1, len(body))
                auth_fetch.assert_not_called()
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(receiving, 5)
            finally:
                release.set()
                receiving.cancel()
                await asyncio.gather(receiving, return_exceptions=True)
        assert files[0].closed
        assert managed.admission_state_for_tests() == (0, 0)
