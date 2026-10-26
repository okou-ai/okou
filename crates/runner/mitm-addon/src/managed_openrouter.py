"""Enforce captured presets before applying platform OpenRouter credentials.

The Runner writes piModelConfig from the API-owned execution context into its
private registry. It is request policy, not proof of the sandbox caller's identity.
Caller/connector-owner isolation is a separate boundary. Streaming validates
before forwarding each chunk, with final authorization at true EOF. Previously
delivered headers and body prefixes cannot be recalled after a later rejection.

Managed requests use incremental, identity-encoded JSON with a declared length.
Only Pi's supported content/protocol/output/cache fields are forwarded; preset,
model-list, provider, plugin and server-tool routing overrides are rejected.
The response remains eligible for the ordinary SSE streaming path. Runner and
this private registry reader ship together; old Runner artifacts must drain for
enforcement. No API writer or persisted-context generation changes are needed.
"""

import math
import re
from dataclasses import dataclass

from mitmproxy import http

import content_encoding
import content_length
import http_header_syntax
import managed_upload
from logging_utils import NETWORK_LOG_MAX_SAFE_SIZE
from request_authority import AuthorityValidationError, get_trusted_authority
from usage.json_selective import JsonSelectiveExtractor, JsonValueKind, Path

OWNER = "model-provider:openrouter-codex"
HOST = "openrouter.ai"
_MAX_JSON_DEPTH = 128
_MAX_JSON_WORK = 262_144
_TOOL_ITEM_DEPTH = 2
_TOOL_TYPE_DEPTH = 3
_HTTPS_PORT = 443
# Addon admission limits, not native request-head buffering limits. Even otherwise
# supported values padded beyond 512 raw bytes are rejected.
_MAX_CONTENT_TYPE_FIELDS = 2048
_MAX_CONTENT_TYPE_BYTES = 512
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


class RequestRejectedError(managed_upload.UploadRejectedError):
    """A fixed, non-secret reason suitable for a local policy response."""


class BodyLengthRejectedError(RequestRejectedError):
    """Retain bounded scalar evidence from the rejected declaration, never headers."""

    def __init__(self, result: content_length.ContentLengthResult) -> None:
        super().__init__("body_length")
        self.kind = "zero" if result.kind == "valid" and result.value == 0 else result.kind
        self.limit_bytes = NETWORK_LOG_MAX_SAFE_SIZE
        self.declared_bytes: int | None = result.value if result.kind == "valid" else None


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
    media_type = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"content-type",
        max_fields=_MAX_CONTENT_TYPE_FIELDS,
        max_value_bytes=_MAX_CONTENT_TYPE_BYTES,
        strip_chars=b" ",
    )
    if media_type is None or media_type.decode("utf-8", "surrogateescape").lower().replace(
        " ", ""
    ) not in (
        "application/json",
        "application/json;charset=utf-8",
        'application/json;charset="utf-8"',
    ):
        raise RequestRejectedError("content_type")
    # New managed admission limit: 8 KiB of raw values, including folded separators.
    # Reject oversized padding before conversion; native head buffering is separate.
    encodings = content_encoding.read_values(flow.request.headers)
    if encodings is None or (
        encodings and (len(encodings) != 1 or encodings[0].lower().strip() != "identity")
    ):
        raise RequestRejectedError("content_encoding")
    if flow.request.headers.get_all("Transfer-Encoding"):
        raise RequestRejectedError("transfer_encoding")
    values = flow.request.headers.get_all("Content-Length")
    length = content_length.parse(values, max_value=NETWORK_LOG_MAX_SAFE_SIZE)
    if length.kind != "valid" or length.value == 0:
        raise BodyLengthRejectedError(length)
    return length.value


def admit_request(
    flow: http.HTTPFlow, sandbox: dict, *, request_end_stream: bool | None = None
) -> None:
    """Select incremental validation before native request-body buffering."""
    policy = policy_for_sandbox(sandbox)
    if policy is None:
        raise RequestRejectedError("captured_policy")
    length = _validate_headers(flow, policy)
    # Native framing skips request.stream when HEADERS already ended the
    # request. A managed request must carry a nonempty JSON document.
    if request_end_stream is True:
        raise RequestRejectedError("incomplete_body")
    release_from_flow(flow)
    managed_upload.attach(flow, managed_upload.Upload(flow, length, _PresetDocument(policy)))
    flow.metadata[_CAPTURED_POLICY] = _CapturedPolicy(sandbox["runId"], policy)
    flow.request.stream = False


