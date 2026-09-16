"""Non-browser Gmail sending is rejected before managed auth or streaming."""

import json

import pytest

import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import _assert_no_request_stream


def _gmail_registry(tmp_path, host="gmail.googleapis.com"):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="gmail",
            api_entry={
                "base": f"https://{host}",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GMAIL_TOKEN }}"}},
                "permissions": [{"name": "messages.send", "rules": ["ANY /{path+}"]}],
            },
            network_policy={"allow": ["messages.send"], "deny": [], "unknownPolicy": "allow"},
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )


@pytest.mark.parametrize("host", ["gmail.googleapis.com", "www.googleapis.com"])
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/gmail/v1/users/me/messages/send"),
        ("POST", "/gmail/v1/users/account@example.com/drafts/send"),
        ("POST", "/upload/gmail/v1/users/me/messages/send?uploadType=media"),
        ("PUT", "/upload/gmail/v1/users/me/drafts/send?upload_id=synthetic"),
        ("POST", "/resumable/upload/gmail/v1/users/me/drafts/send"),
        ("PUT", "/resumable/upload/gmail/v1/users/me/messages/send?upload_id=synthetic"),
        ("POST", "/gmail/v1/users/me/messages/%73end"),
        ("POST", "/%67mail/v1/users/me/drafts/%2573end"),
        ("POST", "/gmail//v1/users/me/messages/send/"),
        ("GET", "/gmail/v1/users/me/messages/send"),
        ("POST", "/batch/gmail/v1"),
    ],
)
async def test_send_is_blocked_even_with_allow_grant(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, host, method, path
):
    reg_path = _gmail_registry(tmp_path, host)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=host,
        method=method,
        path=path,
    )
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)
        auth_fetch.assert_not_awaited()

    assert flow.response is not None
    assert flow.response.status_code == 403
    error = json.loads(flow.response.content)["error"]
    assert error["code"] == 403
    assert error["errors"] == [{"domain": "okou", "reason": "gmail_send_blocked"}]
    # This is also the field Gmail SDKs display to their caller.
    assert "Create a Gmail draft using the Gmail API (drafts.create)" in error["message"]
    assert "reuse or update it" in error["message"]
    assert "okou mail link <gmail-draft-id>" in error["message"]
    assert "user can review and send" in error["message"]
    assert "upload_id" not in error["message"]
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    "body_headers",
    [
        [("Content-Length", "20")],
        [("Content-Length", str(STREAM_BUFFER_LIMIT + 1))],
        [("Transfer-Encoding", "chunked")],
        [],
    ],
    ids=["buffered", "large", "chunked", "unknown-length"],
)
async def test_rejected_send_cannot_start_header_auth_or_streaming(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, body_headers
):
    reg_path = _gmail_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="gmail.googleapis.com",
        method="POST",
        path="/upload/gmail/v1/users/me/messages/send",
        request_headers=headers(("Host", "gmail.googleapis.com"), *body_headers),
    )
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        header_result = mitm_addon.requestheaders(flow)
        if header_result is not None:
            await header_result
        auth_fetch.assert_not_awaited()
        _assert_no_request_stream(flow)
        assert "Authorization" not in flow.request.headers
        await mitm_addon.request(flow)
        auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 403


async def test_browser_passthrough_precedes_send_restriction(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _gmail_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="gmail.googleapis.com",
        method="POST",
        path="/gmail/v1/users/me/messages/send",
        request_headers=headers(
            ("Host", "gmail.googleapis.com"),
            ("User-Agent", "Mozilla/5.0 Chrome/126.0.0.0"),
            ("Transfer-Encoding", "chunked"),
        ),
    )
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        header_result = mitm_addon.requestheaders(flow)
        if header_result is not None:
            await header_result
        assert callable(flow.request.stream)
        await mitm_addon.request(flow)
        auth_fetch.assert_not_awaited()
    assert flow.response is None


@pytest.mark.parametrize(
    ("method", "host", "path", "blocked"),
    [
        ("POST", "gmail.googleapis.com", "/batch", True),
        ("POST", "gmail.googleapis.com", "/gmail/v1/users/me/drafts", False),
        ("POST", "gmail.googleapis.com", "/upload/gmail/v1/users/me/drafts", False),
        ("PUT", "gmail.googleapis.com", "/resumable/upload/gmail/v1/users/me/drafts", False),
        ("GET", "gmail.googleapis.com", "/gmail/v1/users/me/messages", False),
        ("GET", "gmail.googleapis.com", "/gmail/v1/users/me/messages/x?hint=/messages/send", False),
        ("POST", "www.googleapis.com", "/batch/drive/v3", False),
        ("POST", "www.googleapis.com", "/drive/v3/files", False),
        ("POST", "gmail.googleapis.com.example.com", "/gmail/v1/users/me/messages/send", False),
        ("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/../messages/send", True),
    ],
)
async def test_restriction_is_scoped_to_gmail_send_and_batch(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, method, host, path, blocked
):
    reg_path = _gmail_registry(tmp_path, host)
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host=host, method=method, path=path
    )
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer selected-account"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)
    if blocked:
        assert flow.response is not None
        assert flow.response.status_code == 403
        auth_fetch.assert_not_awaited()
    else:
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer selected-account"
