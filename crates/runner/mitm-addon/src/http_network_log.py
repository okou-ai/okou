"""HTTP network-log targets, row projection and observed byte sizes."""

import urllib.parse
from typing import cast

from mitmproxy import http

import codex_model_catalog_cache
import content_length
import flow_metadata
import flow_metadata_keys as metadata_keys
import request_streaming
import response_streaming
import upstream_admission
from logging_utils import NETWORK_LOG_MAX_SAFE_SIZE, add_firewall_metadata

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


def build_entry(
    flow: http.HTTPFlow,
    *,
    action: str,
    status_code: int,
    latency_ms: int,
    request_size: int,
    response_size: int,
) -> tuple[dict, str]:
    url, host, port = target(flow)
    entry = {
        "type": "http",
        "action": action,
        "host": host,
        "port": port,
        "method": flow.request.method,
        "status": status_code,
        "latency_ms": latency_ms,
        "request_size": request_size,
        "response_size": response_size,
    }
    firewall_error = flow_metadata.firewall_error(flow.metadata)
    if firewall_error is not None:
        entry["firewall_error"] = firewall_error
    connector_route_reason = flow_metadata.connector_route_reason(flow.metadata)
    if connector_route_reason is not None:
        entry["connector_route_reason"] = connector_route_reason
    connector_route_candidates = flow_metadata.connector_route_candidates(flow.metadata)
    if connector_route_candidates:
        entry["connector_route_candidates"] = connector_route_candidates
    entry.update(upstream_admission.upstream_binding_log_fields(flow))
    if flow.metadata.get(metadata_keys.BROWSER_USER_AGENT):
        entry["browser_user_agent"] = True
    if flow_metadata.firewall_base(flow.metadata):
        add_firewall_metadata(flow, entry)
    codex_model_catalog_cache.add_network_log_fields(flow, entry)
    return entry, url


def response_size(flow: http.HTTPFlow) -> int:
    if flow.response is None:
        return 0

    streamed_size = response_streaming.streamed_response_size(flow)
    if streamed_size is not None:
        return streamed_size

    parsed_content_length = content_length.parse(
        flow.response.headers.get_all("Content-Length"),
        max_value=NETWORK_LOG_MAX_SAFE_SIZE,
    )
    if parsed_content_length.kind != "valid":
        return 0
    return parsed_content_length.value


def request_size(flow: http.HTTPFlow) -> int:
    streamed_size = request_streaming.streamed_request_size(flow)
    if streamed_size is not None:
        return streamed_size
    return len(flow.request.raw_content or b"")
