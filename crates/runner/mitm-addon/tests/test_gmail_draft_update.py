"""Provider receipts invalidate a preview while the writing Run is active."""

from uuid import uuid4

import pytest
from mitmproxy import http

import mitm_addon
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


@pytest.mark.parametrize(
    ("prefix", "method", "path", "status", "headers", "notify_status"),
    [
        ("gmail", "PUT", "/drafts/r-first", 200, {}, 204),
        ("upload/gmail", "PUT", "/drafts/r-first?uploadType=multipart", 200, {}, 404),
        (
            "resumable/upload/gmail",
            "PUT",
            "/drafts/r-first?uploadType=resumable&upload_id=done",
            201,
            {"Location": "/drafts/r-first"},
            204,
        ),
        (
            "upload/gmail",
            "PUT",
            "/drafts/r-first?uploadType=resumable",
            200,
            {"Location": "/session"},
            None,
        ),
        ("upload/gmail", "PUT", "/drafts/r-first?upload_id=partial", 308, {}, None),
        ("gmail", "PUT", "/drafts/r-first", 403, {}, None),
        ("gmail", "POST", "/drafts", 200, {}, None),
        ("gmail", "DELETE", "/drafts/r-first", 204, {}, None),
    ],
)
async def test_gmail_draft_write_receipts(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
    prefix,
    method,
    path,
    status,
    headers,
    notify_status,
):
    run_id = str(uuid4())
    connection_id = str(uuid4())
    host = "gmail.googleapis.com"
    registry = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=run_id,
            source_id=connection_id,
            firewall_name="gmail",
            api_entry={
                "base": f"https://{host}/{prefix}",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GMAIL_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "drafts.write",
                        "rules": [
                            "PUT /v1/users/{userId}/drafts/{id}",
                            "DELETE /v1/users/{userId}/drafts/{id}",
                            "POST /v1/users/{userId}/drafts",
                        ],
                    }
                ],
            },
            network_policy={
                "allow": ["drafts.write"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    with (
        mitm_ctx(registry_path=str(registry), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(),
    ):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host=host,
            method=method,
            path=f"/{prefix}/v1/users/me{path}",
        )
        await mitm_addon.request(flow)
        assert flow.response is None
        if notify_status is not None:
            usage_webhook_server.queue_response(notify_status)
        receipt = http.Response.make(status, b'{"id":"r-first"}', headers)
        flow.response = receipt
        completion = mitm_addon.response(flow)
        if completion is not None:
            await completion
        # Even an older platform that rejects this hint cannot change Gmail's result.
        assert flow.response is receipt

    if notify_status is None:
        assert usage_webhook_server.request_count == 0
    else:
        (request,) = usage_webhook_server.requests
        assert request.path == "/api/webhooks/run/gmail-draft-updated"
        assert request.header("authorization") == "Bearer tok-conn"
        assert request.json_body() == {
            "runId": run_id,
            "connectionId": connection_id,
            "gmailDraftId": "r-first",
        }
