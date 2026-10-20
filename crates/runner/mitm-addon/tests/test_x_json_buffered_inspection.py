"""Buffered X JSON fairness, strict admission and terminal-hook ownership."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import zstandard
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import ResponseData, ResponseEndOfMessage
from mitmproxy.proxy.layers.http._hooks import HttpResponseHook
from mitmproxy.test import taddons

import body_decoding
import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
import response_streaming
import usage
from body_limits import LARGE_RESPONSE_DECOMPRESS_LIMIT, STREAM_BUFFER_LIMIT
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.x_flow_helpers import make_x_pipeline_flow, x_json_user_page
from usage.json_selective import JsonSelectiveExtractor
from usage.providers.connectors.x_resources import IDENTITY_BODY_LIMIT


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _user_flow(real_flow, tmp_path, *, request_hint=True):
    return make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/users/search",
        query="query=user&user.fields=description" + ("&max_results=1000" if request_hint else ""),
        permission="users.read",
        rule="GET /2/users/search",
        content_encoding="zstd",
    )


def _stream_body(flow, wire, chunk_size=None):
    size = chunk_size or len(wire)
    for offset in range(0, len(wire), size):
        chunk = wire[offset : offset + size]
        assert response_stream(flow)(chunk) == chunk
        assert not response_streaming.has_pending_response_inspection(flow)
    assert response_stream(flow)(b"") == b""


async def test_network_latency_excludes_buffered_terminal_inspection(
    real_flow, tmp_path, usage_webhook_api, monkeypatch
):
    flow = _user_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    _stream_body(flow, zstandard.ZstdCompressor().compress(x_json_user_page()))
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = 10.0
    now = 10.125
    # Replace only the logging clock, leaving asyncio's monotonic clock real.
    monkeypatch.setattr(logging_utils, "time", SimpleNamespace(monotonic=lambda: now))
    loop = asyncio.get_running_loop()
    inspection_waited = loop.create_future()

    def advance_clock():
        nonlocal now
        now = 20.0
        inspection_waited.set_result(response_streaming.has_pending_response_inspection(flow))

    with usage_webhook_api() as webhook:
        loop.call_soon(advance_clock)
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
    assert await inspection_waited is True
    [entry] = read_jsonl_entries_after_flush(tmp_path / "network.jsonl")
    assert entry["latency_ms"] == 125
    [event] = webhook.usage_events()
    assert event["quantity"] == 1_000
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


@pytest.mark.parametrize("count", [500, 1_000])
@pytest.mark.parametrize("representation", ["ascii", "utf8", "escaped"])
@pytest.mark.parametrize("chunk_size", [None, 7], ids=["whole", "partitioned"])
async def test_terminal_parser_yields_bounded_work_before_committing_usage(
    real_flow, tmp_path, usage_webhook_api, monkeypatch, count, representation, chunk_size
):
    flow = _user_flow(real_flow, tmp_path)
    body = x_json_user_page(count, representation=representation)
    wire = zstandard.ZstdCompressor().compress(body)
    assert len(wire) < STREAM_BUFFER_LIMIT < len(body)
    mitm_addon.responseheaders(flow)
    _stream_body(flow, wire, chunk_size)
    assert response_streaming.streamed_response_size(flow) == len(wire)

    # Observe the real selective parser without substituting its results or work.
    original_feed = JsonSelectiveExtractor.feed
    fed_sizes = []

    def observe_feed(extractor, chunk):
        fed_sizes.append(len(chunk))
        original_feed(extractor, chunk)

    monkeypatch.setattr(JsonSelectiveExtractor, "feed", observe_feed)
    loop = asyncio.get_running_loop()
    heartbeat = loop.create_future()
    turn_bytes = []
    last_bytes = 0
    finished = False

    with usage_webhook_api() as webhook:

        def pulse():
            nonlocal last_bytes
            total = sum(fed_sizes)
            turn_bytes.append(total - last_bytes)
            last_bytes = total
            if not heartbeat.done():
                heartbeat.set_result(
                    (
                        response_streaming.has_pending_response_inspection(flow),
                        flow.metadata.get(metadata_keys.X_JSON_STATE),
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
        assert sum(fed_sizes) == len(body)
        assert max(fed_sizes) <= 4 * 1024
        assert max([*turn_bytes, sum(fed_sizes) - last_bytes]) <= 8 * 4 * 1024
        usage.flush_usage_events(trigger="test")
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        usage.flush_usage_events(trigger="test")

    state = flow.metadata[metadata_keys.X_JSON_STATE]
    assert state["body_parsed"] is True
    assert state["body_truncated"] is False
    assert state["response_data_count"] == state["response_result_count"] == count
    (event,) = webhook.usage_events()
    assert event["category"] == "user.read"
    assert event["quantity"] == count
    if len(body) <= IDENTITY_BODY_LIMIT:
        assert event["resources"] == [
            {"id": str(10**18 + index), "occurrences": 1} for index in range(count)
        ]
        assert event["remainder"] == []
    else:
        assert event["resources"] == []
        assert event["remainder"] == [{"reason": "identity_limit", "quantity": count}]
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
    ],
)
@pytest.mark.parametrize("request_hint", [False, True], ids=["no-hint", "hint"])
async def test_strict_body_admission_never_publishes_selected_prefix(
    real_flow, tmp_path, usage_webhook_api, failure, expected_error, request_hint
):
    flow = _user_flow(real_flow, tmp_path, request_hint=request_hint)
    body = x_json_user_page()
    if failure == "decoded-limit":
        body += b" " * LARGE_RESPONSE_DECOMPRESS_LIMIT
    elif failure == "trailing-json":
        body += b"!"
    elif failure == "truncated-json":
        body = body[:-1]
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
    mitm_addon.responseheaders(flow)
    _stream_body(flow, wire)
    with usage_webhook_api() as webhook:
        completion = mitm_addon.response(flow)
        if completion is not None:
            await completion
        usage.flush_usage_events(trigger="test")
    state = flow.metadata[metadata_keys.X_JSON_STATE]
    assert state["body_parsed"] is False
    assert state["body_truncated"] is (failure == "capture-limit")
    assert state["parse_error"] == expected_error
    assert "response_data_count" not in state
    assert "resource_identities" not in state
    if request_hint:
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1_000
        assert event["resources"] == []
        assert event["remainder"] == [{"reason": "parse_fallback", "quantity": 1_000}]
    else:
        assert webhook.usage_events() == []
    assert flow.response is not None
    assert flow.response.stream is False


@pytest.mark.parametrize("extra_space", [0, 1], ids=["exact-budget", "over-budget"])
async def test_terminal_parser_retains_the_complete_document_work_budget(
    real_flow, tmp_path, usage_webhook_api, extra_space
):
    body = b'{"data":[{"id":"1"}]}' + b" " * (65_523 + extra_space)
    flow = _user_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    _stream_body(flow, zstandard.ZstdCompressor().compress(body), 7)
    with usage_webhook_api() as webhook:
        completion = mitm_addon.response(flow)
        assert completion is not None
        await completion
        usage.flush_usage_events(trigger="test")
    state = flow.metadata[metadata_keys.X_JSON_STATE]
    (event,) = webhook.usage_events()
    if extra_space:
        assert state["body_parsed"] is False
        assert state["parse_error"] == "work limit exceeded"
        assert event["quantity"] == 1_000
        assert event["remainder"] == [{"reason": "parse_fallback", "quantity": 1_000}]
    else:
        assert state["body_parsed"] is True
        assert event["quantity"] == 1
        assert event["resources"] == [{"id": "1", "occurrences": 1}]


@pytest.mark.parametrize("terminal", ["cancel", "release", "abandon", "error-before-start"])
async def test_interruption_discards_parser_input_and_a_later_flow_recovers(
    real_flow, tmp_path, usage_webhook_api, terminal
):
    flow = _user_flow(real_flow, tmp_path, request_hint=False)
    mitm_addon.responseheaders(flow)
    _stream_body(flow, zstandard.ZstdCompressor().compress(x_json_user_page()))
    with usage_webhook_api() as webhook:
        if terminal == "error-before-start":
            flow.error = Error("connection failed before response completion")
            assert mitm_addon.error(flow) is None
            assert metadata_keys.X_JSON_STATE not in flow.metadata
        else:
            completion = mitm_addon.response(flow)
            assert completion is not None
            assert response_streaming.has_pending_response_inspection(flow)
            if terminal == "cancel":
                task = asyncio.ensure_future(completion)
                asyncio.get_running_loop().call_soon(task.cancel)
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                if terminal == "release":
                    response_streaming.release_response_stream_state(flow)
                else:
                    response_streaming.abandon_response_inspection(flow)
                await completion
            state = flow.metadata[metadata_keys.X_JSON_STATE]
            assert state["body_parsed"] is False
            assert state["parse_error"] == "response inspection interrupted"
            assert "response_data_count" not in state
            assert "resource_identities" not in state
        usage.flush_usage_events(trigger="test")
        assert webhook.usage_events() == []
        assert flow.response is not None
        assert flow.response.stream is False
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert not response_streaming.has_pending_response_inspection(flow)

        recovered = _user_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(recovered)
        _stream_body(recovered, zstandard.ZstdCompressor().compress(b'{"data":[{"id":"999"}]}'))
        assert mitm_addon.response(recovered) is None
        usage.flush_usage_events(trigger="test")
    (event,) = webhook.usage_events()
    assert event["quantity"] == 1
    assert event["resources"] == [{"id": "999", "occurrences": 1}]


async def _admit_user_flow(real_flow, tmp_path, mitm_ctx, fake_firewall_headers):
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="x",
            billable_firewalls=["x"],
            api_entry={
                "base": "https://api.x.com",
                "auth": {"headers": {"Authorization": "Bearer test-key"}},
                "permissions": [{"name": "users.read", "rules": ["GET /2/users/search"]}],
            },
            network_policy={
                "allow": ["users.read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.x.com",
        path="/2/users/search?query=user&max_results=1000&user.fields=description",
    )
    flow.request.headers["Accept-Encoding"] = "zstd, identity;q=0"
    with mitm_ctx(registry_path=str(registry_path)), fake_firewall_headers():
        await mitm_addon.request(flow)
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "users.read"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is True
    assert flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] == (
        "preserved_client_constraints"
    )
    assert flow.request.headers["Accept-Encoding"] == "zstd, identity;q=0"
    assert usage.delivery_snapshot()["flows"] == 1
    return flow


@pytest.mark.parametrize("cancel", [False, True], ids=["complete", "cancel"])
async def test_native_response_hook_waits_for_buffered_inspection(
    real_flow, tmp_path, mitm_ctx, fake_firewall_headers, usage_webhook_api, cancel
):
    flow = await _admit_user_flow(real_flow, tmp_path, mitm_ctx, fake_firewall_headers)
    flow.response = http.Response.make(
        200, b"", {"Content-Type": "application/json", "Content-Encoding": "zstd"}
    )
    wire = zstandard.ZstdCompressor().compress(x_json_user_page())
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as addon_context,
        usage_webhook_api() as webhook,
    ):
        mitm_addon.responseheaders(flow)
        context = Context(flow.client_conn, addon_context.options)
        context.server = flow.server_conn
        stream = HttpStream(context.fork(), 1)
        list(stream.handle_event(events.Start()))
        stream.flow = flow
        stream.client_state = stream.state_done
        stream.server_state = stream.state_stream_response_body
        forwarded = list(stream.handle_event(ResponseData(1, wire)))
        assert (
            b"".join(
                command.event.data
                for command in forwarded
                if isinstance(command, SendHttp) and isinstance(command.event, ResponseData)
            )
            == wire
        )
        end_commands = list(stream.handle_event(ResponseEndOfMessage(1)))
        (hook,) = [command for command in end_commands if isinstance(command, HttpResponseHook)]
        assert not any(
            isinstance(command, SendHttp) and isinstance(command.event, ResponseEndOfMessage)
            for command in end_commands
        )
        loop = asyncio.get_running_loop()
        heartbeat = loop.create_future()
        task = asyncio.create_task(addon_context.master.addons.invoke_addon(mitm_addon, hook))

        def pulse():
            heartbeat.set_result(
                (
                    task.done(),
                    response_streaming.has_pending_response_inspection(flow),
                    webhook.usage_events(),
                    usage.delivery_snapshot()["flows"],
                )
            )
            if cancel:
                task.cancel()

        loop.call_soon(pulse)
        if cancel:
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            await task
        assert await heartbeat == (False, True, [], 1)
        after_hook = list(stream.handle_event(events.HookCompleted(hook, None)))
        assert any(
            isinstance(command, SendHttp) and isinstance(command.event, ResponseEndOfMessage)
            for command in after_hook
        )
        usage.flush_usage_events(trigger="test")
    if cancel:
        assert webhook.usage_events() == []
        assert flow.metadata[metadata_keys.X_JSON_STATE]["body_parsed"] is False
    else:
        (event,) = webhook.usage_events()
        assert event["quantity"] == 1_000
        assert event["remainder"] == [{"reason": "identity_limit", "quantity": 1_000}]
    assert flow.response is not None
    assert flow.response.stream is False
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert usage.delivery_snapshot()["flows"] == 0
