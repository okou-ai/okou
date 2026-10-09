"""Bound aggregate X work without losing rows at transport/decoder boundaries."""

import asyncio
import gzip
import uuid
import zlib
from collections import Counter

import brotli
import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.x_flow_helpers import make_x_pipeline_flow


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _flow(real_flow, tmp_path, *, encoding="gzip"):
    return make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_run_id=str(uuid.uuid4()),
        content_encoding=encoding,
    )


def _encode(body: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body)
    if encoding == "br":
        return brotli.compress(body)
    if encoding == "deflate":
        return zlib.compress(body)
    return body


async def test_gzip_callback_bounds_real_rows_and_yields_before_reporting_all(
    real_flow, tmp_path, usage_webhook_api
):
    flow = _flow(real_flow, tmp_path)
    # 300 KiB crosses several decoded feeds but fits below the existing grace.
    rows = 100_000
    wire = gzip.compress(b"{}\n" * rows + b'{"data":{"id":"1"}}\n')
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        heartbeat = asyncio.get_running_loop().create_future()
        asyncio.get_running_loop().call_soon(lambda: heartbeat.set_result(state["lines_parsed"]))

        assert response_stream(flow)(wire) == wire
        # This is a work bound, not the billing oracle; the real reporter runs.
        assert 0 < state["lines_parsed"] <= 8
        assert not heartbeat.done()
        await mitm_addon.responseinspection(flow)
        assert await heartbeat <= 8
        assert state["lines_parsed"] == rows + 1
        assert state["lines_failed"] == 0
        assert not response_streaming.has_pending_connector_inspection(flow)

        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")

    (event,) = webhook.usage_events()
    assert event["quantity"] == 1
    assert event["resources"] == [{"id": "1", "occurrences": 1}]
    assert webhook.request_count == 1


@pytest.mark.parametrize("encoding", ["", "gzip", "deflate", "br"])
@pytest.mark.parametrize("chunk_size", [1, 7, None], ids=["bytewise", "split", "whole"])
async def test_transport_partitions_preserve_rows_resources_and_failures(
    real_flow, tmp_path, usage_webhook_api, encoding, chunk_size
):
    flow = _flow(real_flow, tmp_path, encoding=encoding)
    body = b"\r\n" + b"".join(
        b'{"data":{"id":"' + str(index).encode() + b'"}}\r\n' for index in range(40)
    )
    body += b"invalid\n\n" + b'{"data":{"id":"40"}}'  # complete trailing row
    wire = _encode(body, encoding)
    chunks = (
        [wire]
        if chunk_size is None
        else [wire[offset : offset + chunk_size] for offset in range(0, len(wire), chunk_size)]
    )
    forwarded = bytearray()
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        for chunk in chunks:
            emitted = response_stream(flow)(chunk)
            assert emitted == chunk
            forwarded.extend(chunk)
            # The production transport checkpoint, not a test parser drain.
            await mitm_addon.responseinspection(flow)
        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")

    assert forwarded == wire
    assert state["lines_parsed"] == 41
    assert state["lines_failed"] == 1
    events = webhook.usage_events()
    assert len(events) == 41
    assert len({event["idempotencyKey"] for event in events}) == 41
    assert all(event["quantity"] == 1 for event in events)
    assert [event["resources"] for event in events] == [
        [{"id": str(index), "occurrences": 1}] for index in range(41)
    ]


@pytest.mark.parametrize("interrupted", [False, True])
@pytest.mark.parametrize("corrupt", [False, True])
async def test_terminal_hooks_join_pending_rows_and_never_rebill(
    real_flow, tmp_path, usage_webhook_api, interrupted, corrupt
):
    flow = _flow(real_flow, tmp_path)
    body = b"".join(b'{"data":{"id":"' + str(index).encode() + b'"}}\n' for index in range(40))
    body += b'{"data":{"id":"40"}}'
    wire = gzip.compress(body)
    if corrupt:
        wire = wire[:-1]  # completed rows survive, trailing row must not bill
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_connector_inspection(flow)
        if interrupted:
            flow.error = Error("synthetic interrupted stream")
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
        assert flow.response is not None
        assert flow.response.stream is False

    events = webhook.usage_events()
    assert len(events) == (40 if corrupt else 41)
    assert Counter(event["quantity"] for event in events) == {1: len(events)}
    assert len({event["idempotencyKey"] for event in events}) == len(events)
    if corrupt:
        assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"] == (
            "incomplete compressed body"
        )


async def test_long_lived_stream_reuses_quantum_without_a_lifetime_limit(
    real_flow, tmp_path, usage_webhook_api
):
    flow = _flow(real_flow, tmp_path)
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        for _ in range(20):
            wire = gzip.compress(b"{}\n" * 100)
            assert response_stream(flow)(wire) == wire
            await mitm_addon.responseinspection(flow)
        wire = gzip.compress(b'{"data":{"id":"1"}}\n')
        assert response_stream(flow)(wire) == wire
        await mitm_addon.responseinspection(flow)
        assert state["lines_parsed"] == 2001
        assert state["lines_failed"] == 0
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    (event,) = webhook.usage_events()
    assert event["resources"] == [{"id": "1", "occurrences": 1}]


@pytest.mark.parametrize("cancel_terminal", [False, True], ids=["release", "cancel"])
async def test_abandoned_pending_inspection_is_explicit_and_releases_input(
    real_flow, tmp_path, usage_webhook_api, cancel_terminal
):
    flow = _flow(real_flow, tmp_path)
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        wire = gzip.compress(b"{}\n" * 100 + b'{"data":{"id":"uninspected"}}\n')
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_connector_inspection(flow)
        if cancel_terminal:
            completion = mitm_addon.response(flow)
            assert completion is not None
            task = asyncio.ensure_future(completion)
            await asyncio.sleep(0)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            response_streaming.release_response_stream_state(flow)
        await mitm_addon.responseinspection(flow)
        response_streaming.release_response_stream_state(flow)
        assert flow.response is not None
        assert flow.response.stream is False
        assert not response_streaming.has_pending_connector_inspection(flow)
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert flow.metadata[metadata_keys.X_JSON_STATE]["body_parsed"] is False
        assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"] == (
            "response inspection interrupted"
        )
        usage.flush_usage_events(trigger="test")
    assert webhook.usage_events() == []
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert (
        len(
            [entry for entry in entries if entry.get("reason") == "response_inspection_interrupted"]
        )
        == 1
    )
