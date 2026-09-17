"""Billable usage tracking lifecycle tests for the request hook."""

import asyncio
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Never
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import auth
import flow_metadata_keys as metadata_keys
import mitm_addon
import terminal_usage
import usage
from tests.auth_base_forwarder_helpers import fake_forwarder_upstream
from tests.firewall_auth_helpers import firewall_auth_response
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result

_X_FIREWALL_NAME = "x"
_X_TRACKING_PATH = "/2/users/by"
_DEFAULT_RUN_ID = "run-conn-1"
_DEFAULT_SANDBOX_MARKER = "tok-conn"
_MODEL_PROVIDER_FIREWALL_NAME = "model-provider:anthropic-api-key"
_MODEL_PROVIDER_RUN_ID = "run-model-1"
_MODEL_PROVIDER_SANDBOX_MARKER = "tok-model"
_MODEL_PROVIDER_PATH = "/v1/messages"
_AUTH_URL_REWRITE_REQUEST_BODY = b'{"ok":true}'
_FORWARD_START_TIMEOUT_SECONDS = 2.0


class _UnexpectedAuthHeaders(dict[str, str]):
    def items(self) -> Never:
        raise KeyError("unexpected auth header iteration failure")


async def _wait_for_forward_start(
    started: threading.Event,
    request_task: asyncio.Task[None],
    *,
    wait_timeout: float = _FORWARD_START_TIMEOUT_SECONDS,
) -> None:
    started_task = asyncio.create_task(asyncio.to_thread(started.wait, wait_timeout))
    try:
        done, _ = await asyncio.wait(
            (started_task, request_task),
            return_when=asyncio.FIRST_COMPLETED,
            timeout=wait_timeout,
        )
        if (started_task in done and started_task.result()) or started.is_set():
            return

        if request_task not in done and not request_task.done():
            request_task.cancel()
            await asyncio.wait((request_task,), timeout=wait_timeout)

            if request_task.done():
                await asyncio.gather(request_task, return_exceptions=True)

            raise AssertionError(
                "auth.base forwarder did not start before timeout "
                f"(timeout={wait_timeout}, "
                "request_task_pending_before_cancel="
                "True, "
                f"request_task_done={request_task.done()}, "
                f"request_task_cancelled={request_task.cancelled()})"
            )

        try:
            await request_task
        except asyncio.CancelledError as e:
            raise AssertionError("request finished before auth.base forwarder started") from e
        except Exception as e:
            raise AssertionError("request finished before auth.base forwarder started") from e
        raise AssertionError("request finished before auth.base forwarder started")
    finally:
        if not started_task.done():
            started_task.cancel()
            await asyncio.gather(started_task, return_exceptions=True)


async def _await_request_task(request_task: asyncio.Task[None]) -> None:
    result = (await asyncio.gather(request_task, return_exceptions=True))[0]
    if isinstance(result, BaseException):
        raise result


async def _drain_request_task(
    request_task: asyncio.Task[None],
    *,
    wait_timeout: float = _FORWARD_START_TIMEOUT_SECONDS,
) -> None:
    if not request_task.done():
        await asyncio.wait((request_task,), timeout=wait_timeout)
    if request_task.done():
        await asyncio.gather(request_task, return_exceptions=True)
        return

    request_task.cancel()
    await asyncio.wait((request_task,), timeout=wait_timeout)
    if request_task.done():
        await asyncio.gather(request_task, return_exceptions=True)
        return

    raise AssertionError(
        "request task did not finish before cleanup timeout "
        f"(timeout={wait_timeout}, request_task_done={request_task.done()}, "
        f"request_task_cancelled={request_task.cancelled()})"
    )


@pytest.fixture
def usage_control_root(tmp_path: Path) -> Iterator[Path]:
    control_root = tmp_path / "delivery-control"
    usage.counters.reset_for_tests()
    try:
        yield control_root
    finally:
        usage.counters.reset_for_tests()


def _write_billable_x_tracking_registry(
    tmp_path: Path,
    *,
    include_encrypted_secrets: bool = True,
    sandbox_fields: dict[str, object] | None = None,
) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name=_X_FIREWALL_NAME,
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read-posts", "rules": [f"GET {_X_TRACKING_PATH}"]}],
            },
            network_policy={
                "allow": ["read-posts"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[_X_FIREWALL_NAME],
            include_encrypted_secrets=include_encrypted_secrets,
            sandbox_fields=sandbox_fields,
        ),
    )


