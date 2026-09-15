"""Shared pytest fixtures for mitm-addon tests.

Fixtures here exist for two reasons:

1. **Real mitmproxy objects in place of MagicMock**. ``real_flow`` /
   ``headers`` produce genuine :class:`mitmproxy.http.HTTPFlow`,
   :class:`mitmproxy.http.Request`, :class:`mitmproxy.http.Response`, and
   :class:`mitmproxy.http.Headers` via ``mitmproxy.test`` helpers so tests
   exercise real attribute/property semantics (``pretty_host``,
   ``pretty_url``, ``content`` decompression, header casing, …).
2. **Stubbing at genuine external boundaries**. ``mitm_ctx`` replaces
   ``ctx.options`` and captures addon process events for handler tests that
   cannot rely on a running ``mitmdump`` process.
"""

import contextlib
import json
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import Future
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mitmproxy import http, tcp
from mitmproxy.test import tflow, tutils

import anthropic_accounting
import auth
import auth_base_forwarder
import auth_base_transport
import aws_sigv4_body_admission
import aws_sigv4_hash_executor
import builtin_connector_diagnostics
import claude_output_timing
import codex_model_catalog_cache
import codex_output_timing
import firewall_auth_client
import logging_utils
import mitm_addon
import model_provider_failure
import platform_api
import registry
import runner_flush_lifecycle
import upstream_admission
import upstream_destination_binding
import usage
from tests.auth_state_helpers import clear_auth_state
from tests.firewall_auth_helpers import firewall_auth_response
from tests.process_log_helpers import capture_addon_process_events
from tests.usage_helpers import UsageWebhookServer, fresh_usage_executor_context
from usage.providers import connectors as _usage_connectors


@pytest.fixture(autouse=True)
def _reset_module_state() -> Iterator[None]:
    """Clear cached singletons between tests.

    ``registry`` and ``auth`` cache registry data and firewall header
    lookups in module-level dicts.  Without a reset, earlier tests leak
    entries that change later tests' behaviour.

    The usage buffer owns a background timer in production, while runner flush
    handling owns a usage signal worker and a JSONL marker watcher, so tests
    reset them around each case to avoid cross-test callbacks.
    """
    auth_base_forwarder.reset_forward_request_state_for_tests()
    auth_base_transport.reset_transport_state_for_tests()
    firewall_auth_client.reset_transport_state_for_tests()
    aws_sigv4_hash_executor.reset_for_tests()
    aws_sigv4_body_admission.reset_for_tests()
    builtin_connector_diagnostics.reset_cache_for_tests()
    registry.reset_cache_for_tests()
    upstream_destination_binding.reset_for_tests()
    runner_flush_lifecycle.reset_runner_usage_flush_state_for_tests()
    upstream_admission.reset_api_destination_cache_for_tests()
    upstream_admission.reset_tls_admission_state_for_tests()
    platform_api.configure_client_headers(client_session_id="", client_version="")
    clear_auth_state()
    _usage_connectors._unregistered_handler_warned.clear()
    anthropic_accounting.reset_for_tests()
    claude_output_timing.reset_for_tests()
    codex_model_catalog_cache.reset_for_tests()
    codex_output_timing.reset_for_tests()
    model_provider_failure.reset_for_tests()
    usage.reset_usage_buffer_for_tests()
    usage.webhook.reset_delivery_capacity_for_tests()
    usage.counters.reset_for_tests()
    logging_utils.reset_log_writer_for_tests()
    yield
    runner_flush_lifecycle.reset_runner_usage_flush_state_for_tests()
    usage.reset_usage_buffer_for_tests()
    anthropic_accounting.reset_for_tests()
    claude_output_timing.reset_for_tests()
    codex_model_catalog_cache.reset_for_tests()
    codex_output_timing.reset_for_tests()
    model_provider_failure.reset_for_tests()
    logging_utils.reset_log_writer_for_tests()
    auth_base_forwarder.reset_forward_request_state_for_tests()
    auth_base_transport.reset_transport_state_for_tests()
    firewall_auth_client.reset_transport_state_for_tests()
    aws_sigv4_hash_executor.reset_for_tests()
    aws_sigv4_body_admission.reset_for_tests()
    builtin_connector_diagnostics.reset_cache_for_tests()
    upstream_destination_binding.reset_for_tests()
    upstream_admission.reset_api_destination_cache_for_tests()
    upstream_admission.reset_tls_admission_state_for_tests()
    platform_api.configure_client_headers(client_session_id="", client_version="")
    usage.webhook.reset_delivery_capacity_for_tests()
    usage.counters.reset_for_tests()


