"""Admitted model observation and billing through pinned native terminal hooks."""

import asyncio
import json
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.flow import Error
from mitmproxy.proxy import events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpStream, SendHttp
from mitmproxy.proxy.layers.http._events import ResponseData, ResponseEndOfMessage
from mitmproxy.proxy.layers.http._hooks import HttpResponseHook
from mitmproxy.test import taddons

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import run_usage
import runner_control
import usage
from tests.control_helpers import exchange, status_request
from tests.flow_helpers import response_stream
from tests.model_json_cooperative_helpers import encode_model_json, model_json_body
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


@pytest.fixture
def control(tmp_path):
    run_usage.initialize("buffered-model-generation")
    directory = tmp_path / "control"
    directory.mkdir(mode=0o700)
    server = runner_control.ControlServer(
        directory, "buffered-model-generation", usage_snapshot=run_usage.snapshot
    )
    server.start()
    try:
        yield directory
    finally:
        server.stop()


def _read_usage(control):
    reply = exchange(
        control,
        status_request("buffered-model-generation")
        | {"method": "usage.snapshot", "params": {"runId": "run-buffered-model"}},
    )
    assert reply["type"] == "result"
    data = reply["data"]
    assert isinstance(data, dict)
    return data


async def _admit_model_flow(
    real_flow, tmp_path, mitm_ctx, fake_firewall_headers, *, billable=False
):
    firewall_name = (
        "model-provider:buffered-test" if billable else "model-provider:claude-code-oauth-token"
    )
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-buffered-model",
            firewall_name=firewall_name,
            billable_firewalls=[firewall_name] if billable else [],
            api_entry={
                "base": "https://api.anthropic.com",
                "auth": {"headers": {"Authorization": "Bearer test-key"}},
                "permissions": [{"name": "messages", "rules": ["POST /v1/messages"]}],
            },
            network_policy={
                "allow": ["messages"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={
                "usageGeneration": "buffered-model-generation",
                "modelUsageProvider": "claude-sonnet-4-6",
                "cliAgentType": "claude-code",
            },
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.anthropic.com",
        path="/v1/messages",
        method="POST",
        request_content_type="application/json",
        request_body=json.dumps(
            {"model": "claude-sonnet-4-6", "max_tokens": 64000, "stream": False}
        ).encode(),
    )
    flow.request.headers["Accept-Encoding"] = "zstd, identity;q=0"
    with mitm_ctx(registry_path=str(registry_path)), fake_firewall_headers():
        await mitm_addon.request(flow)
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_PERMISSION] == "messages"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is billable
    assert json.loads(flow.request.raw_content)["stream"] is False
    assert flow.request.headers["Accept-Encoding"] == "zstd, identity;q=0"
    flow.response = http.Response.make(
        200, b"", {"Content-Type": "application/json", "Content-Encoding": "zstd"}
    )
    return flow


def _complete_body(*, characters=32_768):
    payload = json.loads(model_json_body(characters=characters))
    payload["usage"].update(cache_read_input_tokens=0, cache_creation_input_tokens=0)
    return json.dumps(payload).encode()


