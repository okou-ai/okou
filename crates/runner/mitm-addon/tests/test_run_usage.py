"""Cumulative measurements through real request/response hooks and private reads."""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import mitm_addon
import registry
import run_usage
import runner_control
import usage
from tests.control_helpers import control_connection, exchange, status_request
from tests.flow_helpers import header_map, response_stream
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_request_flow,
    make_openai_responses_websocket_response_headers,
)
from tests.model_provider_websocket_helpers import (
    capture_deferred_websocket_trims,
    feed_websocket_server_message,
    set_websocket_message,
)
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


@pytest.fixture
def control(tmp_path):
    run_usage.initialize("generation-1")
    directory = tmp_path / "control"
    directory.mkdir(mode=0o700)
    server = runner_control.ControlServer(directory, "generation-1")
    server.start()
    try:
        yield directory
    finally:
        server.stop()


def read_usage(control, run_id="run-1"):
    reply = exchange(
        control,
        status_request()
        | {
            "method": "usage.snapshot",
            "params": {"runId": run_id},
        },
    )
    assert reply["type"] == "result"
    return reply["data"]


def write_registration(tmp_path, *, run_id="run-1", billable=False, generation="generation-1"):
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=run_id,
            firewall_name="model-provider:openai-api-key",
            api_entry={
                "base": "https://api.openai.com",
                "auth": {"headers": {}},
                "permissions": [
                    {
                        "name": "inference",
                        "rules": [
                            "POST /v1/responses",
                            "POST /v1/chat/completions",
                            "POST /v1/messages",
                            "GET /v1/responses",
                        ],
                    }
                ],
            },
            network_policy={"allow": ["inference"], "deny": [], "ask": [], "unknownPolicy": "deny"},
            billable_firewalls=["model-provider:openai-api-key"] if billable else [],
            sandbox_fields={
                "usageGeneration": generation,
                "cliAgentType": "codex",
                "modelUsageProvider": "gpt-5.5",
            },
        ),
    )


async def admit(real_flow, *, path="/v1/responses"):
    flow = real_flow(
        with_response=False, host="api.openai.com", client_ip="10.200.0.5", method="POST", path=path
    )
    await mitm_addon.request(flow)
    assert flow.response is None
    return flow


def payload(response_id="response-1", *, input_tokens=50, output_tokens=20):
    return {
        "id": response_id,
        "model": "gpt-5.5",
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "input_tokens_details": {
                "cached_tokens": 10 if input_tokens else 0,
                "cache_write_tokens": 15 if input_tokens else 0,
            },
        },
    }


def json_response(flow, body):
    flow.response = tutils.tresp(headers=header_map({"content-type": "application/json"}))
    mitm_addon.responseheaders(flow)
    data = json.dumps(body).encode()
    assert response_stream(flow)(data) == data
    response_stream(flow)(b"")
    mitm_addon.response(flow)


@pytest.mark.parametrize("billable", [False, True])
async def test_json_totals_survive_flush_and_deduplicate_across_flows(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_api,
    sync_usage_executor,
    billable,
):
    path = write_registration(tmp_path, billable=billable)
    with (
        usage_webhook_api() as webhook,
        mitm_ctx(registry_path=str(path), api_url=webhook.api_url),
        fake_firewall_headers(),
    ):
        flow = await admit(real_flow)
        assert read_usage(control)["outstandingResponses"] == 1
        json_response(flow, payload())
        first = read_usage(control)
        assert first["totals"] == {
            "input": 25,
            "cacheRead": 10,
            "cacheCreation": 15,
            "output": 20,
            "total": 70,
        }
        assert first["complete"] is True
        assert first["observedResponses"] == 1
        usage.flush_usage_events(trigger="test")
        duplicate = await admit(real_flow)
        json_response(duplicate, payload())
        assert read_usage(control)["totals"] == first["totals"]
        assert read_usage(control)["observedResponses"] == 1
        child = await admit(real_flow)
        json_response(child, payload("response-2"))
        assert read_usage(control)["totals"]["total"] == 140
        usage.flush_usage_events(trigger="test")
    assert bool(webhook.usage_events()) is billable


