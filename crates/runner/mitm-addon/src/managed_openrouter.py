"""Enforce captured presets before applying platform OpenRouter credentials.

The Runner writes piModelConfig from the API-owned execution context into its
private registry. It is request policy, not proof of the sandbox caller's identity.
Caller/connector-owner isolation is a separate boundary. No request may bypass
this policy through header-phase auth or request streaming.

Managed requests use incrementally validated, identity-encoded JSON with a declared length.
Only Pi's supported content/protocol/output/cache fields are forwarded; preset,
model-list, provider, plugin and server-tool routing overrides are rejected.
The response remains eligible for the ordinary SSE streaming path. Runner and
this private registry reader ship together; old Runner artifacts must drain for
enforcement. No API writer or persisted-context generation changes are needed.
"""

import re
from dataclasses import dataclass

from mitmproxy import http

import content_length
import managed_request_body
from logging_utils import NETWORK_LOG_MAX_SAFE_SIZE
from managed_openrouter_json import PolicyError, PolicyJsonValidator
from request_authority import AuthorityValidationError, get_trusted_authority

OWNER = "model-provider:openrouter-codex"
HOST = "openrouter.ai"
_MAX_JSON_DEPTH = 128
_MAX_JSON_WORK = 262_144
_HTTPS_PORT = 443
_PRESET = re.compile(r"@preset/[A-Za-z0-9_.-]{1,504}\Z")
_CAPTURED_POLICY = "_managed_openrouter_captured_policy"
_HEADERS = frozenset(
    (
        "accept",
        "accept-encoding",
        "accept-language",
        "authorization",
        "baggage",
        "cache-control",
        "connection",
        "content-encoding",
        "content-length",
        "content-type",
        "expect",
        "host",
        "http-referer",
        "pragma",
        "sec-fetch-mode",
        "traceparent",
        "tracestate",
        "user-agent",
        "x-client-request-id",
        # Pi coding-agent adds OpenRouter app attribution after pi-ai builds
        # the request. These exact metadata headers do not select a route.
        "x-openrouter-categories",
        "x-openrouter-title",
        "x-session-id",
        "x-session-affinity",
        "x-title",
    )
)
_COMMON_FIELDS = frozenset(
    (
        "model",
        "stream",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "store",
        "prompt_cache_key",
        "prompt_cache_retention",
        "service_tier",
        "temperature",
        "top_p",
        "stop",
        "seed",
        "user",
        "metadata",
    )
)
_FIELDS = {
    "openai-completions": _COMMON_FIELDS
    | {
        "messages",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
    },
    "openai-responses": _COMMON_FIELDS
    | {
        "input",
        "instructions",
        "max_output_tokens",
        "include",
        "prompt_cache_options",
    },
}
_PATHS = {
    "openai-completions": "/api/v1/chat/completions",
    "openai-responses": "/api/v1/responses",
}


class RequestRejectedError(ValueError):
    """A fixed, non-secret reason suitable for a local policy response."""


class BodyLengthRejectedError(RequestRejectedError):
    """Retain bounded scalar evidence from the rejected declaration, never headers."""

    def __init__(self, result: content_length.ContentLengthResult, values: list[str]) -> None:
        super().__init__("body_length")
        self.kind = "zero" if result.kind == "valid" and result.value == 0 else result.kind
        self.limit_bytes = NETWORK_LOG_MAX_SAFE_SIZE
        self.declared_bytes: int | None = result.value if result.kind == "valid" else None
        if result.kind == "over_limit":
            # The admission parser can return limit + 1 as a sentinel. Reuse its
            # bounded conversion on this rejection path to retain exact ordinary
            # sizes without serializing arbitrary integers or raw header text.
            diagnostic = content_length.parse(values, max_value=NETWORK_LOG_MAX_SAFE_SIZE)
            if diagnostic.kind == "valid":
                self.declared_bytes = diagnostic.value


@dataclass(frozen=True, slots=True)
class PresetPolicy:
    preset: str
    dialect: str
    service_tier: str | None


@dataclass(frozen=True, slots=True)
class _CapturedPolicy:
    run_id: str
    policy: PresetPolicy


def policy_for_sandbox(sandbox: dict) -> PresetPolicy | None:
    """Read only API-captured intent, never sandbox env or supplied headers."""
    config = sandbox.get("piModelConfig")
    if not isinstance(config, dict):
        return None
    preset = config.get("model")
    dialect = config.get("dialect")
    tier = config.get("serviceTier")
    if (
        config.get("provider") != "openrouter"
        or config.get("baseUrl")
        not in ("https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/")
        or config.get("transport") != "sse"
        or not isinstance(preset, str)
        or _PRESET.fullmatch(preset) is None
        or not isinstance(dialect, str)
        or dialect not in _PATHS
        or tier not in (None, "priority")
        or (dialect == "openai-completions" and tier is not None)
    ):
        return None
    return PresetPolicy(preset, dialect, tier)


