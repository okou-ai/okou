"""Admission, deadline, worker, and shutdown tests for auth.base forwarding."""

import asyncio
import contextvars
import multiprocessing
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future
from unittest.mock import MagicMock, patch

import pytest
from mitmproxy import http

import auth_base_forwarder as forwarder
import auth_base_transport as transport
from tests.auth_base_forwarder_helpers import (
    FakeResponseFile,
    FakeSocket,
    fake_forwarder_upstream,
    forwarder_concurrency_harness,
    http_response,
)

_PROCESS_EXIT_TIMEOUT_SECONDS = 5


async def _run_ready_tasks() -> None:
    ready = asyncio.Event()
    asyncio.get_running_loop().call_soon(ready.set)
    await ready.wait()


class _BlockingConnectSocket(FakeSocket):
    def __init__(
        self,
        entered: threading.Event,
        release: threading.Event,
    ) -> None:
        super().__init__(http_response())
        self._entered = entered
        self._release = release

    def connect(
        self,
        address: tuple[str, int] | tuple[str, int, int, int],
    ) -> None:
        super().connect(address)
        self._entered.set()
        if not self._release.wait(timeout=2):
            raise TimeoutError("test did not release connect")

    def shutdown(self, how: int) -> None:
        super().shutdown(how)
        self._release.set()


class _SocketBackedForwardSocket(FakeSocket):
    def __init__(
        self,
        client_socket,
        connection_closed: threading.Event,
    ) -> None:
        super().__init__(b"")
        self._client_socket = client_socket
        self._connection_closed = connection_closed

    def settimeout(self, timeout: float | None) -> None:
        super().settimeout(timeout)
        self._client_socket.settimeout(timeout)

    def sendall(self, data: bytes) -> None:
        self.sent.extend(data)
        self._client_socket.sendall(data)

    def makefile(self, *args, **kwargs):
        return self._client_socket.makefile(*args, **kwargs)

    def shutdown(self, how: int) -> None:
        super().shutdown(how)
        self._client_socket.shutdown(how)

    def close(self) -> None:
        super().close()
        self._client_socket.close()
        self._connection_closed.set()


class _TricklingResponseServer:
    def __init__(self, response_head: bytes) -> None:
        self.client_socket, self.server_socket = forwarder.socket.socketpair()
        self.connection_closed = threading.Event()
        self.response_started = threading.Event()
        self.response_body = bytes(range(256))
        self.sent_body_bytes: list[bytes] = []
        self.socket = _SocketBackedForwardSocket(
            self.client_socket,
            self.connection_closed,
        )
        self._response_head = response_head
        self.thread = threading.Thread(
            target=self._serve,
            name="auth-base-trickle-server",
        )

    def start(self) -> None:
        self.thread.start()

    def _serve(self) -> None:
        try:
            request = bytearray()
            while b"\r\n\r\n" not in request:
                chunk = self.server_socket.recv(4096)
                if not chunk:
                    return
                request.extend(chunk)
            self.server_socket.sendall(self._response_head)
            for byte in self.response_body:
                self.server_socket.sendall(bytes((byte,)))
                self.sent_body_bytes.append(bytes((byte,)))
                self.response_started.set()
                time.sleep(0.01)
        except OSError:
            # Deadline or shutdown intentionally closes the peer while it is sending.
            pass
        finally:
            self.server_socket.close()

    async def close(self) -> None:
        self.client_socket.close()
        self.server_socket.close()
        await asyncio.to_thread(self.thread.join, 2)


class _RecordingSocket(forwarder.socket.socket):
    def __init__(self) -> None:
        super().__init__()
        self.close_count = 0
        self.shutdown_calls: list[int] = []

    def shutdown(self, how: int) -> None:
        self.shutdown_calls.append(how)

    def close(self) -> None:
        if self.fileno() != -1:
            self.close_count += 1
        super().close()


