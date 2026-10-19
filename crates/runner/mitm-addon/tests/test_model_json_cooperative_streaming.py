"""Bound HTTP JSON inspection through production response and terminal hooks."""

import asyncio

import pytest
from mitmproxy.flow import Error

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_json_cooperative_helpers import (
    encode_model_json,
    make_model_json_pipeline_flow,
    model_json_body,
)
from tests.model_provider_response_helpers import CLAUDE_CODE_JSON_CASE, standard_success_payload


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


@pytest.mark.parametrize("protocol", ["anthropic", "responses", "chat"])
@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("billable", [False, True])
async def test_small_wire_callback_yields_before_complete_document_usage(
    real_flow, tmp_path, usage_webhook_api, protocol, encoding, billable
):
    flow = make_model_json_pipeline_flow(
        real_flow, tmp_path, protocol=protocol, encoding=encoding, billable=billable
    )
    body = model_json_body(protocol)
    wire = encode_model_json(body, encoding)
    assert len(body) > 64 * 1024
    assert len(wire) < 65_535
    mitm_addon.responseheaders(flow)
    heartbeat = asyncio.get_running_loop().create_future()
    with usage_webhook_api() as webhook:
        asyncio.get_running_loop().call_soon(
            lambda: heartbeat.set_result(
                (
                    response_streaming.has_pending_response_inspection(flow),
                    flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE),
                    webhook.usage_events(),
                )
            )
        )
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        assert not heartbeat.done()
        await mitm_addon.responseinspection(flow)
        assert await heartbeat == (True, None, [])
        # Even fully inspected selected fields remain private until EOF validation.
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert response_streaming.streamed_response_size(flow) == len(wire)
        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    quantities = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
    assert quantities["tokens.input"] == 50
    assert quantities["tokens.output"] == 200
    assert (
        quantities["message_id"]
        == {
            "anthropic": "msg_1",
            "responses": "resp_1",
            "chat": "chatcmpl_1",
        }[protocol]
    )
    assert len(webhook.usage_events()) == (2 if billable else 0)
    assert not response_streaming.has_pending_response_inspection(flow)
    assert flow.response is not None
    assert flow.response.stream is False


def test_parser_step_cannot_reach_error_after_4k_input():
    inspector = usage.create_model_json_response_inspector("anthropic_messages")
    steps = inspector.feed_steps(b" " * 4096 + b"!")
    next(steps)
    assert inspector.accepts_more_input()
    next(steps)
    assert not inspector.accepts_more_input()
    assert list(steps) == []
    assert inspector.finish().usage_error is not None


@pytest.mark.parametrize("protocol", ["anthropic", "responses", "chat"])
@pytest.mark.parametrize("encoding", ["", "gzip", "deflate", "br"])
@pytest.mark.parametrize("chunk_size", [7, None], ids=["split", "whole"])
@pytest.mark.parametrize("ensure_ascii", [False, True], ids=["utf8", "escaped"])
async def test_partitions_preserve_usage_and_lexical_state(
    real_flow, tmp_path, protocol, encoding, chunk_size, ensure_ascii
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, protocol=protocol, encoding=encoding)
    body = model_json_body(protocol, characters=6_000, ensure_ascii=ensure_ascii)
    wire = encode_model_json(body, encoding)
    mitm_addon.responseheaders(flow)
    forwarded = bytearray()
    size = chunk_size or len(wire)
    for offset in range(0, len(wire), size):
        chunk = wire[offset : offset + size]
        emitted = response_stream(flow)(chunk)
        assert emitted == chunk
        assert isinstance(emitted, bytes)
        forwarded.extend(emitted)
        await mitm_addon.responseinspection(flow)
    assert forwarded == wire
    assert response_stream(flow)(b"") == b""
    assert mitm_addon.response(flow) is None
    quantities = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
    assert quantities["tokens.input"] == 50
    assert quantities["tokens.output"] == 200
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("extra_space", [0, 1], ids=["exact-budget", "one-unit-over"])
async def test_document_budget_survives_parser_steps_and_decoder_deliveries(
    real_flow, tmp_path, usage_webhook_api, encoding, extra_space
):
    # This document uses ten units, plus one for each trailing whitespace byte.
    body = b'{"usage":{"input_tokens":1}}' + b" " * (65_526 + extra_space)
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding=encoding, billable=True)
    wire = encode_model_json(body, encoding)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
    if extra_space:
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert webhook.usage_events() == []
        entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(entry.get("error") == "work limit exceeded" for entry in entries)
    else:
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {"tokens.input": 1}
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("failure", ["incomplete", "checksum", "trailing-json"])
async def test_terminal_join_rejects_invalid_suffix_after_selected_usage(
    real_flow, tmp_path, usage_webhook_api, encoding, failure
):
    body = model_json_body()
    if failure == "trailing-json":
        body += b"!"
    wire = encode_model_json(body, encoding)
    if failure == "incomplete":
        wire = wire[:-1]
    elif failure == "checksum":
        wire = wire[:-1] + bytes([wire[-1] ^ 0xFF])
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding=encoding, billable=True)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert webhook.usage_events() == []
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    (warning,) = [
        entry
        for entry in entries
        if entry.get("message") == "Model provider JSON usage extraction failed"
    ]
    assert (
        warning["error"]
        == {
            "incomplete": body_decoding.INCOMPLETE_COMPRESSED_BODY,
            "checksum": body_decoding.INVALID_COMPRESSED_BODY,
            "trailing-json": "trailing data after root value",
        }[failure]
    )
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize("terminal", ["release", "close", "response", "error", "checkpoint"])
async def test_abandonment_never_finalizes_an_already_valid_prefix(
    real_flow, tmp_path, usage_webhook_api, terminal
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, billable=True)
    # The initial quantum contains a valid complete JSON root. An uninspected
    # trailing suffix must not be silently ignored by finishing that prefix.
    body = standard_success_payload(CLAUDE_CODE_JSON_CASE) + b" " * 40_000 + b"!"
    wire = encode_model_json(body, "gzip")
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        if terminal == "release":
            response_streaming.release_response_stream_state(flow)
        elif terminal == "close":
            response_streaming.abandon_response_inspection(flow)
        else:
            if terminal == "checkpoint":
                completion = mitm_addon.responseinspection(flow)
            elif terminal == "error":
                flow.error = Error("synthetic interruption during JSON inspection")
                completion = mitm_addon.error(flow)
            else:
                completion = mitm_addon.response(flow)
            assert completion is not None
            task = asyncio.ensure_future(completion)
            asyncio.get_running_loop().call_soon(task.cancel)
            with pytest.raises(asyncio.CancelledError):
                await task
        completion = mitm_addon.response(flow)
        if completion is not None:
            await completion
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert webhook.usage_events() == []
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    failures = [
        entry for entry in entries if entry.get("reason") == "response_inspection_interrupted"
    ]
    assert len(failures) == 1
    assert failures[0]["parse_error"] == "response inspection interrupted"
    assert not response_streaming.has_pending_response_inspection(flow)
    assert flow.response is not None
    assert flow.response.stream is False


async def test_error_hook_joins_pending_document_and_cleans_up(
    real_flow, tmp_path, usage_webhook_api
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, billable=True)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        wire = encode_model_json(model_json_body(), "gzip")
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        flow.error = Error("synthetic connection error")
        completion = mitm_addon.error(flow)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
    assert webhook.usage_events() == []
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert not response_streaming.has_pending_response_inspection(flow)
    assert flow.response is not None
    assert flow.response.stream is False