@pytest.mark.parametrize("zero", [False, True])
async def test_provider_zero_is_distinct_from_absent_usage(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    zero,
):
    path = write_registration(tmp_path)
    assert read_usage(control)["state"] == "unavailable"
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        json_response(
            flow, payload(input_tokens=0, output_tokens=0) if zero else {"id": "no-usage"}
        )
    result = read_usage(control)
    assert result["totals"]["total"] == 0
    assert result["observedResponses"] == int(zero)
    assert result["complete"] is zero
    assert ("missing_usage" in result["reasons"]) is not zero


async def test_sse_live_repeated_partial_usage_and_late_response_keep_original_run(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        flow.response = tutils.tresp(headers=header_map({"content-type": "text/event-stream"}))
        mitm_addon.responseheaders(flow)
        event = (
            b"data: "
            + json.dumps({"type": "response.completed", "response": payload()}).encode()
            + b"\n\n"
        )
        response_stream(flow)(event)
        assert read_usage(control)["totals"]["total"] == 70
        response_stream(flow)(event)
        assert read_usage(control)["totals"]["total"] == 70
        write_registration(tmp_path, run_id="run-2")
        replacement = await admit(real_flow)
        json_response(replacement, payload("replacement", input_tokens=100))
        flow.error = Error("interrupted after known usage")
        mitm_addon.error(flow)
    original = read_usage(control)
    assert original["totals"]["total"] == 70
    assert original["outstandingResponses"] == 0
    assert "interrupted" in original["reasons"]
    assert read_usage(control, "run-2")["totals"]["total"] == 120


async def test_chat_sse_uses_disjoint_categories(
    tmp_path, control, real_flow, mitm_ctx, fake_firewall_headers
):
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow, path="/v1/chat/completions")
        flow.response = tutils.tresp(headers=header_map({"content-type": "text/event-stream"}))
        mitm_addon.responseheaders(flow)
        data = {
            "id": "chat-1",
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 10, "cache_write_tokens": 15},
            },
        }
        event = b"data: " + json.dumps(data).encode() + b"\n\n"
        response_stream(flow)(event + event + b"data: [DONE]\n\n")
        mitm_addon.response(flow)
    result = read_usage(control)
    assert result["totals"]["input"] == 25
    assert result["totals"]["total"] == 70
    assert result["complete"] is True


async def test_websocket_idle_prewarm_multiple_responses_and_flush(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    capture_deferred_websocket_trims(monkeypatch)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = make_openai_responses_websocket_request_flow(real_flow)
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=101, headers=make_openai_responses_websocket_response_headers()
        )
        mitm_addon.responseheaders(flow)
        mitm_addon.response(flow)
        assert read_usage(control)["outstandingResponses"] == 0
        for response_id, prewarm in [("warm", True), ("one", False), ("two", False)]:
            set_websocket_message(
                flow,
                from_client=True,
                content=json.dumps(
                    {
                        "type": "response.create",
                        "response": {"generate": not prewarm},
                        "generate": not prewarm,
                    }
                ).encode(),
            )
            mitm_addon.websocket_message(flow)
            assert read_usage(control)["outstandingResponses"] == (0 if prewarm else 1)
            feed_websocket_server_message(
                flow,
                json.dumps({"type": "response.created", "response": {"id": response_id}}).encode(),
            )
            frame = json.dumps(
                {"type": "response.completed", "response": payload(response_id)}
            ).encode()
            feed_websocket_server_message(flow, frame)
            feed_websocket_server_message(flow, frame)
            assert read_usage(control)["outstandingResponses"] == 0
        assert read_usage(control)["totals"]["total"] == 140
        assert read_usage(control)["observedResponses"] == 2
        mitm_addon.websocket_end(flow)
    assert read_usage(control)["totals"]["total"] == 140


