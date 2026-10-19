"""Scheduling and lifecycle contracts through the production message hook."""

import asyncio

import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_websocket_usage
import usage
import websocket_retention
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    append_websocket_message,
    openai_websocket_usage_frame,
)
from tests.usage_helpers import assert_usage_event_rows
from tests.websocket_cooperative_helpers import costly_message, deliver


@pytest.mark.parametrize("side", ["client", "created", "terminal"])
@pytest.mark.parametrize("repetitions", [250_000, 350_000], ids=["accepted", "over-budget"])
async def test_costly_message_yields_before_observation_and_recovers(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, side, repetitions
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    body = costly_message(side, repetitions)
    pulse = asyncio.get_running_loop().create_future()
    with usage_webhook_api() as webhook:
        if side != "client":
            await deliver(flow, b'{"type":"response.create"}', from_client=True)
        if side == "terminal":
            await deliver(flow, b'{"type":"response.created","response":{"id":"resp_costly"}}')
        asyncio.get_running_loop().call_soon(
            lambda: pulse.set_result(
                (
                    metadata_keys.WEBSOCKET_INSPECTION in flow.metadata,
                    dict(flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]),
                    list(webhook.usage_events()),
                )
            )
        )
        await deliver(flow, body, from_client=side == "client")
        pending, partial_usage, partial_events = await pulse
        assert pending
        assert not partial_usage
        assert not partial_events
        assert metadata_keys.WEBSOCKET_INSPECTION not in flow.metadata

        # A later terminal event still contributes once, including after a
        # rejected message. Replaying it must not double count its source.
        recovery = openai_websocket_usage_frame("resp_recovery")
        await deliver(flow, recovery)
        await deliver(flow, recovery)
        mitm_addon.websocket_end(flow)
        usage.flush_usage_events(trigger="test")
    events = webhook.usage_events()
    expected_rows = [("gpt-5.5", "tokens.input", 10), ("gpt-5.5", "tokens.output", 4)]
    if side == "terminal" and repetitions == 250_000:
        expected_rows.extend([("gpt-5.5", "tokens.input", 9), ("gpt-5.5", "tokens.output", 4)])
    assert_usage_event_rows(events, "provider", expected_rows)
    assert not model_websocket_usage.is_enabled(flow)
    assert flow.websocket is not None
    assert flow.websocket.messages == []


