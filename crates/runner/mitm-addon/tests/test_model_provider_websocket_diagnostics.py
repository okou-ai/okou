"""Lifetime bounds for model-provider WebSocket usage diagnostics."""

import asyncio
from pathlib import Path

import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
import model_websocket_usage
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_server_message,
    openai_websocket_usage_frame,
    run_deferred_websocket_trims,
    set_websocket_message,
)
from tests.usage_helpers import assert_usage_event_rows

_INTEGER_LIMIT_FRAME = b'{"usage":{"input_tokens":9007199254740992}}'
_WORK_LIMIT_FRAME = b'{"padding":[' + b",".join([b"0"] * 40_000) + b"]}"
_PARSE_WARNING_MESSAGE = "Model provider WebSocket usage extraction failed"


@pytest.fixture
def deferred_websocket_trims(monkeypatch: pytest.MonkeyPatch) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


async def test_websocket_usage_diagnostics_bound_encoding_and_output_before_recovery(
    tmp_path,
    real_flow,
    monkeypatch: pytest.MonkeyPatch,
    deferred_websocket_trims,
    usage_webhook_api,
    sync_usage_executor,
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    encoded_warnings = 0
    initial_warning_bytes = 0
    original_encode = logging_utils._encode_jsonl_entry

    def count_encoding(entry: dict, log_name: str) -> bytes | None:
        nonlocal encoded_warnings
        if entry.get("message") == _PARSE_WARNING_MESSAGE:
            encoded_warnings += 1
        return original_encode(entry, log_name)

    monkeypatch.setattr(logging_utils, "_encode_jsonl_entry", count_encoding)

    with usage_webhook_api() as webhook:
        for batch in range(100):
            for _ in range(100):
                feed_websocket_server_message(flow, _INTEGER_LIMIT_FRAME)
            # A writer that keeps pace must not turn a queue bound into a
            # misleading lifetime-output bound. Also release deferred history.
            run_deferred_websocket_trims(deferred_websocket_trims)
            assert logging_utils.flush_log_path(str(proxy_log))
            if batch == 0:
                initial_warning_bytes = (await asyncio.to_thread(proxy_log.stat)).st_size

        assert initial_warning_bytes > 0
        assert (await asyncio.to_thread(proxy_log.stat)).st_size == initial_warning_bytes

        # Exhaustion must not skip inspection or the independent correlation
        # transition when a different error kind arrives later.
        for _ in range(100):
            completion = feed_websocket_server_message(flow, _WORK_LIMIT_FRAME)
            assert completion is not None
            await completion
            assert flow.websocket is not None
            assert flow.websocket.messages[-1].content == _WORK_LIMIT_FRAME
            assert not flow.websocket.messages[-1].dropped
            run_deferred_websocket_trims(deferred_websocket_trims)
            assert logging_utils.flush_log_path(str(proxy_log))

        entries = read_jsonl_entries_after_flush(proxy_log)
        warnings = [entry for entry in entries if entry.get("message") == _PARSE_WARNING_MESSAGE]
        assert encoded_warnings == len(warnings) == 4
        assert all(entry["error"] == "integer value limit exceeded" for entry in warnings)
        [correlation] = [
            entry for entry in entries if entry.get("type") == "model_usage_correlation"
        ]
        assert correlation["reason"] == "correlation_cap"
        assert len(entries) == 5

        feed_websocket_server_message(
            flow, openai_websocket_usage_frame("after-errors", input_tokens=7, output_tokens=2)
        )
        feed_websocket_server_message(flow, _INTEGER_LIMIT_FRAME)
        run_deferred_websocket_trims(deferred_websocket_trims)
        mitm_addon.websocket_end(flow)
        usage.flush_usage_events(trigger="test")

    assert_usage_event_rows(
        webhook.usage_events(),
        "provider",
        [("gpt-5.5", "tokens.input", 7), ("gpt-5.5", "tokens.output", 2)],
    )
    assert encoded_warnings == 4
    assert not model_websocket_usage.is_enabled(flow)


@pytest.mark.parametrize("termination", ["websocket_end", "error"])
async def test_websocket_usage_diagnostic_budget_isolated_and_released(
    tmp_path,
    real_flow,
    deferred_websocket_trims,
    termination,
):
    first = make_openai_responses_websocket_flow(real_flow, tmp_path)
    second = make_openai_responses_websocket_flow(real_flow, tmp_path)
    second_log = tmp_path / "second-proxy.jsonl"
    second.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(second_log)
    mitm_addon.responseheaders(first)
    mitm_addon.responseheaders(second)
    first_log = Path(first.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])

    for _ in range(10):
        feed_websocket_server_message(first, _INTEGER_LIMIT_FRAME)
    for _ in range(10):
        completion = feed_websocket_server_message(second, _WORK_LIMIT_FRAME)
        assert completion is not None
        await completion
    run_deferred_websocket_trims(deferred_websocket_trims)

    for log in (first_log, second_log):
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(log)
            if entry.get("message") == _PARSE_WARNING_MESSAGE
        ]
        assert len(warnings) == 4
    assert all(
        entry["error"] == "work_limit_exceeded"
        for entry in read_jsonl_entries_after_flush(second_log)
        if entry.get("message") == _PARSE_WARNING_MESSAGE
    )

    first.error = Error("connection lost") if termination == "error" else None
    if termination == "error":
        assert mitm_addon.error(first) is None
    else:
        mitm_addon.websocket_end(first)
    assert not model_websocket_usage.is_enabled(first)
    assert model_websocket_usage.is_enabled(second)

    before_late_message = read_jsonl_entries_after_flush(first_log)
    set_websocket_message(first, from_client=False, content=_INTEGER_LIMIT_FRAME)
    mitm_addon.websocket_message(first)
    run_deferred_websocket_trims(deferred_websocket_trims)
    assert read_jsonl_entries_after_flush(first_log) == before_late_message

    # A new upgraded flow gets its own prefix even after the old one terminates.
    fresh = make_openai_responses_websocket_flow(real_flow, tmp_path)
    fresh_log = tmp_path / "fresh-proxy.jsonl"
    fresh.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(fresh_log)
    mitm_addon.responseheaders(fresh)
    for _ in range(10):
        feed_websocket_server_message(fresh, _INTEGER_LIMIT_FRAME)
    run_deferred_websocket_trims(deferred_websocket_trims)
    assert len(read_jsonl_entries_after_flush(fresh_log)) == 4
    mitm_addon.websocket_end(second)
    mitm_addon.websocket_end(fresh)