def _write_model_provider_tracking_registry(
    tmp_path: Path,
    *,
    billable: bool = False,
    sandbox_fields: dict[str, object] | None = None,
    registry_dir: Path | None = None,
    run_id: str = _DEFAULT_RUN_ID,
    sandbox_marker: str = _DEFAULT_SANDBOX_MARKER,
) -> Path:
    registry_root = registry_dir or tmp_path
    registry_root.mkdir(parents=True, exist_ok=True)
    return _write_registry(
        registry_root,
        sandbox_info=_single_firewall_sandbox(
            registry_root,
            run_id=run_id,
            sandbox_marker=sandbox_marker,
            firewall_name=_MODEL_PROVIDER_FIREWALL_NAME,
            api_entry={
                "base": "https://api.anthropic.com",
                "auth": {"headers": {"x-api-key": "test-key"}},
                "permissions": [{"name": "messages", "rules": [f"POST {_MODEL_PROVIDER_PATH}"]}],
            },
            network_policy={
                "allow": ["messages"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[_MODEL_PROVIDER_FIREWALL_NAME] if billable else None,
            sandbox_fields=sandbox_fields,
        ),
    )


def _x_tracking_flow(real_flow):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.x.com",
        path=_X_TRACKING_PATH,
        method="GET",
    )


def _model_provider_tracking_flow(real_flow):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.anthropic.com",
        path=_MODEL_PROVIDER_PATH,
        method="POST",
    )


def _write_billable_auth_url_rewrite_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-rewrite-1",
            sandbox_marker="tok-rewrite",
            firewall_name="webhook",
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["POST /"]}],
            },
            network_policy={
                "allow": ["send"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=["webhook"],
        ),
    )


def _auth_url_rewrite_flow(real_flow):
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="placeholder.example.com",
        path="/",
        method="POST",
        request_body=_AUTH_URL_REWRITE_REQUEST_BODY,
    )


def _auth_url_rewrite_token_meta() -> dict[str, object]:
    return firewall_auth_response(
        headers={},
        base="https://real.example.com/webhook",
        resolved_secrets=["WEBHOOK_URL"],
    )


def test_repeated_eligibility_checks_keep_one_usage_flow_in_flight(
    usage_control_root,
    real_flow,
):
    """One flow owns one drain unit across changed eligibility signals."""
    flow = _model_provider_tracking_flow(real_flow)

    terminal_usage.track_flow_if_needed(flow, True)
    assert_pending(
        usage_control_root,
        flows=1,
        buffered=0,
        reports=0,
    )

    terminal_usage.track_flow_if_needed(flow, False)
    assert_pending(
        usage_control_root,
        flows=1,
        buffered=0,
        reports=0,
    )

    terminal_usage.release_tracked_flow(flow)
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )

    terminal_usage.release_tracked_flow(flow)
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_billable_flow_is_tracked_before_responseheaders(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Drain sees billable requests after request() even before responseheaders()."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert_pending(
        usage_control_root,
        flows=1,
        buffered=0,
        reports=0,
    )


