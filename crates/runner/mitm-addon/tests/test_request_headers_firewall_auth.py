"""Stream-safe requestheaders firewall-auth and fallback tests."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import auth
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
import upstream_destination_binding
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import (
    _shared_route_sandbox,
    _single_firewall_sandbox,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.requestheaders_helpers import (
    _assert_no_request_stream,
    await_requestheaders_result,
)


@pytest.mark.parametrize(
    "request_header_pairs",
    [
        [("Content-Length", str(STREAM_BUFFER_LIMIT + 1))],
        [("Transfer-Encoding", "chunked")],
        [],
    ],
    ids=["large-content-length", "chunked", "unknown-length"],
)
async def test_capture_enabled_firewall_allow_header_auth_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, request_header_pairs
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), *request_header_pairs),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
        assert flow.request.headers["Authorization"] == "Bearer resolved"
        assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
        assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True


@pytest.mark.parametrize("request_method", ["trace", "track"])
@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
        {"query": {"api_key": "${{ secrets.API_TOKEN }}"}},
    ],
    ids=["headers", "query"],
)
async def test_capture_enabled_reflection_method_with_managed_auth_defers_to_request_block(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    auth_config,
    request_method,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method=request_method,
        path="/diagnostic?client=visible",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("X-Client-Header", "visible"),
        ),
    )
    original_headers = tuple(flow.request.headers.fields)
    original_path = flow.request.path

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        auth_fetch.assert_not_called()
        _assert_no_request_stream(flow)
        assert tuple(flow.request.headers.fields) == original_headers
        assert flow.request.path == original_path

        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_auth_method"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.path == original_path


async def test_firewall_allow_header_auth_requestheaders_strips_connector_intent(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("X-Okou-Connector-Intent", "github"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert callable(flow.request.stream)
        assert flow.request.headers["Authorization"] == "Bearer resolved"
        assert "X-Okou-Connector-Intent" not in flow.request.headers

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] is True


@pytest.mark.parametrize("reverse", [False, True])
async def test_shared_route_intent_selects_requestheaders_auth_in_both_orders(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, reverse
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_shared_route_sandbox(tmp_path, reverse=reverse),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        method="GET",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("X-Okou-Connector-Intent", "primary"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved-primary"}) as auth_fetch,
    ):
        result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(result)

        assert callable(flow.request.stream)
        assert flow.request.headers["Authorization"] == "Bearer resolved-primary"
        assert "X-Okou-Connector-Intent" not in flow.request.headers
        assert flow.metadata[metadata_keys.FIREWALL_NAME] == "primary"
        assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "items-read"

        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    auth_request = auth_fetch.await_args.args[1]
    assert auth_request.auth_headers == {"Authorization": "Bearer ${{ secrets.PRIMARY_TOKEN }}"}
    assert flow.response is None


async def test_ambiguous_shared_route_requestheaders_never_fetches_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_registry(tmp_path, sandbox_info=_shared_route_sandbox(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        method="GET",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        result = mitm_addon.requestheaders(flow)
        assert result is None

        _assert_no_request_stream(flow)
        assert flow.response is None
        auth_fetch.assert_not_awaited()

        await mitm_addon.request(flow)

    auth_fetch.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 409
    assert "Authorization" not in flow.request.headers


def test_capture_enabled_firewall_allow_small_bounded_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(("Host", "api.github.com"), ("Content-Length", "4")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None

    auth_fetch.assert_not_called()
    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata


@pytest.mark.parametrize(
    "auth_error",
    [
        auth_client.ConnectorNotConfiguredError("not linked"),
        RuntimeError("auth backend unavailable"),
    ],
    ids=["connector-not-configured", "generic-auth-error"],
)
async def test_firewall_allow_header_auth_failure_falls_back_to_request_hook(
    tmp_path, real_flow, mitm_ctx, headers, auth_error
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    get_headers = AsyncMock(side_effect=auth_error)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        _assert_no_request_stream(flow)
        assert flow.response is None
        assert metadata_keys.FIREWALL_BASE not in flow.metadata

        await mitm_addon.request(flow)

    assert get_headers.await_count == 1
    assert flow.response is not None
    expected_status = (
        424 if isinstance(auth_error, auth_client.ConnectorNotConfiguredError) else 502
    )
    assert flow.response.status_code == expected_status
    expected_error = (
        "connector_not_configured"
        if isinstance(auth_error, auth_client.ConnectorNotConfiguredError)
        else "auth_failed"
    )
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_error
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()


async def test_firewall_allow_header_auth_cancellation_restores_probe_state(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("X-Client", "original"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    get_headers = AsyncMock(side_effect=asyncio.CancelledError)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        with pytest.raises(asyncio.CancelledError):
            await await_requestheaders_result(requestheaders_result)

    get_headers.assert_awaited_once()
    _assert_no_request_stream(flow)
    assert flow.request.headers["X-Client"] == "original"
    assert "Authorization" not in flow.request.headers
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()


@pytest.mark.parametrize(
    "auth_config",
    [
        {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
        {
            "awsSigv4": {
                "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
                "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            }
        },
    ],
    ids=["auth-base", "aws-sigv4"],
)
async def test_capture_enabled_body_dependent_firewall_auth_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers, auth_config
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": auth_config,
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    get_headers = AsyncMock()
    admission_key = (
        metadata_keys.AUTH_BASE_FORWARD_ADMISSION
        if "base" in auth_config
        else metadata_keys.AWS_SIGV4_BODY_ADMISSION
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        assert requestheaders_result is None
        assert admission_key in flow.metadata
        mitm_addon.error(flow)

    get_headers.assert_not_called()
    _assert_no_request_stream(flow)
    assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.SANDBOX_RUN_ID in flow.metadata
    assert metadata_keys.ORIGINAL_URL in flow.metadata


def test_capture_enabled_firewall_block_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": [],
                "deny": ["full-access"],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/octocat/hello",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata


def test_auth_base_requestheaders_rejection_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": True},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", "placeholder.example.com"),
            ("Content-Length", str(auth.MAX_AUTH_BASE_REQUEST_BODY_BYTES + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert flow.live is False
    assert flow.error is not None
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