@pytest.mark.parametrize("terminal", ["cancel", "end", "error"])
async def test_partial_inspection_is_abandoned_before_terminal_or_recovery(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, terminal
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        await deliver(flow, openai_websocket_usage_frame("resp_previous"))
        append_websocket_message(
            flow, from_client=False, content=costly_message("terminal", 250_000)
        )
        completion = mitm_addon.websocket_message(flow)
        assert completion is not None
        owner = asyncio.ensure_future(completion)
        await asyncio.sleep(0)
        if terminal == "cancel":
            owner.cancel()
            with pytest.raises(asyncio.CancelledError):
                await owner
            await deliver(flow, openai_websocket_usage_frame("resp_recovery"))
            mitm_addon.websocket_end(flow)
        elif terminal == "end":
            mitm_addon.websocket_end(flow)
            await owner
        else:
            flow.error = Error("connection closed during inspection")
            assert mitm_addon.error(flow) is None
            await owner
        usage.flush_usage_events(trigger="test")
    events = webhook.usage_events()
    assert len(events) == (4 if terminal == "cancel" else 2)
    assert metadata_keys.WEBSOCKET_INSPECTION not in flow.metadata
    assert not model_websocket_usage.is_enabled(flow)
    assert flow.websocket is not None
    assert flow.websocket.messages == []
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert sum(entry.get("reason") == "inspection_interrupted" for entry in entries) == 1


async def test_history_remains_available_while_inspection_yields(
    real_flow, tmp_path, monkeypatch, sync_usage_executor, usage_webhook_api
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    monkeypatch.setattr(websocket_retention, "MAX_RETAINED_MESSAGE_BYTES", 1024)
    old = append_websocket_message(flow, from_client=True, content=b"old")
    body = costly_message("client", 250_000)
    message = append_websocket_message(flow, from_client=True, content=body)
    with usage_webhook_api():
        completion = mitm_addon.websocket_message(flow)
        assert completion is not None

        async def complete_and_observe_peer_hook():
            await completion
            assert flow.websocket is not None
            assert flow.websocket.messages == [old, message]

        owner = asyncio.ensure_future(complete_and_observe_peer_hook())
        await asyncio.sleep(0)
        assert flow.websocket is not None
        assert flow.websocket.messages == [old, message]
        await owner
        await asyncio.sleep(0)
        assert flow.websocket.messages == []
        mitm_addon.websocket_end(flow)


async def test_documented_non_usage_message_keeps_synchronous_fast_path(real_flow, tmp_path):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    body = b'{"type":"response.output_text.delta","delta":"' + b"\\u4e2d" * 350_000 + b'"}'
    message = append_websocket_message(flow, from_client=False, content=body)
    assert mitm_addon.websocket_message(flow) is None
    assert message.content == body
    assert not message.dropped
    assert metadata_keys.WEBSOCKET_INSPECTION not in flow.metadata
    mitm_addon.websocket_end(flow)


@pytest.mark.parametrize("from_client", [False, True], ids=["server", "client"])
async def test_empty_message_invalidates_prewarm_correlation(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, from_client
):
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        await deliver(flow, b'{"type":"response.create","generate":false}', from_client=True)
        await deliver(flow, b"", from_client=from_client)
        await deliver(flow, b'{"type":"response.created","response":{"id":"resp_after_empty"}}')
        await deliver(flow, openai_websocket_usage_frame("resp_after_empty"))
        mitm_addon.websocket_end(flow)
        usage.flush_usage_events(trigger="test")
    assert_usage_event_rows(
        webhook.usage_events(),
        "provider",
        [("gpt-5.5", "tokens.input", 10), ("gpt-5.5", "tokens.output", 4)],
    )


@pytest.mark.parametrize("extra_space", [0, 1], ids=["exact-budget", "one-unit-over"])
def test_client_total_work_budget_remains_exact(extra_space):
    # Six structural/scalar work units plus one unit per leading space.
    body = b" " * (65_530 + extra_space) + b'{"type":"response.create"}'
    observation = usage.inspect_openai_responses_client_event_json(body)
    assert observation.request_kind == ("unknown" if extra_space else "create")
    assert observation.work_limit_exceeded is bool(extra_space)


@pytest.mark.parametrize("extra_space", [0, 1], ids=["exact-budget", "one-unit-over"])
async def test_server_total_work_budget_never_commits_partial_usage(
    real_flow, tmp_path, sync_usage_executor, usage_webhook_api, extra_space
):
    # The event uses 23 work units independently of feed boundaries.
    body = b" " * (65_513 + extra_space) + (
        b'{"type":"response.completed","response":{"id":"resp","usage":{"input_tokens":1}}}'
    )
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        await deliver(flow, body)
        mitm_addon.websocket_end(flow)
        usage.flush_usage_events(trigger="test")
    assert len(webhook.usage_events()) == (0 if extra_space else 1)


@pytest.mark.parametrize(
    "duplicate",
    [b'"type":"response.cancel"', b'"generate":true'],
    ids=["type", "generate"],
)
def test_client_duplicate_consistency_survives_feed_boundaries(duplicate):
    body = (
        b'{"type":"response.create","generate":false,"input":"'
        + b"\\u4e2d" * 10_000
        + b'",'
        + duplicate
        + b"}"
    )
    observation = usage.inspect_openai_responses_client_event_json(body)
    assert observation.request_kind == "unknown"
    assert observation.is_prewarm is False
    assert observation.work_limit_exceeded is False


@pytest.mark.parametrize("second_id", ["first", "conflicting"], ids=["consistent", "conflicting"])
def test_server_lifecycle_id_consistency_survives_feed_boundaries(second_id):
    body = (
        b'{"type":"response.created","response":{"id":"first","instructions":"'
        + b"\\u4e2d" * 10_000
        + b'","id":"'
        + second_id.encode()
        + b'"}}'
    )
    event = usage.inspect_openai_responses_event_json(body)
    inspection = usage.inspect_openai_responses_server_event(event, include_lifecycle=True)
    assert inspection.lifecycle is not None
    assert inspection.lifecycle.is_valid is (second_id == "first")
    assert inspection.usage is None
    assert inspection.usage_error is None
