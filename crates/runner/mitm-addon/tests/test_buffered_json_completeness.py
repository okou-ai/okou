"""Usage must distinguish a complete captured response from a valid prefix."""

import json
import struct

import pytest
import zstandard
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from body_limits import STREAM_BUFFER_LIMIT
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_response_helpers import (
    ANTHROPIC_JSON_CASE,
    expected_event_quantities,
    model_provider_flow,
    standard_success_payload,
)
from tests.x_flow_helpers import make_x_pipeline_flow, make_x_stream_pipeline_flow


@pytest.fixture(autouse=True)
def _sync_usage_delivery(sync_usage_executor):
    """Deliver usage to the local webhook within each terminal hook."""


def _zstd_wire_body(payload: bytes, *, truncated: bool) -> bytes:
    frame = zstandard.ZstdCompressor().compress(payload)
    # A standard skippable frame puts a complete JSON document exactly at the
    # capture limit. A second complete data frame can invalidate only its suffix.
    padding_size = STREAM_BUFFER_LIMIT - len(frame) - 8
    assert padding_size >= 0
    prefix = frame + struct.pack("<II", 0x184D2A50, padding_size) + b"x" * padding_size
    assert len(prefix) == STREAM_BUFFER_LIMIT
    if truncated:
        return prefix + zstandard.ZstdCompressor().compress(b" invalid-trailing-json")
    return prefix


def _stream_wire_body(flow, wire: bytes, chunk_size: int | None) -> None:
    mitm_addon.responseheaders(flow)
    callback = response_stream(flow)
    step = chunk_size or len(wire)
    for offset in range(0, len(wire), step):
        chunk = wire[offset : offset + step]
        assert callback(chunk) == chunk
    assert callback(b"") == b""
    assert len(flow.metadata[metadata_keys.STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
    assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is (
        len(wire) > STREAM_BUFFER_LIMIT
    )


@pytest.mark.parametrize("chunk_size", [None, 257], ids=["whole", "fragmented"])
@pytest.mark.parametrize("truncated", [False, True], ids=["exact-limit", "omitted-suffix"])
@pytest.mark.parametrize("query", ["", "max_results=50"], ids=["no-hints", "request-hint"])
def test_x_buffered_json_requires_complete_capture(
    tmp_path, real_flow, usage_webhook_api, chunk_size, truncated, query
):
    flow = make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query=query,
        rule="GET /2/tweets/search/recent",
        content_encoding="zstd",
    )
    payload = (
        b'{"data":[{"id":"synthetic-post"}],"meta":{"result_count":1},'
        b'"includes":{"users":[{"id":"u1"},{"id":"u2"}]}}'
    )
    _stream_wire_body(flow, _zstd_wire_body(payload, truncated=truncated), chunk_size)

    with usage_webhook_api() as webhook:
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    expected = {"posts.read": 50} if query else {}
    if not truncated:
        expected = {"posts.read": 1, "user.read": 2}
    events = webhook.usage_events()
    assert {event["category"]: event["quantity"] for event in events} == expected
    assert len(events) == len(expected)
    lost_visibility = [
        entry
        for entry in read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        if "unparseable" in entry["message"].lower()
    ]
    if truncated and not query:
        assert len(lost_visibility) == 1
        assert lost_visibility[0]["body_truncated"] is True
        assert lost_visibility[0]["parse_error"] == "incomplete compressed body"
    else:
        assert lost_visibility == []


@pytest.mark.parametrize("chunk_size", [None, 257], ids=["whole", "fragmented"])
@pytest.mark.parametrize("truncated", [False, True], ids=["exact-limit", "omitted-suffix"])
def test_model_buffered_json_requires_complete_capture(
    tmp_path, real_flow, usage_webhook_api, chunk_size, truncated
):
    flow = model_provider_flow(real_flow, tmp_path, ANTHROPIC_JSON_CASE)
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "application/json", "content-encoding": "zstd"}),
    )
    payload = standard_success_payload(ANTHROPIC_JSON_CASE)
    _stream_wire_body(flow, _zstd_wire_body(payload, truncated=truncated), chunk_size)

    with usage_webhook_api() as webhook:
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    expected = {} if truncated else expected_event_quantities(ANTHROPIC_JSON_CASE)
    events = webhook.usage_events()
    assert {event["category"]: event["quantity"] for event in events} == expected
    assert len(events) == len(expected)


@pytest.mark.parametrize("body_format", ["json", "ndjson"])
@pytest.mark.parametrize("interrupted", [False, True], ids=["response", "error"])
def test_x_incremental_billing_after_forensic_capture_truncates(
    tmp_path, real_flow, usage_webhook_api, body_format, interrupted
):
    first_post = {"id": "first", "text": "x" * STREAM_BUFFER_LIMIT}
    last_post = {"id": "after-capture-limit"}
    if body_format == "ndjson":
        flow = make_x_stream_pipeline_flow(real_flow, tmp_path)
        body = (
            json.dumps({"data": first_post}).encode()
            + b"\n"
            + json.dumps({"data": last_post, "includes": {"users": [{"id": "u1"}]}}).encode()
            + b"\n"
        )
        if interrupted:
            body += b'{"data":{"id":"unfinished'
    else:
        flow = make_x_pipeline_flow(real_flow, tmp_path, query="ids=1,2,3")
        body = json.dumps(
            {"data": [first_post, last_post], "includes": {"users": [{"id": "u1"}]}}
        ).encode()
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    mitm_addon.responseheaders(flow)
    callback = response_stream(flow)
    assert callback(body[:STREAM_BUFFER_LIMIT]) == body[:STREAM_BUFFER_LIMIT]
    assert callback(body[STREAM_BUFFER_LIMIT:]) == body[STREAM_BUFFER_LIMIT:]
    assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE]["truncated"] is True

    with usage_webhook_api() as webhook:
        if interrupted:
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)
        else:
            assert callback(b"") == b""
            mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    expected = {} if interrupted and body_format == "json" else {"posts.read": 2, "user.read": 1}
    events = webhook.usage_events()
    assert {event["category"]: event["quantity"] for event in events} == expected
    assert len(events) == len(expected)