async def test_billable_flow_error_releases_tracking_after_request(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Connection errors release billable tracking created by request()."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        flow.error = Error("connection reset")
        mitm_addon.error(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_header_phase_streamed_billable_flow_error_releases_tracking(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = _write_billable_x_tracking_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = _x_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)

        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        flow.error = Error("connection reset")
        mitm_addon.error(flow)

    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


async def test_duplicate_terminal_hooks_do_not_double_decrement_usage_flow(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Duplicate terminal hooks release a tracked flow at most once."""
    reg_path = _write_model_provider_tracking_registry(tmp_path, billable=True)
    first_flow = _model_provider_tracking_flow(real_flow)
    second_flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(first_flow)
        await mitm_addon.request(second_flow)

        assert_pending(
            usage_control_root,
            flows=2,
            buffered=0,
            reports=0,
        )

        first_flow.response = mitm_addon.http.Response.make(200)
        mitm_addon.response(first_flow)
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        first_flow.error = Error("connection reset")
        mitm_addon.error(first_flow)
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        second_flow.response = mitm_addon.http.Response.make(200)
        mitm_addon.response(second_flow)

    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_untracked_terminal_hook_does_not_decrement_other_usage_flow(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """A terminal hook for an untracked flow leaves other tracked flows in flight."""
    billable_reg_path = _write_model_provider_tracking_registry(tmp_path, billable=True)
    non_billable_reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        registry_dir=tmp_path / "non-billable-registry",
    )
    tracked_flow = _model_provider_tracking_flow(real_flow)
    untracked_flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(billable_reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(tracked_flow)
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

    with (
        mitm_ctx(registry_path=str(non_billable_reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(untracked_flow)
        assert untracked_flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        untracked_flow.error = Error("connection reset")
        mitm_addon.error(untracked_flow)
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

    with mitm_ctx(registry_path=str(billable_reg_path), api_url="https://api.okou.ai"):
        tracked_flow.response = mitm_addon.http.Response.make(200)
        mitm_addon.response(tracked_flow)

    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_local_firewall_error_leaves_usage_flows_drained(
    tmp_path, usage_control_root, real_flow, mitm_ctx
):
    """Local auth failures do not enqueue usage and must not leak drain counters."""
    reg_path = _write_billable_x_tracking_registry(
        tmp_path,
        include_encrypted_secrets=False,
    )
    flow = _x_tracking_flow(real_flow)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "auth_unavailable"
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_unexpected_request_exception_releases_tracking(
    tmp_path, usage_control_root, real_flow, mitm_ctx
):
    """Unexpected request-hook failures must not leak start-time or usage counters."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    async def return_unexpected_auth_headers_after_tracking(*_args, **_kwargs):
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )
        return {
            "headers": _UnexpectedAuthHeaders({"Authorization": "Bearer resolved-token"}),
            "cache_entry_identity": auth.FirewallAuthCacheEntryIdentity(),
        }

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            return_unexpected_auth_headers_after_tracking,
        ),
        pytest.raises(KeyError),
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 500
    assert flow.response.json() == {
        "error": "request_processing_failed",
        "message": "Request processing failed",
    }
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_request_cancellation_releases_tracking_during_auth_resolution(
    tmp_path, usage_control_root, real_flow, mitm_ctx
):
    """Cancelled auth resolution must not leak request-time usage tracking."""
    reg_path = _write_billable_x_tracking_registry(tmp_path)
    flow = _x_tracking_flow(real_flow)

    async def cancel_auth_after_tracking(*_args, **_kwargs):
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )
        raise asyncio.CancelledError

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", cancel_auth_after_tracking),
        pytest.raises(asyncio.CancelledError),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_non_billable_model_provider_is_not_tracked_before_responseheaders(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    """Non-billable model providers are not tracked even with a canonical model."""
    reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        run_id=_MODEL_PROVIDER_RUN_ID,
        sandbox_marker=_MODEL_PROVIDER_SANDBOX_MARKER,
        sandbox_fields={"modelUsageProvider": "claude-sonnet-4-6"},
    )
    flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata[metadata_keys.FIREWALL_NAME] == _MODEL_PROVIDER_FIREWALL_NAME
    assert flow.metadata[metadata_keys.CLI_AGENT_TYPE] == "claude-code"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_billable_model_provider_records_model_usage_provider(
    tmp_path, usage_control_root, real_flow, mitm_ctx, fake_firewall_headers
):
    """Registry modelUsageProvider is available to model usage reporting."""
    reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        billable=True,
        run_id=_MODEL_PROVIDER_RUN_ID,
        sandbox_marker=_MODEL_PROVIDER_SANDBOX_MARKER,
        sandbox_fields={
            "cliAgentType": "codex",
            "modelUsageProvider": "claude-opus-4-6",
        },
    )
    flow = _model_provider_tracking_flow(real_flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata[metadata_keys.FIREWALL_NAME] == _MODEL_PROVIDER_FIREWALL_NAME
    assert flow.metadata[metadata_keys.CLI_AGENT_TYPE] == "codex"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is True
    assert flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] == "claude-opus-4-6"
    assert_pending(
        usage_control_root,
        flows=1,
        buffered=0,
        reports=0,
    )


