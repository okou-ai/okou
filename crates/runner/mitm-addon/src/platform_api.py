"""Shared platform API request and redirect-policy helpers for the mitmproxy addon."""

import os
import urllib.parse
import urllib.request
import uuid

from mitmproxy import ctx, http

import platform_api_url
from authority_utils import authority_has_empty_port, format_url_host
from host_normalization import normalize_hostname

# Vercel bypass secret (still from environment as it's a secret)
VERCEL_BYPASS = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
_VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass"
CLIENT_VERSION_HEADER = "X-Client-Version"
CLIENT_TYPE_HEADER = "X-Client-Type"
CLIENT_SESSION_ID_HEADER = "X-Client-Session-Id"
CLIENT_REQUEST_ID_HEADER = "X-Client-Request-Id"
CLIENT_TYPE_MITM_ADDON = "MitmAddon"
_CLIENT_HEADERS = ("", "")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Reject redirects from credential-bearing platform API requests."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def _parsed_port(parsed_url: urllib.parse.SplitResult, *, subject: str) -> int | None:
    if authority_has_empty_port(parsed_url.netloc):
        raise ValueError(f"{subject} has an invalid port")
    try:
        return parsed_url.port
    except ValueError as exc:
        raise ValueError(f"{subject} has an invalid port") from exc


def _split_url_without_value_diagnostics(
    value: str,
    *,
    subject: str,
) -> urllib.parse.SplitResult:
    try:
        return urllib.parse.urlsplit(value)
    except ValueError:
        raise ValueError(f"{subject} is invalid") from None


def normalize_proxy_url(proxy_url: str) -> str:
    """Canonicalize the hostname in a URL or authority-form proxy setting."""
    has_scheme = "://" in proxy_url
    has_authority_prefix = proxy_url.startswith("//")
    parsed_url = _split_url_without_value_diagnostics(
        proxy_url if has_scheme or has_authority_prefix else f"//{proxy_url}",
        subject="Proxy URL",
    )
    if not parsed_url.netloc or parsed_url.hostname is None:
        raise ValueError("Proxy URL must include a host")

    port = _parsed_port(parsed_url, subject="Proxy URL")
    authority = format_url_host(normalize_hostname(parsed_url.hostname))
    if port is not None:
        authority = f"{authority}:{port}"
    userinfo, separator, _host = parsed_url.netloc.rpartition("@")
    if separator:
        authority = f"{userinfo}@{authority}"

    normalized_url = urllib.parse.urlunsplit(
        (parsed_url.scheme, authority, parsed_url.path, parsed_url.query, parsed_url.fragment)
    )
    if has_scheme or has_authority_prefix:
        return normalized_url
    return normalized_url.removeprefix("//")


class _CanonicalProxyHandler(urllib.request.ProxyHandler):
    """Apply the platform hostname identity policy to the proxy selected by urllib."""

    def proxy_open(
        self,
        req: urllib.request.Request,
        proxy: str,
        request_type: str,
    ) -> object | None:
        return super().proxy_open(req, normalize_proxy_url(proxy), request_type)


def build_api_opener() -> urllib.request.OpenerDirector:
    """Build an opener that returns redirects as HTTP errors."""
    return urllib.request.build_opener(_CanonicalProxyHandler(), _NoRedirect)


def configure_client_headers(*, client_session_id: str, client_version: str) -> None:
    """Snapshot runner-provided client header values for platform API requests."""
    global _CLIENT_HEADERS
    _CLIENT_HEADERS = (client_session_id, client_version)


def add_vercel_bypass_header(headers: http.Headers) -> None:
    """Add the runner-owned preview bypass to an admitted platform API request."""
    if VERCEL_BYPASS:
        headers[_VERCEL_BYPASS_HEADER] = VERCEL_BYPASS


def get_api_url() -> str:
    """Get API URL from mitmproxy options."""
    return ctx.options.okou_api_url


def make_api_request(url: str, data: bytes, bearer_credential: str) -> urllib.request.Request:
    """Build a Request with standard platform API headers.

    Centralises User-Agent, Authorization, Content-Type, and the optional
    Vercel bypass header so that callers cannot accidentally omit them. The
    credentials are unredirected as defense in depth; callers must still reject
    redirects, using :func:`build_api_opener` or an equivalent transport policy,
    before contacting another URL.
    """
    parsed_url = platform_api_url.parse_platform_api_url(url)
    client_session_id, client_version = _CLIENT_HEADERS

    # S310 (suspicious-url-open-usage): callers build `url` from the
    # operator-configured platform API URL, and the scheme is validated above
    # before urllib can consume the request.
    req = urllib.request.Request(  # noqa: S310
        parsed_url.canonical_url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "vm0-mitm-addon/1.0",
            CLIENT_VERSION_HEADER: client_version,
            CLIENT_TYPE_HEADER: CLIENT_TYPE_MITM_ADDON,
            CLIENT_SESSION_ID_HEADER: client_session_id,
            CLIENT_REQUEST_ID_HEADER: str(uuid.uuid4()),
        },
    )
    req.add_unredirected_header("Authorization", f"Bearer {bearer_credential}")
    if VERCEL_BYPASS:
        req.add_unredirected_header(_VERCEL_BYPASS_HEADER, VERCEL_BYPASS)
    return req
