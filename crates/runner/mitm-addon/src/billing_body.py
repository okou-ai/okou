"""Request body decoding policy for connector billing inspection."""

import zlib

from mitmproxy import http

import content_encoding
from body_limits import REQUEST_BODY_BILLING_INSPECTION_LIMIT
from zlib_decoding import decode_zlib_bounded


def _decode_gzip_request_body_for_billing(data: bytes, max_output: int) -> bytes | None:
    """Decode every gzip member under one output cap."""
    if not data or max_output < 0:
        return None
    result = decode_zlib_bounded(
        data,
        wbits=16 + zlib.MAX_WBITS,
        max_output=max_output,
    )
    return result.body if result.status == "complete" else None


def _decode_deflate_request_body_for_billing(data: bytes, max_output: int) -> bytes | None:
    """Decode one zlib-wrapped or raw deflate stream under one output cap."""
    if not data or max_output < 0:
        return None
    for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
        result = decode_zlib_bounded(
            data,
            wbits=wbits,
            max_output=max_output,
            max_members=1,
        )
        if result.status == "complete":
            return result.body
        if result.status == "output_limit_exceeded":
            return None
    return None


def decode_request_body_for_billing(
    raw_content: bytes | None,
    headers: http.Headers,
    *,
    max_raw: int = REQUEST_BODY_BILLING_INSPECTION_LIMIT,
    max_decoded: int = REQUEST_BODY_BILLING_INSPECTION_LIMIT,
) -> bytes | None:
    """Decode a request body for conservative billing inspection.

    Unlike response capture helpers, billing must fail closed: unsupported,
    invalid, incomplete, or oversized encoded bodies and exhausted encoding
    header budgets are treated as uninspectable rather than falling back to raw
    bytes. Complete gzip member sequences share one decoded-output budget;
    deflate accepts one zlib-wrapped or raw stream.
    """
    if not raw_content:
        return None
    if len(raw_content) > max_raw:
        return None

    encoding = content_encoding.read_folded(headers)
    if encoding is None:
        return None
    if not encoding or encoding == "identity":
        return raw_content if len(raw_content) <= max_decoded else None
    if encoding == "gzip":
        return _decode_gzip_request_body_for_billing(raw_content, max_decoded)
    if encoding == "deflate":
        return _decode_deflate_request_body_for_billing(raw_content, max_decoded)
    return None
