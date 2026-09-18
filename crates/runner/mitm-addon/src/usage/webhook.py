"""Webhook delivery (HTTP + thread pool).

Background workers process usage reports in parallel; the runner
first waits for the pending counters to drain, then ``done()`` flushes
submitted futures during mitmproxy shutdown. Falls back to synchronous
delivery if submission fails during shutdown or worker startup so reports
are not silently lost. A worker and fallback share one delivery claim.
Workers start before payloads enter the pool, so failed startup cannot retain
completed fallback deliveries in an undrained executor queue.
"""

import json
import threading
import time
import urllib.error
import urllib.parse
from collections.abc import Callable
from concurrent.futures import Executor
from datetime import UTC, datetime, timedelta
from functools import partial

import network_log_sanitization
from logging_utils import log_proxy_entry
from platform_api import build_api_opener, make_api_request

from .counters import (
    DeliveryOutcome,
    PendingReportLease,
    admit_pending_report,
    record_delivery_outcome,
)
from .executor import WebhookExecutor

WebhookDeliveryOutcome = DeliveryOutcome
_DeliveryOutcomeCallback = Callable[[WebhookDeliveryOutcome], None]
_SUCCESS: WebhookDeliveryOutcome = "success"
_RETRYABLE_FAILURE: WebhookDeliveryOutcome = "retryable_failure"
_PERMANENT_FAILURE: WebhookDeliveryOutcome = "permanent_failure"
_MIN_RETRYABLE_HTTP_STATUS_CODE = 500
_RETRYABLE_HTTP_STATUS_CODES = {408, 429}
_WEBHOOK_RETRY_DELAY_SECONDS = 0.5


_opener = build_api_opener()


def _payload_log_summary(payload: dict) -> dict:
    summary: dict = {}
    run_id = payload.get("runId")
    if isinstance(run_id, str):
        summary["payload_run_id"] = run_id
    events = payload.get("events")
    if isinstance(events, list):
        summary["payload_event_count"] = len(events)
    return summary


def _log_webhook_entry(
    proxy_log_path: str,
    level: str,
    message_detail: str,
    url: str,
    log_type: str,
    payload: dict,
    payload_bytes: int | None = None,
    attempt: int | None = None,
    error: str | None = None,
    extra_fields: dict[str, object] | None = None,
) -> None:
    display_url = network_log_sanitization.sanitize_url_for_network_log(url)
    safe_message_detail = _sanitize_webhook_log_text(message_detail, url, display_url)
    message = f"Webhook POST to {display_url} {safe_message_detail}"
    extra: dict = {"type": log_type, "url": url}
    extra.update(_payload_log_summary(payload))
    if payload_bytes is not None:
        extra["payload_bytes"] = payload_bytes
    if attempt is not None:
        extra["attempt"] = attempt
    if error is not None:
        extra["error"] = _sanitize_webhook_log_text(error, url, display_url)
    if extra_fields is not None:
        extra.update(extra_fields)
    log_proxy_entry(proxy_log_path, level, message, **extra)


def _sanitize_webhook_log_text(value: str, raw_url: str, display_url: str) -> str:
    if not raw_url:
        return value
    for url_variant in _raw_webhook_url_log_text_variants(raw_url):
        value = value.replace(url_variant, display_url)
    return value


