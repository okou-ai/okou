"""Shared model-provider flow helpers for mitm-addon tests."""

from collections.abc import Callable
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import http_network_log
from tests.flow_helpers import header_map
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush

RealFlowFactory = Callable[..., http.HTTPFlow]
_WEBSOCKET_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
_WEBSOCKET_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def _openai_responses_websocket_request_headers() -> http.Headers:
    return http.Headers(
        [
            (b"Host", b"openrouter.ai"),
            (b"Connection", b"keep-alive, Upgrade"),
            (b"Upgrade", b"websocket"),
            (b"Sec-WebSocket-Key", _WEBSOCKET_KEY.encode()),
            (b"Sec-WebSocket-Version", b"13"),
        ]
    )


def make_openai_responses_websocket_request_flow(
    real_flow: RealFlowFactory,
) -> http.HTTPFlow:
    return real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="openrouter.ai",
        path="/api/v1/responses",
        method="GET",
        request_headers=_openai_responses_websocket_request_headers(),
    )


def make_openai_responses_websocket_response_headers(
    *,
    connection: str | None = "Upgrade",
    upgrade: str = "websocket",
    accept: str = _WEBSOCKET_ACCEPT,
) -> http.Headers:
    pairs = [
        (b"Upgrade", upgrade.encode()),
        (b"Sec-WebSocket-Accept", accept.encode()),
    ]
    if connection is not None:
        pairs.insert(0, (b"Connection", connection.encode()))
    return http.Headers(pairs)


def set_model_provider_flow_metadata(
    flow: http.HTTPFlow,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    proxy_log_path: Path | str | None,
    run_id: str = "run-abc-123",
    network_log_path: Path | str | None = None,
    firewall_action: str = "ALLOW",
    firewall_billable: object = True,
    sandbox_token: str | None = None,
    cli_agent_type: str | None = None,
    model_usage_provider: str | None = None,
) -> None:
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(
        network_log_path if network_log_path is not None else tmp_path / "network.jsonl"
    )
    if proxy_log_path is not None:
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = firewall_action
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    http_network_log.set_target(
        flow,
        url=original_url,
        host=host,
        port=flow.request.port,
    )
    flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = (
        "tok-xyz" if sandbox_token is None else sandbox_token
    )
    if cli_agent_type is not None:
        flow.metadata[metadata_keys.CLI_AGENT_TYPE] = cli_agent_type
    if model_usage_provider is not None:
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = model_usage_provider
        flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 0


def make_model_provider_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    path: str = "/",
    method: str = "GET",
    run_id: str = "run-abc-123",
    network_log_path: Path | str | None = None,
    proxy_log_path: Path | str | None = None,
    firewall_action: str = "ALLOW",
    firewall_billable: object = True,
    sandbox_token: str | None = None,
    cli_agent_type: str | None = None,
    model_usage_provider: str | None = None,
) -> http.HTTPFlow:
    flow = real_flow(with_response=False, host=host, path=path, method=method)
    set_model_provider_flow_metadata(
        flow,
        tmp_path,
        host=host,
        original_url=original_url,
        firewall_name=firewall_name,
        proxy_log_path=(proxy_log_path if proxy_log_path is not None else tmp_path / "proxy.jsonl"),
        run_id=run_id,
        network_log_path=network_log_path,
        firewall_action=firewall_action,
        firewall_billable=firewall_billable,
        sandbox_token=sandbox_token,
        cli_agent_type=cli_agent_type,
        model_usage_provider=model_usage_provider,
    )
    return flow


def make_model_provider_usage_reporting_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str = "openrouter.ai",
    original_url: str = "https://openrouter.ai/api/v1/responses",
    firewall_name: str = "model-provider:openrouter-codex",
    run_id: str = "run-abc-123",
    network_log_path: Path | str | None = None,
    proxy_log_path: Path | str | None = None,
    firewall_billable: bool = True,
    sandbox_token: str | None = None,
    model_usage_provider: str | None = "claude-sonnet-4-6",
    usage: dict | None = None,
    usage_sources: dict | None = None,
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host=host,
        original_url=original_url,
        firewall_name=firewall_name,
        run_id=run_id,
        network_log_path=network_log_path,
        proxy_log_path=proxy_log_path,
        firewall_billable=firewall_billable,
        sandbox_token=sandbox_token,
        model_usage_provider=model_usage_provider,
    )
    if usage is not None:
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage
    if usage_sources is not None:
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = usage_sources
    return flow


def make_openai_responses_websocket_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host="openrouter.ai",
        original_url="https://openrouter.ai/api/v1/responses",
        firewall_name="model-provider:openrouter-codex",
        cli_agent_type="codex",
        model_usage_provider="gpt-5.5",
    )
    flow.metadata[metadata_keys.MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS] = 272_001
    flow.request.headers = _openai_responses_websocket_request_headers()
    flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] = True
    flow.response = tutils.tresp(
        status_code=101,
        headers=make_openai_responses_websocket_response_headers(),
    )
    return flow


def make_model_provider_sse_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    cli_agent_type: str | None = None,
    model_usage_provider: str | None = "claude-sonnet-4-6",
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host=host,
        original_url=original_url,
        firewall_name=firewall_name,
        cli_agent_type=cli_agent_type,
        model_usage_provider=model_usage_provider,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "text/event-stream"}),
    )
    return flow


def model_provider_usage_sources(flow: http.HTTPFlow) -> dict:
    sources = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]
    assert isinstance(sources, dict)
    return sources


def model_usage_source_entries(flow: http.HTTPFlow) -> list[dict]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    if not jsonl_exists_after_flush(proxy_log):
        return []
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("type") == "model_usage_source"
    ]