async def test_registry_refresh_restart_and_lost_retention_are_explicit(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    monkeypatch.setattr(run_usage, "MAX_RUNS", 1)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        json_response(flow, payload())
        write_registration(tmp_path)
        registry.load_registry_state(str(path))
        assert read_usage(control)["totals"]["total"] == 70
        run_usage.initialize("replacement-generation")
        registry.load_registry_state(str(path))
        assert "history_lost" in read_usage(control)["reasons"]
        write_registration(tmp_path, run_id="run-2", generation="replacement-generation")
        registry.load_registry_state(str(path))
        assert read_usage(control)["state"] == "unavailable"
        assert "retention_lost" in read_usage(control, "run-2")["reasons"]


async def test_response_capacity_never_forgets_duplicate_identity(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    monkeypatch.setattr(run_usage, "MAX_RESPONSES_PER_RUN", 1)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        for response_id in ["one", "two", "one"]:
            flow = await admit(real_flow)
            json_response(flow, payload(response_id))
    result = read_usage(control)
    assert result["totals"]["total"] == 70
    assert result["observedResponses"] == 1
    assert "retention_lost" in result["reasons"]


def test_socket_reads_are_strict_concurrent_and_survive_disconnected_peer(control):
    for params in [{}, {"runId": "run-1", "extra": True}, {"runId": 1}]:
        reply = exchange(control, status_request() | {"method": "usage.snapshot", "params": params})
        assert reply["code"] == "invalid_request"
    with control_connection(control) as abandoned:
        abandoned.sendall(b"\x00")
        with ThreadPoolExecutor(max_workers=8) as pool:
            replies = list(pool.map(lambda _: read_usage(control), range(16)))
        assert all(reply["state"] == "unavailable" for reply in replies)
    assert read_usage(control)["state"] == "unavailable"


@pytest.mark.parametrize("protocol", ["responses", "chat/completions", "messages"])
async def test_known_usage_survives_later_malformed_event_in_same_chunk(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    protocol,
):
    path = write_registration(tmp_path)
    if protocol == "messages":
        contents = json.loads(path.read_text())
        contents["sandboxes"]["10.200.0.5"]["cliAgentType"] = "claude-code"
        path.write_text(json.dumps(contents))
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow, path="/v1/" + protocol)
        flow.response = tutils.tresp(headers=header_map({"content-type": "text/event-stream"}))
        mitm_addon.responseheaders(flow)
        if protocol == "responses":
            event = {"type": "response.completed", "response": payload()}
            prefix = b"event: response.completed\n"
        elif protocol == "messages":
            event = {
                "type": "message_start",
                "message": {
                    "id": "anthropic-1",
                    "usage": {
                        "input_tokens": 25,
                        "output_tokens": 20,
                        "cache_read_input_tokens": 10,
                        "cache_creation_input_tokens": 15,
                    },
                },
            }
            prefix = b"event: message_start\n"
        else:
            event = {
                "id": "chat-1",
                "usage": {
                    "prompt_tokens": 50,
                    "completion_tokens": 20,
                    "prompt_tokens_details": {"cached_tokens": 10, "cache_write_tokens": 15},
                },
            }
            prefix = b""
        valid = prefix + b"data: " + json.dumps(event).encode() + b"\n\n"
        response_stream(flow)(valid + prefix + b"data: {invalid\n\n")
        flow.error = Error("provider interrupted")
        mitm_addon.error(flow)
    result = read_usage(control)
    assert result["totals"]["total"] == 70
    assert result["outstandingResponses"] == 0
    assert result["complete"] is False
    assert "interrupted" in result["reasons"]


async def test_overlapping_cache_quantities_are_explicitly_incomplete(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        json_response(flow, payload(input_tokens=5))
    result = read_usage(control)
    assert result["totals"]["total"] == 25
    assert result["complete"] is False
    assert "parse_error" in result["reasons"]


async def test_total_overflow_preserves_last_known_snapshot(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        first = await admit(real_flow)
        json_response(first, payload())
        overflow = await admit(real_flow)
        json_response(overflow, payload("overflow", input_tokens=(1 << 53) - 1))
    result = read_usage(control)
    assert result["totals"]["total"] == 70
    assert result["complete"] is False
    assert "overflow" in result["reasons"]


async def test_expired_run_recreation_and_late_flow_cannot_claim_continuity(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    monkeypatch.setattr(run_usage, "RETIRED_SECONDS", 0)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        old = await admit(real_flow)
        write_registration(tmp_path, run_id="run-2")
        replacement = await admit(real_flow)
        json_response(replacement, payload("new"))
        assert read_usage(control)["state"] == "unavailable"
        json_response(old, payload("late"))
        assert read_usage(control, "run-2")["totals"]["total"] == 70
        write_registration(tmp_path)
        registry.load_registry_state(str(path))
        recreated = read_usage(control)
        assert recreated["totals"]["total"] == 0
        assert "retention_lost" in recreated["reasons"]


async def test_complete_json_before_connection_error_is_retained(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        flow.response = tutils.tresp(headers=header_map({"content-type": "application/json"}))
        mitm_addon.responseheaders(flow)
        response_stream(flow)(json.dumps(payload()).encode())
        flow.error = Error("connection error after body")
        mitm_addon.error(flow)
    result = read_usage(control)
    assert result["totals"]["total"] == 70
    assert result["reasons"] == ["interrupted"]


@pytest.mark.parametrize("terminal", [False, True])
async def test_zero_sse_observation_requires_protocol_terminal_for_complete_coverage(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    terminal,
):
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        flow.response = tutils.tresp(headers=header_map({"content-type": "text/event-stream"}))
        mitm_addon.responseheaders(flow)
        event = {
            "type": "response.completed" if terminal else "provider.future_event",
            "response": payload(input_tokens=0, output_tokens=0),
        }
        response_stream(flow)(b"data: " + json.dumps(event).encode() + b"\n\n")
        mitm_addon.response(flow)
    result = read_usage(control)
    assert result["observedResponses"] == 1
    assert result["totals"]["total"] == 0
    assert result["complete"] is terminal


async def test_repeated_websocket_snapshots_keep_disjoint_input_when_details_disappear(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    capture_deferred_websocket_trims(monkeypatch)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = make_openai_responses_websocket_request_flow(real_flow)
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=101, headers=make_openai_responses_websocket_response_headers()
        )
        mitm_addon.responseheaders(flow)
        first = payload()
        second = payload()
        second["usage"].pop("input_tokens_details")
        for response in [first, second]:
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": response,
                    }
                ).encode(),
            )
        mitm_addon.websocket_end(flow)
    result = read_usage(control)
    assert result["totals"] == {
        "input": 25,
        "cacheRead": 10,
        "cacheCreation": 15,
        "output": 20,
        "total": 70,
    }
    assert result["observedResponses"] == 1


async def test_ambiguous_websocket_recovers_observable_idle_and_pending_boundaries(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    capture_deferred_websocket_trims(monkeypatch)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = make_openai_responses_websocket_request_flow(real_flow)
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=101, headers=make_openai_responses_websocket_response_headers()
        )
        mitm_addon.responseheaders(flow)
        # A missing client boundary makes correlation partial, but does not
        # justify counting the persistent connection forever after completion.
        for response_id in ["one", "two"]:
            feed_websocket_server_message(
                flow,
                json.dumps({"type": "response.created", "response": {"id": response_id}}).encode(),
            )
            assert read_usage(control)["outstandingResponses"] == 1
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {"type": "response.completed", "response": payload(response_id)}
                ).encode(),
            )
            assert read_usage(control)["outstandingResponses"] == 0
        mitm_addon.websocket_end(flow)
    result = read_usage(control)
    assert result["totals"]["total"] == 140
    assert "ambiguous_response" in result["reasons"]


