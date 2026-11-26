"""Synthetic provider bytes and real addon flows for cooperative SSE tests."""

import gzip
import json
import zlib
from functools import lru_cache
from io import BytesIO
from pathlib import Path

import brotli
from mitmproxy import http

import flow_metadata_keys as metadata_keys
from tests.model_provider_flow_helpers import RealFlowFactory, make_model_provider_sse_flow

_SSE_JSON_ENCODER = json.JSONEncoder(separators=(",", ":"))


def make_model_sse_pipeline_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    protocol: str = "anthropic",
    encoding: str = "gzip",
    billable: bool = False,
) -> http.HTTPFlow:
    anthropic = protocol == "anthropic"
    host = "api.anthropic.com" if anthropic else "api.openai.com"
    path = {
        "anthropic": "/v1/messages",
        "responses": "/v1/responses",
        "chat": "/v1/chat/completions",
    }[protocol]
    flow = make_model_provider_sse_flow(
        real_flow,
        tmp_path,
        host=host,
        original_url=f"https://{host}{path}",
        firewall_name=(
            "model-provider:anthropic-claude-code" if anthropic else "model-provider:openai-codex"
        ),
        cli_agent_type="claude-code" if anthropic else "codex",
        model_usage_provider="claude-sonnet-4-6" if anthropic else "gpt-5.5",
    )
    flow.request.method = "POST"
    flow.request.path = path
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = billable
    assert flow.response is not None
    if encoding:
        flow.response.headers["content-encoding"] = encoding
    return flow


def _model_sse_update_template(protocol: str) -> bytes:
    if protocol == "anthropic":
        event = b"message_delta"
    elif protocol == "responses":
        # Unknown compatible-provider events may legitimately contain usage.
        event = b"gateway.usage"
    else:
        return b'data: {"usage":{"completion_tokens":%s}}\n\n'
    return (
        b"event: " + event + b'\ndata: {"type":"' + event + b'","usage":{"output_tokens":%s}}\n\n'
    )


def model_sse_update(protocol: str, output: int) -> bytes:
    return _model_sse_update_template(protocol) % _SSE_JSON_ENCODER.encode(output).encode()


def build_model_sse_updates(protocol: str, outputs: range) -> bytes:
    """Render integer ranges without retaining each frame until the body is complete."""
    template = _model_sse_update_template(protocol)
    body = BytesIO()
    for output in outputs:
        body.write(template % str(output).encode("ascii"))
    return body.getvalue()


@lru_cache(maxsize=6)
def model_sse_updates(protocol: str, count: int) -> bytes:
    """Reuse the three protocols' 40/10,000-event inputs, never per-flow state."""
    return build_model_sse_updates(protocol, range(1, count + 1))


def model_sse_terminal(protocol: str, output: int) -> bytes:
    if protocol == "anthropic":
        return model_sse_update(protocol, output) + (
            b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        )
    if protocol == "chat":
        return model_sse_update(protocol, output) + b"data: [DONE]\n\n"
    return (
        b"event: response.completed\ndata: "
        + _SSE_JSON_ENCODER.encode(
            {"type": "response.completed", "response": {"usage": {"output_tokens": output}}}
        ).encode()
        + b"\n\n"
    )


def encode_model_sse(body: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body, mtime=0)
    if encoding == "deflate":
        return zlib.compress(body)
    if encoding == "br":
        return brotli.compress(body)
    return body