def _run_blocked_forward_then_shutdown_wait_false() -> None:
    async def main():
        forward_started = threading.Event()
        never_release = threading.Event()

        def block_connect(_address):
            forward_started.set()
            never_release.wait()

        with fake_forwarder_upstream(connect_side_effect=block_connect):
            task = asyncio.create_task(
                forwarder.forward_request("https://example.com", "GET", [], None)
            )
            try:
                if not await asyncio.to_thread(forward_started.wait, 2):
                    raise RuntimeError("auth.base forward did not start")
                forwarder.shutdown_forward_request_workers(wait=False)
            finally:
                task.cancel()

    asyncio.run(main())


class TestForwardRequestAbortHandle:
    def test_deadline_before_async_cancel_registration_cancels_and_preserves_error(self):
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        cancel = MagicMock()

        assert abort_handle.abort_for_deadline()
        with pytest.raises(
            forwarder.AuthBaseForwardingDeadlineExceededError,
            match=r"auth\.base forwarding deadline exceeded",
        ):
            abort_handle.register_async_cancel(cancel)

        cancel.assert_called_once_with()

    def test_shutdown_before_socket_registration_aborts_and_preserves_error(self):
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        socket = _RecordingSocket()
        try:
            assert abort_handle.abort_for_shutdown()
            with pytest.raises(RuntimeError, match=r"auth\.base forwarding workers are shut down"):
                abort_handle.register_socket(socket)

            assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
            assert socket.close_count == 1
        finally:
            socket.close()

    def test_deadline_before_socket_replacement_aborts_both_and_preserves_error(self):
        abort_handle = forwarder._ForwardRequestAbortHandle(MagicMock())
        raw_socket = _RecordingSocket()
        tls_socket = _RecordingSocket()
        try:
            abort_handle.register_socket(raw_socket)

            assert abort_handle.abort_for_deadline()
            with pytest.raises(
                forwarder.AuthBaseForwardingDeadlineExceededError,
                match=r"auth\.base forwarding deadline exceeded",
            ):
                abort_handle.replace_socket(raw_socket, tls_socket)

            assert raw_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
            assert raw_socket.close_count == 1
            assert tls_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
            assert tls_socket.close_count == 1
        finally:
            raw_socket.close()
            tls_socket.close()


