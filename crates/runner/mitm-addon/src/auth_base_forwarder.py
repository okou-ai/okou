"""Async lifecycle and admission for auth.base HTTPS forwarding.

The addon forwards auth.base requests itself because mitmproxy's eager
connection has already connected to the placeholder IP. This module is the
public forwarding facade and owns worker lifecycle and admission state.
"""

import asyncio
import contextvars
import socket
import sys
import threading
import time
from collections.abc import Callable
from concurrent.futures import Future, InvalidStateError
from contextlib import suppress
from enum import Enum, auto
from typing import NamedTuple

from mitmproxy import http

import auth_base_transport
import flow_metadata_keys as metadata_keys
import request_body_admission

DEFAULT_HTTPS_PORT = auth_base_transport.DEFAULT_HTTPS_PORT
HOP_BY_HOP = auth_base_transport.HOP_BY_HOP
MAX_AUTH_BASE_REQUEST_BODY_BYTES = auth_base_transport.MAX_AUTH_BASE_REQUEST_BODY_BYTES
MAX_AUTH_BASE_RESPONSE_BODY_BYTES = auth_base_transport.MAX_AUTH_BASE_RESPONSE_BODY_BYTES
AuthBaseForwardingDeadlineExceededError = (
    auth_base_transport.AuthBaseForwardingDeadlineExceededError
)
ForwardedRequestTooLargeError = auth_base_transport.ForwardedRequestTooLargeError
ForwardedResponseTooLargeError = auth_base_transport.ForwardedResponseTooLargeError
InvalidAuthBaseRequestHeadersError = auth_base_transport.InvalidAuthBaseRequestHeadersError
InvalidResolvedAuthHeaderError = auth_base_transport.InvalidResolvedAuthHeaderError
UnsafeAuthBaseDestinationError = auth_base_transport.UnsafeAuthBaseDestinationError
forwarded_auth_base_client_header_pairs = (
    auth_base_transport.forwarded_auth_base_client_header_pairs
)
forwarded_request_header_pairs = auth_base_transport.forwarded_request_header_pairs
header_pairs = auth_base_transport.header_pairs
resolved_auth_header_pairs = auth_base_transport.resolved_auth_header_pairs
trusted_request_header_pairs = auth_base_transport.trusted_request_header_pairs

type ForwardRequestPreSubmitGuard = Callable[[], bool]

MAX_CONCURRENT_AUTH_BASE_FORWARDS = 4
MAX_ADMITTED_AUTH_BASE_FORWARDS = 16
MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES = 128 * 1024 * 1024
AUTH_BASE_FORWARD_DEADLINE_SECONDS = 30.0
_NEGATIVE_FORWARD_REQUEST_BODY_SIZE_ERROR = "auth.base forwarding body size cannot be negative"
_FORWARD_REQUEST_CLEANUP_EXCEPTIONS: tuple[type[BaseException], ...] = (
    Exception,
    asyncio.CancelledError,
    KeyboardInterrupt,
    SystemExit,
    GeneratorExit,
)
_forward_request_accepting = True
_forward_request_lifecycle_lock = threading.Lock()
_forward_request_workers: set[threading.Thread] = set()
_forward_request_workers_lock = threading.Lock()
_forward_request_pending_futures: set[Future[tuple[int, bytes, http.Headers]]] = set()
_forward_request_pending_futures_lock = threading.Lock()
_forward_request_budget = request_body_admission.RequestBodyAdmissionBudget(
    metadata_key=metadata_keys.AUTH_BASE_FORWARD_ADMISSION,
    negative_size_message=_NEGATIVE_FORWARD_REQUEST_BODY_SIZE_ERROR,
    already_attached_message="auth.base forwarding admission is already attached to flow",
)
_forward_request_active_handles: set[_ForwardRequestAbortHandle] = set()
_forward_request_active_handles_lock = threading.Lock()


class _ForwardRequestAdmissionState(NamedTuple):
    loop: asyncio.AbstractEventLoop
    max_workers: int
    admission_limit: int
    semaphore: asyncio.Semaphore


_forward_request_admission_state: _ForwardRequestAdmissionState | None = None


def _track_active_forward_request_handle(handle: _ForwardRequestAbortHandle) -> bool:
    with _forward_request_lifecycle_lock, _forward_request_active_handles_lock:
        if not _forward_request_accepting:
            return False
        _forward_request_active_handles.add(handle)
        return True


