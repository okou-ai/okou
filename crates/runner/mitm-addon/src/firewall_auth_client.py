"""Request and response protocol for the host-only firewall credential resolver."""

import asyncio
import json
import math
from dataclasses import dataclass, field, replace
from typing import TypeGuard

import h11

import platform_api
import platform_http_transport as transport
from aws_sigv4 import AwsSigV4Credentials

_MAX_CLOUDFLARE_TOKEN_LENGTH = 4096
_MAX_CLOUDFLARE_GENERATION = 2**31 - 1
_CLOUDFLARE_TOKEN_MIN_CODEPOINT = 0x21
_CLOUDFLARE_TOKEN_MAX_CODEPOINT = 0x7E
_STRUCTURED_FIREWALL_AUTH_ERROR_CODES = frozenset(
    {
        "FORBIDDEN",
        "TOKEN_REFRESH_FAILED",
        "TOKEN_ACCESS_RESOLUTION_FAILED",
    }
)
_FIREWALL_AUTH_FAILURE_REASONS = frozenset({"upstream_provider", "reconnect_required"})


class ConnectorNotConfiguredError(Exception):
    """Raised when the auth endpoint returns 424 — connector not linked or misconfigured."""


class InsufficientCreditsError(Exception):
    """Raised when the auth endpoint denies billable firewall auth for credits."""


class FirewallAuthResponseTooLargeError(Exception):
    """Raised when the firewall response exceeds the platform transport limit."""


class FirewallAuthInvalidResponseError(ValueError):
    """Raised when /firewall/auth returns invalid protocol or success data."""


class FirewallAuthDeadlineExceededError(Exception):
    """Raised when one /firewall/auth request exceeds its total lifetime."""

    def __init__(self, phase: transport.RequestPhase):
        super().__init__(f"Firewall auth fetch deadline exceeded during {phase.value}")
        self.phase = phase


