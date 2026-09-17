"""Shared fake upstream helpers for auth.base forwarding tests."""

import asyncio
import contextlib
import http.client as http_client
import io
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from types import SimpleNamespace
from unittest.mock import patch

from mitmproxy import http

import auth_base_transport as transport

__all__ = [
    "FakeForwarderUpstream",
    "FakeResponseFile",
    "FakeSocket",
    "FakeTLSContext",
    "ForwarderConcurrencyHarness",
    "fake_forwarder_upstream",
    "forwarder_concurrency_harness",
    "http_response",
]

_FORWARD_START_TIMEOUT_SECONDS = 2.0
_FORWARD_CLEANUP_TIMEOUT_SECONDS = 5.0
_ForwardResult = tuple[int, bytes, http.Headers]
_SocketAddress = tuple[str, int] | tuple[str, int, int, int]


def http_response(
    *,
    status: int = 200,
    body: bytes = b"ok",
    headers: list[tuple[str, str]] | None = None,
) -> bytes:
    """Build raw HTTP/1.1 response bytes for a fake upstream socket.

    The status line uses the standard reason phrase when Python knows the
    status code, repeated headers are preserved in order, and ``body`` is
    appended verbatim after the header terminator.
    """
    reason = http_client.responses.get(status, "OK")
    header_bytes = b"".join(f"{name}: {value}\r\n".encode() for name, value in (headers or []))
    return f"HTTP/1.1 {status} {reason}\r\n".encode("ascii") + header_bytes + b"\r\n" + body


class FakeResponseFile(io.BytesIO):
    """Readable response handle exposed through ``FakeSocket.response_file``.

    Tests use this object to assert how the real forwarder read and closed the
    upstream response. ``read_sizes`` and ``close_count`` are stable assertion
    state.
    """

    def __init__(
        self,
        payload: bytes,
        *,
        read_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
    ) -> None:
        super().__init__(payload)
        self._read_side_effect = read_side_effect
        self._on_action = on_action
        self.read_sizes: list[int] = []
        self.close_count = 0

    def read(self, size: int = -1) -> bytes:
        if self._on_action is not None:
            self._on_action()
        self.read_sizes.append(size)
        if self._read_side_effect is not None:
            raise self._read_side_effect
        return super().read(size)

    def close(self) -> None:
        self.close_count += 1
        super().close()


class FakeSocket:
    """Socket-like test double for the auth.base forwarding lifecycle.

    The real forwarder assigns the remaining deadline, connects to a validated
    numeric address, configures TCP, defers TLS negotiation until an explicit
    handshake, sends request bytes, reads response bytes through ``makefile()``,
    and shuts down or closes the active socket during cleanup.

    Stable assertion state includes ``timeout_calls``, ``connect_calls``,
    ``setsockopt_calls``, ``handshake_count``, ``sent``, ``response_file``,
    ``shutdown_calls``, ``closed``, and ``close_count``. Side-effect arguments
    raise at the matching send, read, TCP option, or manual TLS handshake
    boundary; ``handshake_side_effect`` specifically targets ``do_handshake()``.

    Use ``request_text``, ``request_lines``, and ``request_header_values`` for
    assertions about the HTTP request that the real forwarder serialized.
    """

    def __init__(
        self,
        response: bytes,
        *,
        read_side_effect: Exception | None = None,
        send_side_effect: Exception | None = None,
        setsockopt_side_effect: Exception | None = None,
        handshake_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
        on_connect: Callable[["FakeSocket", _SocketAddress], None] | None = None,
    ) -> None:
        self._response = response
        self._read_side_effect = read_side_effect
        self._send_side_effect = send_side_effect
        self._setsockopt_side_effect = setsockopt_side_effect
        self._handshake_side_effect = handshake_side_effect
        self._on_action = on_action
        self._on_connect = on_connect
        self.sent = bytearray()
        self.response_file: FakeResponseFile | None = None
        self.closed = False
        self.close_count = 0
        self.connect_calls: list[_SocketAddress] = []
        self.handshake_count = 0
        self.setsockopt_calls: list[tuple[int, int, int]] = []
        self.shutdown_calls: list[int] = []
        self.timeout_calls: list[float | None] = []

    def _record_action(self) -> None:
        if self._on_action is not None:
            self._on_action()

    def set_connect_callback(
        self,
        on_connect: Callable[["FakeSocket", _SocketAddress], None],
    ) -> None:
        self._on_connect = on_connect

    def setsockopt(self, level: int, optname: int, value: int) -> None:
        self._record_action()
        self.setsockopt_calls.append((level, optname, value))
        if self._setsockopt_side_effect is not None:
            raise self._setsockopt_side_effect

    def settimeout(self, timeout: float | None) -> None:
        self._record_action()
        self.timeout_calls.append(timeout)

    def connect(self, address: _SocketAddress) -> None:
        self._record_action()
        self.connect_calls.append(address)
        if self._on_connect is not None:
            self._on_connect(self, address)

    def do_handshake(self) -> None:
        self._record_action()
        self.handshake_count += 1
        if self._handshake_side_effect is not None:
            raise self._handshake_side_effect

    def sendall(self, data: bytes) -> None:
        self._record_action()
        if self._send_side_effect is not None:
            raise self._send_side_effect
        self.sent.extend(data)

    def makefile(self, *_args, **_kwargs) -> FakeResponseFile:
        self._record_action()
        self.response_file = FakeResponseFile(
            self._response,
            read_side_effect=self._read_side_effect,
            on_action=self._on_action,
        )
        return self.response_file

    def close(self) -> None:
        self._record_action()
        self.closed = True
        self.close_count += 1

    def shutdown(self, how: int) -> None:
        self._record_action()
        self.shutdown_calls.append(how)

    def request_text(self) -> str:
        return bytes(self.sent).decode("latin1")

    def request_lines(self) -> list[str]:
        return self.request_text().split("\r\n")

    def request_header_values(self, name: str) -> list[str]:
        prefix = f"{name.lower()}:"
        values: list[str] = []
        for line in self.request_lines()[1:]:
            if not line:
                break
            if line.lower().startswith(prefix):
                values.append(line.split(":", 1)[1].strip())
        return values


