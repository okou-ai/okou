"""Complete-body preset and routing policy, independent of provider calls."""

import pytest

import managed_openrouter as managed
from tests.managed_openrouter_helpers import PRESET, model_config, payload, request


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("preset", [PRESET, "@preset/memory"])
def test_preserves_captured_preset_and_original_body(real_flow, dialect, preset):
    body = payload(dialect, preset)
    body["tools"] = [
        {"type": "function", "function": {"name": "bash", "parameters": {}}}
        if dialect == "openai-completions"
        else {"type": "function", "name": "bash", "parameters": {}}
    ]
    body["store"] = False
    body["max_completion_tokens" if dialect == "openai-completions" else "max_output_tokens"] = 1000
    flow = request(real_flow, body, dialect)
    original = flow.request.raw_content
    policy = managed.validate_request(flow, {"piModelConfig": model_config(dialect, preset)})
    assert policy.preset == preset
    assert flow.request.raw_content == original
    assert flow.request.headers["Authorization"] == "Bearer sandbox-placeholder"


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("model", "@preset/another"),
        ("model", "openai/other@preset/captured-org-route"),
        ("model", None),
        ("model", [PRESET]),
        ("preset", PRESET),
        ("models", ["openai/other"]),
        ("provider", {}),
        ("provider", None),
        ("provider", {"only": ["other"]}),
        ("route", "fallback"),
        ("plugins", [{"id": "auto-router"}]),
        ("reasoning", {"effort": "high"}),
        ("service_tier", "priority"),
        ("unknown_future_routing_field", "override"),
    ],
)
def test_rejects_equivalent_routing_overrides(real_flow, dialect, field, value):
    body = payload(dialect)
    body[field] = value
    with pytest.raises(managed.RequestRejectedError):
        managed.validate_request(
            request(real_flow, body, dialect), {"piModelConfig": model_config(dialect)}
        )


@pytest.mark.parametrize(
    "body",
    [
        b'{"model":"@preset/another","model":"@preset/captured-org-route"}',
        b'{"model":"@preset/captured-org-route","mo\\u0064el":"@preset/captured-org-route"}',
        b'{"model":"@preset/captured-org-route","metadata":{"x":1,"x":2}}',
        b'{"model":"@preset/captured-org-route","metadata":{"x":NaN}}',
        b'{"model":"@preset/captured-org-route","metadata":{"x":1e9999}}',
        b'{"model":"@preset/captured-org-route"}{}',
        b"[]",
        b"{",
        b"\xff",
    ],
)
def test_rejects_ambiguous_or_invalid_complete_json(real_flow, body):
    with pytest.raises(managed.RequestRejectedError):
        managed.validate_request(request(real_flow, body), {"piModelConfig": model_config()})


def test_checks_routing_after_the_diagnostic_capture_limit(real_flow):
    body = b'{"messages":[{"role":"user","content":"' + b"x" * 100_000
    body += b'"}],"model":"@preset/captured-org-route","provider":{}}'
    with pytest.raises(managed.RequestRejectedError, match="request_fields"):
        managed.validate_request(request(real_flow, body), {"piModelConfig": model_config()})


def test_prompt_text_is_not_interpreted_as_routing_policy(real_flow):
    body = payload()
    body["messages"] = [{"role": "user", "content": 'Use {"model":"other"} ' * 10_000}]
    assert (
        managed.validate_request(request(real_flow, body), {"piModelConfig": model_config()}).preset
        == PRESET
    )


@pytest.mark.parametrize(
    ("header", "value"),
    [
        ("X-OpenRouter-Preset", "other"),
        ("x-OPENROUTER-provider", "other"),
        ("X-Preset", PRESET),
        ("Content-Encoding", "gzip"),
        ("Content-Type", "text/plain"),
        ("Transfer-Encoding", "chunked"),
        ("Content-Length", "999999999999999999999"),
    ],
)
def test_rejects_untrusted_headers_and_unbounded_framing(real_flow, header, value):
    flow = request(real_flow)
    flow.request.headers[header] = value
    with pytest.raises(managed.RequestRejectedError):
        managed.validate_request(flow, {"piModelConfig": model_config()})