def _headers(*pairs: tuple[str, str]) -> http.Headers:
    return http.Headers([(k.encode(), v.encode()) for k, v in pairs])


@pytest.fixture
def headers():
    """Build ``mitmproxy.http.Headers`` from ``(name, value)`` string pairs."""
    return _headers


@pytest.fixture
def real_flow():
    """Factory that builds a real :class:`mitmproxy.http.HTTPFlow`.

    Parameters mirror the handful of attributes the addon reads from the
    flow: client IP, request scheme/method/host/port/path/body/headers,
    response status/body/headers/encoding. The returned flow has
    ``flow.metadata`` empty (addon fills it in) and, when
    ``with_response=False``, no response attached.
    """

    def _build(
        *,
        client_ip: str = "10.200.0.1",
        host: str = "example.com",
        port: int = 443,
        path: str = "/",
        method: str = "GET",
        scheme: str = "https",
        sni: str | None = None,
        request_body: bytes | None = None,
        request_headers: http.Headers | None = None,
        request_content_type: str | None = None,
        request_encoding: str | None = None,
        with_response: bool = True,
        response_status: int = 200,
        response_body: bytes | None = None,
        response_headers: http.Headers | None = None,
        response_content_type: str | None = None,
        response_encoding: str | None = None,
        include_request_id: bool = False,
    ) -> http.HTTPFlow:
        if request_headers is not None:
            req_headers = request_headers
        else:
            pairs: list[tuple[str, str]] = [("Host", host)]
            if request_content_type:
                pairs.insert(0, ("Content-Type", request_content_type))
            req_headers = _headers(*pairs)
        if request_encoding:
            req_headers[b"Content-Encoding"] = request_encoding.encode()
        req = tutils.treq(
            scheme=scheme.encode(),
            method=method.encode(),
            host=host.encode(),
            port=port,
            path=path.encode(),
            headers=req_headers,
            content=request_body,
        )

        resp: http.Response | bool
        if with_response:
            if response_headers is not None:
                resp_headers = response_headers
            else:
                pairs = []
                if response_content_type:
                    pairs.append(("Content-Type", response_content_type))
                if include_request_id:
                    pairs.append(("X-Request-Id", "req-123"))
                resp_headers = _headers(*pairs)
            if response_encoding:
                resp_headers[b"Content-Encoding"] = response_encoding.encode()
            resp = tutils.tresp(
                status_code=response_status,
                headers=resp_headers,
                content=response_body,
            )
        else:
            resp = False

        flow = tflow.tflow(req=req, resp=resp)
        flow.client_conn.peername = (client_ip, 12345)
        flow.client_conn.sni = sni if sni is not None else (host if scheme == "https" else None)
        flow.server_conn.address = (host, port)
        return flow

    return _build


class _StubTLSClient:
    """Minimal stand-in for ``mitmproxy.connection.Client`` in TLS tests."""

    def __init__(
        self,
        peername: tuple[str, int] | None,
        sni: str | None,
        client_id: str | None,
    ) -> None:
        self.id = client_id or str(uuid.uuid4())
        self.peername = peername
        self.sni = sni
        self.timestamp_end: float | None = None


