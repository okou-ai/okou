"""Cooperate inside costly X rows without changing acceptance or row billing."""

import asyncio
import gzip
import uuid

import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.x_flow_helpers import make_x_pipeline_flow, make_x_response_flow


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _costly_row(repetitions):
    return b'{"data":{"id":"1","text":"' + b"\\u0061" * repetitions + b'"}}'


@pytest.mark.parametrize("repetitions", [250_000, 350_000], ids=["accepted", "over-budget"])
@pytest.mark.parametrize("terminated", [False, True], ids=["eof", "newline"])
@pytest.mark.parametrize("encoding", ["", "gzip"], ids=["identity", "gzip"])
@pytest.mark.parametrize("chunk_size", [64 * 1024, None], ids=["64k", "whole"])
async def test_costly_row_yields_before_completion_and_preserves_billing(
    real_flow, tmp_path, usage_webhook_api, repetitions, terminated, encoding, chunk_size
):
    flow = make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_run_id=str(uuid.uuid4()),
        content_encoding=encoding,
    )
    body = _costly_row(repetitions)
    if terminated:
        body += b'\n{"data":{"id":"2"}}\n'
    wire = gzip.compress(body) if encoding else body
    chunk_size = chunk_size or len(wire)
    yielded_while_pending = False

    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        for offset in range(0, len(wire), chunk_size):
            chunk = wire[offset : offset + chunk_size]
            heartbeat = asyncio.get_running_loop().create_future()
            asyncio.get_running_loop().call_soon(
                lambda h=heartbeat: h.set_result(
                    (
                        response_streaming.has_pending_response_inspection(flow),
                        state["lines_parsed"],
                        state["lines_failed"],
                    )
                )
            )
            assert response_stream(flow)(chunk) == chunk
            await mitm_addon.responseinspection(flow)
            pending, parsed, failed = await heartbeat
            yielded_while_pending |= pending and parsed == failed == 0

        # A real ready callback runs while inspection of this one row remains
        # pending, including when the wire arrives in ordinary 64 KiB chunks.
        assert yielded_while_pending
        if not terminated:
            assert state["lines_parsed"] == state["lines_failed"] == 0
            usage.flush_usage_events(trigger="test")
            assert webhook.usage_events() == []

        assert response_stream(flow)(b"") == b""
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")

    accepted = repetitions == 250_000
    assert state["lines_parsed"] == int(accepted) + int(terminated)
    assert state["lines_failed"] == int(not accepted)
    assert state["data_count"] == state["lines_parsed"]
    events = webhook.usage_events()
    assert len(events) == state["lines_parsed"]
    assert len({event["idempotencyKey"] for event in events}) == len(events)
    assert all(event["quantity"] == 1 for event in events)
    if accepted:
        assert events[0]["resources"] == []
        assert events[0]["remainder"] == [{"reason": "identity_limit", "quantity": 1}]
    if terminated:
        assert events[-1]["resources"] == [{"id": "2", "occurrences": 1}]
        assert events[-1]["remainder"] == []


@pytest.mark.parametrize("cancel_terminal", [False, True], ids=["release", "cancel"])
@pytest.mark.parametrize("terminated", [False, True], ids=["eof", "newline"])
async def test_abandoning_incomplete_row_preserves_only_completed_prefix(
    real_flow, tmp_path, usage_webhook_api, cancel_terminal, terminated
):
    flow = make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_run_id=str(uuid.uuid4()),
    )
    wire = b'{"data":{"id":"2"}}\n' + _costly_row(250_000)
    if terminated:
        wire += b"\n"
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(wire) == wire
        assert response_streaming.has_pending_response_inspection(flow)
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
        assert not response_streaming.has_pending_response_inspection(flow)
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert flow.metadata[metadata_keys.X_JSON_STATE]["parse_error"] == (
            "response inspection interrupted"
        )
        assert flow.response is not None
        assert flow.response.stream is False
        usage.flush_usage_events(trigger="test")
    (event,) = webhook.usage_events()
    assert event["quantity"] == 1
    assert event["resources"] == [{"id": "2", "occurrences": 1}]
    entries = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert sum(entry.get("reason") == "response_inspection_interrupted" for entry in entries) == 1


@pytest.mark.parametrize("terminated", [False, True], ids=["eof", "newline"])
@pytest.mark.parametrize("split_suffix", [False, True], ids=["whole", "split-cr-suffix"])
async def test_trailing_cr_does_not_change_exact_row_work_limit(
    real_flow, terminated, split_suffix
):
    flow = make_x_response_flow(real_flow, path="/2/tweets/search/stream")
    mitm_addon.responseheaders(flow)
    state = flow.metadata[metadata_keys.X_NDJSON_STATE]
    # Whitespace takes one work unit per byte; null takes two more. Exactly
    # 65,536 units must still be accepted, with all trailing CRs stripped.
    body = b" " * (65_536 - 2) + b"null"
    suffix = b"\r" * 100
    chunks = [body, suffix[:41], suffix[41:]] if split_suffix else [body + suffix]
    if terminated:
        chunks.append(b"\n")
    for chunk in chunks:
        assert response_stream(flow)(chunk) == chunk
        await mitm_addon.responseinspection(flow)
    response_streaming.finalize_connector_response_state(flow)
    assert state["lines_parsed"] == 1
    assert state["lines_failed"] == 0


async def test_cr_before_later_content_is_validated_and_next_row_recovers(real_flow):
    flow = make_x_response_flow(real_flow, path="/2/tweets/search/stream")
    mitm_addon.responseheaders(flow)
    state = flow.metadata[metadata_keys.X_NDJSON_STATE]
    for chunk in (b'{"data":{"id":"1","text":"a\r', b'\rb"}}\n{"data":{"id":"2"}}\n'):
        assert response_stream(flow)(chunk) == chunk
        await mitm_addon.responseinspection(flow)
    assert state["lines_failed"] == 1
    assert state["lines_parsed"] == state["data_count"] == 1


async def test_withheld_cr_before_later_content_counts_against_work_limit(real_flow):
    flow = make_x_response_flow(real_flow, path="/2/tweets/search/stream")
    mitm_addon.responseheaders(flow)
    state = flow.metadata[metadata_keys.X_NDJSON_STATE]
    chunks = [b" " * (65_536 - 6) + b"null", b"\r\r", b"\r\r", b" \n{}\n"]
    for chunk in chunks:
        assert response_stream(flow)(chunk) == chunk
        await mitm_addon.responseinspection(flow)
    assert state["lines_failed"] == 1
    assert state["lines_parsed"] == 1


async def test_oversized_partially_inspected_row_discards_observations_and_recovers(
    real_flow, tmp_path, usage_webhook_api
):
    flow = make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_run_id=str(uuid.uuid4()),
    )
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        state = flow.metadata[metadata_keys.X_NDJSON_STATE]
        chunks = [
            b'{"data":{"id":"1"},"includes":{"users":[{},{}]},"text":"',
            b"a" * LARGE_RESPONSE_DECOMPRESS_LIMIT,
            b'"}\n{"data":{"id":"2"}}\n',
        ]
        for chunk in chunks:
            assert response_stream(flow)(chunk) == chunk
            await mitm_addon.responseinspection(flow)
        assert mitm_addon.response(flow) is None
        usage.flush_usage_events(trigger="test")
    assert state["lines_failed"] == 1
    assert state["lines_parsed"] == state["data_count"] == 1
    assert state["includes"] == {}
    (event,) = webhook.usage_events()
    assert event["quantity"] == 1
    assert event["resources"] == [{"id": "2", "occurrences": 1}]
