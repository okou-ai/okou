"""Method overrides must not escape the permission for the wire method."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from body_limits import STREAM_BUFFER_LIMIT
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import _assert_no_request_stream, await_requestheaders_result


@pytest.mark.parametrize("capture_bodies", [False, True])
@pytest.mark.parametrize(
    "override_headers",
    [
        [("X-HTTP-Method-Override", "DELETE")],
        [("x-http-method-override", "PATCH")],
        [("X-hTtP-mEtHoD-oVeRrIdE", "GET")],
        [("X-HTTP-Method-Override", "")],
        [("X-HTTP-Method-Override", "POST"), ("x-http-method-override", "DELETE")],
    ],
    ids=["delete", "lowercase", "mixed-case", "empty", "duplicate"],
)
@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.MAILCHIMP_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
        {"base": "${{ secrets.WEBHOOK_URL }}"},
    ],
    ids=["headers", "query", "aws-sigv4", "auth-base"],
)
async def test_override_cannot_delete_an_audience_with_only_member_write_permission(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    capture_bodies,
    override_headers,
    auth_config,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="mailchimp",
            api_entry={
                "base": "https://us6.api.mailchimp.com/3.0",
                "auth": auth_config,
                "permissions": [
                    {"name": "members.write", "rules": ["POST /lists/{list_id}"]},
                    {"name": "audiences.delete", "rules": ["DELETE /lists/{list_id}"]},
                ],
            },
            network_policy={
                "allow": ["members.write"],
                "deny": ["audiences.delete"],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": capture_bodies},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="us6.api.mailchimp.com",
        method="POST",
        path="/3.0/lists/audience-id",
        request_headers=headers(
            ("Host", "us6.api.mailchimp.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
            *override_headers,
        ),
    )
    original_headers = tuple(flow.request.headers.fields)
    original_url = flow.request.url

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
        fake_forwarder_upstream() as upstream,
    ):
        result = mitm_addon.requestheaders(flow)
        if "headers" in auth_config or "query" in auth_config:
            await await_requestheaders_result(result)
        else:
            assert result is None
        auth_fetch.assert_not_called()
        _assert_no_request_stream(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert upstream.resolve_calls == []
    assert upstream.connect_calls == []
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_auth_method_override"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.url == original_url
    assert json.loads(flow.response.content) == {
        "error": "unsafe_auth_method_override",
        "message": "Use the actual HTTP method instead of X-HTTP-Method-Override",
        "permission": "mailchimp",
        "base": "https://us6.api.mailchimp.com/3.0",
    }
    [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert entry["level"] == "warn"
    assert entry["type"] == "firewall"
    assert "DELETE" not in json.dumps(entry)


@pytest.mark.parametrize("managed_auth", [False, True])
async def test_ordinary_method_and_unmanaged_override_preserve_existing_behavior(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, managed_auth
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.example.com",
                "auth": (
                    {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}}
                    if managed_auth
                    else {}
                ),
                "permissions": [{"name": "write", "rules": ["POST /items"]}],
            },
            network_policy={"allow": ["write"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )
    request_headers = headers(("Host", "api.example.com"))
    if not managed_auth:
        request_headers["X-HTTP-Method-Override"] = "DELETE"
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.example.com",
        method="POST",
        path="/items",
        request_headers=request_headers,
    )
    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    if managed_auth:
        auth_fetch.assert_awaited_once()
        assert flow.request.headers["Authorization"] == "Bearer resolved"
    else:
        auth_fetch.assert_not_called()
        assert "Authorization" not in flow.request.headers
        assert flow.request.headers["X-HTTP-Method-Override"] == "DELETE"
