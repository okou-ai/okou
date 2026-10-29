"""Outlook sends require the review action; unrelated Graph reads keep working."""

import json

import pytest

import mitm_addon
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import _assert_no_request_stream


def _outlook_registry(tmp_path, firewall_name="outlook-mail", custom_connector_id=None):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=firewall_name,
            custom_connector_id=custom_connector_id,
            api_entry={
                "base": "https://graph.microsoft.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OUTLOOK_MAIL_TOKEN }}"}},
                "permissions": [{"name": "mail.send", "rules": ["ANY /{path+}"]}],
            },
            network_policy={"allow": ["mail.send"], "deny": [], "unknownPolicy": "allow"},
        ),
    )


@pytest.mark.parametrize(
    "path",
    [
        "/v1.0/me/sendMail",
        "/beta/users/user@example.com/sendMail",
        "/v1.0/me/messages/message-id/send",
        "/v1.0/me/messages/message-id/reply",
        "/v1.0/me/messages/message-id/replyAll",
        "/v1.0/users/user-id/mailFolders/folder-id/messages/message-id/forward",
        "/v1.0/me/messages/message-id/%2573end",
        "/v1.0/me/messages/message-id/../message-id/send",
        "/v1.0/$batch",
        "/v1.0/me/messages('message-id')/microsoft.graph.reply",
        "/v1.0/users('user@example.com')/sendMail",
        "/v1.0/me/microsoft.graph.user/sendMail",
    ],
)
@pytest.mark.parametrize("headers_only", [False, True])
async def test_mail_send_rejected_before_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, path, headers_only
):
    registry = _outlook_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="graph.microsoft.com",
        method="POST",
        path=path,
    )
    flow.request.headers["X-Okou-Connector-Intent"] = "outlook-mail"
    if headers_only:
        flow.request.headers["Transfer-Encoding"] = "chunked"
    with (
        mitm_ctx(registry_path=str(registry), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        if headers_only:
            header_result = mitm_addon.requestheaders(flow)
            if header_result is not None:
                await header_result
            _assert_no_request_stream(flow)
        await mitm_addon.request(flow)
        auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 403
    error = json.loads(flow.response.content)["error"]
    assert error["code"] == "outlook_send_blocked"
    assert "okou mail link <outlook-message-id> --provider outlook" in error["message"]
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/v1.0/me/messages"),
        ("POST", "/v1.0/me/messages"),
        ("PATCH", "/v1.0/me/messages/draft-id"),
        ("POST", "/v1.0/me/messages/original-id/createReply"),
        ("POST", "/v1.0/me/messages/draft-id/attachments"),
        ("POST", "/v1.0/me/drive/root/children"),
        ("GET", "/v1.0/me/drive/root:/messages/forward"),
        ("GET", "/v1.0/me/drive/root:/sendMail"),
        ("GET", "/v1.0/me/messages/message-id/attachments/reply"),
        ("GET", "/v1.0/me/microsoft.graph.user"),
    ],
)
async def test_draft_and_unrelated_graph_operations_remain_available(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, method, path
):
    registry = _outlook_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="graph.microsoft.com",
        method=method,
        path=path,
    )
    with (
        mitm_ctx(registry_path=str(registry), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)
    assert flow.response is None


@pytest.mark.parametrize("explicit_intent", [False, True])
async def test_non_mail_connector_keeps_graph_batch(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, explicit_intent
):
    registry = _outlook_registry(tmp_path, firewall_name="microsoft-365")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="graph.microsoft.com",
        method="POST",
        path="/v1.0/$batch",
    )
    if explicit_intent:
        flow.request.headers["X-Okou-Connector-Intent"] = "microsoft-365"
    with (
        mitm_ctx(registry_path=str(registry), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)
    assert flow.response is None


async def test_custom_graph_connection_cannot_bypass_review_with_a_non_mail_display_name(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry = _outlook_registry(
        tmp_path,
        firewall_name="microsoft-365",
        custom_connector_id="00000000-0000-4000-8000-000000000411",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="graph.microsoft.com",
        method="POST",
        path="/v1.0/$batch",
    )
    with (
        mitm_ctx(registry_path=str(registry), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)
        auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 403
