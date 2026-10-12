"""Bound model SSE inspection through installed stream and transport hooks."""

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
from tests.model_provider_sse_usage_helpers import model_sse_parse_warnings
from tests.model_sse_cooperative_helpers import (
    encode_model_sse,
    make_model_sse_pipeline_flow,
    model_sse_terminal,
    model_sse_update,
)


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


@pytest.mark.shard_cost(2)
@pytest.mark.parametrize("protocol", ["anthropic", "responses", "chat"])
async def test_gzip_callback_and_heartbeat_bound_usage_across_decoder_deliveries(
    real_flow, tmp_path, protocol
):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path, protocol=protocol)
    count = 10_000
    body = b"".join(model_sse_update(protocol, index) for index in range(1, count + 1))
    body += model_sse_terminal(protocol, count + 1)
    wire = encode_model_sse(body, "gzip")
    assert len(body) > 64 * 1024
    assert len(wire) < 65_535
    mitm_addon.responseheaders(flow)
    quantities = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
    heartbeat = asyncio.get_running_loop().create_future()
    asyncio.get_running_loop().call_soon(
        lambda: heartbeat.set_result(quantities.get("tokens.output", 0))
    )

    assert response_stream(flow)(wire) == wire
    # Real accepted usage values are a deterministic work oracle, not a mock.
    assert 0 < quantities["tokens.output"] <= 8
    assert response_streaming.has_pending_response_inspection(flow)
    assert not heartbeat.done()
    await mitm_addon.responseinspection(flow)
    assert 0 < await heartbeat <= 8
    assert quantities["tokens.output"] == count + 1
    assert not response_streaming.has_pending_response_inspection(flow)
    assert response_streaming.streamed_response_size(flow) == len(wire)
    assert response_stream(flow)(b"") == b""
    assert mitm_addon.response(flow) is None
    assert flow.response is not None
    assert flow.response.stream is False


@pytest.mark.parametrize("protocol", ["anthropic", "responses", "chat"])
@pytest.mark.parametrize("encoding", ["", "gzip", "deflate", "br"])
@pytest.mark.parametrize("chunk_size", [1, 7, None], ids=["bytewise", "split", "whole"])
async def test_partitions_preserve_final_usage_and_trailing_event(
    real_flow, tmp_path, protocol, encoding, chunk_size
):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path, protocol=protocol, encoding=encoding)
    body = b"\xef\xbb\xbf: heartbeat\n\n"
    body += b"".join(model_sse_update(protocol, index) for index in range(1, 41))
    # End with a captured trailing event rather than a blank-line terminator.
    body += model_sse_terminal(protocol, 41).rstrip(b"\n")
    body = body.replace(b"\n", b"\r\n")
    wire = encode_model_sse(body, encoding)
    chunks = (
        [wire]
        if chunk_size is None
        else [wire[offset : offset + chunk_size] for offset in range(0, len(wire), chunk_size)]
    )
    mitm_addon.responseheaders(flow)
    forwarded = bytearray()
    for chunk in chunks:
        emitted = response_stream(flow)(chunk)
        assert emitted == chunk
        assert isinstance(emitted, bytes)
        forwarded.extend(emitted)
        await mitm_addon.responseinspection(flow)
    assert response_stream(flow)(b"") == b""
    completion = mitm_addon.response(flow)
    if completion is not None:
        await completion
    assert forwarded == wire
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 41
    assert model_sse_parse_warnings(flow) == []
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize(
    "prefix",
    [b"\n" * 100, b": heartbeat\n\n" * 100, b"event: message_delta\ndata: {invalid}\n\n" * 100],
    ids=["blank", "heartbeat", "malformed"],
)
async def test_blank_and_ignored_frames_consume_work_before_usage(real_flow, tmp_path, prefix):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    wire = encode_model_sse(prefix + model_sse_terminal("anthropic", 17), "gzip")
    assert response_stream(flow)(wire) == wire
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
    assert response_streaming.has_pending_response_inspection(flow)
    await mitm_addon.responseinspection(flow)
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 17
    assert mitm_addon.response(flow) is None