def _raw_webhook_url_log_text_variants(raw_url: str) -> tuple[str, ...]:
    variants = {raw_url}
    try:
        parts = urllib.parse.urlsplit(raw_url)
    except ValueError:
        variants.add(raw_url.split("#", 1)[0])
        variants.add(raw_url.split("?", 1)[0])
    else:
        if parts.fragment:
            variants.add(
                urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))
            )
        if parts.query or parts.fragment:
            variants.add(urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", "")))
    variants.discard("")
    return tuple(sorted(variants, key=len, reverse=True))


def _post_webhook(url: str, bearer_credential: str, data: bytes) -> None:
    """POST JSON data to a platform webhook.  Raises on failure."""
    req = make_api_request(url, data, bearer_credential)
    try:
        with _opener.open(req, timeout=10):
            pass
    except urllib.error.HTTPError as exc:
        # HTTPError wraps an open socket; context-manage it so the fd is
        # released on every exit path (matches _forward_request_sync #10476).
        with exc:
            raise


def _post_webhook_with_retry(
    url: str,
    bearer_credential: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    pending_report: PendingReportLease,
    max_retries: int = 1,
    delivery_outcome_callback: _DeliveryOutcomeCallback | None = None,
) -> None:
    """POST with retry.

    Reports the final delivery outcome before decrementing pending reports.
    Non-retryable programming errors (``TypeError`` from a non-serializable
    payload, invalid request URLs, etc.) are logged and reported as permanent.
    They are re-raised only when no outcome callback owns the failure.
    """
    try:
        outcome = _do_post_webhook_attempts(
            url, bearer_credential, payload, proxy_log_path, log_type, max_retries
        )
    except Exception:
        record_delivery_outcome(_PERMANENT_FAILURE)
        if delivery_outcome_callback is not None:
            delivery_outcome_callback(_PERMANENT_FAILURE)
        else:
            raise
    else:
        record_delivery_outcome(outcome)
        if delivery_outcome_callback is not None:
            delivery_outcome_callback(outcome)
    finally:
        pending_report.release()


def _handle_retryable_webhook_failure(
    *,
    proxy_log_path: str,
    url: str,
    log_type: str,
    payload: dict,
    payload_bytes: int,
    attempt: int,
    max_retries: int,
    exc: Exception,
) -> WebhookDeliveryOutcome | None:
    attempt_number = attempt + 1
    if attempt < max_retries:
        _log_webhook_entry(
            proxy_log_path,
            "info",
            f"attempt {attempt_number} failed, retrying: {exc}",
            url,
            log_type,
            payload,
            payload_bytes=payload_bytes,
            attempt=attempt_number,
            error=str(exc),
        )
        time.sleep(_WEBHOOK_RETRY_DELAY_SECONDS)
        return None

    _log_webhook_entry(
        proxy_log_path,
        "info",
        f"failed after {attempt_number} attempts: {exc}",
        url,
        log_type,
        payload,
        payload_bytes=payload_bytes,
        attempt=attempt_number,
        error=str(exc),
        extra_fields={"delivery_outcome": _RETRYABLE_FAILURE},
    )
    return _RETRYABLE_FAILURE


def _do_post_webhook_attempts(
    url: str,
    bearer_credential: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    max_retries: int,
) -> WebhookDeliveryOutcome:
    try:
        data = json.dumps(payload).encode()
    except Exception as exc:
        _log_webhook_entry(
            proxy_log_path,
            "error",
            f"failed with non-retryable error: {exc}",
            url,
            log_type,
            payload,
            attempt=1,
            error=str(exc),
        )
        raise

    payload_bytes = len(data)
    for attempt in range(max_retries + 1):
        try:
            if _resource_observation_expired(payload):
                _log_webhook_entry(
                    proxy_log_path,
                    "error",
                    "expired outside the two-UTC-date resource admission window",
                    url,
                    log_type,
                    payload,
                    payload_bytes=payload_bytes,
                    attempt=attempt + 1,
                    extra_fields={
                        "reason": "x_resource_observation_expired",
                        "delivery_outcome": _PERMANENT_FAILURE,
                    },
                )
                return _PERMANENT_FAILURE
            _post_webhook(url, bearer_credential, data)
            _log_webhook_entry(
                proxy_log_path,
                "info",
                "succeeded",
                url,
                log_type,
                payload,
                payload_bytes=payload_bytes,
                attempt=attempt + 1,
            )
            return _SUCCESS
        except urllib.error.HTTPError as exc:
            if not _is_retryable_http_error(exc):
                _log_webhook_entry(
                    proxy_log_path,
                    "error",
                    f"failed with permanent HTTP error: {exc}",
                    url,
                    log_type,
                    payload,
                    payload_bytes=payload_bytes,
                    attempt=attempt + 1,
                    error=str(exc),
                )
                return _PERMANENT_FAILURE
            outcome = _handle_retryable_webhook_failure(
                proxy_log_path=proxy_log_path,
                url=url,
                log_type=log_type,
                payload=payload,
                payload_bytes=payload_bytes,
                attempt=attempt,
                max_retries=max_retries,
                exc=exc,
            )
            if outcome is not None:
                return outcome
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            outcome = _handle_retryable_webhook_failure(
                proxy_log_path=proxy_log_path,
                url=url,
                log_type=log_type,
                payload=payload,
                payload_bytes=payload_bytes,
                attempt=attempt,
                max_retries=max_retries,
                exc=exc,
            )
            if outcome is not None:
                return outcome
        except Exception as exc:
            # Catch-all by design: non-retryable failures (TypeError on
            # non-serializable payload, AttributeError, ValueError, or any
            # unexpected type) must leave a forensic breadcrumb before
            # being re-raised into ``ThreadPoolExecutor``'s Future, which
            # would otherwise swallow them silently.  Tightening to
            # specific types would regress this debuggability.
            _log_webhook_entry(
                proxy_log_path,
                "error",
                f"failed with non-retryable error: {exc}",
                url,
                log_type,
                payload,
                payload_bytes=payload_bytes,
                attempt=attempt + 1,
                error=str(exc),
            )
            raise

    return _RETRYABLE_FAILURE


def _resource_observation_expired(payload: dict) -> bool:
    """Check immutable observation dates again after executor waits and HTTP retries."""
    events = payload.get("events")
    if not isinstance(events, list):
        return False
    resource_events = [
        event
        for event in events
        if isinstance(event, dict) and event.get("protocol") == "x-resource-v1"
    ]
    if not resource_events:
        return False
    oldest_date = datetime.now(UTC).date() - timedelta(days=1)
    return any(
        datetime.fromisoformat(event["observedAt"]).astimezone(UTC).date() < oldest_date
        for event in resource_events
    )


def _is_retryable_http_error(exc: urllib.error.HTTPError) -> bool:
    return exc.code >= _MIN_RETRYABLE_HTTP_STATUS_CODE or exc.code in _RETRYABLE_HTTP_STATUS_CODES


USAGE_WEBHOOK_WORKERS = 4
MAX_PENDING_WEBHOOK_PAYLOADS = USAGE_WEBHOOK_WORKERS * 4

usage_executor = WebhookExecutor(
    max_workers=USAGE_WEBHOOK_WORKERS,
    thread_name_prefix="usage",
)

_delivery_capacity_lock = threading.Lock()
_pending_delivery_payloads = 0


def _try_acquire_delivery_capacity() -> int | None:
    global _pending_delivery_payloads
    with _delivery_capacity_lock:
        if _pending_delivery_payloads >= MAX_PENDING_WEBHOOK_PAYLOADS:
            return None
        _pending_delivery_payloads += 1
        return _pending_delivery_payloads


def _release_delivery_capacity() -> None:
    global _pending_delivery_payloads
    with _delivery_capacity_lock:
        if _pending_delivery_payloads <= 0:
            raise RuntimeError("usage webhook delivery capacity released without acquire")
        _pending_delivery_payloads -= 1


def _pending_delivery_payload_count() -> int:
    with _delivery_capacity_lock:
        return _pending_delivery_payloads


def pending_delivery_payload_count_for_tests() -> int:
    return _pending_delivery_payload_count()


def reset_delivery_capacity_for_tests() -> None:
    global _pending_delivery_payloads
    with _delivery_capacity_lock:
        _pending_delivery_payloads = 0


def _post_admitted_webhook_with_retry(
    url: str,
    bearer_credential: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    pending_report: PendingReportLease,
    delivery_outcome_callback: _DeliveryOutcomeCallback | None,
    release_capacity: Callable[[], None],
    try_claim_delivery: Callable[[], bool],
    *,
    fallback_message: str | None = None,
) -> None:
    if not try_claim_delivery():
        return

    delivery_started = False
    try:
        if fallback_message is not None:
            log_proxy_entry(
                proxy_log_path,
                "warn",
                fallback_message,
                type=log_type,
                url=url,
            )
        delivery_started = True
        _post_webhook_with_retry(
            url,
            bearer_credential,
            payload,
            proxy_log_path,
            log_type,
            pending_report,
            delivery_outcome_callback=delivery_outcome_callback,
        )
    finally:
        try:
            if not delivery_started:
                pending_report.release()
        finally:
            release_capacity()


def enqueue_webhook_delivery(
    url: str,
    sandbox_token: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    delivery_outcome_callback: _DeliveryOutcomeCallback | None = None,
) -> bool:
    """Submit webhook POST to the thread pool.

    The caller transfers ownership of ``payload`` to webhook delivery and
    must not mutate it after enqueue.

    If submission raises ``RuntimeError`` during shutdown or worker startup,
    falls back to synchronous delivery unless a worker already claimed it.
    A queued worker and the fallback cannot both deliver the same payload.

    When provided, ``delivery_outcome_callback`` is invoked exactly once for
    an admitted payload after delivery reaches a final ``success``,
    ``retryable_failure``, or ``permanent_failure`` outcome.  It is not
    invoked when admission returns ``False`` or when enqueueing fails before
    delivery ownership transfers.  Normal delivery invokes it on a webhook
    executor worker; the submission-failure fallback invokes it synchronously
    on the enqueueing thread.

    The callback runs before the pending-report lease and delivery-capacity
    slot are released.  Exceptions raised by the callback propagate through
    the worker future or synchronous fallback, while the surrounding cleanup
    still releases the owned counters.

    Returns whether the payload was admitted to delivery.  ``False`` means
    delivery was saturated and the caller still owns retry handling.
    """
    return _enqueue_webhook_delivery(
        url=url,
        bearer_credential=sandbox_token,
        payload=payload,
        proxy_log_path=proxy_log_path,
        log_type=log_type,
        delivery_outcome_callback=delivery_outcome_callback,
        executor=usage_executor,
        try_acquire_capacity=_try_acquire_delivery_capacity,
        release_capacity=_release_delivery_capacity,
        pending_delivery_count=_pending_delivery_payload_count,
        saturation_label="usage delivery",
        fallback_message="Webhook submission failed, falling back to synchronous delivery",
    )


def _enqueue_webhook_delivery(
    *,
    url: str,
    bearer_credential: str,
    payload: dict,
    proxy_log_path: str,
    log_type: str,
    delivery_outcome_callback: _DeliveryOutcomeCallback | None,
    executor: Executor,
    try_acquire_capacity: Callable[[], int | None],
    release_capacity: Callable[[], None],
    pending_delivery_count: Callable[[], int],
    saturation_label: str,
    fallback_message: str,
) -> bool:
    admitted_count = try_acquire_capacity()
    if admitted_count is None:
        _log_webhook_entry(
            proxy_log_path,
            "info",
            f"was not admitted because {saturation_label} is saturated",
            url,
            log_type,
            payload,
            extra_fields={
                "reason": "delivery_saturated",
                "webhook_delivery_capacity": MAX_PENDING_WEBHOOK_PAYLOADS,
                "webhook_delivery_pending": pending_delivery_count(),
            },
        )
        return False

    try:
        _log_webhook_entry(
            proxy_log_path,
            "info",
            "enqueued",
            url,
            log_type,
            payload,
            extra_fields={
                "webhook_delivery_capacity": MAX_PENDING_WEBHOOK_PAYLOADS,
                "webhook_delivery_pending": admitted_count,
            },
        )
    except Exception:
        release_capacity()
        raise

    pending_report = admit_pending_report()
    claim_lock = threading.Lock()
    claimed = False

    def try_claim_delivery() -> bool:
        nonlocal claimed
        with claim_lock:
            if claimed:
                return False
            claimed = True
            return True

    deliver = partial(
        _post_admitted_webhook_with_retry,
        url,
        bearer_credential,
        payload,
        proxy_log_path,
        log_type,
        pending_report,
        delivery_outcome_callback,
        release_capacity,
        try_claim_delivery,
    )
    try:
        executor.submit(deliver)
    except RuntimeError:
        # submit() can queue work before Thread.start() raises. Only one
        # invocation may own delivery, its callback, and counter cleanup.
        deliver(fallback_message=fallback_message)
    except Exception:
        if try_claim_delivery():
            try:
                pending_report.release()
            finally:
                release_capacity()
        raise
    return True


def shutdown_delivery_executor(*, wait: bool) -> None:
    """Shut down the usage delivery executor."""
    usage_executor.shutdown(wait=wait)