async def test_global_response_capacity_does_not_erase_another_run(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    monkeypatch.setattr(run_usage, "MAX_RESPONSES", 1)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        first = await admit(real_flow)
        json_response(first, payload())
        write_registration(tmp_path, run_id="run-2")
        second = await admit(real_flow)
        json_response(second, payload("two"))
    assert read_usage(control)["totals"]["total"] == 70
    result = read_usage(control, "run-2")
    assert result["totals"]["total"] == 0
    assert "retention_lost" in result["reasons"]


async def test_websocket_close_keeps_known_usage_and_marks_unfinished_inference(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
):
    capture_deferred_websocket_trims(monkeypatch)
    path = write_registration(tmp_path)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = make_openai_responses_websocket_request_flow(real_flow)
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=101, headers=make_openai_responses_websocket_response_headers()
        )
        mitm_addon.responseheaders(flow)
        set_websocket_message(flow, content=b'{"type":"response.create"}', from_client=True)
        mitm_addon.websocket_message(flow)
        feed_websocket_server_message(
            flow, b'{"type":"response.created","response":{"id":"response-1"}}'
        )
        feed_websocket_server_message(
            flow,
            json.dumps({"type": "provider.future_event", "response": payload()}).encode(),
        )
        assert read_usage(control)["totals"]["total"] == 70
        assert read_usage(control)["outstandingResponses"] == 1
        mitm_addon.websocket_end(flow)
    result = read_usage(control)
    assert result["totals"]["total"] == 70
    assert result["outstandingResponses"] == 0
    assert "interrupted" in result["reasons"]
    assert result["complete"] is False