async def test_billable_model_provider_rejects_uninspectable_response_and_drains_tracking(
    tmp_path,
    usage_control_root,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_server,
):
    reg_path = _write_model_provider_tracking_registry(
        tmp_path,
        billable=True,
        sandbox_fields={"modelUsageProvider": "claude-sonnet-4-6"},
    )
    flow = _model_provider_tracking_flow(real_flow)
    flow.request.headers["Accept-Encoding"] = "zstd, identity;q=0"

    with (
        mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

        assert flow.request.headers["Accept-Encoding"] == "zstd, identity;q=0"
        assert (
            flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION]
            == "preserved_client_constraints"
        )
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        flow.response = http.Response.make(
            200,
            b"",
            {
                "Content-Type": "text/event-stream",
                "Content-Encoding": "zstd",
            },
        )
        mitm_addon.responseheaders(flow)

        underbilling_entries = [
            entry
            for entry in read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
            if entry.get("type") == "usage_underbilling"
        ]
        [entry] = underbilling_entries
        assert entry["reason"] == "response_encoding_not_stream_decodable"
        assert entry["firewall_billable"] is True
        assert entry["inspection_disposition"] == "fail_closed"
        assert entry["request_encoding_negotiation"] == "preserved_client_constraints"
        assert flow.response.status_code == 502
        assert flow.response.content == b""
        stream = response_stream(flow)
        assert stream(b"uninspectable upstream bytes") == b""
        assert stream(b"") == b""
        mitm_addon.response(flow)
        assert metadata_keys.RESPONSE_ENCODING_NEGOTIATION not in flow.metadata
        assert usage.flush_usage_events(trigger="test") == 0

    assert usage_webhook_server.request_count == 0
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_billable_auth_url_rewrite_flow_drains_after_response(
    tmp_path, usage_control_root, real_flow, mitm_ctx
):
    """Inline auth.base responses still pair request-time tracking with response()."""
    reg_path = _write_billable_auth_url_rewrite_registry(tmp_path)
    flow = _auth_url_rewrite_flow(real_flow)
    token_meta = _auth_url_rewrite_token_meta()
    forward_started = threading.Event()
    release_forward = threading.Event()

    def block_connect(_address):
        forward_started.set()
        if not release_forward.wait(timeout=5):
            raise TimeoutError("test did not release blocked auth.base forward")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(return_value=token_meta),
        ),
        fake_forwarder_upstream(
            body=b'{"delivered":true}',
            headers=[("Content-Type", "application/json")],
            connect_side_effect=block_connect,
        ) as upstream,
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_forward_start(forward_started, request_task)

            assert upstream.resolve_calls == ["real.example.com"]
            assert upstream.connect_calls == [("93.184.216.34", 443)]
            assert_pending(
                usage_control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            release_forward.set()
            await _await_request_task(request_task)
        finally:
            release_forward.set()
            await _drain_request_task(request_task)

        assert flow.response is not None
        assert flow.response.status_code == 200
        assert flow.response.content == b'{"delivered":true}'
        assert flow.metadata[metadata_keys.AUTH_URL_REWRITE] is True
        assert_pending(
            usage_control_root,
            flows=1,
            buffered=0,
            reports=0,
        )

        mitm_addon.response(flow)

    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_billable_auth_url_rewrite_forward_failure_releases_tracking(
    tmp_path, usage_control_root, real_flow, mitm_ctx
):
    """Failed inline auth.base forwarding is a local response and drains immediately."""
    reg_path = _write_billable_auth_url_rewrite_registry(tmp_path)
    flow = _auth_url_rewrite_flow(real_flow)
    token_meta = _auth_url_rewrite_token_meta()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(return_value=token_meta),
        ),
        fake_forwarder_upstream(
            send_side_effect=ConnectionError("upstream unavailable"),
        ) as upstream,
    ):
        await mitm_addon.request(flow)

    assert upstream.resolve_calls == ["real.example.com"]
    assert upstream.connect_calls == [("93.184.216.34", 443)]
    assert flow.response is not None
    assert flow.response.status_code == 502
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "url_rewrite_forward_failed"
    assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


async def test_billable_auth_url_rewrite_forward_cancellation_releases_tracking(
    tmp_path, usage_control_root, real_flow, mitm_ctx
):
    """Cancelled inline auth.base forwarding drains request-time tracking."""
    reg_path = _write_billable_auth_url_rewrite_registry(tmp_path)
    flow = _auth_url_rewrite_flow(real_flow)
    token_meta = _auth_url_rewrite_token_meta()
    forward_started = threading.Event()
    release_forward = threading.Event()
    forward_unblocked = threading.Event()

    def block_connect(_address):
        forward_started.set()
        try:
            if not release_forward.wait(timeout=5):
                raise TimeoutError("test did not release blocked auth.base forward")
        finally:
            forward_unblocked.set()

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        patch.object(
            auth,
            "get_firewall_headers",
            AsyncMock(return_value=token_meta),
        ),
        fake_forwarder_upstream(connect_side_effect=block_connect),
    ):
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_forward_start(forward_started, request_task)

            assert_pending(
                usage_control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            request_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await _await_request_task(request_task)
        finally:
            release_forward.set()
            if forward_started.is_set():
                forward_finished = await asyncio.to_thread(
                    forward_unblocked.wait,
                    _FORWARD_START_TIMEOUT_SECONDS,
                )
                assert forward_finished
            await _drain_request_task(request_task)

    assert flow.response is None
    assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert "_usage_flow_tracked" not in flow.metadata
    assert_pending(
        usage_control_root,
        flows=0,
        buffered=0,
        reports=0,
    )
