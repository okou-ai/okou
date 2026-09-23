"""HTTP network-log target metadata helpers."""

import urllib.parse
from typing import cast

from mitmproxy import http

import flow_metadata_keys as metadata_keys

_HTTP_DEFAULT_PORT = 80
_HTTPS_DEFAULT_PORT = 443


def set_target(flow: http.HTTPFlow, *, url: str, host: str, port: int) -> None:
    """Store the caller-selected network-log identity on the flow.

    Request classification supplies the trusted pre-mutation target, while
    authority-validation failures supply their diagnostic fallback target.
    The snapshot remains independent of later changes to ``flow.request``.
    """
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": url,
        "host": host,
        "port": port,
    }


def fallback_host_port(flow: http.HTTPFlow, original_url: str) -> tuple[str, int]:
    """Return the network-log ``(host, port)`` derived from ``original_url``.

    Use the parsed hostname when present, otherwise the request's pretty host.
    Preserve an explicit port, including zero; without one, use 443 for HTTPS
    and 80 for every other scheme. If URL parsing or hostname/port access raises
    ``ValueError``, fall back to the request's pretty host and port together.
    """
    try:
        # Pinned Python 3.14 urlparse uses uncached _urlsplit, avoiding urlsplit's LRU.
        parsed_url = urllib.parse.urlparse(original_url)
        host = parsed_url.hostname or flow.request.pretty_host
        parsed_port = parsed_url.port
        port = (
            (_HTTPS_DEFAULT_PORT if parsed_url.scheme == "https" else _HTTP_DEFAULT_PORT)
            if parsed_port is None
            else parsed_port
        )
    except ValueError:
        host = flow.request.pretty_host
        port = flow.request.port
    return host, port


def set_target_from_url(flow: http.HTTPFlow, url: str) -> None:
    """Store ``url`` unchanged with its derived network-log host and port.

    A missing hostname uses the request's pretty host. An explicit port is
    preserved; otherwise HTTPS uses 443 and every other scheme uses 80. A
    parsing or hostname/port ``ValueError`` falls back to both request fields.
    This path records authority-validation diagnostic fallback targets.
    """
    host, port = fallback_host_port(flow, url)
    set_target(flow, url=url, host=host, port=port)


def target(flow: http.HTTPFlow) -> tuple[str, str, int]:
    """Return the required network-log target as ``(url, host, port)``.

    The snapshot must have been stored during request classification or
    authority validation. This intentionally has no fallback to mutable request
    state, so missing target metadata or fields propagate ``KeyError``.
    """
    typed_target = cast(
        dict[str, object],
        flow.metadata[metadata_keys.NETWORK_LOG_TARGET],
    )
    return (
        cast(str, typed_target["url"]),
        cast(str, typed_target["host"]),
        cast(int, typed_target["port"]),
    )