def _untrack_active_forward_request_handle(handle: _ForwardRequestAbortHandle) -> None:
    with _forward_request_active_handles_lock:
        _forward_request_active_handles.discard(handle)


def _abort_active_forward_request_handles() -> None:
    with _forward_request_active_handles_lock:
        handles = tuple(_forward_request_active_handles)
    for handle in handles:
        handle.abort_for_shutdown()


def _cancel_pending_forward_request_futures() -> None:
    with _forward_request_pending_futures_lock:
        futures = tuple(_forward_request_pending_futures)
        _forward_request_pending_futures.clear()
    for future in futures:
        future.cancel()


def _wake_forward_request_admission_waiters(
    state: _ForwardRequestAdmissionState | None,
) -> None:
    if state is None:
        return

    def release_waiters() -> None:
        # Wake every admitted waiter. Shutdown has already disabled submission, so
        # these extra permits only let waiters observe the closed lifecycle state.
        for _ in range(state.admission_limit):
            state.semaphore.release()

    with suppress(RuntimeError):
        state.loop.call_soon_threadsafe(release_waiters)


def _discard_pending_forward_request_future(
    future: Future[tuple[int, bytes, http.Headers]],
) -> None:
    with _forward_request_pending_futures_lock:
        _forward_request_pending_futures.discard(future)


def _join_forward_request_workers() -> None:
    current_thread = threading.current_thread()
    while True:
        with _forward_request_workers_lock:
            workers = tuple(
                worker
                for worker in _forward_request_workers
                if worker is not current_thread and worker.is_alive()
            )
        if not workers:
            return
        for worker in workers:
            worker.join()


def reset_forward_request_state_for_tests() -> None:
    """Reset forwarder worker state between tests."""
    global _forward_request_accepting

    shutdown_forward_request_workers(wait=True)
    _forward_request_budget.reset_for_tests()
    _forward_request_accepting = True


def shutdown_forward_request_workers(*, wait: bool) -> None:
    """Close admission and shut down the auth.base forwarding worker lifecycle.

    This is a one-way production transition: new forwards are rejected, and the
    admission state is cleared. Admitted waiters are woken so they can observe
    shutdown, pending worker futures are cancelled, and active DNS lookups or
    upstream sockets are best-effort aborted. Affected forwards therefore become
    terminal instead of waiting indefinitely for admission or upstream work.

    Both values of `wait` perform those shutdown actions. `wait=True` additionally
    joins the tracked daemon worker threads, while `wait=False` returns without
    joining them and does not wait for slow upstream responses. The latter is used
    by production teardown to keep process shutdown bounded.

    Production shutdown cannot re-enable admission. The test-only
    `reset_forward_request_state_for_tests()` helper is the mechanism that resets
    worker and admission state and re-enables forwarding between tests.
    """
    global _forward_request_admission_state
    global _forward_request_accepting

    with _forward_request_lifecycle_lock:
        _forward_request_accepting = False
        admission_state = _forward_request_admission_state
        _forward_request_admission_state = None
    _wake_forward_request_admission_waiters(admission_state)
    _abort_active_forward_request_handles()
    _cancel_pending_forward_request_futures()
    if wait:
        _join_forward_request_workers()


class AuthBaseForwardingSaturatedError(Exception):
    """Raised when auth.base forwarding admission is saturated."""


class ForwardRequestPreSubmitRejectedError(Exception):
    """Raised when a caller rejects forwarding after asynchronous preparation."""


class _ForwardRequestTerminalState(Enum):
    COMPLETED = auto()
    DEADLINE_EXPIRED = auto()
    SHUTDOWN_ABORTED = auto()


def _abort_socket(sock: socket.socket) -> None:
    with suppress(Exception):
        sock.shutdown(socket.SHUT_RDWR)
    with suppress(Exception):
        sock.close()


