"""Correlate Data Router tool calls before upstream execution; never parse prices."""

import json
import uuid

from mitmproxy import http

import firewall_auth_client
import flow_metadata
import platform_api

OWNER = "data-router"
REQUEST_ID_HEADER = "X-Okou-Data-Request-Id"


async def register_request(flow: http.HTTPFlow) -> None:
    """Register every tool call independently of the credential cache.

    MCP control traffic and the free billing lookup do not start executions.
    The caller owns final authorization revalidation after this asynchronous step.
    """
    # Never let a sandbox choose another request's billing identity.
    flow.request.headers.pop(REQUEST_ID_HEADER, None)
    if flow.request.method != "POST":
        return
    try:
        payload = json.loads(flow.request.content or b"")
    except UnicodeDecodeError, json.JSONDecodeError:
        return
    if not isinstance(payload, dict) or payload.get("method") != "tools/call":
        return
    params = payload.get("params")
    if not isinstance(params, dict) or params.get("name") == "billing_get":
        return
    run_id = flow_metadata.run_id(flow.metadata)
    token = flow_metadata.sandbox_auth_key(flow.metadata)
    if not run_id or not token:
        raise ValueError("Data Router requires a registered Run")
    request_id = str(uuid.uuid4())
    body = json.dumps({"runId": run_id, "requestId": request_id}).encode()
    await firewall_auth_client.post_platform_json(
        f"{platform_api.get_api_url()}/api/webhooks/agent/data-request", body, token
    )
    flow.request.headers[REQUEST_ID_HEADER] = request_id
