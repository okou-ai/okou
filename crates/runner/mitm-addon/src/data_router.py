"""Correlate Data Router response IDs with Runs; never parse prices or results."""

import json
import uuid

from mitmproxy import http

import firewall_auth_client
import flow_metadata
import platform_api

OWNER = "data-router"
REQUEST_ID_HEADER = "X-Okou-Data-Request-Id"
_RESPONSE_REGISTRATION_ATTEMPTED = "_data_router_response_registration_attempted"


def prepare_request(flow: http.HTTPFlow) -> None:
    """Only Router assigns billing identity; discard any sandbox-supplied header."""
    flow.request.headers.pop(REQUEST_ID_HEADER, None)


async def register_response(flow: http.HTTPFlow) -> None:
    """Attempt registration once before response/error releases Run drain tracking.

    Router emits the header for executed tools, including failed executions.
    Control traffic and free billing/pricing reads have no execution identity.
    """
    if flow.metadata.get(_RESPONSE_REGISTRATION_ATTEMPTED) or flow.response is None:
        return
    request_id = flow.response.headers.get(REQUEST_ID_HEADER)
    if request_id is None:
        return
    request_id = str(uuid.UUID(request_id))
    run_id = flow_metadata.run_id(flow.metadata)
    token = flow_metadata.sandbox_auth_key(flow.metadata)
    if not run_id or not token:
        raise ValueError("Data Router requires a registered Run")
    # Keep the claim even on failure: another terminal hook must not retry an
    # uncertain platform write.
    flow.metadata[_RESPONSE_REGISTRATION_ATTEMPTED] = True
    body = json.dumps({"runId": run_id, "requestId": request_id}).encode()
    await firewall_auth_client.post_platform_json(
        f"{platform_api.get_api_url()}/api/webhooks/agent/data-request", body, token
    )
