"""Invalidate a linked mail preview after a confirmed Gmail drafts.update."""

import asyncio
import json
from collections.abc import Awaitable
from http import HTTPStatus
from urllib.parse import unquote

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
import platform_api
import platform_http_transport as transport
from logging_utils import log_proxy_entry

# Keep notification latency bounded even if the platform is unavailable.
_NOTIFY_TIMEOUT_SECONDS = 2
_MAX_DRAFT_ID_LENGTH = 1024


def notify_if_updated(flow: http.HTTPFlow, run_id: str) -> Awaitable[None] | None:
    if (
        flow_metadata.firewall_name(flow.metadata) != "gmail"
        or flow_metadata.firewall_permission(flow.metadata) != "drafts.write"
        or flow.request.method != "PUT"
        or flow.response is None
        or flow.response.status_code not in (HTTPStatus.OK, HTTPStatus.CREATED)
    ):
        return None
    # Initiating a resumable upload only allocates a session. Its final PUT
    # carries an upload_id and may include a Location for the saved resource.
    if (
        "location" in flow.response.headers
        and flow.request.query.get("uploadType") == "resumable"
        and "upload_id" not in flow.request.query
    ):
        return None
    params = flow.metadata.get(metadata_keys.FIREWALL_PARAMS)
    draft_id = params.get("id") if isinstance(params, dict) else None
    connection_id = flow.metadata.get(metadata_keys.FIREWALL_SOURCE_ID)
    token = flow_metadata.sandbox_auth_key(flow.metadata)
    if not (
        isinstance(draft_id, str)
        and 0 < len(draft_id) <= _MAX_DRAFT_ID_LENGTH
        and isinstance(connection_id, str)
        and token
    ):
        return None
    return _notify(
        run_id, connection_id, unquote(draft_id), token, flow_metadata.proxy_log_path(flow.metadata)
    )


async def _notify(
    run_id: str, connection_id: str, draft_id: str, token: str, log_path: str
) -> None:
    body = json.dumps(
        {"runId": run_id, "connectionId": connection_id, "gmailDraftId": draft_id}
    ).encode()
    try:
        url = f"{platform_api.get_api_url()}/api/webhooks/run/gmail-draft-updated"
        request = platform_api.make_api_request(url, body, token)
        async with asyncio.timeout(_NOTIFY_TIMEOUT_SECONDS):
            response = await transport.send(request, body, transport.RequestProgress())
        if not response.ok:
            log_proxy_entry(
                log_path, "warn", "Gmail draft notification rejected", status=response.status
            )
    except Exception as error:
        # Gmail has already saved the edit. A failed notification must not turn
        # its receipt into a failed write or cause the client to repeat it.
        log_proxy_entry(
            log_path, "warn", "Gmail draft notification unavailable", error=type(error).__name__
        )
