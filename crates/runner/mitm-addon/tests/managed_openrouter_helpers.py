"""Synthetic managed OpenRouter requests for policy and native-hook tests."""

import json
from pathlib import Path

import managed_openrouter
import mitm_addon
from tests.request_handler_helpers import _single_firewall_sandbox

PRESET = "@preset/captured-org-route"
# Pi coding-agent 1.1.0's getDefaultAttributionHeaders adds these after the
# bare pi-ai request builder. Keep the production client profile in hook tests.
PI_ATTRIBUTION_HEADERS = (
    ("HTTP-Referer", "https://pi.dev"),
    ("X-OpenRouter-Title", "pi"),
    ("X-OpenRouter-Categories", "cli-agent"),
)
PATHS = {
    "openai-completions": "/api/v1/chat/completions",
    "openai-responses": "/api/v1/responses",
}


def model_config(dialect: str = "openai-completions", preset: str = PRESET) -> dict:
    return {
        "schemaVersion": 5 if dialect == "openai-completions" else 2,
        "provider": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "dialect": dialect,
        "transport": "sse",
        "model": preset,
        "credentialBindings": [
            {"kind": "api-key", "environment": "OPENAI_API_KEY", "secretName": "OPENROUTER_API_KEY"}
        ],
    }


def sandbox(tmp_path: Path, dialect: str = "openai-completions", preset: str = PRESET) -> dict:
    return _single_firewall_sandbox(
        tmp_path,
        firewall_name=managed_openrouter.OWNER,
        api_entry={
            "base": "https://openrouter.ai" + PATHS[dialect],
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.OPENROUTER_API_KEY }}"}},
            "permissions": [],
        },
        network_policy={"allow": [], "deny": [], "ask": [], "unknownPolicy": "allow"},
        billable_firewalls=[managed_openrouter.OWNER],
        sandbox_fields={
            "cliAgentType": "pi",
            "piModelConfig": model_config(dialect, preset),
            "modelUsageProvider": "okou-1.0",
        },
    )


def payload(dialect: str = "openai-completions", preset: str = PRESET) -> dict:
    return {
        "model": preset,
        "stream": True,
        "messages" if dialect == "openai-completions" else "input": [
            {"role": "user", "content": "hello"}
        ],
    }


def request(real_flow, body: dict | bytes | None = None, dialect: str = "openai-completions"):
    raw = (
        body
        if isinstance(body, bytes)
        else json.dumps(payload(dialect) if body is None else body).encode()
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="openrouter.ai",
        method="POST",
        path=PATHS[dialect],
        request_body=raw,
        request_content_type="application/json",
    )
    flow.request.headers["Content-Length"] = str(len(raw))
    flow.request.headers["Authorization"] = "Bearer sandbox-placeholder"
    for name, value in PI_ATTRIBUTION_HEADERS:
        flow.request.headers[name] = value
    return flow


async def authorize_headers(flow) -> None:
    continuation = mitm_addon.requestheaders(flow)
    if continuation is not None:
        await continuation