class _ForwardRequestAbortHandle:
    """Serialize one forward's async lookup, socket, deadline, and shutdown."""

    __slots__ = ("_async_cancel", "_lock", "_loop", "_socket", "_terminal_state")

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._async_cancel: Callable[[], object] | None = None
        self._lock = threading.Lock()
        self._loop = loop
        self._socket: socket.socket | None = None
        self._terminal_state: _ForwardRequestTerminalState | None = None

    def register_async_cancel(self, cancel: Callable[[], object]) -> None:
        with self._lock:
            terminal_state = self._terminal_state
            if terminal_state is None:
                self._async_cancel = cancel
                return
        cancel()
        self._raise_terminal(terminal_state)

    def clear_async_cancel(self, cancel: Callable[[], object]) -> None:
        with self._lock:
            if self._async_cancel is cancel:
                self._async_cancel = None

    def register_socket(self, sock: socket.socket) -> None:
        with self._lock:
            terminal_state = self._terminal_state
            if terminal_state is None:
                self._socket = sock
                return
        _abort_socket(sock)
        self._raise_terminal(terminal_state)

    def replace_socket(self, current: socket.socket, replacement: socket.socket) -> None:
        with self._lock:
            terminal_state = self._terminal_state
            if terminal_state is None and self._socket is current:
                self._socket = replacement
                return
        _abort_socket(replacement)
        if terminal_state is None:
            raise RuntimeError("auth.base forwarding socket ownership changed unexpectedly")
        self._raise_terminal(terminal_state)

    def clear_socket(self, sock: socket.socket) -> None:
        with self._lock:
            if self._socket is sock:
                self._socket = None

    def abort_for_deadline(self) -> bool:
        return self._abort(_ForwardRequestTerminalState.DEADLINE_EXPIRED)

    def abort_for_shutdown(self) -> bool:
        return self._abort(_ForwardRequestTerminalState.SHUTDOWN_ABORTED)

    def finish(self, deadline: float) -> _ForwardRequestTerminalState:
        async_cancel: Callable[[], object] | None = None
        sock: socket.socket | None = None
        with self._lock:
            if self._terminal_state is None:
                if time.monotonic() >= deadline:
                    self._terminal_state = _ForwardRequestTerminalState.DEADLINE_EXPIRED
                    async_cancel = self._async_cancel
                    sock = self._socket
                else:
                    self._terminal_state = _ForwardRequestTerminalState.COMPLETED
                self._async_cancel = None
                self._socket = None
            terminal_state = self._terminal_state
        self._cancel_async(async_cancel)
        if sock is not None:
            _abort_socket(sock)
        return terminal_state

    @property
    def terminal_state(self) -> _ForwardRequestTerminalState | None:
        with self._lock:
            return self._terminal_state

    def raise_if_aborted(self) -> None:
        terminal_state = self.terminal_state
        if terminal_state is not None:
            self._raise_terminal(terminal_state)

    def _abort(self, terminal_state: _ForwardRequestTerminalState) -> bool:
        async_cancel: Callable[[], object] | None = None
        sock: socket.socket | None = None
        with self._lock:
            if self._terminal_state is not None:
                return False
            self._terminal_state = terminal_state
            async_cancel = self._async_cancel
            sock = self._socket
            self._async_cancel = None
            self._socket = None
        self._cancel_async(async_cancel)
        if sock is not None:
            _abort_socket(sock)
        return True

    def _cancel_async(self, cancel: Callable[[], object] | None) -> None:
        if cancel is not None:
            with suppress(RuntimeError):
                self._loop.call_soon_threadsafe(cancel)

    @staticmethod
    def _raise_terminal(terminal_state: _ForwardRequestTerminalState) -> None:
        if terminal_state is _ForwardRequestTerminalState.DEADLINE_EXPIRED:
            raise AuthBaseForwardingDeadlineExceededError("auth.base forwarding deadline exceeded")
        if terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
            raise RuntimeError("auth.base forwarding workers are shut down")
        raise RuntimeError("auth.base forwarding attempt is already completed")


def reserve_forward_request_admission(
    body_bytes: int,
) -> request_body_admission.RequestBodyAdmissionLease:
    """Reserve aggregate auth.base forwarding capacity before body buffering."""
    if body_bytes < 0:
        raise ValueError(_NEGATIVE_FORWARD_REQUEST_BODY_SIZE_ERROR)

    with _forward_request_lifecycle_lock:
        if not _forward_request_accepting:
            raise RuntimeError("auth.base forwarding workers are shut down")

        try:
            return _forward_request_budget.reserve(
                body_bytes,
                max_admitted_count=MAX_ADMITTED_AUTH_BASE_FORWARDS,
                max_admitted_body_bytes=MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES,
            )
        except request_body_admission.RequestBodyAdmissionCountSaturatedError:
            raise AuthBaseForwardingSaturatedError(
                "auth.base forwarding admission is full"
            ) from None
        except request_body_admission.RequestBodyAdmissionByteSaturatedError:
            raise AuthBaseForwardingSaturatedError(
                "auth.base forwarding body budget is full"
            ) from None