@pytest.mark.parametrize("cancel", [False, True], ids=["complete", "cancel"])
@pytest.mark.parametrize("billable", [False, True], ids=["personal", "platform-billable"])
async def test_native_terminal_hook_owns_inspection_until_completion_or_cancellation(
    real_flow,
    tmp_path,
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_api,
    control,
    cancel,
    billable,
):
    flow = await _admit_model_flow(
        real_flow, tmp_path, mitm_ctx, fake_firewall_headers, billable=billable
    )
    assert _read_usage(control)["outstandingResponses"] == 1
    wire = encode_model_json(_complete_body(), "zstd")
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
            snapshot = _read_usage(control)
            heartbeat.set_result(
                (
                    task.done(),
                    response_streaming.has_pending_response_inspection(flow),
                    snapshot["observedResponses"],
                    snapshot["outstandingResponses"],
                    usage.delivery_snapshot()["flows"],
                    webhook.usage_events(),
                )
            )
            if cancel:
                task.cancel()

        loop.call_soon(pulse)
        if cancel:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=5)
        else:
            await asyncio.wait_for(task, timeout=5)
        assert await asyncio.wait_for(heartbeat, timeout=5) == (
            False,
            True,
            0,
            1,
            int(billable),
            [],
        )
        after_hook = list(stream.handle_event(events.HookCompleted(hook, None)))
        assert any(
            isinstance(command, SendHttp) and isinstance(command.event, ResponseEndOfMessage)
            for command in after_hook
        )
        usage.flush_usage_events(trigger="test")
        result = _read_usage(control)
        assert result["observedResponses"] == (0 if cancel else 1)
        assert result["outstandingResponses"] == 0
        assert result["totals"]["input"] == (0 if cancel else 50)
        assert result["totals"]["output"] == (0 if cancel else 200)
        if cancel:
            assert {"parse_error", "interrupted"} <= set(result["reasons"])
        else:
            assert result["complete"] is True
        assert len(webhook.usage_events()) == (2 if billable and not cancel else 0)
        assert usage.delivery_snapshot()["flows"] == 0
        assert mitm_addon.response(flow) is None
        flow.error = Error("duplicate terminal notification")
        assert mitm_addon.error(flow) is None
        after_duplicate = _read_usage(control)
        assert {key: value for key, value in after_duplicate.items() if key != "sampledAtMs"} == {
            key: value for key, value in result.items() if key != "sampledAtMs"
        }
        if cancel:
            recovered = await _admit_model_flow(
                real_flow, tmp_path, mitm_ctx, fake_firewall_headers, billable=billable
            )
            mitm_addon.responseheaders(recovered)
            healthy_wire = encode_model_json(_complete_body(characters=0), "zstd")
            assert response_stream(recovered)(healthy_wire) == healthy_wire
            assert response_stream(recovered)(b"") == b""
            assert mitm_addon.response(recovered) is None
            recovered_usage = _read_usage(control)
            assert recovered_usage["observedResponses"] == 1
            assert recovered_usage["outstandingResponses"] == 0
            assert recovered_usage["totals"]["total"] == 250
            assert {"parse_error", "interrupted"} <= set(recovered_usage["reasons"])
            usage.flush_usage_events(trigger="test")
        assert len(webhook.usage_events()) == (2 if billable else 0)
        if billable:
            assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
                "tokens.input": 50,
                "tokens.output": 200,
            }
    assert flow.response is not None
    assert flow.response.stream is False
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert "_response_inspection" not in flow.metadata


@pytest.mark.parametrize("failure", [None, "trailing-json", "truncated-json", "truncated-frame"])
@pytest.mark.parametrize("billable", [False, True], ids=["personal", "platform-billable"])
async def test_interrupted_capture_only_observes_fully_validated_document(
    real_flow,
    tmp_path,
    mitm_ctx,
    fake_firewall_headers,
    usage_webhook_api,
    control,
    failure,
    billable,
):
    flow = await _admit_model_flow(
        real_flow, tmp_path, mitm_ctx, fake_firewall_headers, billable=billable
    )
    body = _complete_body()
    if failure == "trailing-json":
        body += b"!"
    elif failure == "truncated-json":
        body = body[:-1]
    wire = encode_model_json(body, "zstd")
    if failure == "truncated-frame":
        wire = wire[:-1]
    mitm_addon.responseheaders(flow)
    assert response_stream(flow)(wire) == wire
    flow.error = Error("connection closed after capture")
    with usage_webhook_api() as webhook:
        completion = mitm_addon.error(flow)
        if completion is not None:
            await completion
        usage.flush_usage_events(trigger="test")
    result = _read_usage(control)
    assert result["observedResponses"] == int(failure is None)
    assert result["outstandingResponses"] == 0
    assert result["totals"]["input"] == (50 if failure is None else 0)
    assert result["totals"]["output"] == (200 if failure is None else 0)
    assert "interrupted" in result["reasons"]
    assert ("parse_error" in result["reasons"]) is (failure is not None)
    assert result["complete"] is False
    assert webhook.usage_events() == []
    assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert not response_streaming.has_pending_response_inspection(flow)
    assert usage.delivery_snapshot()["flows"] == 0
