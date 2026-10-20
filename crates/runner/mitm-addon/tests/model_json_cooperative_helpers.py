"""Synthetic model JSON bytes and production response-hook flow setup."""

import gzip
import json
import zlib
from pathlib import Path

import brotli
import zstandard
from mitmproxy import http
from mitmproxy.test import tutils

from tests.flow_helpers import header_map
from tests.model_provider_flow_helpers import RealFlowFactory
from tests.model_provider_response_helpers import (
    CLAUDE_CODE_JSON_CASE,
    OPENAI_RESPONSES_CASE,
    ModelProviderJsonCase,
    model_provider_flow,
)

_CHAT_CASE = ModelProviderJsonCase(
    host="api.openai.com",
    original_url="https://api.openai.com/v1/chat/completions",
    firewall_name="model-provider:openai-codex",
    cli_agent_type="codex",
    message_id="chatcmpl_1",
    model="gpt-5.5",
)
_CASES = {
    "anthropic": CLAUDE_CODE_JSON_CASE,
    "responses": OPENAI_RESPONSES_CASE,
    "chat": _CHAT_CASE,
}


def make_model_json_pipeline_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    protocol: str = "anthropic",
    encoding: str = "gzip",
    billable: bool = False,
) -> http.HTTPFlow:
    flow = model_provider_flow(
        real_flow,
        tmp_path,
        _CASES[protocol],
        billable=billable,
        proxy_log_path=tmp_path / "proxy.jsonl",
    )
    flow.request.method = "POST"
    headers = {"content-type": "application/json"}
    if encoding:
        headers["content-encoding"] = encoding
    flow.response = tutils.tresp(status_code=200, headers=header_map(headers))
    return flow


def model_json_body(
    protocol: str = "anthropic", *, characters: int = 32_768, ensure_ascii: bool = True
) -> bytes:
    case = _CASES[protocol]
    quantities = (
        {"prompt_tokens": 50, "completion_tokens": 200}
        if protocol == "chat"
        else {"input_tokens": 50, "output_tokens": 200}
    )
    # Put usage first: accepted prefix fields must still wait for the document.
    body: dict[str, object] = {"id": case.message_id, "model": case.model, "usage": quantities}
    text = "中" * characters
    if protocol == "chat":
        body["choices"] = [{"message": {"role": "assistant", "content": text}}]
    elif protocol == "responses":
        body["output"] = [{"type": "message", "content": [{"type": "output_text", "text": text}]}]
    else:
        body["content"] = [{"type": "text", "text": text}]
    return json.dumps(body, ensure_ascii=ensure_ascii, separators=(",", ":")).encode()


def encode_model_json(body: bytes, encoding: str) -> bytes:
    if encoding == "gzip":
        return gzip.compress(body, mtime=0)
    if encoding == "deflate":
        return zlib.compress(body)
    if encoding == "br":
        return brotli.compress(body)
    if encoding == "zstd":
        return zstandard.ZstdCompressor().compress(body)
    return body