class _StubTLSServer:
    """Minimal stand-in for ``mitmproxy.connection.Server`` in TLS tests."""

    def __init__(
        self,
        *,
        address: tuple[str, int],
        peername: tuple[str, int] | None,
        connected: bool,
        server_id: str | None,
    ) -> None:
        self.id = server_id or str(uuid.uuid4())
        self.address = address
        self.peername = peername
        self.connected = connected


class _StubTLSContext:
    def __init__(self, client: _StubTLSClient, server: _StubTLSServer) -> None:
        self.client = client
        self.server = server


class _StubClientHello:
    def __init__(self, sni: str | None) -> None:
        self.sni = sni


class _StubClientHelloData:
    """Plain stub for ``mitmproxy.tls.ClientHelloData``.

    ``ClientHelloData`` is constructed inside mitmproxy's TLS layer from
    protocol state we don't have access to at test time, so we can't
    build a real one.  The addon reads the context's client/server plus
    ``data.client_hello.sni`` and writes ``data.ignore_connection``; a
    dataclass-shaped stub covers that surface without pulling in
    MagicMock's attribute-proliferation.
    """

    def __init__(
        self,
        peername: tuple[str, int] | None,
        sni: str | None,
        client_id: str | None,
        client_sni: str | None,
        server_address: tuple[str, int],
        server_peername: tuple[str, int] | None,
        server_connected: bool,
        server_id: str | None,
    ) -> None:
        self.context = _StubTLSContext(
            _StubTLSClient(peername, client_sni, client_id),
            _StubTLSServer(
                address=server_address,
                peername=server_peername,
                connected=server_connected,
                server_id=server_id,
            ),
        )
        self.client_hello = _StubClientHello(sni)
        self.ignore_connection = False


@pytest.fixture
def make_tls_data():
    def _make(
        *,
        client_ip: str = "10.200.0.1",
        sni: str = "example.com",
        client_id: str | None = None,
        client_sni: str | None = None,
        server_address: tuple[str, int] = ("203.0.113.10", 443),
        server_peername: tuple[str, int] | None = None,
        server_connected: bool = False,
        server_id: str | None = None,
    ) -> _StubClientHelloData:
        return _StubClientHelloData(
            peername=(client_ip, 12345),
            sni=sni,
            client_id=client_id,
            client_sni=sni if client_sni is None else client_sni,
            server_address=server_address,
            server_peername=server_peername,
            server_connected=server_connected,
            server_id=server_id,
        )

    return _make


@pytest.fixture
def real_tcp_flow():
    """Factory that builds a real :class:`mitmproxy.tcp.TCPFlow`.

    Mirrors the addon's access surface: ``flow.client_conn.peername``,
    ``flow.server_conn.address``, ``flow.metadata``, ``flow.messages``,
    ``flow.error``.  Default messages are a 2-way client/server handshake
    (``b"hello"`` / ``b"SSH-2.0-babeld"``) that the TCP log tests exercise.
    """

    def _build(
        *,
        client_ip: str = "10.200.0.1",
        server_address: tuple[str, int] = ("140.82.116.3", 22),
        messages: list[tcp.TCPMessage] | None = None,
    ) -> tcp.TCPFlow:
        flow = tflow.ttcpflow()
        flow.client_conn.peername = (client_ip, 12345)
        flow.server_conn.address = server_address
        flow.error = None
        if messages is None:
            flow.messages = [
                tcp.TCPMessage(True, b"hello"),
                tcp.TCPMessage(False, b"SSH-2.0-babeld"),
            ]
        else:
            flow.messages = messages
        return flow

    return _build