_ConnectSideEffect = Callable[[_SocketAddress], None]
_LookupSideEffect = Callable[[str], Awaitable[list[str]]]
_SocketFactory = Callable[[], FakeSocket]


class FakeTLSContext:
    """TLS context test double created by ``fake_forwarder_upstream``.

    Tests use ``server_hostnames`` to assert SNI behavior and
    ``do_handshake_on_connect`` to assert whether socket wrapping requested an
    immediate TLS handshake. The real forwarder passes ``False``, deferring
    negotiation to an explicit ``FakeSocket.do_handshake()`` call.
    ``alpn_protocols`` and ``post_handshake_auth`` reflect how the forwarder
    configures the TLS context before wrapping sockets.
    """

    def __init__(
        self,
        *,
        wrap_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
    ) -> None:
        self._wrap_side_effect = wrap_side_effect
        self._on_action = on_action
        self.alpn_protocols: list[str] = []
        self.post_handshake_auth = False
        self.do_handshake_on_connect: list[bool] = []
        self.server_hostnames: list[str] = []

    def set_alpn_protocols(self, protocols: list[str]) -> None:
        self.alpn_protocols = protocols

    def wrap_socket(
        self,
        raw_sock: FakeSocket,
        *,
        server_hostname: str,
        do_handshake_on_connect: bool,
    ):
        if self._on_action is not None:
            self._on_action()
        self.server_hostnames.append(server_hostname)
        self.do_handshake_on_connect.append(do_handshake_on_connect)
        if self._wrap_side_effect is not None:
            raise self._wrap_side_effect
        return raw_sock


