"""Buffered model JSON scheduling, validation and terminal ownership contracts."""

import asyncio
from types import SimpleNamespace

import pytest
import zstandard
from mitmproxy.flow import Error

import body_decoding
import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
import response_streaming
import usage
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT, STREAM_BUFFER_LIMIT
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_json_cooperative_helpers import make_model_json_pipeline_flow, model_json_body
from usage.json_selective import JsonSelectiveExtractor


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _stream_body(flow, wire, chunk_size=None):
    mitm_addon.responseheaders(flow)
    size = chunk_size or len(wire) or 1
    for offset in range(0, len(wire), size):
        chunk = wire[offset : offset + size]
        assert response_stream(flow)(chunk) == chunk
        assert not response_streaming.has_pending_response_inspection(flow)
    assert response_stream(flow)(b"") == b""
    assert response_streaming.streamed_response_size(flow) == len(wire)


@pytest.mark.parametrize("protocol", ["anthropic", "responses", "chat"])
@pytest.mark.parametrize("billable", [False, True])
@pytest.mark.parametrize("ensure_ascii", [False, True], ids=["utf8", "escaped"])
@pytest.mark.parametrize("chunk_size", [None, 7], ids=["whole", "partitioned"])
async def test_terminal_parser_yields_bounded_steps_before_publishing_usage(
    real_flow,
    tmp_path,
    usage_webhook_api,
    monkeypatch,
    protocol,
    billable,
    ensure_ascii,
    chunk_size,
):
    flow = make_model_json_pipeline_flow(
        real_flow, tmp_path, protocol=protocol, encoding="zstd", billable=billable
    )
    body = model_json_body(protocol, ensure_ascii=ensure_ascii)
    # Split a JSON token across strict concatenated frames as well as wire callbacks.
    midpoint = len(body) // 2
    compressor = zstandard.ZstdCompressor()
    wire = compressor.compress(body[:midpoint]) + compressor.compress(body[midpoint:])
    assert len(wire) < STREAM_BUFFER_LIMIT < len(body)
    _stream_body(flow, wire, chunk_size)
    original_feed = JsonSelectiveExtractor.feed
    feeds = []

    def observe_feed(extractor, chunk):
        feeds.append((id(extractor), len(chunk)))
        original_feed(extractor, chunk)

    monkeypatch.setattr(JsonSelectiveExtractor, "feed", observe_feed)
    loop = asyncio.get_running_loop()
    heartbeat = loop.create_future()
    turn_steps = []
    last_steps = 0
    finished = False
    with usage_webhook_api() as webhook:

        def pulse():
            nonlocal last_steps
            turn_steps.append(len(feeds) - last_steps)
            last_steps = len(feeds)
            if not heartbeat.done():
                heartbeat.set_result(
                    (
                        response_streaming.has_pending_response_inspection(flow),
                        flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE),
                        webhook.usage_events(),
                    )
                )
            if not finished:
                loop.call_soon(pulse)

        loop.call_soon(pulse)
        completion = mitm_addon.response(flow)
        assert completion is not None
        assert not heartbeat.done()
        try:
            await completion
        finally:
            finished = True
        assert await heartbeat == (True, None, [])
        assert sum(size for _, size in feeds) == len(body)
        assert len({owner for owner, _ in feeds}) == 1
        assert max(size for _, size in feeds) <= 4096
        assert max([*turn_steps, len(feeds) - last_steps]) <= 8
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        assert sum(size for _, size in feeds) == len(body)
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
    if billable:
        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 50,
            "tokens.output": 200,
        }
    assert flow.response is not None
    assert flow.response.stream is False
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize(
    ("failure", "expected_error"),
    [
        ("truncated-frame", body_decoding.INCOMPLETE_COMPRESSED_BODY),
        ("checksum", body_decoding.INVALID_COMPRESSED_BODY),
        ("truncated-next-frame", body_decoding.INCOMPLETE_COMPRESSED_BODY),
        ("frame-limit", body_decoding.COMPRESSED_FRAME_LIMIT_EXCEEDED),
        ("decoded-limit", body_decoding.DECODED_BODY_LIMIT_EXCEEDED),
        ("capture-limit", body_decoding.INCOMPLETE_COMPRESSED_BODY),
        ("trailing-json", "trailing data after root value"),
        ("truncated-json", "incomplete json"),
        ("empty-document", "incomplete json"),
    ],
)
async def test_strict_validation_rejects_selected_prefix_usage(
    real_flow, tmp_path, usage_webhook_api, failure, expected_error
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="zstd", billable=True)
    body = model_json_body()
    if failure == "decoded-limit":
        body += b" " * LARGE_RESPONSE_DECOMPRESS_LIMIT
    elif failure == "trailing-json":
        body += b"!"
    elif failure == "truncated-json":
        body = body[:-1]
    elif failure == "empty-document":
        body = b""
    compressor = zstandard.ZstdCompressor(write_checksum=True)
    wire = compressor.compress(body)
    if failure == "truncated-frame":
        wire = wire[:-1]
    elif failure == "checksum":
        wire = wire[:-1] + bytes([wire[-1] ^ 0xFF])
    elif failure == "truncated-next-frame":
        wire += compressor.compress(b" ")[:-1]
    elif failure == "frame-limit":
        wire += compressor.compress(b"") * 64
    elif failure == "capture-limit":
        wire += b"x" * STREAM_BUFFER_LIMIT
    _stream_body(flow, wire)
    with usage_webhook_api() as webhook:
        completion = mitm_addon.response(flow)
        if completion is not None:
            await completion
        usage.flush_usage_events(trigger="test")
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert webhook.usage_events() == []
    warnings = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert [
        entry["error"]
        for entry in warnings
        if entry.get("message") == "Model provider JSON usage extraction failed"
    ] == [expected_error]
    assert metadata_keys.STREAM_BUFFER not in flow.metadata


