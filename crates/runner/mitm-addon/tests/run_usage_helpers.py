"""Shared real request, response and private-control fixtures for cumulative usage."""

import json

import pytest
from mitmproxy.test import tutils

import mitm_addon
import run_usage
import runner_control
from tests.control_helpers import exchange, status_request
from tests.flow_helpers import header_map, response_stream
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


@pytest.fixture
def control(tmp_path):
    run_usage.initialize("generation-1")
    directory = tmp_path / "control"
    directory.mkdir(mode=0o700)
    server = runner_control.ControlServer(
        directory, "generation-1", usage_snapshot=run_usage.snapshot
    )
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
    data = reply["data"]
    assert isinstance(data, dict)
    return data


def write_registration(tmp_path, *, run_id="run-1", billable=False, generation="generation-1"):
    # A synthetic, credential-free source exercises cumulative usage across
    # HTTP and WebSocket protocols independently of managed-preset admission.
    firewall_name = "model-provider:usage-test"
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id=run_id,
            firewall_name=firewall_name,
            api_entry={
                "base": "https://openrouter.ai",
                "auth": {"headers": {}},
                "permissions": [
                    {
                        "name": "inference",
                        "rules": [
                            "POST /api/v1/responses",
                            "POST /api/v1/chat/completions",
                            "GET /api/v1/responses",
                        ],
                    }
                ],
            },
            network_policy={"allow": ["inference"], "deny": [], "ask": [], "unknownPolicy": "deny"},
            billable_firewalls=[firewall_name] if billable else [],
            sandbox_fields={
                "usageGeneration": generation,
                "cliAgentType": "codex",
                "modelUsageProvider": "gpt-5.5",
            },
        ),
    )


async def admit(real_flow, *, host="openrouter.ai", path="/api/v1/responses"):
    flow = real_flow(
        with_response=False, host=host, client_ip="10.200.0.5", method="POST", path=path
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
