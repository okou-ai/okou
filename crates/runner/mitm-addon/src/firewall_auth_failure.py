"""Content-free attribution for local firewall auth-resolution failures."""

import json
import urllib.error

from firewall_auth_client import (
    FirewallAuthDeadlineExceededError,
    FirewallAuthInvalidResponseError,
    FirewallAuthResponseTooLargeError,
)

_HTTP_STATUS_MIN = 100
_HTTP_STATUS_MAX = 599


def project_firewall_auth_failure(exc: Exception) -> dict[str, str | int]:
    """Retain only owned classes, HTTP status and the closed deadline phase."""
    evidence: dict[str, str | int] = {"source": "okou_firewall_auth"}
    if isinstance(exc, urllib.error.HTTPError) and _HTTP_STATUS_MIN <= exc.code <= _HTTP_STATUS_MAX:
        return {**evidence, "kind": "api_http_error", "status": exc.code}
    if isinstance(exc, FirewallAuthDeadlineExceededError):
        return {**evidence, "kind": "deadline_exceeded", "phase": exc.phase.value}
    if isinstance(exc, (urllib.error.URLError, OSError)):
        return {**evidence, "kind": "transport_error"}
    if isinstance(
        exc,
        (
            FirewallAuthInvalidResponseError,
            FirewallAuthResponseTooLargeError,
            json.JSONDecodeError,
            UnicodeDecodeError,
        ),
    ):
        return {**evidence, "kind": "invalid_response"}
    return {**evidence, "kind": "unexpected_error"}