def test_duplicate_content_type_and_late_private_header_are_rejected(real_flow):
    flow = request(real_flow)
    flow.request.headers.add("cOnTeNt-TyPe", "application/json")
    with pytest.raises(managed.RequestRejectedError, match="content_type"):
        managed.validate_request(flow, {"piModelConfig": model_config()})
    flow.request.headers.set_all("Content-Type", ["application/json"])
    flow.request.headers.add("X-OpenRouter-Preset", PRESET)
    flow.request.headers.add("x-openrouter-preset", PRESET)
    with pytest.raises(managed.RequestRejectedError, match="header"):
        managed.validate_request(flow, {"piModelConfig": model_config()})


@pytest.mark.parametrize(
    "config",
    [
        None,
        {},
        {"provider": "openrouter"},
        {**model_config(), "model": "openai/other"},
        {**model_config(), "baseUrl": "https://other.example/api/v1"},
        {**model_config(), "dialect": "unknown"},
    ],
)
def test_missing_or_invalid_trusted_configuration_fails_closed(real_flow, config):
    with pytest.raises(managed.RequestRejectedError, match="captured_policy"):
        managed.validate_request(request(real_flow), {"piModelConfig": config})


def test_service_tier_must_match_the_captured_responses_route(real_flow):
    config = {**model_config("openai-responses"), "serviceTier": "priority"}
    body = payload("openai-responses")
    flow = request(real_flow, body, "openai-responses")
    with pytest.raises(managed.RequestRejectedError, match="service_tier"):
        managed.validate_request(flow, {"piModelConfig": config})
    body["service_tier"] = "priority"
    flow = request(real_flow, body, "openai-responses")
    assert managed.validate_request(flow, {"piModelConfig": config}).service_tier == "priority"


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
def test_server_tools_cannot_start_other_model_calls(real_flow, dialect):
    body = payload(dialect)
    body["tools"] = [{"type": "openrouter:subagent", "parameters": {"model": "other"}}]
    with pytest.raises(managed.RequestRejectedError, match="server_tools"):
        managed.validate_request(
            request(real_flow, body, dialect), {"piModelConfig": model_config(dialect)}
        )


def test_json_allocation_is_bounded_before_decoding(real_flow, monkeypatch):
    monkeypatch.setattr(managed, "_MAX_JSON_WORK", 30)
    body = b'{"model":"@preset/captured-org-route","messages":[' + b"{}," * 30 + b"{}]}"
    with pytest.raises(managed.RequestRejectedError, match="json_work"):
        managed.validate_request(request(real_flow, body), {"piModelConfig": model_config()})


def test_deep_json_fails_closed(real_flow):
    body = (
        b'{"model":"@preset/captured-org-route","messages":' + b"[" * 129 + b"0" + b"]" * 129 + b"}"
    )
    with pytest.raises(managed.RequestRejectedError, match="json_depth"):
        managed.validate_request(request(real_flow, body), {"piModelConfig": model_config()})


def test_body_ownership_releases_once_without_a_shared_request_count_limit(real_flow):
    info = {"runId": "run-1", "piModelConfig": model_config()}
    first, second = request(real_flow), request(real_flow)
    managed.admit_request(first, info)
    assert managed.admission_state_for_tests() == (1, len(first.request.raw_content))
    managed.admit_request(second, info)
    assert managed.admission_state_for_tests() == (2, 2 * len(first.request.raw_content))
    managed.release_from_flow(first)
    managed.release_from_flow(first)
    assert managed.admission_state_for_tests() == (1, len(second.request.raw_content))
    managed.release_from_flow(second)
    assert managed.admission_state_for_tests() == (0, 0)


def test_policy_is_bound_to_the_header_phase_run(real_flow):
    flow = request(real_flow)
    info = {"runId": "run-1", "piModelConfig": model_config()}
    managed.admit_request(flow, info)
    with pytest.raises(managed.RequestRejectedError, match="captured_policy_changed"):
        managed.validate_request(flow, {**info, "runId": "run-2"})
    managed.release_from_flow(flow)