class _StubOptions:
    """Plain stand-in for ``ctx.options`` fields consumed by the addon."""

    def __init__(
        self,
        *,
        registry_path: str,
        api_url: str,
        builtin_firewall_catalog_cache_path: str,
        client_session_id: str,
        client_version: str,
        ssl_insecure: bool,
    ) -> None:
        self.okou_proxy_registry_path = registry_path
        self.okou_api_url = api_url
        self.okou_builtin_firewall_catalog_cache_path = builtin_firewall_catalog_cache_path
        self.okou_client_session_id = client_session_id
        self.okou_client_version = client_version
        self.okou_usage_flush_interval_seconds = usage.DEFAULT_FLUSH_INTERVAL_SECONDS
        self.ssl_insecure = ssl_insecure


@pytest.fixture
def mitm_ctx(tmp_path):
    """Stub ``mitmproxy.ctx.options`` and addon process events for a test block.

    Returns a context-manager factory: calling ``mitm_ctx(registry_path=...)``
    patches in a concrete options stub for settings consumed by the addon and a
    ``MagicMock`` process-event capture. WARN and ERROR event details are
    exposed as ``log.warn`` and ``log.error`` calls for focused assertions.
    ``options`` stays concrete so unexpected attribute access fails instead of
    silently creating another mock.

    When the caller omits ``registry_path`` the default comes from pytest's
    per-test ``tmp_path`` fixture, so tests never share a /tmp path that
    could race between parallel workers.
    """

    default_registry_path = str(tmp_path / "proxy-registry.json")
    default_builtin_firewall_catalog_cache_path = str(
        tmp_path / "builtin-firewall-catalog-cache.json"
    )

    @contextlib.contextmanager
    def _stub(
        *,
        registry_path: str | None = None,
        api_url: str = "https://api.okou.ai",
        builtin_firewall_catalog_cache_path: str | None = None,
        client_session_id: str = "runner-session-test",
        client_version: str = "runner-version-test",
        ssl_insecure: bool = False,
    ) -> Iterator[MagicMock]:
        if registry_path is None:
            registry_path = default_registry_path
        if builtin_firewall_catalog_cache_path is None:
            builtin_firewall_catalog_cache_path = default_builtin_firewall_catalog_cache_path
        options = _StubOptions(
            registry_path=registry_path,
            api_url=api_url,
            builtin_firewall_catalog_cache_path=builtin_firewall_catalog_cache_path,
            client_session_id=client_session_id,
            client_version=client_version,
            ssl_insecure=ssl_insecure,
        )
        with (
            patch.object(mitm_addon.ctx, "options", options, create=True),
            capture_addon_process_events() as log,
        ):
            platform_api.configure_client_headers(
                client_session_id=client_session_id,
                client_version=client_version,
            )
            try:
                yield log
            finally:
                platform_api.configure_client_headers(
                    client_session_id="",
                    client_version="",
                )

    return _stub


@pytest.fixture
def fake_firewall_headers():
    """Stub ``auth.get_firewall_headers`` at the real external boundary.

    Dispatcher tests that want to verify ``mitm_addon.request`` routed to
    ``handle_firewall_request`` should not patch the handler itself (that was
    the Phase-3-forbidden pattern). Instead they patch the auth-service
    boundary behind ``get_firewall_headers`` and assert on shared firewall
    metadata keys populated by
    ``_prepare_firewall_metadata`` at the start of the real handler, before
    auth resolution begins.

    Returns a context manager that yields the ``AsyncMock`` in case a test
    wants to inspect call arguments.
    """

    @contextlib.contextmanager
    def _stub(
        *,
        headers: dict[str, str] | None = None,
    ) -> Iterator[AsyncMock]:
        mock = AsyncMock(
            return_value=firewall_auth_response(
                headers=headers if headers is not None else {"Authorization": "Bearer x"},
            )
        )
        with patch.object(auth, "get_firewall_headers", mock):
            yield mock

    return _stub


@pytest.fixture
def usage_webhook_server() -> Iterator[UsageWebhookServer]:
    server = UsageWebhookServer()
    with server.run():
        yield server