@pytest.mark.parametrize(
    "prefix",
    [
        b"event: content_block_delta\ndata: " + b"x" * 100_000,
        b":" + b"x" * 100_000,
        b'event: message_delta\ndata: {"ignored":"' + b"x" * 100_000 + b'"}',
    ],
    ids=["discarded-data", "malformed-control", "captured-large-data"],
)
async def test_large_fragments_checkpoint_before_reaching_later_usage(real_flow, tmp_path, prefix):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    wire = encode_model_sse(prefix + b"\n\n" + model_sse_terminal("anthropic", 17), "gzip")
    assert response_stream(flow)(wire) == wire
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
    assert response_streaming.has_pending_response_inspection(flow)
    await mitm_addon.responseinspection(flow)
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 17
    assert mitm_addon.response(flow) is None


@pytest.mark.parametrize("protocol", ["anthropic", "responses", "chat"])
@pytest.mark.parametrize("interrupted", [False, True])
@pytest.mark.parametrize("corrupt", [False, True])
async def test_terminal_hooks_join_pending_usage_and_preserve_decode_error_policy(
    real_flow, tmp_path, usage_webhook_api, protocol, interrupted, corrupt
):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path, protocol=protocol, billable=True)
    body = b"".join(model_sse_update(protocol, index) for index in range(1, 41))
    body += model_sse_terminal(protocol, 41)
    wire = encode_model_sse(body, "gzip")
    if corrupt:
        wire = wire[:-1]
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        if interrupted:
            flow.error = Error("synthetic stream interruption")
            completion = mitm_addon.error(flow)
        else:
            completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")
    quantities = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
    if corrupt and protocol != "responses":
        assert quantities == {}
        assert webhook.usage_events() == []
    else:
        assert quantities["tokens.output"] == 41
        events = webhook.usage_events()
        assert len(events) == 1
        assert events[0]["quantity"] == 41
    if corrupt:
        (warning,) = model_sse_parse_warnings(flow)
        assert warning["error"] == body_decoding.INCOMPLETE_COMPRESSED_BODY
    assert flow.response is not None
    assert flow.response.stream is False
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize("terminal", ["release", "response", "error", "checkpoint"])
@pytest.mark.parametrize("accepted_prefix", [False, True])
async def test_abandonment_keeps_only_accepted_prefix_and_reports_incomplete_inspection(
    real_flow, tmp_path, terminal, accepted_prefix
):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path)
    prefix = model_sse_update("anthropic", 7) if accepted_prefix else b""
    wire = encode_model_sse(prefix + b"\n" * 100 + model_sse_terminal("anthropic", 999), "gzip")
    mitm_addon.responseheaders(flow)
    assert response_stream(flow)(wire) == wire
    quantities = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]
    assert quantities == ({"tokens.output": 7} if accepted_prefix else {})
    assert response_streaming.has_pending_response_inspection(flow)
    if terminal == "release":
        response_streaming.release_response_stream_state(flow)
    else:
        if terminal == "checkpoint":
            completion = mitm_addon.responseinspection(flow)
        elif terminal == "error":
            flow.error = Error("synthetic error during inspection")
            completion = mitm_addon.error(flow)
        else:
            completion = mitm_addon.response(flow)
        assert completion is not None
        task = asyncio.ensure_future(completion)
        asyncio.get_running_loop().call_soon(task.cancel)
        with pytest.raises(asyncio.CancelledError):
            await task
        # A later terminal notification must not finish the uninspected suffix.
        completion = mitm_addon.response(flow)
        if completion is not None:
            await completion
    response_streaming.release_response_stream_state(flow)
    await mitm_addon.responseinspection(flow)
    assert quantities == ({"tokens.output": 7} if accepted_prefix else {})
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    failures = [
        entry for entry in entries if entry.get("reason") == "response_inspection_interrupted"
    ]
    assert len(failures) == 1
    assert failures[0]["parse_error"] == "response inspection interrupted"
    assert not response_streaming.has_pending_response_inspection(flow)
    assert flow.response is not None
    assert flow.response.stream is False


async def test_long_lived_stream_has_no_lifetime_event_cap(real_flow, tmp_path):
    flow = make_model_sse_pipeline_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    for index in range(20):
        body = b"".join(model_sse_update("anthropic", index * 100 + n) for n in range(1, 101))
        wire = encode_model_sse(body, "gzip")
        assert response_stream(flow)(wire) == wire
        await mitm_addon.responseinspection(flow)
    wire = encode_model_sse(model_sse_terminal("anthropic", 2001), "gzip")
    assert response_stream(flow)(wire) == wire
    await mitm_addon.responseinspection(flow)
    assert mitm_addon.response(flow) is None
    assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]["tokens.output"] == 2001
