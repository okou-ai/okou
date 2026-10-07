"""Response hook integration tests for terminal lifecycle cleanup."""

import time

from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import http_network_log
import mitm_addon
import request_streaming
from tests.flow_helpers import header_map, response_stream


def test_pops_start_time_even_when_run_id_absent(real_flow, mitm_ctx):
    # If a partially initialized flow reaches response() without
    # sandbox_run_id, response() must still pop the timing state.
    flow = real_flow(with_response=False)
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

    with mitm_ctx():
        mitm_addon.response(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


def test_response_releases_streaming_state(tmp_path, real_flow, mitm_ctx):
    """The completed response hook must not retain parser/buffer closures."""
    flow = real_flow(with_response=False, host="api.anthropic.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.anthropic.com/v1/messages"
    http_network_log.set_target(
        flow,
        url="https://api.anthropic.com/v1/messages",
        host="api.anthropic.com",
        port=443,
    )
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:claude-code-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(b'{"model":"claude-sonnet-4-6"}')

    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.response.stream is False
    assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
    assert "model_json_usage_finish" not in flow.metadata


def test_response_without_run_id_releases_x_json_streaming_state(real_flow):
    """Even early-returning flows should not retain response parser closures."""
    flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
    flow.metadata[metadata_keys.FIREWALL_NAME] = "x"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.x.com/2/tweets"
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(b'{"data":[{"id":"1"}]}')
    assert "connector_response_finish" in flow.metadata

    mitm_addon.response(flow)

    assert flow.response.stream is False
    assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
    assert "connector_response_finish" not in flow.metadata


def test_response_without_run_id_releases_request_stream_state(real_flow):
    """Even early-returning flows should not retain request stream closures."""
    flow = real_flow(with_response=False, host="api.example.com", method="POST")
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    stream(b"request-prefix")

    mitm_addon.response(flow)

    assert flow.request.stream is False
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_response_does_not_clear_replaced_request_stream_callback(real_flow):
    """Cleanup should not clear a request callback that replaced ours."""
    flow = real_flow(with_response=False, host="api.example.com", method="POST")

    def external_stream(chunk):
        return chunk

    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    stream(b"request-prefix")
    flow.request.stream = external_stream

    mitm_addon.response(flow)

    assert flow.request.stream is external_stream
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_response_without_run_id_releases_sse_streaming_state(real_flow):
    """Early-returning SSE flows should not retain parser closures."""
    flow = real_flow(with_response=False, host="openrouter.ai")
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openrouter-codex"
    flow.metadata[metadata_keys.CLI_AGENT_TYPE] = "codex"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
    flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.5"
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "text/event-stream"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(
        b"event: response.completed\n"
        b'data: {"response":{"model":"gpt-5.5","usage":{"output_tokens":7}}}\n'
    )
    assert "model_sse_usage_finish" in flow.metadata

    mitm_addon.response(flow)

    assert flow.response.stream is False
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
    assert "model_sse_usage_finish" not in flow.metadata


def test_response_does_not_clear_external_stream_callback(tmp_path, real_flow, mitm_ctx):
    """Cleanup should only reset the stream callback installed by this addon."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    def external_stream(chunk):
        return chunk

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(status_code=200)
    flow.response.stream = external_stream

    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.response.stream is external_stream


def test_response_does_not_clear_replaced_stream_callback(tmp_path, real_flow, mitm_ctx):
    """Cleanup should not clear a callback that replaced ours after responseheaders."""
    flow = real_flow(with_response=False, host="api.anthropic.com")

    def external_stream(chunk):
        return chunk

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.anthropic.com/v1/messages"
    http_network_log.set_target(
        flow,
        url="https://api.anthropic.com/v1/messages",
        host="api.anthropic.com",
        port=443,
    )
    flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:claude-code-oauth-token"
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    stream_callback = response_stream(flow)
    stream_callback(b'{"model":"claude-sonnet-4-6"}')
    flow.response.stream = external_stream

    with mitm_ctx():
        mitm_addon.response(flow)

    assert flow.response.stream is external_stream
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert "model_json_usage_finish" not in flow.metadata
