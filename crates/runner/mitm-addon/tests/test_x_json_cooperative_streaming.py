"""Ordinary X JSON scheduling, complete-document billing and cancellation."""

import asyncio
import gzip
import zlib

import brotli
import pytest
from mitmproxy.flow import Error

import body_decoding
import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.x_flow_helpers import make_x_pipeline_flow, make_x_response_flow, x_json_user_page
from usage.providers.connectors import x_response_inspection
from usage.providers.connectors.x_resources import IDENTITY_BODY_LIMIT


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _user_flow(real_flow, tmp_path, *, encoding="gzip", request_hint=True):
    return make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/users/search",
        query="query=user&user.fields=description" + ("&max_results=1000" if request_hint else ""),
        permission="users.read",
        rule="GET /2/users/search",
        content_encoding=encoding,
    )


def _encode(body, encoding):
    if encoding == "gzip":
        return gzip.compress(body)
    if encoding == "deflate":
        return zlib.compress(body)
    if encoding == "br":
        return brotli.compress(body)
    return body


@pytest.mark.parametrize("representation", ["ascii", "utf8", "escaped"])
@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
async def test_supported_page_yields_without_publishing_partial_usage(
    real_flow, tmp_path, usage_webhook_api, representation, encoding
):
    flow = _user_flow(real_flow, tmp_path, encoding=encoding)
    body = x_json_user_page(representation=representation)
    wire = _encode(body, encoding)
    assert len(body) > 64 * 1024
    assert len(wire) < 65_535
    mitm_addon.responseheaders(flow)
    loop = asyncio.get_running_loop()
    heartbeat = loop.create_future()
    with usage_webhook_api() as webhook:
        loop.call_soon(
            lambda: heartbeat.set_result(
                (
                    response_streaming.has_pending_response_inspection(flow),
                    flow.metadata.get(metadata_keys.X_JSON_STATE),
                    webhook.usage_events(),
                )
            )
        )
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        assert not heartbeat.done()
        await mitm_addon.responseinspection(flow)
        assert await heartbeat == (True, None, [])
        assert metadata_keys.X_JSON_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert response_streaming.streamed_response_size(flow) == len(wire)
        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")

    state = flow.metadata[metadata_keys.X_JSON_STATE]
    assert state["body_parsed"] is True
    assert state["body_truncated"] is False
    assert state["response_data_count"] == state["response_result_count"] == 1_000
    assert "parse_error" not in state
    (event,) = webhook.usage_events()
    assert event["category"] == "user.read"
    assert event["quantity"] == 1_000
    assert event["observedAt"] == state["observed_at"]
    if len(body) <= IDENTITY_BODY_LIMIT:
        assert event["resources"] == [
            {"id": str(10**18 + index), "occurrences": 1} for index in range(1_000)
        ]
        assert event["remainder"] == []
    else:
        assert event["resources"] == []
        assert event["remainder"] == [{"reason": "identity_limit", "quantity": 1_000}]
    assert not response_streaming.has_pending_response_inspection(flow)
    assert flow.response is not None
    assert flow.response.stream is False


def test_parser_step_limits_input_before_malformed_suffix(real_flow):
    flow = make_x_response_flow(real_flow)
    parser = x_response_inspection.create_response_parser(
        flow, "https://api.x.com/2/tweets", on_row=lambda *_: None
    )
    assert parser is not None
    assert parser.feed_steps is not None
    assert parser.should_continue is not None
    steps = parser.feed_steps(b" " * 4096 + b"!")
    next(steps)
    assert parser.should_continue()
    next(steps)
    assert not parser.should_continue()
    assert list(steps) == []
    assert parser.finish is not None
    parser.finish()
    assert flow.metadata[metadata_keys.X_JSON_STATE]["body_parsed"] is False
    assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"]


