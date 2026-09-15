"""AWS SigV4 placeholder-to-real re-signing for connector firewall auth.

This module is the runner-side boundary between sandbox-generated placeholder
AWS signatures and connector-resolved real AWS credentials. It does not sign
arbitrary AWS requests from scratch: incoming requests must already contain
placeholder SigV4 metadata in either the ``Authorization`` header or presigned
``X-Amz-*`` query parameters.

Unsupported, ambiguous, or malformed requests fail closed by raising
``AwsSigV4SigningError``. The contract is used by normal firewall auth
injection in ``auth._sign_flow_request_with_aws_sigv4``.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import re
import urllib.parse
from dataclasses import dataclass, field
from enum import Enum
from typing import NewType

from http_header_syntax import has_forbidden_header_value_control, is_http_header_name
from runtime_url_parsing import split_runtime_url

_AWS4_REQUEST = "aws4_request"
_HMAC_ALGORITHM = "AWS4-HMAC-SHA256"
_ASYMMETRIC_ALGORITHM = "AWS4-ECDSA-P256-SHA256"
_S3_SIGNING_NAMES = frozenset(("s3", "s3-outposts", "s3-object-lambda"))
_UNSUPPORTED_S3_EXPRESS_SIGNING_NAME = "s3express"
_STREAMING_PAYLOAD_PREFIX = "STREAMING-"
_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"
_CONTENT_HASH_HEADER = "x-amz-content-sha256"
_SHA256_HEX_LENGTH = 64
_CREDENTIAL_SCOPE_PARTS = 5
_AUTH_HEADER_PARAM_NAMES = frozenset(("Credential", "SignedHeaders", "Signature"))
_QUERY_SIGNING_PARAM_NAMES = frozenset(
    (
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Security-Token",
        "X-Amz-Signature",
    )
)
_SCOPE_DATE_RE = re.compile(r"^\d{8}$")
_SCOPE_REGION_RE = re.compile(r"^(?:[A-Za-z0-9._-]+|\*)$")
_SCOPE_SERVICE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_AMZ_DATE_RE = re.compile(r"^\d{8}T\d{6}Z$")
_PRESIGN_EXPIRES_MAX_TEXT = "604800"
_PRESIGN_EXPIRES_RE = re.compile(r"^[1-9][0-9]*$")
_ACCESS_KEY_ID_RE = re.compile(r"^[A-Za-z0-9]+$")
_LOWER_HEX_DIGITS = frozenset("0123456789abcdef")
_HEX_DIGITS = frozenset("0123456789ABCDEFabcdef")
_RAW_WHITESPACE_CHARS = frozenset(" \t\n\r\f\v")
_ASCII_CONTROL_MAX = 0x1F
_ASCII_DELETE = 0x7F
_DEFAULT_PORTS = {"http": 80, "https": 443}
# ALB caps the complete request line at 16 KiB; CloudFront and API Gateway
# impose smaller URL limits. Even one-byte non-empty query pairs require
# 2 * count - 1 bytes with separators, so this admits every request within
# those documented front-door limits while bounding synchronous signing work.
MAX_AWS_SIGV4_QUERY_PAIRS = 8 * 1024
_RAW_QUERY_PAIR_RE = re.compile(r"[^&]+")

AwsSigV4BodyHash = NewType("AwsSigV4BodyHash", str)


class AwsSigV4SigningError(Exception):
    """Raised when a request cannot be safely re-signed."""


class _AuthLocation(Enum):
    HEADER = "header"
    QUERY = "query"


@dataclass(frozen=True)
class AwsSigV4Credentials:
    """Connector-resolved real AWS credentials used after placeholder auth is found.

    These are distinct from the placeholder credentials carried by the sandbox
    request. ``session_token`` is present for temporary AWS credentials.
    """

    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


@dataclass(frozen=True)
class _CredentialScope:
    date: str
    region: str
    service: str


@dataclass(frozen=True)
class _SigningContext:
    location: _AuthLocation
    algorithm: str
    source_access_key_id: str
    scope: _CredentialScope
    signed_headers: frozenset[str]
    amz_date: str
    expires: str | None = None


@dataclass(frozen=True)
class _SigningUrl:
    text: str
    parts: urllib.parse.SplitResult
    query_pairs: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class AwsSigV4RequestInspection:
    """Validated SigV4 request context for one exact URL/header representation."""

    requires_body: bool
    _url: str = field(repr=False)
    _headers: tuple[tuple[str, str], ...] = field(repr=False)
    _context: _SigningContext = field(repr=False)
    _signing_url: _SigningUrl = field(repr=False)

    def _matches(self, *, url: str, headers: list[tuple[str, str]]) -> bool:
        """Return whether this inspection describes the exact current input."""
        return self._url == url and self._headers == tuple(headers)


def inspect_request(
    *,
    url: str,
    headers: list[tuple[str, str]],
) -> AwsSigV4RequestInspection:
    """Validate and classify one exact SigV4 request representation."""
    _validate_headers(headers)
    context, signing_url = _classify_request(url, headers)
    _validate_signing_context(context)
    requires_body = _content_hash_header_value(headers) is None and not (
        context.location is _AuthLocation.QUERY and context.scope.service in _S3_SIGNING_NAMES
    )
    return AwsSigV4RequestInspection(
        requires_body=requires_body,
        _url=url,
        _headers=tuple(headers),
        _context=context,
        _signing_url=signing_url,
    )


def sign_request(
    *,
    method: str,
    url: str,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
    precomputed_body_hash: AwsSigV4BodyHash | None = None,
    inspection: AwsSigV4RequestInspection | None = None,
) -> tuple[str, list[tuple[str, str]]]:
    """Return a URL/header pair re-signed with real AWS credentials.

    The request must already include placeholder SigV4 auth metadata. Supported
    forms are header auth (``Authorization: AWS4-HMAC-SHA256 ...`` plus a
    single ``x-amz-date`` header) and presigned query auth with complete
    ``X-Amz-*`` signing metadata, including ``X-Amz-Expires`` and
    ``X-Amz-Signature``.

    The source access key from the incoming credential scope is expected to be
    a placeholder and must differ from ``credentials.access_key_id``. Header
    auth remains header auth; query auth remains query auth.

    The signer intentionally fails closed for SigV4A, wildcard-region signing,
    S3 Express, AWS streaming payload signing, ambiguous header/query auth,
    malformed or duplicate auth metadata, and signed headers that cannot be
    reconstructed from the request.

    S3-family services keep S3 canonical URI behavior. For presigned S3
    requests without an explicit ``x-amz-content-sha256`` header, the payload
    hash is ``UNSIGNED-PAYLOAD``.

    When supplied, ``precomputed_body_hash`` must be the SHA-256 digest of
    ``body``. It is ignored when the request declares a supported payload hash.
    ``inspection`` is reused only when it describes the exact current URL and
    ordered headers; otherwise the current representation is inspected once.
    """
    _validate_credentials(credentials)
    if inspection is None or not inspection._matches(url=url, headers=headers):
        inspection = inspect_request(url=url, headers=headers)
    context = inspection._context
    signing_url = inspection._signing_url
    if context.source_access_key_id == credentials.access_key_id:
        raise AwsSigV4SigningError("AWS request must use a placeholder access key ID")

    is_s3 = context.scope.service in _S3_SIGNING_NAMES
    if context.location is _AuthLocation.QUERY:
        return _sign_query_request(
            method=method,
            url=signing_url,
            headers=headers,
            body=body,
            credentials=credentials,
            context=context,
            is_s3=is_s3,
            precomputed_body_hash=precomputed_body_hash,
        )
    return _sign_header_request(
        method=method,
        url=signing_url,
        headers=headers,
        body=body,
        credentials=credentials,
        context=context,
        is_s3=is_s3,
        precomputed_body_hash=precomputed_body_hash,
    )


def hash_request_body(body: bytes | None) -> AwsSigV4BodyHash:
    """Return the SHA-256 digest used by payload-dependent SigV4 signing."""
    return AwsSigV4BodyHash(hashlib.sha256(body or b"").hexdigest())


def request_requires_body_for_signing(
    *,
    url: str,
    headers: list[tuple[str, str]],
) -> bool:
    """Return whether re-signing must hash the request body bytes."""
    return inspect_request(url=url, headers=headers).requires_body


def _validate_signing_context(context: _SigningContext) -> None:
    if context.algorithm == _ASYMMETRIC_ALGORITHM:
        raise AwsSigV4SigningError("SigV4A is not supported by this runner")
    if context.algorithm != _HMAC_ALGORITHM:
        raise AwsSigV4SigningError("Unsupported AWS signing algorithm")
    if context.scope.region == "*":
        raise AwsSigV4SigningError("Wildcard AWS signing region requires SigV4A")
    if context.scope.service == _UNSUPPORTED_S3_EXPRESS_SIGNING_NAME:
        raise AwsSigV4SigningError("S3 Express signing is not supported by this runner")


def _classify_request(
    url: str,
    headers: list[tuple[str, str]],
) -> tuple[_SigningContext, _SigningUrl]:
    auth_header = _unique_header_value(
        headers,
        "authorization",
        "Malformed AWS authorization header",
    )
    signing_url = _parse_url_for_signing(url)
    query_algorithm = _unique_query_value(signing_url.query_pairs, "X-Amz-Algorithm")
    if auth_header and query_algorithm:
        raise AwsSigV4SigningError("Ambiguous AWS auth location")
    if query_algorithm:
        return _classify_query_request(signing_url.query_pairs, query_algorithm), signing_url
    if auth_header:
        return _classify_header_request(auth_header, headers), signing_url
    raise AwsSigV4SigningError("Missing AWS SigV4 auth metadata")


def _parse_url_for_signing(url: str) -> _SigningUrl:
    _utf8_encode(url, "AWS request URL is malformed")
    if _has_raw_whitespace(url) or _has_ascii_control(url):
        raise AwsSigV4SigningError("AWS request URL is malformed")
    if _has_malformed_percent_encoding(url):
        raise AwsSigV4SigningError("AWS request URL is malformed")
    try:
        parts = split_runtime_url(url)
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e
    return _SigningUrl(
        text=url,
        parts=parts,
        query_pairs=tuple(_parse_query_pairs(parts.query)),
    )


def _classify_header_request(
    auth_header: str,
    headers: list[tuple[str, str]],
) -> _SigningContext:
    algorithm, params = _parse_authorization_header(auth_header)
    credential = params.get("Credential")
    signed_headers = params.get("SignedHeaders")
    signature = params.get("Signature")
    if not credential or not signed_headers or not signature:
        raise AwsSigV4SigningError("Malformed AWS authorization header")
    source_access_key_id, scope = _parse_credential(credential)
    amz_date = _unique_header_value(
        headers,
        "x-amz-date",
        "AWS SigV4 header auth requires a single x-amz-date",
    )
    if not amz_date:
        raise AwsSigV4SigningError("AWS SigV4 header auth requires x-amz-date")
    _validate_amz_date(amz_date, scope)
    return _SigningContext(
        location=_AuthLocation.HEADER,
        algorithm=algorithm,
        source_access_key_id=source_access_key_id,
        scope=scope,
        signed_headers=_parse_signed_headers(signed_headers),
        amz_date=amz_date,
    )


def _classify_query_request(
    query_pairs: tuple[tuple[str, str], ...],
    algorithm: str,
) -> _SigningContext:
    credential = _unique_query_value(query_pairs, "X-Amz-Credential")
    signed_headers = _unique_query_value(query_pairs, "X-Amz-SignedHeaders")
    amz_date = _unique_query_value(query_pairs, "X-Amz-Date")
    expires = _unique_query_value(query_pairs, "X-Amz-Expires")
    signature = _unique_query_value(query_pairs, "X-Amz-Signature")
    if not credential or not signed_headers or not amz_date or not expires or not signature:
        raise AwsSigV4SigningError("Malformed AWS presigned query")
    source_access_key_id, scope = _parse_credential(credential)
    _validate_amz_date(amz_date, scope)
    if (
        len(expires) > len(_PRESIGN_EXPIRES_MAX_TEXT)
        or not _PRESIGN_EXPIRES_RE.fullmatch(expires)
        or (len(expires) == len(_PRESIGN_EXPIRES_MAX_TEXT) and expires > _PRESIGN_EXPIRES_MAX_TEXT)
    ):
        raise AwsSigV4SigningError("Malformed AWS presigned query expiry")
    return _SigningContext(
        location=_AuthLocation.QUERY,
        algorithm=algorithm,
        source_access_key_id=source_access_key_id,
        scope=scope,
        signed_headers=_parse_signed_headers(signed_headers),
        amz_date=amz_date,
        expires=expires,
    )


def _parse_authorization_header(value: str) -> tuple[str, dict[str, str]]:
    algorithm, sep, remainder = value.partition(" ")
    if not sep or not algorithm or not remainder.strip():
        raise AwsSigV4SigningError("Malformed AWS authorization header")
    params: dict[str, str] = {}
    for raw_param in remainder.split(","):
        key, param_sep, raw_param_value = raw_param.strip().partition("=")
        param_value = raw_param_value.strip()
        if not param_sep or key not in _AUTH_HEADER_PARAM_NAMES or not param_value or key in params:
            raise AwsSigV4SigningError("Malformed AWS authorization header")
        params[key] = param_value
    return algorithm, params


def _parse_credential(credential: str) -> tuple[str, _CredentialScope]:
    parts = credential.split("/")
    if len(parts) != _CREDENTIAL_SCOPE_PARTS or parts[-1] != _AWS4_REQUEST:
        raise AwsSigV4SigningError("Malformed AWS credential scope")
    access_key_id = parts[0]
    date = parts[1]
    region = parts[2]
    service = parts[3]
    if not access_key_id or not date or not region or not service:
        raise AwsSigV4SigningError("Incomplete AWS credential scope")
    if (
        not _ACCESS_KEY_ID_RE.fullmatch(access_key_id)
        or _has_ascii_control(access_key_id)
        or not _SCOPE_DATE_RE.fullmatch(date)
        or not _SCOPE_REGION_RE.fullmatch(region)
        or not _SCOPE_SERVICE_RE.fullmatch(service)
    ):
        raise AwsSigV4SigningError("Malformed AWS credential scope")
    return access_key_id, _CredentialScope(date=date, region=region, service=service)


def _parse_signed_headers(value: str) -> frozenset[str]:
    parts = [part.strip().lower() for part in value.split(";")]
    if (
        not parts
        or any(not is_http_header_name(part) for part in parts)
        or len(parts) != len(set(parts))
    ):
        raise AwsSigV4SigningError("Malformed AWS signed headers")
    headers = frozenset(parts)
    if "host" not in headers:
        raise AwsSigV4SigningError("AWS signed headers must include host")
    return headers


def _validate_amz_date(amz_date: str, scope: _CredentialScope) -> None:
    if not _AMZ_DATE_RE.fullmatch(amz_date):
        raise AwsSigV4SigningError("Malformed AWS signing date")
    if not amz_date.startswith(scope.date):
        raise AwsSigV4SigningError("AWS signing date does not match credential scope")
    try:
        datetime.datetime.strptime(amz_date, "%Y%m%dT%H%M%SZ")
    except ValueError as e:
        raise AwsSigV4SigningError("Malformed AWS signing date") from e


def _sign_header_request(
    *,
    method: str,
    url: _SigningUrl,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
    context: _SigningContext,
    is_s3: bool,
    precomputed_body_hash: AwsSigV4BodyHash | None,
) -> tuple[str, list[tuple[str, str]]]:
    payload_hash = _payload_hash(headers, body, precomputed_body_hash)
    clean_headers = _without_headers(headers, {"authorization", "x-amz-security-token"})
    clean_headers = _upsert_header(clean_headers, "host", _host_header_value(url))
    clean_headers = _upsert_header(clean_headers, "x-amz-date", context.amz_date)
    if credentials.session_token:
        clean_headers = _upsert_header(
            clean_headers,
            "x-amz-security-token",
            credentials.session_token,
        )

    # The session-token header and its signature membership follow resolved credentials.
    signed_headers = set(context.signed_headers) - {"x-amz-security-token"}
    signed_headers.add("host")
    signed_headers.add("x-amz-date")
    if credentials.session_token:
        signed_headers.add("x-amz-security-token")
    for name, _value in clean_headers:
        lower_name = name.lower()
        if lower_name.startswith("x-amz-"):
            signed_headers.add(lower_name)

    canonical_request, signed_header_names = _canonical_request(
        method=method,
        url=url,
        headers=clean_headers,
        signed_headers=frozenset(signed_headers),
        payload_hash=payload_hash,
        is_s3=is_s3,
    )
    signature = _signature(
        canonical_request=canonical_request,
        credentials=credentials,
        scope=context.scope,
        amz_date=context.amz_date,
    )
    authorization = (
        f"{_HMAC_ALGORITHM} "
        f"Credential={credentials.access_key_id}/{_scope_string(context.scope)}, "
        f"SignedHeaders={signed_header_names}, "
        f"Signature={signature}"
    )
    return url.text, _upsert_header(clean_headers, "authorization", authorization)


def _sign_query_request(
    *,
    method: str,
    url: _SigningUrl,
    headers: list[tuple[str, str]],
    body: bytes | None,
    credentials: AwsSigV4Credentials,
    context: _SigningContext,
    is_s3: bool,
    precomputed_body_hash: AwsSigV4BodyHash | None,
) -> tuple[str, list[tuple[str, str]]]:
    clean_headers = _without_headers(headers, {"authorization", "x-amz-security-token"})
    clean_headers = _upsert_header(clean_headers, "host", _host_header_value(url))
    signed_headers = frozenset(set(context.signed_headers) | {"host"})
    payload_hash = _query_payload_hash(headers, body, is_s3, precomputed_body_hash)
    unsigned_url = _replace_query_signing_params(
        url,
        credentials=credentials,
        context=context,
        signed_headers=signed_headers,
        signature=None,
    )
    canonical_request, signed_header_names = _canonical_request(
        method=method,
        url=unsigned_url,
        headers=clean_headers,
        signed_headers=signed_headers,
        payload_hash=payload_hash,
        is_s3=is_s3,
    )
    signature = _signature(
        canonical_request=canonical_request,
        credentials=credentials,
        scope=context.scope,
        amz_date=context.amz_date,
    )
    signed_url = _replace_query_signing_params(
        url,
        credentials=credentials,
        context=context,
        signed_headers=frozenset(signed_header_names.split(";")),
        signature=signature,
    )
    return signed_url.text, clean_headers


def _canonical_request(
    *,
    method: str,
    url: _SigningUrl,
    headers: list[tuple[str, str]],
    signed_headers: frozenset[str],
    payload_hash: str,
    is_s3: bool,
) -> tuple[str, str]:
    canonical_uri = _canonical_uri(url.parts.path, is_s3=is_s3)
    canonical_query = _canonical_query_string(url.query_pairs)
    canonical_headers, signed_header_names = _canonical_headers(headers, signed_headers)
    request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            canonical_query,
            canonical_headers,
            signed_header_names,
            payload_hash,
        ]
    )
    return request, signed_header_names


def _canonical_uri(path: str, *, is_s3: bool) -> str:
    raw_path = path or "/"
    if is_s3:
        return raw_path
    normalized = _remove_dot_segments(raw_path)
    return _quote_url_component(normalized, safe="/~")


def _remove_dot_segments(path: str) -> str:
    if not path:
        return "/"

    output: list[str] = []
    for segment in path.split("/"):
        if not segment or segment == ".":
            continue
        if segment == "..":
            if output:
                output.pop()
            continue
        output.append(segment)

    leading_slash = "/" if path.startswith("/") else ""
    trailing_slash = "/" if path.endswith("/") and output else ""
    return f"{leading_slash}{'/'.join(output)}{trailing_slash}"


def _canonical_query_string(pairs: tuple[tuple[str, str], ...]) -> str:
    encoded = [(_aws_quote(key), _aws_quote(value)) for key, value in pairs]
    encoded.sort()
    return "&".join(f"{key}={value}" for key, value in encoded)


def _canonical_headers(
    headers: list[tuple[str, str]],
    signed_headers: frozenset[str],
) -> tuple[str, str]:
    values: dict[str, list[str]] = {}
    for name, value in headers:
        lower_name = name.lower()
        if lower_name in signed_headers:
            values.setdefault(lower_name, []).append(_normalize_header_value(value))

    missing = signed_headers.difference(values)
    if missing:
        raise AwsSigV4SigningError("AWS signed header is missing")

    signed_header_names = ";".join(sorted(signed_headers))
    canonical = "".join(f"{name}:{','.join(values[name])}\n" for name in sorted(signed_headers))
    return canonical, signed_header_names


def _normalize_header_value(value: str) -> str:
    return " ".join(value.strip().split())


def _payload_hash(
    headers: list[tuple[str, str]],
    body: bytes | None,
    precomputed_body_hash: AwsSigV4BodyHash | None,
) -> str:
    header_value = _content_hash_header_value(headers)
    if header_value is not None:
        return header_value
    if precomputed_body_hash is not None:
        return precomputed_body_hash
    return hash_request_body(body)


def _query_payload_hash(
    headers: list[tuple[str, str]],
    body: bytes | None,
    is_s3: bool,
    precomputed_body_hash: AwsSigV4BodyHash | None,
) -> str:
    header_value = _content_hash_header_value(headers)
    if header_value is not None:
        return header_value
    if is_s3:
        return _UNSIGNED_PAYLOAD
    if precomputed_body_hash is not None:
        return precomputed_body_hash
    return hash_request_body(body)


def _content_hash_header_value(headers: list[tuple[str, str]]) -> str | None:
    header_value = _unique_header_value(
        headers,
        _CONTENT_HASH_HEADER,
        "AWS content hash header is ambiguous",
    )
    if header_value is None:
        return None
    if _has_content_hash_invalid_text(header_value):
        raise AwsSigV4SigningError("AWS content hash header contains invalid text")

    normalized = _normalize_header_value(header_value)
    if not normalized:
        raise AwsSigV4SigningError("AWS content hash header is empty")
    if normalized.startswith(_STREAMING_PAYLOAD_PREFIX):
        raise AwsSigV4SigningError("AWS streaming payload signing is not supported")
    if normalized == _UNSIGNED_PAYLOAD:
        return normalized
    if _is_sha256_hex_digest(normalized):
        return normalized
    raise AwsSigV4SigningError("Unsupported AWS content hash header")


def _is_sha256_hex_digest(value: str) -> bool:
    return len(value) == _SHA256_HEX_LENGTH and all(char in _LOWER_HEX_DIGITS for char in value)


def _has_content_hash_invalid_text(value: str) -> bool:
    return any(
        ord(char) > _ASCII_DELETE
        or (ord(char) <= _ASCII_CONTROL_MAX and char != "\t")
        or ord(char) == _ASCII_DELETE
        for char in value
    )


def _signature(
    *,
    canonical_request: str,
    credentials: AwsSigV4Credentials,
    scope: _CredentialScope,
    amz_date: str,
) -> str:
    string_to_sign = "\n".join(
        [
            _HMAC_ALGORITHM,
            amz_date,
            _scope_string(scope),
            hashlib.sha256(
                _utf8_encode(canonical_request, "AWS request contains invalid text")
            ).hexdigest(),
        ]
    )
    signing_key = _signing_key(credentials.secret_access_key, scope)
    return hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()


def _signing_key(secret_access_key: str, scope: _CredentialScope) -> bytes:
    date_key = _hmac_digest(
        _utf8_encode(f"AWS4{secret_access_key}", "Invalid AWS secret access key"),
        scope.date,
    )
    region_key = _hmac_digest(date_key, scope.region)
    service_key = _hmac_digest(region_key, scope.service)
    return _hmac_digest(service_key, _AWS4_REQUEST)


def _hmac_digest(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


def _scope_string(scope: _CredentialScope) -> str:
    return f"{scope.date}/{scope.region}/{scope.service}/{_AWS4_REQUEST}"


def _replace_query_signing_params(
    url: _SigningUrl,
    *,
    credentials: AwsSigV4Credentials,
    context: _SigningContext,
    signed_headers: frozenset[str],
    signature: str | None,
) -> _SigningUrl:
    filtered = [
        (key, value) for key, value in url.query_pairs if key not in _QUERY_SIGNING_PARAM_NAMES
    ]
    filtered.extend(
        [
            ("X-Amz-Algorithm", _HMAC_ALGORITHM),
            (
                "X-Amz-Credential",
                f"{credentials.access_key_id}/{_scope_string(context.scope)}",
            ),
            ("X-Amz-Date", context.amz_date),
            ("X-Amz-Expires", context.expires or "3600"),
            ("X-Amz-SignedHeaders", ";".join(sorted(signed_headers))),
        ]
    )
    if credentials.session_token:
        filtered.append(("X-Amz-Security-Token", credentials.session_token))
    if signature:
        filtered.append(("X-Amz-Signature", signature))
    return _replace_query_pairs(url, filtered)


def _replace_query_pairs(
    url: _SigningUrl,
    query_pairs: list[tuple[str, str]],
) -> _SigningUrl:
    immutable_pairs = tuple(query_pairs)
    parts = url.parts._replace(query=_encode_query_pairs(immutable_pairs))
    return _SigningUrl(
        text=parts.geturl(),
        parts=parts,
        query_pairs=immutable_pairs,
    )


def _encode_query_pairs(pairs: tuple[tuple[str, str], ...]) -> str:
    return "&".join(f"{_aws_quote(key)}={_aws_quote(value)}" for key, value in pairs)


def _aws_quote(value: str) -> str:
    return _quote_url_component(value, safe="-_.~")


def _quote_url_component(value: str, *, safe: str) -> str:
    try:
        return urllib.parse.quote(value, safe=safe)
    except UnicodeEncodeError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e


def _parse_query_pairs(query: str) -> list[tuple[str, str]]:
    if not query:
        return []

    _validate_query_pair_count(query)
    pairs: list[tuple[str, str]] = []
    for raw_pair in query.split("&"):
        if not raw_pair:
            continue
        raw_key, _separator, raw_value = raw_pair.partition("=")
        pairs.append((_unquote_query_component(raw_key), _unquote_query_component(raw_value)))
    return pairs


def _validate_query_pair_count(query: str) -> None:
    for pair_count, _match in enumerate(_RAW_QUERY_PAIR_RE.finditer(query), start=1):
        if pair_count > MAX_AWS_SIGV4_QUERY_PAIRS:
            raise AwsSigV4SigningError("AWS request has too many query parameters")


def _unquote_query_component(value: str) -> str:
    if _has_malformed_percent_encoding(value):
        raise AwsSigV4SigningError("AWS request URL is malformed")
    try:
        return urllib.parse.unquote_to_bytes(value).decode()
    except UnicodeDecodeError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e


def _has_malformed_percent_encoding(value: str) -> bool:
    index = 0
    while True:
        index = value.find("%", index)
        if index == -1:
            return False
        if (
            index + 2 >= len(value)
            or value[index + 1] not in _HEX_DIGITS
            or value[index + 2] not in _HEX_DIGITS
        ):
            return True
        index += 3


def _validate_credentials(credentials: AwsSigV4Credentials) -> None:
    if not _ACCESS_KEY_ID_RE.fullmatch(credentials.access_key_id):
        raise AwsSigV4SigningError("Invalid AWS access key ID")
    if (
        not credentials.secret_access_key
        or _has_ascii_control(credentials.secret_access_key)
        or not _is_utf8_encodable(credentials.secret_access_key)
    ):
        raise AwsSigV4SigningError("Invalid AWS secret access key")
    if credentials.session_token is not None and (
        not credentials.session_token
        or _has_ascii_control(credentials.session_token)
        or not _is_utf8_encodable(credentials.session_token)
    ):
        raise AwsSigV4SigningError("Invalid AWS session token")


def _validate_headers(headers: list[tuple[str, str]]) -> None:
    for name, value in headers:
        _utf8_encode(name, "AWS request header contains invalid text")
        _utf8_encode(value, "AWS request header contains invalid text")
        if not is_http_header_name(name) or (
            name.lower() != _CONTENT_HASH_HEADER and has_forbidden_header_value_control(value)
        ):
            raise AwsSigV4SigningError("AWS request header contains invalid text")


def _utf8_encode(value: str, message: str) -> bytes:
    try:
        return value.encode()
    except UnicodeEncodeError as e:
        raise AwsSigV4SigningError(message) from e


def _is_utf8_encodable(value: str) -> bool:
    try:
        value.encode()
    except UnicodeEncodeError:
        return False
    return True


def _has_ascii_control(value: str) -> bool:
    return any(ord(char) <= _ASCII_CONTROL_MAX or ord(char) == _ASCII_DELETE for char in value)


def _has_raw_whitespace(value: str) -> bool:
    return any(char in _RAW_WHITESPACE_CHARS for char in value)


def _unique_header_value(
    headers: list[tuple[str, str]],
    name: str,
    duplicate_message: str,
) -> str | None:
    lower_name = name.lower()
    result: str | None = None
    found = False
    for header_name, value in headers:
        if header_name.lower() == lower_name:
            if found:
                raise AwsSigV4SigningError(duplicate_message)
            found = True
            result = value
    return result


def _unique_query_value(
    pairs: tuple[tuple[str, str], ...],
    name: str,
) -> str | None:
    result: str | None = None
    found = False
    for key, value in pairs:
        if key == name:
            if found:
                raise AwsSigV4SigningError("Malformed AWS presigned query")
            found = True
            result = value
    return result


def _without_headers(
    headers: list[tuple[str, str]],
    names: set[str],
) -> list[tuple[str, str]]:
    return [(name, value) for name, value in headers if name.lower() not in names]


def _upsert_header(
    headers: list[tuple[str, str]],
    name: str,
    value: str,
) -> list[tuple[str, str]]:
    lower_name = name.lower()
    filtered = [
        (header_name, item) for header_name, item in headers if header_name.lower() != lower_name
    ]
    filtered.append((name, value))
    return filtered


def _host_header_value(url: _SigningUrl) -> str:
    parts = url.parts
    try:
        hostname = parts.hostname
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e
    if not parts.netloc or not hostname:
        raise AwsSigV4SigningError("AWS request URL must include a host")
    host = hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    try:
        port = parts.port
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL has an invalid port") from e
    if port is not None and port != _DEFAULT_PORTS.get(parts.scheme.lower()):
        host = f"{host}:{port}"
    return host