@pytest.mark.parametrize("extra_space", [0, 1], ids=["exact-budget", "one-over"])
async def test_document_budget_spans_all_terminal_parser_turns(
    real_flow, tmp_path, usage_webhook_api, extra_space
):
    body = b'{"usage":{"input_tokens":1}}' + b" " * (65_526 + extra_space)
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="zstd", billable=True)
    _stream_body(flow, zstandard.ZstdCompressor().compress(body), 7)
    with usage_webhook_api() as webhook:
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
    if extra_space:
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert webhook.usage_events() == []
        warnings = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert any(entry.get("error") == "work limit exceeded" for entry in warnings)
    else:
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {"tokens.input": 1}
        assert [event["quantity"] for event in webhook.usage_events()] == [1]


@pytest.mark.parametrize("body", [b"", b"{}", b'{"content":[{"text":"hello"}]}'])
async def test_empty_capture_or_missing_usage_remains_unreported(
    real_flow, tmp_path, usage_webhook_api, body
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="zstd", billable=True)
    wire = zstandard.ZstdCompressor().compress(body) if body else b""
    _stream_body(flow, wire)
    with usage_webhook_api() as webhook:
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert webhook.usage_events() == []


@pytest.mark.parametrize("billable", [False, True])
async def test_complete_interrupted_document_does_not_authorize_success_billing(
    real_flow, tmp_path, usage_webhook_api, billable
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="zstd", billable=billable)
    _stream_body(flow, zstandard.ZstdCompressor().compress(model_json_body()))
    flow.error = Error("connection closed after complete captured JSON")
    with usage_webhook_api() as webhook:
        completion = mitm_addon.error(flow)
        assert completion is not None
        await completion
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert webhook.usage_events() == []
    assert flow.response is not None
    assert flow.response.stream is False


@pytest.mark.parametrize("terminal", ["response", "error"])
@pytest.mark.parametrize("interruption", ["cancel", "release", "abandon"])
async def test_interruption_discards_uninspected_suffix_and_a_later_flow_recovers(
    real_flow, tmp_path, usage_webhook_api, terminal, interruption
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="zstd", billable=True)
    body = model_json_body(characters=0) + b" " * 40_000 + b"!"
    _stream_body(flow, zstandard.ZstdCompressor().compress(body))
    with usage_webhook_api() as webhook:
        flow.error = Error("connection failed during buffered inspection")
        completion = getattr(mitm_addon, terminal)(flow)
        assert completion is not None
        assert response_streaming.has_pending_response_inspection(flow)
        if interruption == "cancel":
            task = asyncio.ensure_future(completion)
            asyncio.get_running_loop().call_soon(task.cancel)
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            if interruption == "release":
                response_streaming.release_response_stream_state(flow)
            else:
                response_streaming.abandon_response_inspection(flow)
            await completion
        assert mitm_addon.response(flow) is None
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
        assert webhook.usage_events() == []
        assert flow.response is not None
        assert flow.response.stream is False
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert not response_streaming.has_pending_response_inspection(flow)
        recovered = make_model_json_pipeline_flow(
            real_flow, tmp_path, encoding="zstd", billable=True
        )
        _stream_body(recovered, zstandard.ZstdCompressor().compress(model_json_body()))
        completion = mitm_addon.response(recovered)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
    assert len(webhook.usage_events()) == 2
    warnings = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert (
        len(
            [
                entry
                for entry in warnings
                if entry.get("reason") == "response_inspection_interrupted"
            ]
        )
        == 1
    )


@pytest.mark.parametrize("terminal", ["response", "error"])
async def test_network_latency_excludes_new_terminal_parser_waits(
    real_flow, tmp_path, usage_webhook_api, monkeypatch, terminal
):
    flow = make_model_json_pipeline_flow(real_flow, tmp_path, encoding="zstd")
    _stream_body(flow, zstandard.ZstdCompressor().compress(model_json_body()))
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = 10.0
    flow.error = Error("synthetic interruption")
    now = 10.125
    monkeypatch.setattr(logging_utils, "time", SimpleNamespace(monotonic=lambda: now))
    loop = asyncio.get_running_loop()
    waited = loop.create_future()

    def advance_clock():
        nonlocal now
        now = 20.0
        waited.set_result(response_streaming.has_pending_response_inspection(flow))

    with usage_webhook_api():
        loop.call_soon(advance_clock)
        completion = getattr(mitm_addon, terminal)(flow)
        assert completion is not None
        await completion
    assert await waited is True
    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["latency_ms"] == 125
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