@pytest.fixture
def usage_webhook_api(mitm_ctx):
    @contextlib.contextmanager
    def _api() -> Iterator[UsageWebhookServer]:
        server = UsageWebhookServer()
        with server.run(), mitm_ctx(api_url=server.api_url):
            yield server

    return _api


@pytest.fixture
def sync_usage_executor():
    """Swap the usage webhook executor for a synchronous stub.

    Tests that want webhook side effects to complete before inline
    assertions can use this instead of a background thread plus explicit
    ``fresh_usage_executor`` + ``shutdown(wait=True)`` boilerplate.  The
    inline executor returns real ``Future`` objects while still running the
    function synchronously; the original executor is restored on teardown.
    """

    class _InlineExecutor:
        def __init__(self) -> None:
            self._futures: list[Future[Any]] = []
            self._shutdown = False

        def submit(
            self,
            fn: Callable[..., Any],
            *args: Any,
            **kwargs: Any,
        ) -> Future[Any]:
            if self._shutdown:
                raise RuntimeError("cannot schedule new futures after shutdown")

            future: Future[Any] = Future()
            self._futures.append(future)
            try:
                result = fn(*args, **kwargs)
            except BaseException as error:
                future.set_exception(error)
            else:
                future.set_result(result)
            return future

        def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
            self._shutdown = True
            if not wait:
                return
            futures = self._futures
            self._futures = []
            for future in futures:
                future.result()

    original = usage.webhook.usage_executor
    executor = _InlineExecutor()
    usage.webhook.usage_executor = executor
    try:
        yield executor
    finally:
        try:
            executor.shutdown(wait=True)
        finally:
            usage.webhook.usage_executor = original


@pytest.fixture
def fresh_usage_executor():
    """Swap ``usage.webhook.usage_executor`` for a throw-away pool for one test.

    Tests that call ``shutdown(wait=True)`` to flush pending webhook
    reports need a fresh executor afterwards so later tests still see a
    live pool.  This fixture owns the lifecycle: a new
    :class:`usage.executor.WebhookExecutor` is installed before the test and the
    original is restored after a shutdown-triggered final flush.
    ``WebhookExecutor.shutdown`` is idempotent, so we always call it
    on the way out regardless of whether the test already did.
    """
    with fresh_usage_executor_context() as executor:
        yield executor


@pytest.fixture(
    params=[
        pytest.param("https://[::1", id="unmatched-ipv6-bracket"),
        pytest.param("https://api.okou.ai:not-a-port", id="non-numeric-port"),
        pytest.param("https://api.okou.ai:65536", id="out-of-range-port"),
        pytest.param(
            "https://user:secret@api.okou.ai/base",
            id="userinfo",
        ),
        pytest.param("https://api.okou.ai:/base", id="empty-port"),
    ]
)
def malformed_platform_api_url(request: pytest.FixtureRequest) -> str:
    value = request.param
    assert isinstance(value, str)
    return value


@pytest.fixture
def registry_file(tmp_path):
    """Create a sample proxy registry JSON file and return its path."""
    registry: dict[str, Any] = {
        "sandboxes": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
                "sandboxToken": "tok-xyz",
                "registeredAt": 1700000000000,
                "networkLogPath": str(tmp_path / "network.jsonl"),
                "proxyLogPath": str(tmp_path / "proxy-run-abc-123.jsonl"),
            },
            "10.200.0.2": {
                "runId": "run-def-456",
                "billableFirewalls": [],
                "cliAgentType": "claude-code",
                "sandboxToken": "tok-abc",
                "registeredAt": 1700000000000,
                "networkLogPath": str(tmp_path / "network-2.jsonl"),
                "proxyLogPath": str(tmp_path / "proxy-run-def-456.jsonl"),
            },
        },
        "updatedAt": 1700000000000,
    }
    path = tmp_path / "proxy-registry.json"
    path.write_text(json.dumps(registry))
    return path