class FirewallAuthApiError(Exception):
    """Raised for general /firewall/auth errors recognized by the runner.

    The recognized codes are ``FORBIDDEN``, ``TOKEN_REFRESH_FAILED``, and
    ``TOKEN_ACCESS_RESOLUTION_FAILED``. A string-list ``connectors`` value is
    preserved. The wire ``failureReason`` is preserved as ``failure_reason``
    only for ``upstream_provider`` and ``reconnect_required``.
    """

    def __init__(
        self,
        *,
        status: int,
        code: str,
        message: str,
        connectors: list[str] | None = None,
        failure_reason: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.connectors = connectors
        self.failure_reason = failure_reason


@dataclass(frozen=True)
class FirewallAuthRequest:
    """Inputs sent to the runner firewall auth webhook."""

    auth_headers: dict
    firewall_token: str = field(repr=False)
    auth_base: str | None = None
    auth_query: dict | None = None
    auth_aws_sigv4: dict | None = None
    secret_connector_map: dict | None = None
    secret_connector_metadata_map: dict | None = None
    vars_map: dict | None = None
    firewall_billable: bool = False
    matched_firewall: dict | None = None
    network_admission: bool = False
    network_request: dict | None = None
    network_intent: dict | None = None
    prepared_normal_body: bytes | None = field(default=None, repr=False, compare=False)

    def to_body(self, *, force_refresh: bool = False) -> dict:
        """Build the webhook JSON body while preserving omission semantics."""
        body: dict = {
            "authHeaders": self.auth_headers,
        }
        if self.auth_base:
            body["authBase"] = self.auth_base
        if self.auth_query:
            body["authQuery"] = self.auth_query
        if self.auth_aws_sigv4:
            body["authAwsSigv4"] = self.auth_aws_sigv4
        if self.secret_connector_map:
            body["secretConnectorMap"] = self.secret_connector_map
        if self.secret_connector_metadata_map:
            body["secretConnectorMetadataMap"] = self.secret_connector_metadata_map
        if self.vars_map:
            body["vars"] = self.vars_map
        if self.firewall_billable:
            body["firewallBillable"] = True
        if self.matched_firewall is not None:
            body["matchedFirewall"] = self.matched_firewall
        if self.network_admission:
            body["networkAdmission"] = True
        if self.network_request is not None:
            body["networkRequest"] = self.network_request
        if self.network_intent is not None:
            body["networkIntent"] = self.network_intent
        if force_refresh:
            body["forceRefresh"] = True
        return body

    def to_bytes(self, *, force_refresh: bool = False) -> bytes:
        """Serialize the webhook body with stable content-derived bytes."""
        return json.dumps(
            self.to_body(force_refresh=force_refresh),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

    def with_prepared_normal_body(self, body: bytes) -> FirewallAuthRequest:
        """Attach normal request bytes for the request-local fetch path."""
        return replace(self, prepared_normal_body=body)


@dataclass(frozen=True)
class FirewallAuthPayload:
    """Cacheable /firewall/auth data applied to outbound requests."""

    headers: dict[str, str]
    resolved_secrets: list[str] = field(default_factory=list)
    base: str | None = None
    query: dict[str, str] | None = None
    aws_sigv4: AwsSigV4Credentials | None = None
    # Explicit network-only requests populate this field, cached separately from app credentials.
    network_admission: dict | None = field(default=None, repr=False)


@dataclass(frozen=True)
class FirewallAuthSuccess:
    """Validated /firewall/auth success response consumed by the auth cache."""

    payload: FirewallAuthPayload
    expires_at: int | float | None = None
    refreshed_connectors: list[str] = field(default_factory=list)
    refreshed_secrets: list[str] = field(default_factory=list)


def _firewall_auth_api_error_from_envelope(
    status: int,
    error_info: dict,
) -> FirewallAuthApiError | None:
    code = error_info.get("code")
    message = error_info.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    if code not in _STRUCTURED_FIREWALL_AUTH_ERROR_CODES:
        return None
    connectors = error_info.get("connectors")
    if isinstance(connectors, list) and all(isinstance(item, str) for item in connectors):
        parsed_connectors = connectors
    else:
        parsed_connectors = None
    failure_reason = error_info.get("failureReason")
    parsed_failure_reason = (
        failure_reason
        if isinstance(failure_reason, str) and failure_reason in _FIREWALL_AUTH_FAILURE_REASONS
        else None
    )
    return FirewallAuthApiError(
        status=status,
        code=code,
        message=message,
        connectors=parsed_connectors,
        failure_reason=parsed_failure_reason,
    )


_MALFORMED_FIREWALL_AUTH_SUCCESS = "Firewall auth endpoint returned malformed success response"


def _malformed_firewall_auth_success(message: str) -> FirewallAuthInvalidResponseError:
    return FirewallAuthInvalidResponseError(f"{_MALFORMED_FIREWALL_AUTH_SUCCESS}: {message}")


def _parse_string_map(value: object, field_name: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success(f"{field_name} must be an object")

    parsed: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise _malformed_firewall_auth_success(f"{field_name} keys must be strings")
        if not isinstance(item, str):
            raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
        parsed[key] = item
    return parsed


def _parse_optional_string_map(
    decoded: dict[object, object], field_name: str
) -> dict[str, str] | None:
    value = decoded.get(field_name)
    if value is None:
        return None
    return _parse_string_map(value, field_name)


def _parse_optional_string(decoded: dict[object, object], field_name: str) -> str | None:
    value = decoded.get(field_name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _malformed_firewall_auth_success(f"{field_name} must be a string")
    if value == "":
        raise _malformed_firewall_auth_success(f"{field_name} must not be empty")
    return value


def _parse_required_string_list(decoded: dict[object, object], field_name: str) -> list[str]:
    if field_name not in decoded:
        raise _malformed_firewall_auth_success(f"{field_name} is required")
    value = decoded[field_name]
    if not isinstance(value, list):
        raise _malformed_firewall_auth_success(f"{field_name} must be an array")
    if not all(isinstance(item, str) for item in value):
        raise _malformed_firewall_auth_success(f"{field_name} values must be strings")
    return list(value)


def is_supported_expiry(value: object) -> TypeGuard[int | float]:
    """Return whether an expiry is a finite number supported by the runtime."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _parse_expires_at(decoded: dict[object, object]) -> int | float | None:
    if "expiresAt" not in decoded:
        raise _malformed_firewall_auth_success("expiresAt is required")
    value = decoded["expiresAt"]
    if value is None:
        return None
    if not is_supported_expiry(value):
        raise _malformed_firewall_auth_success("expiresAt must be a finite number or null")
    return value


def _parse_optional_aws_sigv4_credentials(
    decoded: dict[object, object],
) -> AwsSigV4Credentials | None:
    if "awsSigv4" not in decoded:
        return None
    value = decoded["awsSigv4"]
    if not isinstance(value, dict):
        raise _malformed_firewall_auth_success("awsSigv4 must be an object")
    access_key_id = value.get("accessKeyId")
    secret_access_key = value.get("secretAccessKey")
    if not isinstance(access_key_id, str) or not access_key_id:
        raise _malformed_firewall_auth_success("awsSigv4.accessKeyId is required")
    if not isinstance(secret_access_key, str) or not secret_access_key:
        raise _malformed_firewall_auth_success("awsSigv4.secretAccessKey is required")
    if "sessionToken" in value and value["sessionToken"] is None:
        raise _malformed_firewall_auth_success("sessionToken must be a string")
    return AwsSigV4Credentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=_parse_optional_string(value, "sessionToken"),
    )


def _parse_firewall_auth_success(
    decoded: object,
    request: FirewallAuthRequest,
) -> FirewallAuthSuccess:
    if not isinstance(decoded, dict):
        raise _malformed_firewall_auth_success("response must be an object")

    decoded_map: dict[object, object] = decoded
    if "headers" not in decoded_map:
        raise _malformed_firewall_auth_success("headers is required")

    headers = _parse_string_map(decoded_map["headers"], "headers")
    network_admission = None
    if request.network_admission:
        value = decoded_map.get("networkAdmission")
        expected = request.network_request.get("intent") if request.network_request else None
        if not isinstance(value, dict):
            raise _malformed_firewall_auth_success("missing network admission")
        if value.get("kind") == "direct":
            if value != {"kind": "direct"} or expected != {"kind": "direct"}:
                raise _malformed_firewall_auth_success("network intent changed")
        elif value.get("kind") == "cloudflare_access":
            if (
                set(value) != {"kind", "configId", "generation", "headers"}
                or not isinstance(expected, dict)
                or set(expected) != {"kind", "configId", "generation"}
                or expected.get("kind") != "cloudflare_access"
                or expected.get("configId") != value.get("configId")
                or isinstance(value.get("generation"), bool)
                or not isinstance(value.get("generation"), int)
                or value["generation"] <= 0
                or value["generation"] > _MAX_CLOUDFLARE_GENERATION
            ):
                raise _malformed_firewall_auth_success("invalid Cloudflare network identity")
            pair = value.get("headers")
            if not isinstance(pair, dict) or set(pair) != {
                "CF-Access-Client-Id",
                "CF-Access-Client-Secret",
            }:
                raise _malformed_firewall_auth_success("invalid Cloudflare network headers")
            for token in pair.values():
                if (
                    not isinstance(token, str)
                    or not 1 <= len(token) <= _MAX_CLOUDFLARE_TOKEN_LENGTH
                    or any(
                        ord(char) < _CLOUDFLARE_TOKEN_MIN_CODEPOINT
                        or ord(char) > _CLOUDFLARE_TOKEN_MAX_CODEPOINT
                        for char in token
                    )
                ):
                    raise _malformed_firewall_auth_success("invalid Cloudflare header value")
        else:
            raise _malformed_firewall_auth_success("unsupported network admission")
        network_admission = value
    elif "networkAdmission" in decoded_map:
        raise _malformed_firewall_auth_success("unsolicited network admission")
    expires_at = _parse_expires_at(decoded_map)
    resolved_secrets = _parse_required_string_list(decoded_map, "resolvedSecrets")
    refreshed_connectors = _parse_required_string_list(decoded_map, "refreshedConnectors")
    refreshed_secrets = _parse_required_string_list(decoded_map, "refreshedSecrets")
    base = _parse_optional_string(decoded_map, "base")
    query = _parse_optional_string_map(decoded_map, "query")
    aws_sigv4 = _parse_optional_aws_sigv4_credentials(decoded_map)

    if set(headers) != set(request.auth_headers):
        raise _malformed_firewall_auth_success(
            "headers must match the configured auth header names"
        )
    if set(query or {}) != set(request.auth_query or {}):
        raise _malformed_firewall_auth_success("query must match the configured auth query names")
    if (base is not None) != (request.auth_base is not None):
        raise _malformed_firewall_auth_success("base presence must match the configured auth base")
    if (aws_sigv4 is not None) != (request.auth_aws_sigv4 is not None):
        raise _malformed_firewall_auth_success(
            "awsSigv4 presence must match the configured auth mode"
        )
    request_session_token_present = (
        request.auth_aws_sigv4 is not None
        and request.auth_aws_sigv4.get("sessionToken") is not None
    )
    response_session_token_present = aws_sigv4 is not None and aws_sigv4.session_token is not None
    if response_session_token_present != request_session_token_present:
        raise _malformed_firewall_auth_success(
            "awsSigv4.sessionToken presence must match the configured auth mode"
        )

    payload = FirewallAuthPayload(
        headers=headers,
        network_admission=network_admission,
        resolved_secrets=resolved_secrets,
        base=base,
        query=query,
        aws_sigv4=aws_sigv4,
    )
    return FirewallAuthSuccess(
        payload=payload,
        expires_at=expires_at,
        refreshed_connectors=refreshed_connectors,
        refreshed_secrets=refreshed_secrets,
    )


def _raise_firewall_auth_http_error(response: transport.HttpResponse, url: str) -> None:
    """Raise the mapped runner exception for a non-success auth response.

    ``CONNECTOR_NOT_CONFIGURED`` and ``INSUFFICIENT_CREDITS`` map to their
    specialized exceptions. Recognized general codes map to
    ``FirewallAuthApiError``. Responses that match neither path, including
    envelopes without a usable code and otherwise unknown codes, retain the
    original ``urllib.error.HTTPError``.

    Preserving a new endpoint error requires an intentional specialized branch
    or ``_STRUCTURED_FIREWALL_AUTH_ERROR_CODES`` update plus focused client and
    handling tests. Propagating a new ``failureReason`` also requires updating
    ``_FIREWALL_AUTH_FAILURE_REASONS`` and those tests.
    """
    error = response.as_http_error(url)
    try:
        error_body: object = json.loads(response.body)
    except UnicodeDecodeError, json.JSONDecodeError:
        raise error from None
    if not isinstance(error_body, dict):
        raise error from None
    error_info = error_body.get("error")
    if not isinstance(error_info, dict):
        raise error from None
    error_message = error_info.get("message")
    if error_info.get("code") == "CONNECTOR_NOT_CONFIGURED":
        raise ConnectorNotConfiguredError(
            error_message if isinstance(error_message, str) else "Connector not configured",
        ) from None
    if error_info.get("code") == "INSUFFICIENT_CREDITS":
        raise InsufficientCreditsError(
            error_message if isinstance(error_message, str) else "Insufficient credits",
        ) from None
    api_error = _firewall_auth_api_error_from_envelope(response.status, error_info)
    if api_error is None:
        raise error from None
    raise api_error from None


async def fetch_firewall_headers(
    request: FirewallAuthRequest,
    *,
    force_refresh: bool = False,
) -> FirewallAuthSuccess:
    """Resolve application or network credentials with host-only authority.

    request.secret_connector_map maps firewall auth secret env aliases (the
    `NAME` in `${{ secrets.NAME }}`) to the connector or provider owner that
    can refresh/resolve access. request.secret_connector_metadata_map uses the
    same keys to add source details when the owner alone is not enough to
    locate access storage.

    When request.secret_connector_map is provided, the auth endpoint can refresh
    expired access tokens and returns an expiresAt timestamp for TTL caching.
    For billable firewall auth, expiresAt is also bounded by the server-side
    credit authorization lease.

    When force_refresh is True, the endpoint refreshes access tokens regardless
    of DB tokenExpiresAt — used after the upstream returns 401 (#9860).

    One monotonic deadline covers cancellable DNS, connect, TLS, request write,
    response headers, and the bounded response body.
    """
    api_url = platform_api.get_api_url()
    url = f"{api_url}/api/webhooks/run/firewall/auth"
    body = (
        request.prepared_normal_body
        if not force_refresh and request.prepared_normal_body is not None
        else request.to_bytes(force_refresh=force_refresh)
    )
    req = platform_api.make_api_request(url, body, request.firewall_token)
    progress = transport.RequestProgress()
    timeout = asyncio.timeout(transport.REQUEST_DEADLINE_SECONDS)
    try:
        async with timeout:
            response = await transport.send(req, body, progress)
    except TimeoutError:
        if timeout.expired():
            raise FirewallAuthDeadlineExceededError(progress.phase) from None
        raise
    except h11.ProtocolError:
        raise FirewallAuthInvalidResponseError("Firewall auth HTTP protocol error") from None
    except transport.ResponseTooLargeError:
        raise FirewallAuthResponseTooLargeError("Firewall auth response body too large") from None

    if not response.ok:
        _raise_firewall_auth_http_error(response, url)
    decoded: object = json.loads(response.body)
    return _parse_firewall_auth_success(decoded, request)