@pytest.mark.parametrize("representation", ["utf8", "escaped"])
@pytest.mark.parametrize("encoding", ["", "gzip", "deflate", "br"])
@pytest.mark.parametrize("chunk_size", [7, None], ids=["split", "whole"])
async def test_wire_partitions_preserve_lexical_state_counts_and_identities(
    real_flow, tmp_path, usage_webhook_api, representation, encoding, chunk_size
):
    flow = _user_flow(real_flow, tmp_path, encoding=encoding)
    body = x_json_user_page(80, representation=representation)
    wire = _encode(body, encoding)
    size = chunk_size or len(wire)
    mitm_addon.responseheaders(flow)
    forwarded = bytearray()
    with usage_webhook_api() as webhook:
        for offset in range(0, len(wire), size):
            chunk = wire[offset : offset + size]
            emitted = response_stream(flow)(chunk)
            assert emitted == chunk
            assert isinstance(emitted, bytes)
            forwarded.extend(emitted)
            await mitm_addon.responseinspection(flow)
        assert forwarded == wire
        assert metadata_keys.X_JSON_STATE not in flow.metadata
        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    state = flow.metadata[metadata_keys.X_JSON_STATE]
    assert state["body_parsed"] is True
    assert state["response_data_count"] == state["response_result_count"] == 80
    (event,) = webhook.usage_events()
    assert event["quantity"] == 80
    assert event["resources"] == [
        {"id": str(10**18 + index), "occurrences": 1} for index in range(80)
    ]
    assert event["remainder"] == []


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("split", [False, True], ids=["one-wire-chunk", "two-wire-chunks"])
@pytest.mark.parametrize("extra_space", [0, 1], ids=["exact-budget", "one-unit-over"])
async def test_document_budget_survives_parser_decoder_and_wire_boundaries(
    real_flow, tmp_path, usage_webhook_api, encoding, split, extra_space
):
    # The JSON root consumes thirteen work units; trailing whitespace uses one per byte.
    body = b'{"data":[{"id":"1"}]}' + b" " * (65_523 + extra_space)
    parts = [body[: len(body) // 2], body[len(body) // 2 :]] if split else [body]
    flow = _user_flow(real_flow, tmp_path, encoding=encoding)
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        for part in parts:
            wire = _encode(part, encoding)
            assert response_stream(flow)(wire) == wire
            await mitm_addon.responseinspection(flow)
        if extra_space:
            # Permanent parser failure must stop the decoder before this corrupt member.
            corrupt = _encode(b"", encoding)
            corrupt = corrupt[:-1] + bytes([corrupt[-1] ^ 0xFF])
            assert response_stream(flow)(corrupt) == corrupt
            await mitm_addon.responseinspection(flow)
        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    state = flow.metadata[metadata_keys.X_JSON_STATE]
    if extra_space:
        assert state["body_parsed"] is False
        assert state["parse_error"] == "work limit exceeded"
        assert "response_data_count" not in state
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1_000
        assert event["resources"] == []
        assert event["remainder"] == [{"reason": "parse_fallback", "quantity": 1_000}]
    else:
        assert state["body_parsed"] is True
        assert state["response_data_count"] == 1
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1
        assert event["resources"] == [{"id": "1", "occurrences": 1}]


@pytest.mark.parametrize("encoding", ["gzip", "deflate"])
@pytest.mark.parametrize("failure", ["incomplete", "checksum", "trailing-json"])
@pytest.mark.parametrize("request_hint", [False, True], ids=["no-hint", "request-fallback"])
async def test_terminal_join_rejects_invalid_suffix_after_selected_counts(
    real_flow, tmp_path, usage_webhook_api, encoding, failure, request_hint
):
    flow = _user_flow(real_flow, tmp_path, encoding=encoding, request_hint=request_hint)
    body = x_json_user_page()
    if failure == "trailing-json":
        body += b"!"
    wire = _encode(body, encoding)
    if failure == "incomplete":
        wire = wire[:-1]
    elif failure == "checksum":
        wire = wire[:-1] + bytes([wire[-1] ^ 0xFF])
    mitm_addon.responseheaders(flow)
    with usage_webhook_api() as webhook:
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    state = flow.metadata[metadata_keys.X_JSON_STATE]
    assert state["body_parsed"] is False
    assert "response_data_count" not in state
    assert "resource_identities" not in state
    assert (
        state["parse_error"]
        == {
            "incomplete": body_decoding.INCOMPLETE_COMPRESSED_BODY,
            "checksum": body_decoding.INVALID_COMPRESSED_BODY,
            "trailing-json": "trailing data after root value",
        }[failure]
    )
    if request_hint:
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1_000
        assert event["resources"] == []
        assert event["remainder"] == [{"reason": "parse_fallback", "quantity": 1_000}]
    else:
        assert webhook.usage_events() == []
    assert not response_streaming.has_pending_response_inspection(flow)


@pytest.mark.parametrize("terminal", ["release", "close", "response", "error", "checkpoint"])
async def test_abandonment_discards_valid_prefix_and_next_flow_recovers(
    real_flow, tmp_path, usage_webhook_api, terminal
):
    flow = _user_flow(real_flow, tmp_path, request_hint=False)
    body = b'{"data":[{"id":"prefix"}]}' + b" " * 40_000 + b"!"
    wire = _encode(body, "gzip")
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
        usage.flush_usage_events(trigger="test")
        state = flow.metadata[metadata_keys.X_JSON_STATE]
        assert state["body_parsed"] is False
        assert state["parse_error"] == "response inspection interrupted"
        assert "response_data_count" not in state
        assert "resource_identities" not in state
        assert webhook.usage_events() == []
        assert not response_streaming.has_pending_response_inspection(flow)
        assert flow.response is not None
        assert flow.response.stream is False

        recovered = _user_flow(real_flow, tmp_path, encoding="")
        mitm_addon.responseheaders(recovered)
        assert response_stream(recovered)(b'{"data":[{"id":"999"}]}') == b'{"data":[{"id":"999"}]}'
        assert mitm_addon.response(recovered) is None
        usage.flush_usage_events(trigger="test")
    (event,) = webhook.usage_events()
    assert event["quantity"] == 1
    assert event["resources"] == [{"id": "999", "occurrences": 1}]
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert len([e for e in entries if e.get("reason") == "response_inspection_interrupted"]) == 1