def adjust_forward_request_admission(
    admission: request_body_admission.RequestBodyAdmissionLease,
    body_bytes: int,
) -> None:
    """Resize an existing reservation when actual body size differs."""
    try:
        _forward_request_budget.resize(
            admission,
            body_bytes,
            max_admitted_body_bytes=MAX_ADMITTED_AUTH_BASE_REQUEST_BODY_BYTES,
            already_released_message="auth.base forwarding admission is already released",
        )
    except request_body_admission.RequestBodyAdmissionByteSaturatedError:
        raise AuthBaseForwardingSaturatedError("auth.base forwarding body budget is full") from None


def release_forward_request_admission(
    admission: request_body_admission.RequestBodyAdmissionLease,
) -> None:
    """Release aggregate auth.base forwarding capacity exactly once."""
    _forward_request_budget.release(admission)


def attach_forward_request_admission_to_flow(
    flow: http.HTTPFlow,
    admission: request_body_admission.RequestBodyAdmissionLease,
) -> None:
    """Attach an auth.base forward admission to a flow until ownership is transferred."""
    _forward_request_budget.attach_to_flow(flow, admission)


def take_forward_request_admission_from_flow(
    flow: http.HTTPFlow,
) -> request_body_admission.RequestBodyAdmissionLease | None:
    """Remove an attached auth.base forward admission and transfer ownership."""
    return _forward_request_budget.take_from_flow(flow)


def release_forward_request_admission_from_flow(flow: http.HTTPFlow) -> None:
    """Release any auth.base forward admission still attached to a flow."""
    _forward_request_budget.release_from_flow(flow)


def forward_request_admission_state_for_tests() -> tuple[int, int]:
    """Return current admitted count and body bytes for tests."""
    return _forward_request_budget.state_for_tests()


def _get_forward_request_admission_semaphore() -> asyncio.Semaphore:
    global _forward_request_admission_state

    with _forward_request_lifecycle_lock:
        if not _forward_request_accepting:
            raise RuntimeError("auth.base forwarding workers are shut down")
        loop = asyncio.get_running_loop()
        max_workers = MAX_CONCURRENT_AUTH_BASE_FORWARDS
        admission_limit = MAX_ADMITTED_AUTH_BASE_FORWARDS
        if (
            _forward_request_admission_state is None
            or _forward_request_admission_state.loop is not loop
            or _forward_request_admission_state.max_workers != max_workers
        ):
            _forward_request_admission_state = _ForwardRequestAdmissionState(
                loop=loop,
                max_workers=max_workers,
                admission_limit=admission_limit,
                semaphore=asyncio.Semaphore(max_workers),
            )
        elif admission_limit > _forward_request_admission_state.admission_limit:
            # Keep the same semaphore so a capacity change cannot reset the
            # active concurrency limit while forwards are already running.
            _forward_request_admission_state = _ForwardRequestAdmissionState(
                loop=_forward_request_admission_state.loop,
                max_workers=_forward_request_admission_state.max_workers,
                admission_limit=admission_limit,
                semaphore=_forward_request_admission_state.semaphore,
            )
        return _forward_request_admission_state.semaphore


def _can_submit_forward_request(semaphore: asyncio.Semaphore) -> bool:
    with _forward_request_lifecycle_lock:
        return (
            _forward_request_accepting
            and _forward_request_admission_state is not None
            and _forward_request_admission_state.semaphore is semaphore
        )


def _release_forward_request_resources(
    loop: asyncio.AbstractEventLoop,
    semaphore: asyncio.Semaphore,
    admission: request_body_admission.RequestBodyAdmissionLease,
    abort_handle: _ForwardRequestAbortHandle,
    deadline_timer: asyncio.TimerHandle,
    _future: Future[tuple[int, bytes, http.Headers]],
) -> None:
    _untrack_active_forward_request_handle(abort_handle)
    release_forward_request_admission(admission)

    def release_on_loop() -> None:
        deadline_timer.cancel()
        semaphore.release()

    with suppress(RuntimeError):
        loop.call_soon_threadsafe(release_on_loop)


