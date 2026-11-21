"""Shared request-target rules for response parsing and cumulative model usage."""

from typing import Literal

from mitmproxy import http

import flow_metadata
import runtime_url_parsing


def normalized_target(flow: http.HTTPFlow) -> str:
    """Prefer the captured original target and remove query, fragment and trailing slashes."""
    target = flow_metadata.original_url(flow.metadata) or flow.request.path
    return runtime_url_parsing.strip_url_query_and_fragment(target).rstrip("/")


def openai_protocol(target: str) -> Literal["openai_chat_completions", "openai_responses"] | None:
    """Recognize the explicit OpenAI operation in a normalized target."""
    if target.endswith("/chat/completions"):
        return "openai_chat_completions"
    if target.endswith("/responses"):
        return "openai_responses"
    return None
