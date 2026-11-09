"""Read-only RFC 6455 request recognition and response confirmation.

Callers supply their existing raw-header work budget and retain auth, encoding,
usage activation and flow/stream custody. Request recognition strictly validates
Base64 key bytes; confirmation consumes the exact request marker and preserves
its separate ASCII-key/accept-token policy. Inspection never mutates traffic or
metadata and does not authorize credentials.
"""

import base64
import binascii

from mitmproxy import http
from wsproto.utilities import generate_accept_token

import flow_metadata_keys as metadata_keys
import http_header_syntax

_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_WEBSOCKET_KEY_BYTES = 16
_WEBSOCKET_KEY_BASE64_BYTES = 24
_WEBSOCKET_ACCEPT_BASE64_BYTES = 28


def is_websocket_upgrade_request(
    flow: http.HTTPFlow,
    *,
    websocket_header_work_limit: int,
) -> bool:
    if flow.request.method.upper() != "GET":
        return False
    if flow.request.http_version != "HTTP/1.1":
        return False
    if not http_header_syntax.header_fields_contain_token(
        flow.request.headers.fields,
        b"upgrade",
        b"websocket",
        max_work_units=websocket_header_work_limit,
    ):
        return False
    websocket_key = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"sec-websocket-key",
        max_fields=websocket_header_work_limit,
        max_value_bytes=websocket_header_work_limit,
    )
    if websocket_key is None or not _is_valid_websocket_key(websocket_key):
        return False
    websocket_version = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"sec-websocket-version",
        max_fields=websocket_header_work_limit,
        max_value_bytes=websocket_header_work_limit,
    )
    if websocket_version != b"13":
        return False

    return http_header_syntax.header_fields_contain_token(
        flow.request.headers.fields,
        b"connection",
        b"upgrade",
        max_work_units=websocket_header_work_limit,
    )


def _is_valid_websocket_key(value: bytes) -> bool:
    if len(value) != _WEBSOCKET_KEY_BASE64_BYTES:
        return False
    try:
        decoded = base64.b64decode(value, validate=True)
    except binascii.Error:
        return False
    return len(decoded) == _WEBSOCKET_KEY_BYTES


def is_confirmed_websocket_upgrade_response(
    flow: http.HTTPFlow,
    *,
    websocket_header_work_limit: int,
) -> bool:
    """Return whether ``flow`` completed a confirmed WebSocket upgrade.

    Confirmation requires a response with status 101, the exact ``True``
    value for ``WEBSOCKET_UPGRADE_REQUEST``, response ``Upgrade`` and
    ``Connection`` field values containing the ``websocket`` and ``upgrade``
    list tokens, singleton request ``Sec-WebSocket-Key`` and response
    ``Sec-WebSocket-Accept`` fields, an ASCII request key, and a matching
    RFC-generated accept token. Missing or malformed values fail closed and
    return ``False``.

    For a billable OpenAI Responses model-provider flow, ``True`` is the
    signal for WebSocket usage activation and allows tracked-flow release to
    wait for ``websocket_end()``; ``False`` follows ordinary HTTP terminal
    handling.
    """
    response = flow.response
    if response is None:
        return False
    if response.status_code != _HTTP_STATUS_SWITCHING_PROTOCOLS:
        return False
    if flow.metadata.get(metadata_keys.WEBSOCKET_UPGRADE_REQUEST) is not True:
        return False
    if not http_header_syntax.header_fields_contain_token(
        response.headers.fields,
        b"upgrade",
        b"websocket",
        max_work_units=websocket_header_work_limit,
    ):
        return False
    if not http_header_syntax.header_fields_contain_token(
        response.headers.fields,
        b"connection",
        b"upgrade",
        max_work_units=websocket_header_work_limit,
    ):
        return False

    request_key = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"sec-websocket-key",
        max_fields=websocket_header_work_limit,
        max_value_bytes=websocket_header_work_limit,
    )
    response_accept = http_header_syntax.single_header_value(
        response.headers.fields,
        b"sec-websocket-accept",
        max_fields=websocket_header_work_limit,
        max_value_bytes=websocket_header_work_limit,
    )
    if (
        request_key is None
        or len(request_key) != _WEBSOCKET_KEY_BASE64_BYTES
        or not request_key.isascii()
        or response_accept is None
        or len(response_accept) != _WEBSOCKET_ACCEPT_BASE64_BYTES
    ):
        return False
    expected_accept = generate_accept_token(request_key)
    return response_accept == expected_accept