class _PresetChecks:
    """Only policy scalars are captured; the main scanner owns JSON structure."""

    def __init__(self, policy: PresetPolicy) -> None:
        self.policy = policy
        self.model_matches = False
        self.tier_matches = policy.service_tier is None

    def value_start(self, path: Path, kind: JsonValueKind) -> int | None:
        expected = None
        reason = "model"
        if not path and kind != "object":
            raise RequestRejectedError("json_object")
        if len(path) == 1 and path[0] not in _FIELDS[self.policy.dialect]:
            raise RequestRejectedError("request_fields")
        if path == ("model",):
            expected = self.policy.preset
        elif path == ("service_tier",):
            if self.policy.service_tier is None:
                raise RequestRejectedError("service_tier")
            expected, reason = self.policy.service_tier, "service_tier"
        elif (path == ("tools",) and kind != "array") or (
            len(path) == _TOOL_ITEM_DEPTH and path[0] == "tools" and kind != "object"
        ):
            raise RequestRejectedError("server_tools")
        elif len(path) == _TOOL_TYPE_DEPTH and path[0] == "tools" and path[2] == "type":
            expected, reason = "function", "server_tools"
        if expected is not None:
            if kind != "string":
                raise RequestRejectedError(reason)
            # ASCII policy values may arrive entirely as six-byte JSON escapes.
            return 6 * len(expected)
        return None

    def scalar(self, path: Path, value: object) -> None:
        if isinstance(value, float) and not math.isfinite(value):
            raise RequestRejectedError("json_number")
        if path == ("model",):
            if value != self.policy.preset:
                raise RequestRejectedError("model")
            self.model_matches = True
        elif path == ("service_tier",):
            if value != self.policy.service_tier:
                raise RequestRejectedError("service_tier")
            self.tier_matches = True
        elif len(path) == _TOOL_TYPE_DEPTH and path[0] == "tools" and path[2] == "type":
            if value != "function":
                raise RequestRejectedError("server_tools")

    def object_end(self, path: Path, members: set[str]) -> None:
        if len(path) == _TOOL_ITEM_DEPTH and path[0] == "tools" and "type" not in members:
            raise RequestRejectedError("server_tools")


class _PresetDocument:
    def __init__(self, policy: PresetPolicy) -> None:
        self.checks = _PresetChecks(policy)
        self.parser = JsonSelectiveExtractor(
            document_policy=self.checks,
            max_depth=_MAX_JSON_DEPTH,
            max_work_units=_MAX_JSON_WORK,
            max_key_bytes=4096,
            max_number_bytes=4300,
        )

    def feed(self, chunk: bytes) -> None:
        self.parser.feed(chunk)
        if not self.parser.accepts_more_input():
            self.finish()

    def finish(self) -> None:
        result = self.parser.finish()
        if not result.complete:
            reason = {
                "duplicate object key": "duplicate_json_key",
                "max depth exceeded": "json_depth",
                "work limit exceeded": "json_work",
                "key limit exceeded": "json_key",
                "number limit exceeded": "json_number",
            }.get(result.error or "", "json")
            raise RequestRejectedError(reason)
        if not self.checks.model_matches:
            raise RequestRejectedError("model")
        if not self.checks.tier_matches:
            raise RequestRejectedError("service_tier")


def validate_request(flow: http.HTTPFlow, sandbox: dict) -> PresetPolicy:
    """Validate policy binding and completed streaming, or already supplied bytes."""
    policy = policy_for_sandbox(sandbox)
    if policy is None:
        raise RequestRejectedError("captured_policy")
    captured = flow.metadata.get(_CAPTURED_POLICY)
    if captured is not None and captured != _CapturedPolicy(sandbox["runId"], policy):
        raise RequestRejectedError("captured_policy_changed")
    if flow.request.trailers:
        raise RequestRejectedError("trailers")
    length = _validate_headers(flow, policy)
    upload = managed_upload.get(flow)
    if upload is not None:
        if upload.failure is not None:
            raise RequestRejectedError(upload.failure)
        if upload.phase is managed_upload.Phase.COMPLETE:
            if upload.length != length or flow.request.raw_content not in (None, b""):
                raise RequestRejectedError("incomplete_body")
            return policy
    body = flow.request.raw_content
    if flow.request.stream or body is None or len(body) != length:
        raise RequestRejectedError("incomplete_body")
    document = _PresetDocument(policy)
    for offset in range(0, len(body), managed_upload.PARSE_SLICE):
        document.feed(body[offset : offset + managed_upload.PARSE_SLICE])
    document.finish()
    return policy


def release_from_flow(flow: http.HTTPFlow) -> None:
    """Release remaining upload state idempotently on terminal hooks."""
    managed_upload.release(flow)
    flow.metadata.pop(_CAPTURED_POLICY, None)


def reset_for_tests() -> None:
    managed_upload.close_all()
