"""Content-free length rejection evidence at the production HTTP hook boundary."""

import asyncio
import json
from pathlib import Path

import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import managed_openrouter as managed
import mitm_addon
from logging_utils import flush_log_path
from tests.managed_openrouter_helpers import payload, prepare_request_headers, request, sandbox
from tests.request_handler_helpers import _write_registry


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("phase", ["requestheaders", "request"])
@pytest.mark.parametrize(
    ("values", "kind", "declared_bytes"),
    [
        pytest.param([], "missing", None, id="missing"),
        pytest.param(["private-length-canary"], "invalid", None, id="invalid-private-value"),
        pytest.param(["33554433", "33554434"], "conflicting", None, id="conflicting"),
        pytest.param(["0000"], "zero", 0, id="zero"),
        pytest.param(["9007199254740992"], "over_limit", None, id="beyond-json-safe-limit"),
        pytest.param(["9" * 5000], "over_limit", None, id="unbounded-numeral"),
    ],
)
async def test_length_rejection_persists_exact_or_explicitly_unavailable_evidence(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    dialect,
    phase,
    values,
    kind,
    declared_bytes,
):
    info = sandbox(tmp_path, dialect)
    info["captureNetworkBodies"] = True
    registry = _write_registry(tmp_path, sandbox_info=info)
    body = payload(dialect)
    body["messages" if dialect == "openai-completions" else "input"][0]["content"] = (
        "private-body-canary"
    )
    flow = request(real_flow, body, dialect)
    flow.request.headers["Authorization"] = "Bearer private-credential-canary"
    flow.request.headers.set_all("Content-Length", values)
    if phase == "requestheaders":
        flow.request.raw_content = None

    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as auth_fetch:
        if phase == "requestheaders":
            assert mitm_addon.requestheaders(flow) is None
            await mitm_addon.request(flow)
            assert flow.error is not None
            assert flow.error.msg == "Connection killed."
            assert flow.response is None
            assert flow.request.raw_content is None
            mitm_addon.error(flow)
        else:
            await mitm_addon.request(flow)
            assert flow.error is None
            assert flow.response is not None
            assert flow.response.status_code == 403
            assert flow.response.json()["reason"] == "body_length"
            mitm_addon.response(flow)
        auth_fetch.assert_not_called()

    assert flow.request.headers["Authorization"] == "Bearer private-credential-canary"
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert managed.admission_state_for_tests() == (0, 0)
    proxy_path = Path(info["proxyLogPath"])
    assert await asyncio.to_thread(flush_log_path, str(proxy_path))
    text = await asyncio.to_thread(proxy_path.read_text)
    records = [json.loads(line) for line in text.splitlines()]
    policies = [row for row in records if row.get("type") == "managed_model_policy"]
    assert len(policies) == 1
    policy = policies[0]
    assert policy["reason"] == "body_length"
    assert policy["rejection_phase"] == phase
    assert policy["content_length_kind"] == kind
    assert policy["content_length_limit_bytes"] == 9_007_199_254_740_991
    assert policy["declared_content_length_bytes"] == declared_bytes
    assert policy["declared_content_length_is_exact"] is (declared_bytes is not None)
    assert len(json.dumps(policy)) < 1024
    assert "private-length-canary" not in text
    assert "private-credential-canary" not in text
    assert "private-body-canary" not in text
    network_path = Path(info["networkLogPath"])
    assert await asyncio.to_thread(flush_log_path, str(network_path))
    network_text = await asyncio.to_thread(network_path.read_text)
    network_records = [json.loads(line) for line in network_text.splitlines()]
    assert all("request_body" not in row for row in network_records)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("declared_bytes", [33_554_431, 33_554_432, 33_554_433, 134_217_729])
async def test_lengths_at_or_below_limit_still_admit_before_body_arrives(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect, declared_bytes
):
    info = sandbox(tmp_path, dialect)
    registry = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow, dialect=dialect)
    flow.request.headers["Content-Length"] = str(declared_bytes)
    flow.request.raw_content = None
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as auth_fetch:
        await prepare_request_headers(flow)
        assert flow.error is None
        assert flow.response is None
        assert callable(flow.request.stream)
        assert managed.admission_state_for_tests() == (1, declared_bytes)
        flow.error = Error("client disconnected while uploading")
        mitm_addon.error(flow)
        auth_fetch.assert_awaited_once()
    assert managed.admission_state_for_tests() == (0, 0)
    proxy_path = Path(info["proxyLogPath"])
    assert await asyncio.to_thread(flush_log_path, str(proxy_path))
    text = await asyncio.to_thread(proxy_path.read_text)
    records = [json.loads(line) for line in text.splitlines()]
    assert not any(row.get("type") == "managed_model_policy" for row in records)


async def test_other_policy_rejection_does_not_claim_a_length_failure(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    info = sandbox(tmp_path)
    registry = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow, {**payload(), "model": "@preset/other"})
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers() as auth_fetch:
        await mitm_addon.request(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.response.json()["reason"] == "model"
        mitm_addon.response(flow)
        auth_fetch.assert_not_called()
    assert managed.admission_state_for_tests() == (0, 0)
    proxy_path = Path(info["proxyLogPath"])
    assert await asyncio.to_thread(flush_log_path, str(proxy_path))
    text = await asyncio.to_thread(proxy_path.read_text)
    records = [json.loads(line) for line in text.splitlines()]
    policies = [row for row in records if row.get("type") == "managed_model_policy"]
    assert len(policies) == 1
    assert policies[0]["reason"] == "model"
    assert policies[0]["rejection_phase"] == "request"
    assert not any("content_length" in key for key in policies[0])
