"""Shared model-provider SSE usage integration-test mechanics."""

import asyncio
import gzip
import zlib
from collections.abc import Awaitable, Callable
from contextlib import AbstractContextManager
from pathlib import Path

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.model_provider_flow_helpers import RealFlowFactory, make_model_provider_sse_flow
from tests.usage_helpers import UsageWebhookServer

UsageWebhookApi = Callable[[], AbstractContextManager[UsageWebhookServer]]


def model_provider_sse_flow(
    tmp_path: Path,
    real_flow: RealFlowFactory,
    *,
    host: str,
    original_url: str,
    firewall_name: str,
    model_usage_provider: str | None,
    cli_agent_type: str | None = None,
) -> http.HTTPFlow:
    return make_model_provider_sse_flow(
        real_flow,
        tmp_path,
        host=host,
        original_url=original_url,
        firewall_name=firewall_name,
        cli_agent_type=cli_agent_type,
        model_usage_provider=model_usage_provider,
    )


def compress_zlib_sse(body: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body)
    assert encoding == "deflate"
    return zlib.compress(body)


async def _join_completion(completion: Awaitable[None]) -> None:
    await completion


def run_response(
    flow: http.HTTPFlow,
    usage_webhook_api: UsageWebhookApi,
) -> UsageWebhookServer:
    with usage_webhook_api() as webhook:
        completion = mitm_addon.response(flow)
        if completion is not None:
            asyncio.run(_join_completion(completion))
        usage.flush_usage_events(trigger="test")
    return webhook


def run_error(
    flow: http.HTTPFlow,
    usage_webhook_api: UsageWebhookApi,
) -> UsageWebhookServer:
    with usage_webhook_api() as webhook:
        completion = mitm_addon.error(flow)
        if completion is not None:
            asyncio.run(_join_completion(completion))
        usage.flush_usage_events(trigger="test")
    return webhook


def model_sse_parse_warnings(flow: http.HTTPFlow) -> list[dict]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    if not jsonl_exists_after_flush(proxy_log):
        return []
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("message") == "Model provider SSE usage extraction failed"
    ]


def assert_single_model_sse_parse_warning(
    flow: http.HTTPFlow,
    *,
    usage_protocol: str,
    event: str,
    error: str | None = None,
) -> None:
    usage_warnings = model_sse_parse_warnings(flow)
    assert len(usage_warnings) == 1
    warning = usage_warnings[0]
    assert warning["level"] == "warn"
    assert warning["type"] == "usage_event"
    assert warning["usage_protocol"] == usage_protocol
    assert warning["event"] == event
    if error is None:
        assert warning["error"]
    else:
        assert warning["error"] == error