class FakeForwarderUpstream:
    """Assertion handle yielded by ``fake_forwarder_upstream``.

    The class is public so the context manager's return value and stable fields
    are explicit. Tests should still obtain instances from
    ``fake_forwarder_upstream`` because direct construction does not patch
    ``auth_base_transport``.

    Stable assertion state includes DNS calls, connection calls, created
    sockets, TLS contexts, and the most recent socket via ``socket``.
    """

    def __init__(
        self,
        *,
        status: int = 200,
        body: bytes = b"ok",
        headers: list[tuple[str, str]] | None = None,
        addresses: tuple[str, ...] = ("93.184.216.34",),
        read_side_effect: Exception | None = None,
        send_side_effect: Exception | None = None,
        setsockopt_side_effect: Exception | None = None,
        wrap_side_effect: Exception | None = None,
        handshake_side_effect: Exception | None = None,
        on_action: Callable[[], None] | None = None,
        connect_side_effect: _ConnectSideEffect | None = None,
        lookup_side_effect: _LookupSideEffect | None = None,
        socket_factory: _SocketFactory | None = None,
    ) -> None:
        self._addresses = addresses
        self._response = http_response(status=status, body=body, headers=headers)
        self._read_side_effect = read_side_effect
        self._send_side_effect = send_side_effect
        self._setsockopt_side_effect = setsockopt_side_effect
        self._wrap_side_effect = wrap_side_effect
        self._handshake_side_effect = handshake_side_effect
        self._on_action = on_action
        self._connect_side_effect = connect_side_effect
        self._lookup_side_effect = lookup_side_effect
        self._socket_factory = socket_factory
        self.sockets: list[FakeSocket] = []
        self.contexts: list[FakeTLSContext] = []
        self.resolve_calls: list[str] = []
        self.socket_calls: list[tuple[int, int]] = []
        self.connect_calls: list[_SocketAddress] = []

    async def lookup_ip(self, host: str) -> list[str]:
        self.resolve_calls.append(host)
        if self._lookup_side_effect is not None:
            return await self._lookup_side_effect(host)
        return list(self._addresses)

    def create_socket(self, family: int, kind: int) -> FakeSocket:
        self.socket_calls.append((family, kind))
        sock = self._socket_factory() if self._socket_factory is not None else self.make_socket()
        sock.set_connect_callback(self._connect)
        self.sockets.append(sock)
        return sock

    def _connect(self, sock: FakeSocket, address: _SocketAddress) -> None:
        self.connect_calls.append(address)
        if self._connect_side_effect is not None:
            self._connect_side_effect(address)

    def make_socket(self) -> FakeSocket:
        return FakeSocket(
            self._response,
            read_side_effect=self._read_side_effect,
            send_side_effect=self._send_side_effect,
            setsockopt_side_effect=self._setsockopt_side_effect,
            handshake_side_effect=self._handshake_side_effect,
            on_action=self._on_action,
        )

    def create_default_context(self) -> FakeTLSContext:
        context = FakeTLSContext(
            wrap_side_effect=self._wrap_side_effect,
            on_action=self._on_action,
        )
        self.contexts.append(context)
        return context

    @property
    def socket(self) -> FakeSocket:
        assert self.sockets
        return self.sockets[-1]


