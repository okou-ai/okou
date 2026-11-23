"""Correlate Data Router response IDs with Runs; never parse prices or results."""

import asyncio
import json
import uuid

from mitmproxy import http

import flow_metadata
import platform_api
import platform_http_transport as transport

OWNER = "data-router"
REQUEST_ID_HEADER = "X-Okou-Data-Request-Id"
_REQUEST_ID_HEADER_NAME = REQUEST_ID_HEADER.lower().encode("ascii")
_RESPONSE_REGISTRATION_ATTEMPTED = "_data_router_response_registration_attempted"


async def post_registration(url: str, body: bytes, sandbox_token: str) -> None:
    request = platform_api.make_api_request(url, body, sandbox_token)
    async with asyncio.timeout(transport.REQUEST_DEADLINE_SECONDS):
        response = await transport.send(request, body, transport.RequestProgress())
    if not response.ok:
        raise response.as_http_error(url)


def prepare_request(flow: http.HTTPFlow) -> None:
    """Only Router assigns billing identity; discard any sandbox-supplied header."""
    # Mapping lookup and deletion decode values that we only need to discard.
    flow.request.headers.fields = tuple(
        field
        for field in flow.request.headers.fields
        if len(field[0]) != len(_REQUEST_ID_HEADER_NAME)
        or field[0].lower() != _REQUEST_ID_HEADER_NAME
    )


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
    await post_registration(
        f"{platform_api.get_api_url()}/api/webhooks/run/data-request", body, token
    )
