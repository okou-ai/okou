"""Tests for real deferred callback scheduling in mitm-addon hooks."""

import time
from pathlib import Path

from mitmproxy import tcp

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.deferred_callback_helpers import await_ready_callbacks
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    append_websocket_message,
    openai_websocket_usage_frame,
)


async def test_registered_non_model_websocket_trim_uses_real_event_loop_scheduler(
    mitm_ctx, real_flow
):
    flow = real_flow(with_response=False, host="example.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    old_client = append_websocket_message(flow, from_client=True, content=b"client-old")
    old_server = append_websocket_message(flow, from_client=False, content=b"server-old")
    latest_server = append_websocket_message(
        flow,
        from_client=False,
        content=b"server-latest",
    )
    assert flow.websocket is not None
    messages = flow.websocket.messages

    with mitm_ctx():
        mitm_addon.websocket_message(flow)

    assert messages == [old_client, old_server, latest_server]

    await await_ready_callbacks()

    assert flow.websocket.messages is messages
    assert flow.websocket.messages == [latest_server]


async def test_model_websocket_trim_coalesces_with_real_event_loop_scheduler(
    tmp_path,
    mitm_ctx,
    real_flow,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    first_server = append_websocket_message(
        flow,
        from_client=False,
        content=openai_websocket_usage_frame("resp_ws_first"),
    )

    with mitm_ctx():
        mitm_addon.websocket_message(flow)

    latest_server = append_websocket_message(
        flow,
        from_client=False,
        content=openai_websocket_usage_frame("resp_ws_latest"),
    )
    with mitm_ctx():
        mitm_addon.websocket_message(flow)

    assert flow.websocket is not None
    assert flow.websocket.messages == [first_server, latest_server]

    await await_ready_callbacks()

    assert flow.websocket.messages == [latest_server]


async def test_tcp_message_drain_uses_real_event_loop_scheduler(
    tmp_path: Path,
    mitm_ctx,
    real_tcp_flow,
):
    client_message = tcp.TCPMessage(True, b"client")
    server_message = tcp.TCPMessage(False, b"server-response")
    messages = [client_message, server_message]
    flow = real_tcp_flow(messages=messages)
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()

    with mitm_ctx():
        mitm_addon.tcp_message(flow)

    assert flow.messages == messages

    await await_ready_callbacks()

    assert flow.messages == []

    with mitm_ctx():
        mitm_addon.tcp_end(flow)

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["request_size"] == len(client_message.content)
    assert entry["response_size"] == len(server_message.content)