class ForwarderConcurrencyHarness:
    """Coordinate blocked fake connections and their forwarding tasks."""

    def __init__(self, *, blocked_connections: int) -> None:
        self._blocked_connections = blocked_connections
        self._condition = threading.Condition()
        self._release = threading.Event()
        self._started = 0
        self._active = 0
        self._max_active = 0
        self._workers: set[threading.Thread] = set()
        self._tasks: set[asyncio.Task[_ForwardResult]] = set()

    def connect(self, _address: _SocketAddress) -> None:
        """Record and optionally block a worker at the connection boundary."""
        with self._condition:
            self._started += 1
            current = self._started
            self._active += 1
            self._max_active = max(self._max_active, self._active)
            self._workers.add(threading.current_thread())
            self._condition.notify_all()

        try:
            if current <= self._blocked_connections and not self._release.wait(
                timeout=_FORWARD_CLEANUP_TIMEOUT_SECONDS
            ):
                raise TimeoutError("test did not release blocked forwards")
        finally:
            with self._condition:
                self._active -= 1

    def track_task(self, task: asyncio.Task[_ForwardResult]) -> asyncio.Task[_ForwardResult]:
        """Register one scenario-owned task for failure-safe cleanup."""
        self._tasks.add(task)
        return task

    async def wait_started(
        self,
        count: int,
        *,
        wait_timeout: float = _FORWARD_START_TIMEOUT_SECONDS,
    ) -> bool:
        """Wait until at least ``count`` workers reach the connection boundary."""
        return await asyncio.to_thread(self._wait_started, count, wait_timeout)

    def _wait_started(self, count: int, timeout: float) -> bool:
        with self._condition:
            return self._condition.wait_for(lambda: self._started >= count, timeout=timeout)

    @property
    def started(self) -> int:
        with self._condition:
            return self._started

    @property
    def active(self) -> int:
        with self._condition:
            return self._active

    @property
    def max_active(self) -> int:
        with self._condition:
            return self._max_active

    def release(self) -> None:
        """Release every connection blocked by this harness."""
        self._release.set()

    async def _cleanup(self) -> None:
        self.release()
        timed_out_tasks = await self._collect_tasks()
        alive_workers = await asyncio.to_thread(self._join_workers)

        failures: list[str] = []
        if timed_out_tasks:
            failures.append(f"{len(timed_out_tasks)} forward task(s) exceeded cleanup timeout")
        if alive_workers:
            worker_names = ", ".join(sorted(worker.name for worker in alive_workers))
            failures.append(f"forward worker(s) did not finish before timeout: {worker_names}")
        if failures:
            raise AssertionError("; ".join(failures))

    async def _collect_tasks(self) -> set[asyncio.Task[_ForwardResult]]:
        if not self._tasks:
            return set()

        _, pending = await asyncio.wait(
            self._tasks,
            timeout=_FORWARD_CLEANUP_TIMEOUT_SECONDS,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        return pending

    def _join_workers(self) -> set[threading.Thread]:
        deadline = time.monotonic() + _FORWARD_CLEANUP_TIMEOUT_SECONDS
        with self._condition:
            workers = set(self._workers)
        for worker in workers:
            worker.join(timeout=max(0.0, deadline - time.monotonic()))
        return {worker for worker in workers if worker.is_alive()}


@contextlib.contextmanager
def fake_forwarder_upstream(
    *,
    status: int = 200,
    body: bytes = b"ok",
    headers: list[tuple[str, str]] | None = None,
    addresses: tuple[str, ...] = ("93.184.216.34",),
    read_side_effect: Exception | None = None,
    send_side_effect: Exception | None = None,
    setsockopt_side_effect: Exception | None = None,
    wrap_side_effect: Exception | None = None,
    handshake_side_effect: Exception | None = None,
    on_action: Callable[[], None] | None = None,
    connect_side_effect: _ConnectSideEffect | None = None,
    lookup_side_effect: _LookupSideEffect | None = None,
    socket_factory: _SocketFactory | None = None,
) -> Iterator[FakeForwarderUpstream]:
    """Patch auth.base DNS/connect/TLS boundaries and yield an upstream handle.

    The context manager patches only the forwarder's external resolver,
    ``auth_base_transport.socket.socket``, and
    ``auth_base_transport.ssl.create_default_context``. ``addresses`` controls
    the DNS answers returned to the real forwarder before any socket is opened.
    Socket and TLS side effects raise at their matching fake boundary.

    The yielded handle exposes stable assertion state: ``resolve_calls``,
    ``connect_calls``, ``sockets``, ``contexts``, and ``socket`` for
    the most recent connection.
    """
    upstream = FakeForwarderUpstream(
        status=status,
        body=body,
        headers=headers,
        addresses=addresses,
        read_side_effect=read_side_effect,
        send_side_effect=send_side_effect,
        setsockopt_side_effect=setsockopt_side_effect,
        wrap_side_effect=wrap_side_effect,
        handshake_side_effect=handshake_side_effect,
        on_action=on_action,
        connect_side_effect=connect_side_effect,
        lookup_side_effect=lookup_side_effect,
        socket_factory=socket_factory,
    )
    with (
        patch.object(transport, "_dns_resolver", upstream),
        # Keep the external transport fake local: the delivery control reactor
        # and its clients must still be able to open real Unix sockets.
        patch.object(transport, "socket", SimpleNamespace(**vars(transport.socket))),
        patch.object(
            transport.socket,
            "socket",
            side_effect=upstream.create_socket,
        ),
        patch.object(
            transport.ssl,
            "create_default_context",
            side_effect=upstream.create_default_context,
        ),
    ):
        yield upstream


@contextlib.asynccontextmanager
async def forwarder_concurrency_harness(
    *,
    blocked_connections: int = 1,
) -> AsyncIterator[tuple[ForwarderConcurrencyHarness, FakeForwarderUpstream]]:
    """Yield a blocked upstream harness and fully drain its workers on exit."""
    harness = ForwarderConcurrencyHarness(blocked_connections=blocked_connections)
    with fake_forwarder_upstream(connect_side_effect=harness.connect) as upstream:
        try:
            yield harness, upstream
        finally:
            await harness._cleanup()
