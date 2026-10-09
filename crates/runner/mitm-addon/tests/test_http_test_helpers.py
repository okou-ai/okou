"""Concurrency contracts for threaded loopback HTTP test helpers."""

from __future__ import annotations

import http.client
import selectors
import socket
import threading
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass
from http.server import ThreadingHTTPServer
from types import TracebackType
from unittest.mock import patch

import pytest

from tests.auth_endpoint_helpers import FakeAuthEndpoint
from tests.thread_helpers import ThreadUnderTest, wait_for_event
from tests.threaded_http_test_server import ThreadedHttpTestServer
from tests.usage_helpers import UsageWebhookServer

_THREAD_TIMEOUT_SECONDS = 2.0
_Response = tuple[int, bytes]


@dataclass(frozen=True)
class _CapturedRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


class _PauseFirstHandlerReacquire:
    """Force a split record/reserve implementation to invert two responses.

    The first handler may complete one synchronized transition. If it tries to
    acquire the lock again, it waits until the second handler has acquired and
    released the lock twice. A correct single-transition implementation never
    takes that second acquisition and therefore never waits.
    """

    def __init__(self) -> None:
        self.first_transition_released = threading.Event()
        self._second_handler_reserved_or_cleanup = threading.Event()
        self._state_lock = threading.Lock()
        self._lock = threading.Lock()
        self._first_thread: threading.Thread | None = None
        self._owner_thread: threading.Thread | None = None
        self._acquisition_counts: dict[threading.Thread, int] = {}

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        thread = threading.current_thread()
        with self._state_lock:
            acquisition_count = self._acquisition_counts.get(thread, 0) + 1
            first_thread = self._first_thread

        if (
            thread == first_thread
            and acquisition_count == 2
            and not self._second_handler_reserved_or_cleanup.wait(timeout=_THREAD_TIMEOUT_SECONDS)
        ):
            raise AssertionError("second handler did not reserve its response")

        if timeout == -1:
            acquired = self._lock.acquire(blocking)
        else:
            acquired = self._lock.acquire(blocking, timeout)
        if not acquired:
            return False

        with self._state_lock:
            if self._first_thread is None:
                self._first_thread = thread
            self._owner_thread = thread
            self._acquisition_counts[thread] = acquisition_count
        return True

    def release(self) -> None:
        thread = threading.current_thread()
        with self._state_lock:
            acquisition_count = self._acquisition_counts[thread]
            first_thread = self._first_thread
            self._owner_thread = None

        self._lock.release()

        if thread == first_thread and acquisition_count == 1:
            self.first_transition_released.set()
        elif thread != first_thread and acquisition_count == 2:
            self._second_handler_reserved_or_cleanup.set()

    def unblock_for_cleanup(self) -> None:
        self._second_handler_reserved_or_cleanup.set()

    def locked(self) -> bool:
        return self._lock.locked()

    def _is_owned(self) -> bool:
        with self._state_lock:
            return self._owner_thread == threading.current_thread()

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        self.release()