def _validate_headers(flow: http.HTTPFlow, policy: PresetPolicy) -> int:
    try:
        authority = get_trusted_authority(flow)
    except AuthorityValidationError as error:
        raise RequestRejectedError("endpoint") from error
    if (
        flow.request.method != "POST"
        or flow.request.scheme != "https"
        or authority.host != HOST
        or authority.port != _HTTPS_PORT
        or flow.request.path != _PATHS[policy.dialect]
    ):
        raise RequestRejectedError("endpoint")
    for name, _value in flow.request.headers.fields:
        normalized = name.decode("ascii", errors="replace").lower()
        if normalized not in _HEADERS and not normalized.startswith("x-stainless-"):
            raise RequestRejectedError("header")
    media_types = flow.request.headers.get_all("Content-Type")
    if len(media_types) != 1 or media_types[0].lower().replace(" ", "") not in (
        "application/json",
        "application/json;charset=utf-8",
        'application/json;charset="utf-8"',
    ):
        raise RequestRejectedError("content_type")
    encodings = flow.request.headers.get_all("Content-Encoding")
    if encodings and (len(encodings) != 1 or encodings[0].lower().strip() != "identity"):
        raise RequestRejectedError("content_encoding")
    if flow.request.headers.get_all("Transfer-Encoding"):
        raise RequestRejectedError("transfer_encoding")
    values = flow.request.headers.get_all("Content-Length")
    length = content_length.parse(values, max_value=NETWORK_LOG_MAX_SAFE_SIZE)
    if length.kind != "valid" or length.value == 0:
        raise BodyLengthRejectedError(length, values)
    return length.value


def admit_request(flow: http.HTTPFlow, sandbox: dict) -> None:
    """Select private spooling before native request-body accumulation starts."""
    policy = policy_for_sandbox(sandbox)
    if policy is None:
        raise RequestRejectedError("captured_policy")
    length = _validate_headers(flow, policy)
    release_from_flow(flow)
    managed_request_body.attach(
        flow,
        managed_request_body.TemporaryBody(
            length,
            _validator(policy),
            capture=sandbox.get("captureNetworkBodies") is True,
        ),
    )
    flow.metadata[_CAPTURED_POLICY] = _CapturedPolicy(sandbox["runId"], policy)
    flow.request.stream = False


def _validator(policy: PresetPolicy) -> PolicyJsonValidator:
    return PolicyJsonValidator(
        preset=policy.preset,
        service_tier=policy.service_tier,
        fields=_FIELDS[policy.dialect],
        max_depth=_MAX_JSON_DEPTH,
        max_work=_MAX_JSON_WORK,
    )


def validate_request(flow: http.HTTPFlow, sandbox: dict) -> PresetPolicy:
    """Validate complete, original bytes before any managed auth resolution."""
    policy = policy_for_sandbox(sandbox)
    if policy is None:
        raise RequestRejectedError("captured_policy")
    captured = flow.metadata.get(_CAPTURED_POLICY)
    if captured is not None and captured != _CapturedPolicy(sandbox["runId"], policy):
        raise RequestRejectedError("captured_policy_changed")
    if flow.request.trailers:
        raise RequestRejectedError("trailers")
    length = _validate_headers(flow, policy)
    stored = managed_request_body.get(flow)
    if stored is not None and stored.failure is not None:
        raise RequestRejectedError(stored.failure)
    if stored is not None and stored.validated:
        if stored.closed or stored.length != length or flow.request.raw_content not in (None, b""):
            raise RequestRejectedError("incomplete_body")
        return policy
    body = flow.request.raw_content
    if flow.request.stream or body is None or len(body) != length:
        raise RequestRejectedError("incomplete_body")
    validator = _validator(policy)
    try:
        for offset in range(0, len(body), managed_request_body.PARSE_BYTES):
            validator.feed(body[offset : offset + managed_request_body.PARSE_BYTES])
        validator.finish()
    except PolicyError as error:
        raise RequestRejectedError(str(error)) from error
    return policy


def release_from_flow(flow: http.HTTPFlow) -> None:
    """Idempotent abandonment; successful replay releases storage before SSE."""
    managed_request_body.release(flow)
    flow.metadata.pop(_CAPTURED_POLICY, None)


def admission_state_for_tests() -> tuple[int, int]:
    return managed_request_body.state_for_tests()


def reset_for_tests() -> None:
    managed_request_body.reset_for_tests()
