"""Shared fixtures for model-provider JSON response usage tests."""

import json
from dataclasses import dataclass
from pathlib import Path

import mitm_addon
import usage
from tests.model_provider_flow_helpers import set_model_provider_flow_metadata


@dataclass(frozen=True)
class ModelProviderJsonCase:
    host: str
    original_url: str
    firewall_name: str
    cli_agent_type: str | None
    message_id: str
    model: str
    input_tokens: int = 50
    output_tokens: int = 200
    cached_tokens: int | None = None


CLAUDE_CODE_JSON_CASE = ModelProviderJsonCase(
    host="api.anthropic.com",
    original_url="https://api.anthropic.com/v1/messages",
    firewall_name="model-provider:claude-code-oauth-token",
    cli_agent_type="claude-code",
    message_id="msg_1",
    model="claude-sonnet-4-6",
)

OPENAI_RESPONSES_CASE = ModelProviderJsonCase(
    host="openrouter.ai",
    original_url="https://openrouter.ai/api/v1/responses",
    firewall_name="model-provider:openrouter-codex",
    cli_agent_type="codex",
    message_id="resp_1",
    model="gpt-5.5",
    cached_tokens=10,
)


def standard_success_payload(
    provider_case: ModelProviderJsonCase,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_tokens: int | None = None,
    cache_write_tokens: int | None = None,
) -> bytes:
    resolved_input_tokens = provider_case.input_tokens if input_tokens is None else input_tokens
    resolved_output_tokens = provider_case.output_tokens if output_tokens is None else output_tokens
    resolved_cached_tokens = provider_case.cached_tokens if cached_tokens is None else cached_tokens
    usage_payload: dict[str, object] = {
        "input_tokens": resolved_input_tokens,
        "output_tokens": resolved_output_tokens,
    }
    input_tokens_details: dict[str, int] = {}
    if resolved_cached_tokens is not None:
        input_tokens_details["cached_tokens"] = resolved_cached_tokens
    if cache_write_tokens is not None:
        input_tokens_details["cache_write_tokens"] = cache_write_tokens
    if input_tokens_details:
        usage_payload["input_tokens_details"] = input_tokens_details
    payload: dict[str, object] = {
        "id": provider_case.message_id,
        "model": provider_case.model,
        "usage": usage_payload,
    }
    return json.dumps(payload).encode()


def expected_model_usage(
    provider_case: ModelProviderJsonCase,
    *,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cached_tokens: int | None = None,
    cache_write_tokens: int | None = None,
) -> dict[str, object]:
    resolved_input_tokens = provider_case.input_tokens if input_tokens is None else input_tokens
    resolved_output_tokens = provider_case.output_tokens if output_tokens is None else output_tokens
    resolved_cached_tokens = provider_case.cached_tokens if cached_tokens is None else cached_tokens
    expected = {
        "message_id": provider_case.message_id,
        "model": provider_case.model,
        "tokens.input": resolved_input_tokens,
        "tokens.output": resolved_output_tokens,
    }
    remaining_input_tokens = resolved_input_tokens
    if resolved_cached_tokens is not None:
        assert resolved_cached_tokens <= remaining_input_tokens
        remaining_input_tokens -= resolved_cached_tokens
        expected["tokens.cache_read"] = resolved_cached_tokens
    if cache_write_tokens is not None:
        assert cache_write_tokens <= remaining_input_tokens
        remaining_input_tokens -= cache_write_tokens
        expected["tokens.cache_creation"] = cache_write_tokens
    expected["tokens.input"] = remaining_input_tokens
    return expected


def expected_event_quantities(
    provider_case: ModelProviderJsonCase,
    *,
    cache_write_tokens: int | None = None,
) -> dict[str, int]:
    return {
        category: quantity
        for category, quantity in expected_model_usage(
            provider_case,
            cache_write_tokens=cache_write_tokens,
        ).items()
        if category.startswith("tokens.")
        and isinstance(quantity, int)
        and not isinstance(quantity, bool)
        and quantity > 0
    }


def run_response(flow, usage_webhook_api):
    with usage_webhook_api() as webhook:
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")
    return webhook


def model_provider_flow(
    real_flow,
    tmp_path: Path,
    provider_case: ModelProviderJsonCase,
    *,
    billable: bool = True,
    proxy_log_path: Path | None = None,
    run_id: str = "run-abc-123",
):
    flow = real_flow(with_response=False, host=provider_case.host)
    set_model_provider_flow_metadata(
        flow,
        tmp_path,
        host=provider_case.host,
        original_url=provider_case.original_url,
        firewall_name=provider_case.firewall_name,
        proxy_log_path=proxy_log_path,
        run_id=run_id,
        firewall_billable=billable,
        cli_agent_type=provider_case.cli_agent_type,
        model_usage_provider=provider_case.model,
    )
    return flow