def _forward_request_sync_in_context(
    context: contextvars.Context,
    prepared: auth_base_transport.PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[auth_base_transport.ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> tuple[int, bytes, http.Headers]:
    return context.run(
        auth_base_transport.forward_request_sync,
        prepared,
        method,
        headers,
        body,
        validated_addresses,
        abort_handle,
        deadline,
    )


def _set_forward_request_future_exception(
    future: Future[tuple[int, bytes, http.Headers]],
    exc: BaseException,
) -> None:
    with suppress(InvalidStateError):
        future.set_exception(exc)


def _set_forward_request_terminal_exception(
    future: Future[tuple[int, bytes, http.Headers]],
    terminal_state: _ForwardRequestTerminalState,
) -> bool:
    if terminal_state is _ForwardRequestTerminalState.DEADLINE_EXPIRED:
        _set_forward_request_future_exception(
            future,
            AuthBaseForwardingDeadlineExceededError("auth.base forwarding deadline exceeded"),
        )
        return True
    if terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
        _set_forward_request_future_exception(
            future,
            RuntimeError("auth.base forwarding workers are shut down"),
        )
        return True
    return False


def _run_forward_request_worker(
    future: Future[tuple[int, bytes, http.Headers]],
    context: contextvars.Context,
    prepared: auth_base_transport.PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[auth_base_transport.ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> None:
    try:
        with _forward_request_lifecycle_lock:
            if not _forward_request_accepting:
                future.cancel()
                _discard_pending_forward_request_future(future)
                return
            if not future.set_running_or_notify_cancel():
                _discard_pending_forward_request_future(future)
                return
            _discard_pending_forward_request_future(future)
        try:
            result = _forward_request_sync_in_context(
                context,
                prepared,
                method,
                headers,
                body,
                validated_addresses,
                abort_handle,
                deadline,
            )
        except Exception as exc:
            terminal_state = abort_handle.finish(deadline)
            if not _set_forward_request_terminal_exception(future, terminal_state):
                _set_forward_request_future_exception(future, exc)
        else:
            terminal_state = abort_handle.finish(deadline)
            if not _set_forward_request_terminal_exception(future, terminal_state):
                with suppress(InvalidStateError):
                    future.set_result(result)
    finally:
        if sys.exc_info()[1] is not None and future.running():
            terminal_state = abort_handle.finish(deadline)
            if not _set_forward_request_terminal_exception(future, terminal_state):
                _set_forward_request_future_exception(
                    future,
                    RuntimeError("auth.base forwarding worker exited without completing future"),
                )
        with _forward_request_workers_lock:
            _forward_request_workers.discard(threading.current_thread())


def _start_forward_request_worker(
    context: contextvars.Context,
    prepared: auth_base_transport.PreparedForwardRequest,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    validated_addresses: tuple[auth_base_transport.ValidatedAddress, ...],
    abort_handle: _ForwardRequestAbortHandle,
    deadline: float,
) -> Future[tuple[int, bytes, http.Headers]]:
    future: Future[tuple[int, bytes, http.Headers]] = Future()
    worker = threading.Thread(
        target=_run_forward_request_worker,
        args=(
            future,
            context,
            prepared,
            method,
            headers,
            body,
            validated_addresses,
            abort_handle,
            deadline,
        ),
        name="auth-base-forward",
        daemon=True,
    )
    with _forward_request_lifecycle_lock:
        if not _forward_request_accepting:
            raise RuntimeError("auth.base forwarding workers are shut down")
        with _forward_request_pending_futures_lock:
            _forward_request_pending_futures.add(future)
        with _forward_request_workers_lock:
            _forward_request_workers.add(worker)
        try:
            worker.start()
        except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
            with _forward_request_pending_futures_lock:
                _forward_request_pending_futures.discard(future)
            with _forward_request_workers_lock:
                _forward_request_workers.discard(worker)
            future.cancel()
            raise
    return future


async def forward_request(
    url: str,
    method: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    *,
    admission: request_body_admission.RequestBodyAdmissionLease | None = None,
    pre_submit_guard: ForwardRequestPreSubmitGuard | None = None,
) -> tuple[int, bytes, http.Headers]:
    """Forward an auth.base request within one absolute worker lifetime.

    When this coroutine starts, it reserves admission capacity unless `admission` is supplied.
    A supplied admission is consumed: it is resized to the actual request body or released if
    validation or resizing fails. The caller must not release or reuse it after scheduling or
    awaiting this coroutine.

    One monotonic deadline covers active-slot waiting, DNS, connect, TLS, request, and response
    work. Deadline expiry cancels async resolution or aborts the request's active socket. After
    worker submission, only the worker future's completion callback releases admission and
    concurrency capacity.

    After asynchronous preparation, an optional synchronous guard runs on the event-loop thread
    immediately before worker submission. Guard rejection creates no worker. Cancellation before
    submission also creates no worker, while cancelling a pending worker future prevents it from
    running. Once synchronous work has started, caller cancellation does not stop it; the
    independent deadline remains armed and the worker retains resources until completion.

    Request body size, admission saturation, shutdown, URL/header/destination validation, upstream
    forwarding, and response processing failures propagate to the caller.
    """
    body_bytes = auth_base_transport.request_body_size(body)
    try:
        auth_base_transport.validate_request_body_size(body)
    except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
        if admission is not None:
            release_forward_request_admission(admission)
        raise
    if admission is None:
        admission = reserve_forward_request_admission(body_bytes)
    else:
        try:
            adjust_forward_request_admission(admission, body_bytes)
        except _FORWARD_REQUEST_CLEANUP_EXCEPTIONS:
            release_forward_request_admission(admission)
            raise

    deadline = time.monotonic() + AUTH_BASE_FORWARD_DEADLINE_SECONDS
    submitted = False
    semaphore_acquired = False
    abort_handle: _ForwardRequestAbortHandle | None = None
    deadline_timer: asyncio.TimerHandle | None = None
    try:
        loop = asyncio.get_running_loop()
        semaphore = _get_forward_request_admission_semaphore()
        context = contextvars.copy_context()
        try:
            async with asyncio.timeout(auth_base_transport.remaining_deadline_seconds(deadline)):
                await semaphore.acquire()
                semaphore_acquired = True
        except TimeoutError as exc:
            raise AuthBaseForwardingDeadlineExceededError(
                "auth.base forwarding deadline exceeded"
            ) from exc
        if not _can_submit_forward_request(semaphore):
            raise RuntimeError("auth.base forwarding workers are shut down")

        abort_handle = _ForwardRequestAbortHandle(loop)
        if not _track_active_forward_request_handle(abort_handle):
            abort_handle.abort_for_shutdown()
            raise RuntimeError("auth.base forwarding workers are shut down")

        prepared = auth_base_transport.prepare_forward_request(url)
        effective_port = prepared.port if prepared.port is not None else DEFAULT_HTTPS_PORT
        try:
            async with asyncio.timeout(auth_base_transport.remaining_deadline_seconds(deadline)):
                validated_addresses = await auth_base_transport.resolve_validated_addresses(
                    prepared.host,
                    effective_port,
                    abort_handle,
                )
        except TimeoutError as exc:
            abort_handle.abort_for_deadline()
            raise AuthBaseForwardingDeadlineExceededError(
                "auth.base forwarding deadline exceeded"
            ) from exc
        except asyncio.CancelledError:
            if abort_handle.terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
                raise RuntimeError("auth.base forwarding workers are shut down") from None
            raise

        if pre_submit_guard is not None and not pre_submit_guard():
            raise ForwardRequestPreSubmitRejectedError(
                "auth.base forwarding rejected before worker submission"
            )

        deadline_timer = loop.call_later(
            auth_base_transport.remaining_deadline_seconds(deadline),
            abort_handle.abort_for_deadline,
        )
        future = _start_forward_request_worker(
            context,
            prepared,
            method,
            headers,
            body,
            validated_addresses,
            abort_handle,
            deadline,
        )
        future.add_done_callback(
            lambda completed_future: _release_forward_request_resources(
                loop,
                semaphore,
                admission,
                abort_handle,
                deadline_timer,
                completed_future,
            )
        )
        submitted = True
        semaphore_acquired = False
        try:
            return await asyncio.wrap_future(future, loop=loop)
        except asyncio.CancelledError:
            future.cancel()
            if abort_handle.terminal_state is _ForwardRequestTerminalState.SHUTDOWN_ABORTED:
                raise RuntimeError("auth.base forwarding workers are shut down") from None
            raise
    finally:
        if not submitted:
            if deadline_timer is not None:
                deadline_timer.cancel()
            if abort_handle is not None:
                abort_handle.finish(deadline)
                _untrack_active_forward_request_handle(abort_handle)
            if semaphore_acquired:
                semaphore.release()
            release_forward_request_admission(admission)