class TestForwardRequestAsyncWrapper:
    def test_shutdown_wait_false_does_not_keep_process_alive_with_blocked_forward(self):
        process = multiprocessing.get_context("spawn").Process(
            target=_run_blocked_forward_then_shutdown_wait_false,
            name="auth-base-shutdown-regression",
        )
        process.start()
        try:
            process.join(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)
            assert not process.is_alive()
            assert process.exitcode == 0
        finally:
            if process.is_alive():
                process.kill()
                process.join(timeout=_PROCESS_EXIT_TIMEOUT_SECONDS)

        assert process.exitcode == 0

    async def test_deadline_covers_waiting_for_active_slot(self):
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                with patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    5,
                ):
                    running_task = scenario.track_task(
                        asyncio.create_task(
                            forwarder.forward_request(
                                "https://example.com",
                                "GET",
                                [],
                                None,
                            )
                        )
                    )
                    assert await scenario.wait_started(1)

                with (
                    patch.object(
                        forwarder,
                        "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                        0.05,
                    ),
                    pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
                ):
                    await forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )

                assert scenario.started == 1
                assert forwarder.forward_request_admission_state_for_tests() == (
                    1,
                    0,
                )
                scenario.release()
                status, body, _headers = await running_task

        assert status == 200
        assert body == b"ok"
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_pre_submit_guard_rejection_after_dns_releases_capacity(self):
        guard_threads: list[threading.Thread] = []

        def reject_before_submit() -> bool:
            guard_threads.append(threading.current_thread())
            return False

        event_loop_thread = threading.current_thread()
        with fake_forwarder_upstream() as upstream:
            with pytest.raises(
                forwarder.ForwardRequestPreSubmitRejectedError,
                match="rejected before worker submission",
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                    pre_submit_guard=reject_before_submit,
                )

            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert upstream.resolve_calls == ["example.com", "example.com"]
        assert len(upstream.socket_calls) == 1
        assert guard_threads == [event_loop_thread]
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_deadline_cancels_async_dns_and_releases_capacity(self):
        lookup_entered = asyncio.Event()
        lookup_cancelled = asyncio.Event()

        async def blocked_lookup(_host: str) -> list[str]:
            lookup_entered.set()
            try:
                await asyncio.Event().wait()
                raise AssertionError("blocked DNS lookup unexpectedly resumed")
            finally:
                lookup_cancelled.set()

        with (
            patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.05,
            ),
            fake_forwarder_upstream(lookup_side_effect=blocked_lookup) as upstream,
            pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert lookup_entered.is_set()
        assert lookup_cancelled.is_set()
        assert upstream.sockets == []
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    async def test_caller_cancellation_during_dns_releases_capacity(self):
        lookup_entered = asyncio.Event()
        lookup_cancelled = asyncio.Event()

        async def blocked_lookup(_host: str) -> list[str]:
            lookup_entered.set()
            try:
                await asyncio.Event().wait()
                raise AssertionError("blocked DNS lookup unexpectedly resumed")
            finally:
                lookup_cancelled.set()

        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            with fake_forwarder_upstream(lookup_side_effect=blocked_lookup) as upstream:
                task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                await lookup_entered.wait()
                semaphore = forwarder._get_forward_request_admission_semaphore()
                task.cancel()

                with pytest.raises(asyncio.CancelledError):
                    await task

                assert lookup_cancelled.is_set()
                assert upstream.sockets == []

            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
            with forwarder._forward_request_active_handles_lock:
                assert not forwarder._forward_request_active_handles
            with forwarder._forward_request_pending_futures_lock:
                assert not forwarder._forward_request_pending_futures
            with forwarder._forward_request_workers_lock:
                assert not forwarder._forward_request_workers
            assert forwarder._get_forward_request_admission_semaphore() is semaphore

            await asyncio.wait_for(semaphore.acquire(), timeout=1)
            try:
                assert semaphore.locked()
            finally:
                semaphore.release()

            with fake_forwarder_upstream():
                status, body, headers = await asyncio.wait_for(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    ),
                    timeout=2,
                )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []

    async def test_shutdown_before_active_handle_tracking_releases_capacity(self):
        loop = asyncio.get_running_loop()
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            semaphore = forwarder._get_forward_request_admission_semaphore()
            with (
                patch.object(
                    forwarder,
                    "_track_active_forward_request_handle",
                    return_value=False,
                ) as track_active_handle,
                patch.object(
                    transport,
                    "prepare_forward_request",
                    wraps=transport.prepare_forward_request,
                ) as prepare_forward_request,
                patch.object(loop, "call_later") as schedule_deadline,
                fake_forwarder_upstream() as upstream,
            ):
                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await forwarder.forward_request(
                        "https://example.com",
                        "POST",
                        [],
                        b"payload",
                    )

                track_active_handle.assert_called_once()
                prepare_forward_request.assert_not_called()
                schedule_deadline.assert_not_called()
                assert upstream.resolve_calls == []
                assert upstream.sockets == []

            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
            with forwarder._forward_request_active_handles_lock:
                assert not forwarder._forward_request_active_handles
            with forwarder._forward_request_pending_futures_lock:
                assert not forwarder._forward_request_pending_futures
            with forwarder._forward_request_workers_lock:
                assert not forwarder._forward_request_workers
            assert forwarder._get_forward_request_admission_semaphore() is semaphore

            with fake_forwarder_upstream():
                status, body, _headers = await asyncio.wait_for(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    ),
                    timeout=2,
                )

        assert status == 200
        assert body == b"ok"

    async def test_shutdown_cancels_dns_before_socket_registration(self):
        lookup_entered = asyncio.Event()
        lookup_cancelled = asyncio.Event()

        async def blocked_lookup(_host: str) -> list[str]:
            lookup_entered.set()
            try:
                await asyncio.Event().wait()
                raise AssertionError("blocked DNS lookup unexpectedly resumed")
            finally:
                lookup_cancelled.set()

        with fake_forwarder_upstream(lookup_side_effect=blocked_lookup) as upstream:
            task = asyncio.create_task(
                forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )
            )
            await lookup_entered.wait()
            forwarder.shutdown_forward_request_workers(wait=False)

            with pytest.raises(RuntimeError, match="workers are shut down"):
                await task

        assert lookup_cancelled.is_set()
        assert upstream.sockets == []
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_deadline_aborts_connect_before_reusing_capacity(self):
        connect_entered = threading.Event()
        release_connect = threading.Event()
        blocked_socket = _BlockingConnectSocket(connect_entered, release_connect)
        sockets = iter(
            (
                blocked_socket,
                FakeSocket(http_response()),
            )
        )

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(socket_factory=lambda: next(sockets)),
        ):
            with (
                patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    0.05,
                ),
                pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

            assert connect_entered.is_set()
            assert blocked_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                1,
            ):
                status, body, _headers = await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

        assert status == 200
        assert body == b"ok"

    async def test_deadline_aborts_deferred_tls_handshake(self):
        handshake_entered = threading.Event()
        release_handshake = threading.Event()

        class BlockingHandshakeSocket(FakeSocket):
            def do_handshake(self) -> None:
                self.handshake_count += 1
                handshake_entered.set()
                if not release_handshake.wait(timeout=2):
                    raise TimeoutError("test did not release TLS handshake")

            def shutdown(self, how: int) -> None:
                super().shutdown(how)
                release_handshake.set()

        socket = BlockingHandshakeSocket(http_response())
        with (
            patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.05,
            ),
            fake_forwarder_upstream(socket_factory=lambda: socket),
            pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert handshake_entered.is_set()
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert socket.closed

    @pytest.mark.parametrize(
        "response_head",
        [
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 256\r\n\r\n",
            b"HTTP/1.0 200 OK\r\nContent-Length: 256\r\n\r\n",
            b"HTTP/1.1 200 OK\r\n\r\n",
        ],
        ids=("connection-close", "http-1.0", "eof-delimited"),
    )
    async def test_absolute_deadline_stops_detached_trickling_response(
        self,
        response_head: bytes,
    ):
        server = _TricklingResponseServer(response_head)
        sockets = iter((server.socket, FakeSocket(http_response())))
        server.start()
        try:
            with (
                patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
                patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    0.2,
                ),
                fake_forwarder_upstream(socket_factory=lambda: next(sockets)),
            ):
                with pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError):
                    await asyncio.wait_for(
                        forwarder.forward_request(
                            "https://example.com",
                            "GET",
                            [],
                            None,
                        ),
                        timeout=1,
                    )

                assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
                status, body, _headers = await asyncio.wait_for(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    ),
                    timeout=1,
                )
        finally:
            await server.close()

        assert status == 200
        assert body == b"ok"
        assert server.connection_closed.is_set()
        assert server.response_started.is_set()
        assert not server.thread.is_alive()
        assert 2 <= len(server.sent_body_bytes) < len(server.response_body)
        assert server.socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]

    async def test_shutdown_stops_detached_trickling_response(self):
        server = _TricklingResponseServer(
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 256\r\n\r\n"
        )
        server.start()
        try:
            with fake_forwarder_upstream(socket_factory=lambda: server.socket):
                task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(server.connection_closed.wait, 1)
                assert await asyncio.to_thread(server.response_started.wait, 1)

                forwarder.shutdown_forward_request_workers(wait=False)

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(task, timeout=1)
        finally:
            await server.close()

        assert server.response_started.is_set()
        assert not server.thread.is_alive()
        assert 1 <= len(server.sent_body_bytes) < len(server.response_body)
        assert server.socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    async def test_deadline_does_not_abort_unrelated_forward(self):
        first_entered = threading.Event()
        first_release = threading.Event()
        second_entered = threading.Event()
        second_release = threading.Event()
        first_socket = _BlockingConnectSocket(first_entered, first_release)
        second_socket = _BlockingConnectSocket(second_entered, second_release)
        sockets = iter((first_socket, second_socket))

        with fake_forwarder_upstream(socket_factory=lambda: next(sockets)):
            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.08,
            ):
                first_task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(first_entered.wait, 1)

            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                1,
            ):
                second_task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(second_entered.wait, 1)

                with pytest.raises(forwarder.AuthBaseForwardingDeadlineExceededError):
                    await first_task

                assert not second_task.done()
                assert second_socket.shutdown_calls == []
                second_release.set()
                status, body, _headers = await second_task

        assert status == 200
        assert body == b"ok"
        assert first_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert second_socket.shutdown_calls == []

    async def test_caller_cancellation_keeps_worker_deadline_armed(self):
        first_entered = threading.Event()
        first_release = threading.Event()
        first_socket = _BlockingConnectSocket(first_entered, first_release)
        sockets = iter((first_socket, FakeSocket(http_response())))

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(socket_factory=lambda: next(sockets)),
        ):
            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                0.08,
            ):
                cancelled_task = asyncio.create_task(
                    forwarder.forward_request(
                        "https://example.com",
                        "GET",
                        [],
                        None,
                    )
                )
                assert await asyncio.to_thread(first_entered.wait, 1)
                cancelled_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await cancelled_task

            with patch.object(
                forwarder,
                "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                1,
            ):
                status, body, _headers = await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

        assert status == 200
        assert body == b"ok"
        assert first_socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]

    async def test_completed_forward_cancels_deadline_timer(self):
        loop = asyncio.get_running_loop()
        original_call_later = loop.call_later
        deadline_handles: list[asyncio.TimerHandle] = []

        def record_deadline_handle(
            delay: float,
            callback: Callable[..., object],
            *args: object,
            context: contextvars.Context | None = None,
        ) -> asyncio.TimerHandle:
            handle = original_call_later(
                delay,
                callback,
                *args,
                context=context,
            )
            deadline_handles.append(handle)
            return handle

        with (
            patch.object(loop, "call_later", side_effect=record_deadline_handle),
            fake_forwarder_upstream() as upstream,
        ):
            status, body, _headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert len(deadline_handles) == 1
        assert deadline_handles[0].cancelled()
        assert upstream.socket.shutdown_calls == []
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    async def test_worker_rejects_result_after_deadline_before_timer_callback(self):
        class ControlledTime:
            def __init__(self) -> None:
                self._lock = threading.Lock()
                self._now = 0.0

            def monotonic(self) -> float:
                with self._lock:
                    return self._now

            def advance_past_deadline(self) -> None:
                with self._lock:
                    self._now = 11.0

        class UnscheduledDeadlineHandle:
            def __init__(self) -> None:
                self.cancel_count = 0

            def cancel(self) -> None:
                self.cancel_count += 1

        clock = ControlledTime()
        deadline_handle = UnscheduledDeadlineHandle()

        class DeadlineCrossingSocket(FakeSocket):
            def makefile(self, *_args, **_kwargs) -> FakeResponseFile:
                self.response_file = FakeResponseFile(
                    http_response(),
                    on_action=clock.advance_past_deadline,
                )
                return self.response_file

        loop = asyncio.get_running_loop()
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            with (
                patch.object(
                    forwarder,
                    "AUTH_BASE_FORWARD_DEADLINE_SECONDS",
                    10,
                ),
                patch.object(forwarder, "time", clock),
                patch.object(transport, "time", clock),
                patch.object(
                    loop,
                    "call_later",
                    return_value=deadline_handle,
                ),
                fake_forwarder_upstream(
                    socket_factory=lambda: DeadlineCrossingSocket(http_response())
                ),
                pytest.raises(
                    forwarder.AuthBaseForwardingDeadlineExceededError,
                    match=r"auth\.base forwarding deadline exceeded",
                ),
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

            assert deadline_handle.cancel_count == 1
            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
            with forwarder._forward_request_active_handles_lock:
                assert not forwarder._forward_request_active_handles

            semaphore = forwarder._get_forward_request_admission_semaphore()
            await semaphore.acquire()
            try:
                assert semaphore.locked()
            finally:
                semaphore.release()

            with fake_forwarder_upstream():
                status, body, _headers = await forwarder.forward_request(
                    "https://example.com",
                    "GET",
                    [],
                    None,
                )

        assert status == 200
        assert body == b"ok"

    def test_shutdown_before_worker_start_cancels_pending_forward(self):
        future: Future[tuple[int, bytes, http.Headers]] = Future()
        with forwarder._forward_request_pending_futures_lock:
            forwarder._forward_request_pending_futures.add(future)

        forwarder.shutdown_forward_request_workers(wait=False)

        assert future.cancelled()
        with forwarder._forward_request_pending_futures_lock:
            assert future not in forwarder._forward_request_pending_futures

        with patch.object(forwarder, "_forward_request_sync_in_context") as forward_sync:
            forwarder._run_forward_request_worker(
                future,
                contextvars.copy_context(),
                transport.prepare_forward_request("https://example.com"),
                "GET",
                [],
                None,
                (),
                forwarder._ForwardRequestAbortHandle(MagicMock()),
                time.monotonic() + 30,
            )

        forward_sync.assert_not_called()
        assert future.cancelled()

    def test_shutdown_rejects_new_forward_admission(self):
        forwarder.shutdown_forward_request_workers(wait=False)

        with pytest.raises(RuntimeError, match="workers are shut down"):
            forwarder.reserve_forward_request_admission(0)

        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_rejects_body_over_limit_before_forwarding(self):
        with (
            patch.object(transport, "MAX_AUTH_BASE_REQUEST_BODY_BYTES", 4),
            fake_forwarder_upstream() as upstream,
            pytest.raises(transport.ForwardedRequestTooLargeError),
        ):
            await forwarder.forward_request(
                "https://example.com",
                "POST",
                [],
                b"12345",
            )

        assert upstream.resolve_calls == []

    async def test_rejects_when_admitted_forward_count_is_saturated(self):
        with patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 1):
            async with forwarder_concurrency_harness() as (scenario, upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request("https://example.com", "GET", [], None)

        assert upstream.resolve_calls == ["example.com"]
        assert upstream.connect_calls == [("93.184.216.34", 443)]

    async def test_rejects_when_admitted_forward_body_bytes_are_saturated(self):
        with (
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES", 4),
        ):
            async with forwarder_concurrency_harness() as (scenario, upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "POST", [], b"1234")
                    )
                )
                assert await scenario.wait_started(1)
                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request("https://example.com", "POST", [], b"x")

        assert upstream.resolve_calls == ["example.com"]
        assert upstream.connect_calls == [("93.184.216.34", 443)]

    async def test_releases_forward_slot_when_forwarding_raises(self):
        first = True

        def make_socket():
            nonlocal first

            if first:
                first = False
                return FakeSocket(
                    http_response(),
                    send_side_effect=ConnectionError("upstream unavailable"),
                )
            return FakeSocket(http_response())

        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(socket_factory=make_socket),
        ):
            with pytest.raises(ConnectionError, match="upstream unavailable"):
                await forwarder.forward_request("https://example.com", "GET", [], None)

            status, body, headers = await asyncio.wait_for(
                forwarder.forward_request("https://example.com", "GET", [], None),
                timeout=1,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []

    async def test_worker_start_failure_releases_tracking_and_capacity(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            fake_forwarder_upstream(),
        ):
            with (
                patch.object(
                    forwarder.threading.Thread,
                    "start",
                    side_effect=RuntimeError("can't start new thread"),
                ),
                pytest.raises(RuntimeError, match="can't start new thread"),
            ):
                await forwarder.forward_request(
                    "https://example.com",
                    "POST",
                    [],
                    b"request body",
                )

            assert forwarder.forward_request_admission_state_for_tests() == (0, 0)
            with forwarder._forward_request_pending_futures_lock:
                assert not forwarder._forward_request_pending_futures
            with forwarder._forward_request_workers_lock:
                assert not forwarder._forward_request_workers

            status, body, headers = await asyncio.wait_for(
                forwarder.forward_request("https://example.com", "GET", [], None),
                timeout=2,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []

    async def test_limits_concurrent_forwarding_work(self):
        cap = 2
        task_count = cap + 2
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", cap):
            async with forwarder_concurrency_harness(blocked_connections=cap) as (
                scenario,
                _upstream,
            ):
                tasks = [
                    scenario.track_task(
                        asyncio.create_task(
                            forwarder.forward_request("https://example.com", "GET", [], None)
                        )
                    )
                    for _ in range(task_count)
                ]
                assert await scenario.wait_started(cap)
                scenario.release()
                results = await asyncio.gather(*tasks)

        response_summaries = [
            (status, body, list(headers.items(multi=True))) for status, body, headers in results
        ]
        assert response_summaries == [(200, b"ok", [])] * task_count
        assert scenario.max_active == cap

    async def test_cancelled_await_does_not_release_running_forward_slot(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 1),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                first_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                assert scenario.started == 1

                first_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(first_task, timeout=1)
                assert scenario.active == 1
                started_before_second_attempt = scenario.started

                with pytest.raises(forwarder.AuthBaseForwardingSaturatedError):
                    await forwarder.forward_request("https://example.com", "GET", [], None)
                assert scenario.started == started_before_second_attempt

                scenario.release()

        assert scenario.started == 1
        assert scenario.max_active == 1

    async def test_cancelled_waiting_forward_does_not_leak_forward_slot(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                waiting_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                assert scenario.started == 1

                waiting_task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(waiting_task, timeout=1)

                third_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                await _run_ready_tasks()
                assert scenario.started == 1

                scenario.release()
                assert await scenario.wait_started(2)

                status, body, headers = await asyncio.wait_for(third_task, timeout=2)

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert scenario.started == 2
        assert scenario.max_active == 1

    async def test_admission_limit_change_does_not_reset_concurrency_limit(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)
                assert scenario.started == 1

                with patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 3):
                    second_task = scenario.track_task(
                        asyncio.create_task(
                            forwarder.forward_request("https://example.com", "GET", [], None)
                        )
                    )
                    await _run_ready_tasks()

                assert scenario.started == 1

                scenario.release()
                assert await scenario.wait_started(2)

                status, body, headers = await asyncio.wait_for(second_task, timeout=2)

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert scenario.started == 2
        assert scenario.max_active == 1

    def test_worker_base_exception_completes_future_before_propagating(self):
        future: Future[tuple[int, bytes, http.Headers]] = Future()
        with forwarder._forward_request_pending_futures_lock:
            forwarder._forward_request_pending_futures.add(future)

        with (
            patch.object(
                forwarder,
                "_forward_request_sync_in_context",
                side_effect=SystemExit("worker stopped"),
            ),
            pytest.raises(SystemExit, match="worker stopped"),
        ):
            forwarder._run_forward_request_worker(
                future,
                contextvars.copy_context(),
                transport.prepare_forward_request("https://example.com"),
                "GET",
                [],
                None,
                (),
                forwarder._ForwardRequestAbortHandle(MagicMock()),
                time.monotonic() + 30,
            )

        assert future.done()
        with pytest.raises(RuntimeError, match="worker exited without completing future"):
            future.result()
        with forwarder._forward_request_pending_futures_lock:
            assert future not in forwarder._forward_request_pending_futures

    async def test_shutdown_rejects_untracked_running_forward_and_waiting_forward(self):
        with patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                first_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                waiting_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)

                forwarder.shutdown_forward_request_workers(wait=False)
                scenario.release()

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(first_task, timeout=2)
                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(waiting_task, timeout=2)

        assert scenario.started == 1

    async def test_shutdown_wakes_waiting_forward_when_running_forward_is_blocked(self):
        with (
            patch.object(forwarder, "MAX_CONCURRENT_AUTH_BASE_FORWARDS", 1),
            patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 2),
        ):
            async with forwarder_concurrency_harness() as (scenario, _upstream):
                scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                waiting_task = scenario.track_task(
                    asyncio.create_task(
                        forwarder.forward_request("https://example.com", "GET", [], None)
                    )
                )
                assert await scenario.wait_started(1)

                with patch.object(forwarder, "MAX_ADMITTED_AUTH_BASE_FORWARDS", 0):
                    forwarder.shutdown_forward_request_workers(wait=False)

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(waiting_task, timeout=2)

        assert scenario.started == 1

    async def test_shutdown_closes_active_forward_socket(self):
        setsockopt_entered = threading.Event()
        socket_closed = threading.Event()
        release_setsockopt = threading.Event()

        class BlockingSetsockoptSocket(FakeSocket):
            def setsockopt(self, level: int, optname: int, value: int) -> None:
                self.setsockopt_calls.append((level, optname, value))
                setsockopt_entered.set()
                if not release_setsockopt.wait(timeout=5):
                    raise TimeoutError("test did not release setsockopt")

            def close(self) -> None:
                super().close()
                socket_closed.set()
                release_setsockopt.set()

        socket = BlockingSetsockoptSocket(http_response())

        with fake_forwarder_upstream(socket_factory=lambda: socket):
            task = asyncio.create_task(
                forwarder.forward_request("https://example.com", "GET", [], None)
            )
            try:
                assert await asyncio.to_thread(setsockopt_entered.wait, 2)
                forwarder.shutdown_forward_request_workers(wait=False)
                assert await asyncio.to_thread(socket_closed.wait, 2)
            finally:
                release_setsockopt.set()
                await asyncio.gather(task, return_exceptions=True)

        assert socket.closed
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles

    async def test_shutdown_aborts_socket_during_connect(self):
        connect_entered = threading.Event()
        release_connect = threading.Event()

        class BlockingConnectSocket(FakeSocket):
            def connect(self, address) -> None:
                self.connect_calls.append(address)
                connect_entered.set()
                if not release_connect.wait(timeout=5):
                    raise TimeoutError("test did not release connect")

            def shutdown(self, how: int) -> None:
                super().shutdown(how)
                release_connect.set()

        socket = BlockingConnectSocket(http_response())
        with fake_forwarder_upstream(socket_factory=lambda: socket):
            task = asyncio.create_task(
                forwarder.forward_request("https://example.com", "GET", [], None)
            )
            try:
                assert await asyncio.to_thread(connect_entered.wait, 2)
                forwarder.shutdown_forward_request_workers(wait=False)

                with pytest.raises(RuntimeError, match="workers are shut down"):
                    await asyncio.wait_for(task, timeout=2)
            finally:
                release_connect.set()
                await asyncio.gather(task, return_exceptions=True)

        assert socket.closed
        assert socket.shutdown_calls == [forwarder.socket.SHUT_RDWR]
        assert not socket.setsockopt_calls
        with forwarder._forward_request_active_handles_lock:
            assert not forwarder._forward_request_active_handles
        assert forwarder.forward_request_admission_state_for_tests() == (0, 0)

    async def test_offloads_request_work_from_event_loop_thread(self):
        event_loop_thread_id = threading.get_ident()
        forwarding_thread_ids: list[int] = []

        def record_forwarding_thread():
            forwarding_thread_ids.append(threading.get_ident())

        with fake_forwarder_upstream(on_action=record_forwarding_thread):
            status, body, headers = await forwarder.forward_request(
                "https://example.com",
                "GET",
                [],
                None,
            )

        assert status == 200
        assert body == b"ok"
        assert list(headers.items(multi=True)) == []
        assert forwarding_thread_ids
        assert all(thread_id != event_loop_thread_id for thread_id in forwarding_thread_ids)

    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "http://example.com",
        ],
    )
    async def test_propagates_validation_errors(self, url: str):
        with pytest.raises(ValueError, match="Unsupported URL scheme"):
            await forwarder.forward_request(url, "GET", [], None)
