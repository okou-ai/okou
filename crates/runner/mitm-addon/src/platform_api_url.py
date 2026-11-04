"""Configured platform HTTP URL parsing and normalization."""

import urllib.parse
from dataclasses import dataclass
from typing import Literal

from authority_utils import authority_has_empty_port, format_url_host
from host_normalization import normalize_hostname


@dataclass(frozen=True)
class PlatformApiUrl:
    """Canonical request URL and normalized origin for the platform API."""

    canonical_url: str
    scheme: Literal["http", "https"]
    host: str
    port: int


def parse_explicit_port(parsed_url: urllib.parse.SplitResult, *, subject: str) -> int | None:
    """Read an explicit configured-URL port with a caller-owned diagnostic label."""
    if authority_has_empty_port(parsed_url.netloc):
        raise ValueError(f"{subject} has an invalid port")
    try:
        return parsed_url.port
    except ValueError as exc:
        raise ValueError(f"{subject} has an invalid port") from exc


def split_url_without_value_diagnostics(
    value: str,
    *,
    subject: str,
) -> urllib.parse.SplitResult:
    """Split a configured URL with a caller-owned diagnostic label."""
    try:
        return urllib.parse.urlsplit(value)
    except ValueError:
        raise ValueError(f"{subject} is invalid") from None


def parse_platform_api_url(url: str) -> PlatformApiUrl:
    """Parse one platform API URL into its canonical URL and effective origin."""
    parsed_url = split_url_without_value_diagnostics(url, subject="Platform API URL")
    scheme = parsed_url.scheme.lower()
    if scheme == "http":
        default_port = 80
    elif scheme == "https":
        default_port = 443
    else:
        raise ValueError("Platform API URL must be an absolute http(s) URL")
    if not parsed_url.netloc or parsed_url.hostname is None:
        raise ValueError("Platform API URL must be an absolute http(s) URL")
    if parsed_url.username is not None or parsed_url.password is not None:
        raise ValueError("Platform API URL must not contain user information")

    explicit_port = parse_explicit_port(parsed_url, subject="Platform API URL")
    host = normalize_hostname(parsed_url.hostname)
    authority = format_url_host(host)
    if explicit_port is not None:
        authority = f"{authority}:{explicit_port}"
    canonical_url = urllib.parse.urlunsplit(
        (scheme, authority, parsed_url.path, parsed_url.query, parsed_url.fragment)
    )
    return PlatformApiUrl(
        canonical_url=canonical_url,
        scheme=scheme,
        host=host,
        port=explicit_port if explicit_port is not None else default_port,
    )