def _request(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> _Response:
    parsed = urllib.parse.urlsplit(url)
    assert parsed.scheme == "http"
    assert parsed.hostname is not None
    connection = http.client.HTTPConnection(
        parsed.hostname,
        parsed.port,
        timeout=_THREAD_TIMEOUT_SECONDS,
    )
    try:
        connection.request(
            method,
            parsed.path,
            body=body,
            headers={} if headers is None else headers,
        )
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def _post(url: str) -> _Response:
    return _request("POST", url, body=b"{}")


def _start_post(
    url: str,
    *,
    key: str,
    responses: dict[str, _Response],
    responses_lock: threading.Lock,
) -> ThreadUnderTest:
    def post() -> None:
        response = _post(url)
        with responses_lock:
            responses[key] = response

    thread = ThreadUnderTest(target=post, name=f"http-test-helper-{key}")
    thread.start()
    return thread


@pytest.mark.parametrize("failure_point", ["__init__", "start"])
@pytest.mark.parametrize("failure_type", [RuntimeError, OSError])
def test_threaded_http_server_closes_listener_after_startup_failure(
    failure_point: str,
    failure_type: type[Exception],
) -> None:
    server = ThreadedHttpTestServer(
        request_factory=_CapturedRequest,
        default_status=204,
        thread_name="startup-failure-http-test-server",
    )
    failure = failure_type("injected thread startup failure")
    listener: socket.socket | None = None
    shutdown_sockets: list[socket.socket] = []
    socketpair = socket.socketpair

    def observe_socketpair() -> tuple[socket.socket, socket.socket]:
        pair = socketpair()
        shutdown_sockets.extend(pair)
        return pair

    def fail_startup(*args: object, **kwargs: object) -> None:
        nonlocal listener
        assert server._server is not None
        listener = server._server.socket
        raise failure

    try:
        with (
            patch.object(socket, "socketpair", side_effect=observe_socketpair),
            patch.object(threading.Thread, failure_point, side_effect=fail_startup),
            patch.object(
                threading.Thread,
                "join",
                side_effect=AssertionError("cannot join an unstarted server"),
            ),
            pytest.raises(failure_type, match="injected thread startup failure") as caught,
            server.run(),
        ):
            pytest.fail("failed startup unexpectedly yielded")

        assert caught.value is failure
        assert listener is not None
        assert listener.fileno() == -1
        assert len(shutdown_sockets) == 2
        assert all(sock.fileno() == -1 for sock in shutdown_sockets)
        with pytest.raises(AssertionError):
            _ = server.api_url
    finally:
        if listener is not None:
            listener.close()

    with server.run():
        assert _post(f"{server.api_url}/recovered") == (204, b"")

    with pytest.raises(AssertionError):
        _ = server.api_url


def test_threaded_http_server_shutdown_wakes_an_idle_selector() -> None:
    server = ThreadedHttpTestServer(
        request_factory=_CapturedRequest,
        default_status=204,
        thread_name="idle-http-test-server",
    )
    selecting = threading.Event()
    select_timeouts: list[float | None] = []
    serving_threads: list[threading.Thread] = []
    select = selectors.DefaultSelector.select

    def observe_select(
        selector: selectors.DefaultSelector,
        timeout: float | None = None,
    ) -> list[tuple[selectors.SelectorKey, int]]:
        select_timeouts.append(timeout)
        serving_threads.append(threading.current_thread())
        selecting.set()
        return select(selector, timeout)

    with patch.object(selectors.DefaultSelector, "select", observe_select), server.run():
        wait_for_event(selecting, timeout=_THREAD_TIMEOUT_SECONDS)
        assert server._server is not None
        listener = server._server.socket

    assert select_timeouts
    assert all(timeout is None for timeout in select_timeouts)
    assert all(not thread.is_alive() for thread in serving_threads)
    assert listener.fileno() == -1
    assert server.request_count == 0
    with pytest.raises(AssertionError):
        _ = server.api_url


def test_threaded_http_server_shutdown_releases_a_blocked_response() -> None:
    server = ThreadedHttpTestServer(
        request_factory=_CapturedRequest,
        default_status=503,
        thread_name="blocked-http-test-server",
    )
    release_response = threading.Event()
    server.queue_response(201, body=b"released", release_event=release_response)
    responses: dict[str, _Response] = {}
    responses_lock = threading.Lock()
    thread: ThreadUnderTest | None = None

    try:
        with server.run():
            thread = _start_post(
                f"{server.api_url}/blocked",
                key="blocked",
                responses=responses,
                responses_lock=responses_lock,
            )
            assert server.wait_for_request_count(1)
            assert not release_response.is_set()
            assert thread.is_alive()

        assert release_response.is_set()
        thread.join_and_raise(timeout=_THREAD_TIMEOUT_SECONDS)
        assert responses == {"blocked": (201, b"released")}
        assert [request.path for request in server.requests] == ["/blocked"]
    finally:
        release_response.set()
        if thread is not None:
            thread.join(timeout=_THREAD_TIMEOUT_SECONDS)


def test_threaded_http_server_propagates_serving_failure() -> None:
    server = ThreadedHttpTestServer(
        request_factory=_CapturedRequest,
        default_status=204,
        thread_name="failed-http-test-server",
    )
    failed = threading.Event()
    failure = RuntimeError("injected serving failure")
    listener: socket.socket | None = None

    def fail_request() -> None:
        failed.set()
        raise failure

    def exercise_server() -> None:
        nonlocal listener
        with server.run():
            assert server._server is not None
            listener = server._server.socket
            with socket.create_connection(listener.getsockname(), timeout=_THREAD_TIMEOUT_SECONDS):
                wait_for_event(failed, timeout=_THREAD_TIMEOUT_SECONDS)

    with (
        patch.object(ThreadingHTTPServer, "handle_request", side_effect=fail_request),
        pytest.raises(RuntimeError, match="injected serving failure") as caught,
    ):
        exercise_server()

    assert caught.value is failure
    assert listener is not None
    assert listener.fileno() == -1
    with pytest.raises(AssertionError):
        _ = server.api_url


def test_threaded_http_server_aligns_responses_with_recorded_order():
    server = ThreadedHttpTestServer(
        request_factory=_CapturedRequest,
        default_status=503,
        default_body=b"default",
        thread_name="shared-http-test-server",
    )
    server.queue_response(201, body=b"first")
    server.queue_response(202, body=b"second")
    responses: dict[str, _Response] = {}
    responses_lock = threading.Lock()
    gate = _PauseFirstHandlerReacquire()
    with patch.object(threading, "RLock", return_value=gate):
        condition = threading.Condition()
    first = None
    second = None

    with patch.object(server, "_condition", condition), server.run():
        try:
            first = _start_post(
                f"{server.api_url}/first",
                key="first",
                responses=responses,
                responses_lock=responses_lock,
            )
            wait_for_event(
                gate.first_transition_released,
                timeout=_THREAD_TIMEOUT_SECONDS,
                threads=(first,),
            )
            second = _start_post(
                f"{server.api_url}/second",
                key="second",
                responses=responses,
                responses_lock=responses_lock,
            )
            first.join_and_raise(timeout=_THREAD_TIMEOUT_SECONDS)
            second.join_and_raise(timeout=_THREAD_TIMEOUT_SECONDS)
        finally:
            gate.unblock_for_cleanup()
            if first is not None:
                first.join(timeout=_THREAD_TIMEOUT_SECONDS)
            if second is not None:
                second.join(timeout=_THREAD_TIMEOUT_SECONDS)

        assert [request.path for request in server.requests[:2]] == ["/first", "/second"]
        assert responses == {
            "first": (201, b"first"),
            "second": (202, b"second"),
        }
        assert _post(f"{server.api_url}/default") == (503, b"default")


def test_fake_auth_endpoint_preserves_capture_and_default_response():
    endpoint = FakeAuthEndpoint()

    with endpoint.run():
        response = _request(
            "GET",
            f"{endpoint.api_url}/auth-default",
            headers={"X-Test-Header": "auth"},
        )

    assert response == (500, b"unexpected auth request")
    assert endpoint.request_count == 1
    [request] = endpoint.requests
    assert request.method == "GET"
    assert request.path == "/auth-default"
    assert request.headers["x-test-header"] == "auth"
    assert "X-Test-Header" not in request.headers
    assert request.body == b""


def test_usage_webhook_server_preserves_capture_and_default_response():
    server = UsageWebhookServer()

    with server.run():
        response = _request(
            "POST",
            server.url("/usage-default"),
            body=b"usage-body",
            headers={"X-Test-Header": "usage"},
        )

    assert response == (204, b"")
    assert server.request_count == 1
    [request] = server.requests
    assert request.method == "POST"
    assert request.path == "/usage-default"
    assert request.headers["x-test-header"] == "usage"
    assert "X-Test-Header" not in request.headers
    assert request.body == b"usage-body"
