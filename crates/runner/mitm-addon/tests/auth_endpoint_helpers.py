"""Shared fake auth endpoint for mitm-addon tests."""

import contextlib
import json
import threading
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

from tests.threaded_http_test_server import ThreadedHttpTestServer


@dataclass(frozen=True)
class AuthEndpointRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def json_body(self) -> dict[str, object]:
        """Decode the raw body and assert it is a JSON object."""
        body = json.loads(self.body)
        assert isinstance(body, dict)
        return body


def firewall_auth_success_response(
    headers: Mapping[str, str],
    *,
    expires_at: int | float | None = None,
    resolved_secrets: Sequence[str] = (),
    refreshed_connectors: Sequence[str] = (),
    refreshed_secrets: Sequence[str] = (),
) -> dict[str, object]:
    """Build the canonical required shape for a successful firewall auth response."""
    return {
        "headers": dict(headers),
        "expiresAt": expires_at,
        "resolvedSecrets": list(resolved_secrets),
        "refreshedConnectors": list(refreshed_connectors),
        "refreshedSecrets": list(refreshed_secrets),
    }


class FakeAuthEndpoint:
    """Threaded local auth endpoint for mitm-addon auth-related tests.

    The endpoint is live only inside ``run()``. It implements GET and POST,
    records method, path, raw body, and lower-cased headers, and
    serves queued responses in FIFO order. Requests without a queued response
    receive a synthetic HTTP 500 response so accidental extra auth calls fail
    visibly.

    Queued responses may include a ``release_event`` to block sending the
    response. Context teardown releases pending events so blocked handler
    threads can exit.
    """

    def __init__(self) -> None:
        self._http = ThreadedHttpTestServer(
            request_factory=AuthEndpointRequest,
            default_status=500,
            default_body=b"unexpected auth request",
            thread_name="auth-endpoint-test-server",
        )

    @property
    def api_url(self) -> str:
        return self._http.api_url

    @property
    def requests(self) -> tuple[AuthEndpointRequest, ...]:
        return self._http.requests

    @property
    def request_count(self) -> int:
        return self._http.request_count

    def queue_json_response(
        self,
        body: dict[str, object],
        *,
        status: int = 200,
        release_event: threading.Event | None = None,
    ) -> None:
        """Queue a JSON response with FIFO and ``release_event`` semantics.

        The body is JSON-encoded and served with ``Content-Type: application/json``.
        """
        self.queue_response(
            status,
            body=json.dumps(body).encode(),
            headers=(("Content-Type", "application/json"),),
            release_event=release_event,
        )

    def queue_response(
        self,
        status: int,
        *,
        body: bytes = b"",
        headers: Sequence[tuple[str, str]] = (),
        release_event: threading.Event | None = None,
    ) -> None:
        """Queue a response for the next auth request.

        Responses are served FIFO. If ``release_event`` is provided, the
        handler records the request immediately and waits to send this response
        until the event is set. Context teardown sets pending release events.
        When no queued response remains, the helper returns its synthetic
        unexpected-request HTTP 500 response.
        """
        self._http.queue_response(
            status,
            body=body,
            headers=headers,
            release_event=release_event,
        )

    def wait_for_request_count(self, count: int, *, timeout: float = 2.0) -> bool:
        """Wait until at least ``count`` auth requests have been recorded.

        Use this instead of sleeps when concurrent tests coordinate with a
        blocked queued response or auth-cache request coalescing.
        """
        return self._http.wait_for_request_count(count, timeout=timeout)

    @contextlib.contextmanager
    def run(self) -> Iterator[FakeAuthEndpoint]:
        with self._http.run():
            yield self
