"""Enforce captured presets before applying platform OpenRouter credentials.

The Runner writes piModelConfig from the API-owned execution context into its
private registry. It is request policy, not proof of the sandbox caller's identity.
Caller/connector-owner isolation is a separate boundary. No request may bypass
this policy through header-phase auth or request streaming.

Managed requests use bounded, identity-encoded JSON with a declared length.
Only Pi's supported content/protocol/output/cache fields are forwarded; preset,
model-list, provider, plugin and server-tool routing overrides are rejected.
The response remains eligible for the ordinary SSE streaming path. Runner and
this private registry reader ship together; old Runner artifacts must drain for
enforcement. No API writer or persisted-context generation changes are needed.

Request counts are scoped to the host-assigned sandbox source IP used by the
private registry. All sandboxes still share the retained-body byte budget.
"""

import json
import math
import re
from dataclasses import dataclass

from mitmproxy import http

import connection_endpoints
import content_length
import flow_metadata_keys as metadata_keys
import request_body_admission
from logging_utils import NETWORK_LOG_MAX_SAFE_SIZE
from request_authority import AuthorityValidationError, get_trusted_authority

OWNER = "model-provider:openrouter-codex"
HOST = "openrouter.ai"
MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
MAX_ADMITTED_REQUESTS = 16
MAX_ADMITTED_BODY_BYTES = 128 * 1024 * 1024
_MAX_JSON_DEPTH = 128
_MAX_JSON_WORK = 262_144
_HTTPS_PORT = 443
_PRESET = re.compile(r"@preset/[A-Za-z0-9_.-]{1,504}\Z")
_JSON_STRUCTURE = re.compile(rb'["{}\[\],:]')
_JSON_STRING = re.compile(rb'["\\]')
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
_budget = request_body_admission.RequestBodyAdmissionBudget(
    metadata_key=metadata_keys.MANAGED_OPENROUTER_BODY_ADMISSION,
    negative_size_message="Managed model request body size cannot be negative",
    already_attached_message="Managed model body admission is already attached",
)


class RequestRejectedError(ValueError):
    """A fixed, non-secret reason suitable for a local policy response."""


class BodyLengthRejectedError(RequestRejectedError):
    """Retain bounded scalar evidence from the rejected declaration, never headers."""

    def __init__(self, result: content_length.ContentLengthResult, values: list[str]) -> None:
        super().__init__("body_length")
        self.kind = "zero" if result.kind == "valid" and result.value == 0 else result.kind
        self.limit_bytes = MAX_REQUEST_BODY_BYTES
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
    length = content_length.parse(values, max_value=MAX_REQUEST_BODY_BYTES)
    if length.kind != "valid" or length.value == 0:
        raise BodyLengthRejectedError(length, values)
    return length.value


def admit_request(flow: http.HTTPFlow, sandbox: dict) -> None:
    """Reserve capacity before mitmproxy starts native request-body buffering."""
    policy = policy_for_sandbox(sandbox)
    if policy is None:
        raise RequestRejectedError("captured_policy")
    length = _validate_headers(flow, policy)
    peer = connection_endpoints.client_peername(flow.client_conn)
    if peer is None or not peer[0]:
        raise RequestRejectedError("sandbox_identity")
    release_from_flow(flow)
    try:
        admission = _budget.reserve(
            length,
            max_admitted_count=MAX_ADMITTED_REQUESTS,
            max_admitted_body_bytes=MAX_ADMITTED_BODY_BYTES,
            count_scope=peer[0],
        )
    except (
        request_body_admission.RequestBodyAdmissionCountSaturatedError,
        request_body_admission.RequestBodyAdmissionByteSaturatedError,
    ) as error:
        raise RequestRejectedError("body_admission") from error
    try:
        _budget.attach_to_flow(flow, admission)
    except BaseException:
        _budget.release(admission)
        raise
    flow.metadata[_CAPTURED_POLICY] = _CapturedPolicy(sandbox["runId"], policy)
    flow.request.stream = False


def _check_json_structure(body: bytes) -> None:
    """Bound container/scalar allocation before stdlib JSON materialization.

    Only syntax outside strings counts as structure. Escaped quote scanning is
    bounded too; braces or field names in prompts never become policy inputs.
    This is a resource guard; json.loads owns authoritative syntax validation.
    """
    position = depth = work = 0
    while match := _JSON_STRUCTURE.search(body, position):
        work += 1
        if work > _MAX_JSON_WORK:
            raise RequestRejectedError("json_work")
        token = body[match.start()]
        position = match.end()
        if token == ord('"'):
            while string_match := _JSON_STRING.search(body, position):
                work += 1
                if work > _MAX_JSON_WORK:
                    raise RequestRejectedError("json_work")
                position = string_match.end()
                if body[string_match.start()] == ord('"'):
                    break
                position += 1
            else:
                raise RequestRejectedError("json")
        elif token in (ord("{"), ord("[")):
            depth += 1
            if depth > _MAX_JSON_DEPTH:
                raise RequestRejectedError("json_depth")
        elif token in (ord("}"), ord("]")):
            depth -= 1


def _json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise RequestRejectedError("duplicate_json_key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise RequestRejectedError("json_constant")


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise RequestRejectedError("json_number")
    return result


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
    body = flow.request.raw_content
    if flow.request.stream or body is None or len(body) != length:
        raise RequestRejectedError("incomplete_body")
    _check_json_structure(body)
    try:
        payload: object = json.loads(
            body.decode("utf-8"),
            object_pairs_hook=_json_object,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except RequestRejectedError:
        raise
    except (ValueError, RecursionError) as error:
        raise RequestRejectedError("json") from error
    if not isinstance(payload, dict):
        raise RequestRejectedError("json_object")
    if payload.get("model") != policy.preset:
        raise RequestRejectedError("model")
    # Even an empty provider object replaces the preset's provider field under
    # OpenRouter's shallow merge. Unknown fields and all alternate selectors
    # are rejected, rather than guessing whether an override is harmless.
    if not payload.keys() <= _FIELDS[policy.dialect]:
        raise RequestRejectedError("request_fields")
    if policy.service_tier is None:
        if "service_tier" in payload:
            raise RequestRejectedError("service_tier")
    elif payload.get("service_tier") != policy.service_tier:
        raise RequestRejectedError("service_tier")
    tools = payload.get("tools", [])
    if not isinstance(tools, list) or any(
        not isinstance(tool, dict) or tool.get("type") != "function" for tool in tools
    ):
        raise RequestRejectedError("server_tools")
    return policy


def release_from_flow(flow: http.HTTPFlow) -> None:
    """Release only when the retaining flow completes or is abandoned."""
    _budget.release_from_flow(flow)
    flow.metadata.pop(_CAPTURED_POLICY, None)


def admission_state_for_tests() -> tuple[int, int]:
    return _budget.state_for_tests()


def reset_for_tests() -> None:
    _budget.reset_for_tests()
