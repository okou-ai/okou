"""Policy parity over adversarial chunk partitions without prompt materialization."""

import json

import pytest
from mitmproxy.flow import Error

import managed_upload
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, authorize_headers, request, sandbox
from tests.request_handler_helpers import _write_registry
from tests.upstream_connection_helpers import mark_connected_tls_upstream


@pytest.mark.parametrize("chunk_size", [1, 7, 4096])
@pytest.mark.parametrize(
    ("case", "fragment", "accepted"),
    [
        ("tools", b'"tools":[{"type":"function"},{"type":"function","parameters":{}}]', True),
        (
            "escaped-tool",
            rb'"tools":[{"type":"\u0066\u0075\u006e\u0063\u0074\u0069\u006f\u006e"}]',
            True,
        ),
        ("opaque-surrogates", rb'"metadata":{"\ud800":1,"\ud801":2}', True),
        ("surrogate-duplicate", rb'"metadata":{"\ud800":1,"\uD800":2}', False),
        ("nested-duplicate", rb'"messages":[{"role":"u","\u0072ole":"a"}]', False),
        ("missing-tool-type", b'"tools":[{}]', False),
        ("non-object-tool", b'"tools":[null]', False),
        ("surrogate-tool", rb'"tools":[{"type":"\ud800"}]', False),
        ("nonfinite", b'"metadata":{"number":1e999}', False),
        ("number-at-bound", b'"metadata":{"number":-' + b"1" * 4299 + b"}", True),
        ("number-over-bound", b'"metadata":{"number":' + b"1" * 4301 + b"}", False),
        ("key-at-bound", b'"metadata":{"' + b"k" * 4096 + b'":0}', True),
        ("key-over-bound", b'"metadata":{"' + b"k" * 4097 + b'":0}', False),
    ],
    ids=[
        "tools",
        "escaped-tool",
        "opaque-surrogates",
        "surrogate-duplicate",
        "nested-duplicate",
        "missing-tool-type",
        "non-object-tool",
        "surrogate-tool",
        "nonfinite",
        "number-at-bound",
        "number-over-bound",
        "key-at-bound",
        "key-over-bound",
    ],
)
async def test_full_document_policy_is_chunk_independent(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, chunk_size, case, fragment, accepted
):
    raw = b'{"model":"' + PRESET.encode() + b'",' + fragment + b"}"
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path))
    flow = request(real_flow, raw)
    flow.request.raw_content = None
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers():
        await authorize_headers(flow)
        mark_connected_tls_upstream(
            flow,
            sni="openrouter.ai",
            server_address=("openrouter.ai", 443),
            peername=("104.18.32.47", 443),
        )
        upload = managed_upload.get(flow)
        assert upload is not None
        forwarded = bytearray()
        for offset in range(0, len(raw), chunk_size):
            result = upload(raw[offset : offset + chunk_size])
            if isinstance(result, bytes):
                forwarded.extend(result)
            else:
                forwarded.extend(b"".join(result))
        final = upload(b"")
        if isinstance(final, bytes):
            forwarded.extend(final)
        assert upload.validator is None
        assert upload.tail == b""
        assert flow.request.raw_content is None
        if accepted:
            assert upload.phase is managed_upload.Phase.COMPLETE
            assert forwarded == raw
        else:
            assert upload.phase is managed_upload.Phase.REJECTED
            assert len(forwarded) < len(raw)
        flow.error = Error("synthetic terminal cleanup")
        mitm_addon.error(flow)
        assert managed_upload.get(flow) is None


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
async def test_maximum_escaped_preset_and_current_tier(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, dialect
):
    preset = "@preset/" + "x" * 504
    info = sandbox(tmp_path, dialect, preset)
    value = {"model": preset, "tools": [{"type": "function"}]}
    if dialect == "openai-responses":
        info["piModelConfig"]["serviceTier"] = "priority"
        value["service_tier"] = "priority"
    raw = json.dumps(value).encode()
    raw = raw.replace(preset.encode(), "".join(f"\\u{ord(c):04x}" for c in preset).encode())
    registry = _write_registry(tmp_path, sandbox_info=info)
    flow = request(real_flow, raw, dialect)
    flow.request.raw_content = None
    with mitm_ctx(registry_path=str(registry)), fake_firewall_headers():
        await authorize_headers(flow)
        mark_connected_tls_upstream(
            flow,
            sni="openrouter.ai",
            server_address=("openrouter.ai", 443),
            peername=("104.18.32.47", 443),
        )
        upload = managed_upload.get(flow)
        assert upload is not None
        result = []
        for offset in range(0, len(raw), 7):
            part = upload(raw[offset : offset + 7])
            assert isinstance(part, bytes)
            result.append(part)
        final = upload(b"")
        assert isinstance(final, bytes)
        result.append(final)
        assert b"".join(result) == raw
        assert upload.phase is managed_upload.Phase.COMPLETE
        mitm_addon.error(flow)
