"""Shared usage test helpers for mitm-addon tests."""

from __future__ import annotations

import contextlib
import json
import threading
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import usage
from tests.threaded_http_test_server import ThreadedHttpTestServer
from usage.executor import WebhookExecutor

_DeliveryOutcomeCallback = Callable[[usage.webhook.WebhookDeliveryOutcome], None]
_EnqueueWebhook = Callable[[str, str, dict, str, str, _DeliveryOutcomeCallback], bool]


def assert_usage_event_rows(
    events: Sequence[dict[str, Any]],
    resource_field: Literal["provider"],
    expected_rows: Sequence[tuple[str, str, int]],
) -> None:
    actual_rows = [
        (event[resource_field], event["category"], event["quantity"]) for event in events
    ]
    assert len(actual_rows) == len(expected_rows)
    assert sorted(actual_rows) == sorted(expected_rows)

    idempotency_keys = [event["idempotencyKey"] for event in events]
    assert len(set(idempotency_keys)) == len(idempotency_keys)
    for key in idempotency_keys:
        uuid.UUID(key)


class _FlushOwnerLock(Protocol):
    def acquire(self, blocking: bool = True) -> bool:
        raise NotImplementedError

    def release(self) -> None:
        raise NotImplementedError


class RecordingTimer:
    def __init__(self, delay: float, callback: Callable[[], None]) -> None:
        self.delay = delay
        self.callback = callback
        self.daemon = False
        self.cancelled = False
        self.started = False

    def start(self) -> None:
        self.started = True

    def cancel(self) -> None:
        self.cancelled = True


def install_recording_usage_timer(
    *,
    enqueue_webhook: _EnqueueWebhook | None = None,
    flush_owner_lock: _FlushOwnerLock | None = None,
    max_retained_batch_retries: int | None = None,
) -> list[RecordingTimer]:
    """Reset the usage buffer with a timer factory that records scheduled timers."""
    timers: list[RecordingTimer] = []

    def timer_factory(delay: float, callback: Callable[[], None]) -> RecordingTimer:
        timer = RecordingTimer(delay, callback)
        timers.append(timer)
        return timer

    if max_retained_batch_retries is None:
        usage.reset_usage_buffer_for_tests(
            timer_enabled=True,
            timer_factory=timer_factory,
            enqueue_webhook=enqueue_webhook,
            flush_owner_lock=flush_owner_lock,
        )
    else:
        usage.reset_usage_buffer_for_tests(
            timer_enabled=True,
            timer_factory=timer_factory,
            enqueue_webhook=enqueue_webhook,
            flush_owner_lock=flush_owner_lock,
            max_retained_batch_retries=max_retained_batch_retries,
        )
    return timers


@contextlib.contextmanager
def fresh_usage_executor_context() -> Iterator[WebhookExecutor]:
    """Install a temporary usage executor and restore the original on exit."""
    original = usage.webhook.usage_executor
    executor = WebhookExecutor(max_workers=4, thread_name_prefix="usage-test")
    usage.webhook.usage_executor = executor
    try:
        yield executor
    finally:
        usage.webhook.usage_executor = executor
        try:
            try:
                usage.flush_usage_events(trigger="shutdown")
            finally:
                executor.shutdown(wait=True)
                usage.drain_usage_events_after_executor_shutdown()
        finally:
            usage.webhook.usage_executor = original


@dataclass(frozen=True)
class CapturedWebhookRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    def json_body(self) -> dict[str, Any]:
        body = json.loads(self.body)
        assert isinstance(body, dict)
        return body


class UsageWebhookServer:
    def __init__(self) -> None:
        self._http = ThreadedHttpTestServer(
            request_factory=CapturedWebhookRequest,
            default_status=204,
            thread_name="usage-webhook-test-server",
        )

    @property
    def api_url(self) -> str:
        return self._http.api_url

    @property
    def requests(self) -> tuple[CapturedWebhookRequest, ...]:
        return self._http.requests

    @property
    def request_count(self) -> int:
        return self._http.request_count

    def url(self, path: str = "/api/webhooks/run/usage-event") -> str:
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{self.api_url}{path}"

    def queue_response(
        self,
        status: int,
        *,
        headers: Sequence[tuple[str, str]] = (),
        body: bytes = b"",
        release_event: threading.Event | None = None,
    ) -> None:
        """Queue a response, optionally blocking it until an event is set."""
        self._http.queue_response(
            status,
            headers=headers,
            body=body,
            release_event=release_event,
        )

    def wait_for_request_count(self, count: int, *, timeout: float = 2.0) -> bool:
        """Wait until at least ``count`` requests have been recorded."""
        return self._http.wait_for_request_count(count, timeout=timeout)

    def json_bodies(self) -> list[dict[str, Any]]:
        return [request.json_body() for request in self.requests]

    def usage_events(self) -> list[dict[str, Any]]:
        return [
            event
            for request in self.requests
            if request.path == "/api/webhooks/run/usage-event"
            for body in [request.json_body()]
            for event in body.get("events", [])
            if isinstance(event, dict)
        ]

    @contextlib.contextmanager
    def run(self) -> Iterator[UsageWebhookServer]:
        with self._http.run():
            yield self
