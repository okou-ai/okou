"""Response hook integration tests for network and proxy logging."""

import gzip
import json
import time
import tracemalloc
import urllib.parse
from pathlib import Path

import pytest
import zstandard
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import http_network_log
import mitm_addon
import request_classification
import request_streaming
from body_limits import BODY_CAPTURE_LIMIT, STREAM_BUFFER_LIMIT
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.requestheaders_helpers import await_requestheaders_result
from tests.stream_buffer_helpers import set_request_stream_buffer, set_response_stream_buffer
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class _BoundedFindUrl(str):
    find_calls: list[tuple[str, int, int | None]]

    def __new__(cls, value: str) -> "_BoundedFindUrl":
        instance = super().__new__(cls, value)
        instance.find_calls = []
        return instance

    def find(self, sub: str, start: int = 0, end: int | None = None) -> int:
        self.find_calls.append((sub, start, end))
        if end is None:
            raise AssertionError("oversized retained URLs must not use an unbounded delimiter scan")
        return super().find(sub, start, end)


class _DecodeGuardHeaderValue(bytes):
    def decode(self, encoding="utf-8", errors="strict"):
        raise AssertionError("over-budget dependency header values must not be decoded")


def test_calculates_latency_and_logs(registry_file, tmp_path, real_flow, mitm_ctx, headers):
    flow = real_flow(with_response=False, host="api.anthropic.com")
    log_path = str(tmp_path / "network.jsonl")

    # Simulate request handler setting metadata
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"

    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.anthropic.com/"
    http_network_log.set_target(
        flow,
        url="https://api.anthropic.com/",
        host="api.anthropic.com",
        port=443,
    )

    # Add response
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map(
            {
                "content-length": "256",
                "content-type": "application/json",
                "content-encoding": "gzip",
                "transfer-encoding": "chunked",
            }
        ),
    )

    # Simulate tracked start time
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic() - 0.1

    with mitm_ctx():
        mitm_addon.response(flow)

    # Start time should be cleaned up
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

    # Network log should be written
    entries = read_jsonl_entries_after_flush(Path(log_path))
    assert len(entries) == 1
    entry = entries[0]
    assert entry["action"] == "ALLOW"
    assert entry["host"] == "api.anthropic.com"
    assert entry["latency_ms"] > 0
    assert entry["response_size"] == 256
    assert_utc_millisecond_timestamp(entry["timestamp"])


def test_logs_request_time_network_log_target(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="request.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://original.example.com/"
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": "https://target.example.com:9443/path",
        "host": "target.example.com",
        "port": 9443,
    }
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "target.example.com"
    assert entry["port"] == 9443
    assert entry["url"] == "https://target.example.com:9443/path"


def test_response_log_includes_firewall_auth_metadata(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.example.com", path="/items")
    log_path = str(tmp_path / "network.jsonl")
    flow.metadata.update(
        {
            metadata_keys.SANDBOX_RUN_ID: "run-abc-123",
            metadata_keys.SANDBOX_NETWORK_LOG_PATH: log_path,
            metadata_keys.ORIGINAL_URL: "https://api.example.com/items",
            metadata_keys.FIREWALL_ACTION: "ALLOW",
            metadata_keys.FIREWALL_BASE: "https://api.example.com",
            metadata_keys.FIREWALL_NAME: "model-provider:example",
            metadata_keys.FIREWALL_PERMISSION: "read",
            metadata_keys.FIREWALL_RULE_MATCH: "GET /items",
            metadata_keys.FIREWALL_BILLABLE: True,
            metadata_keys.FIREWALL_PARAMS: {"owner": "okou-ai", "repo": "okou"},
            metadata_keys.AUTH_RESOLVED_SECRETS: ["GITHUB_TOKEN"],
            metadata_keys.AUTH_REFRESHED_CONNECTORS: ["github"],
            metadata_keys.AUTH_REFRESHED_SECRETS: ["GITHUB_TOKEN"],
            metadata_keys.AUTH_CACHE_HIT: False,
            metadata_keys.AUTH_URL_REWRITE: True,
        }
    )
    http_network_log.set_target(
        flow,
        url="https://api.example.com/items",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["firewall_base"] == "https://api.example.com"
    assert entry["firewall_name"] == "model-provider:example"
    assert entry["firewall_permission"] == "read"
    assert entry["firewall_rule_match"] == "GET /items"
    assert entry["firewall_billable"] is True
    assert entry["firewall_params"] == {"owner": "okou-ai", "repo": "okou"}
    assert entry["auth_resolved_secrets"] == ["GITHUB_TOKEN"]
    assert entry["auth_refreshed_connectors"] == ["github"]
    assert entry["auth_refreshed_secrets"] == ["GITHUB_TOKEN"]
    assert entry["auth_cache_hit"] is False
    assert entry["auth_url_rewrite"] is True


@pytest.mark.parametrize(
    "with_firewall_context",
    [False, True],
    ids=["without-firewall", "with-firewall"],
)
@pytest.mark.parametrize(
    ("route_candidates", "expected_candidates"),
    [
        pytest.param(None, None, id="absent"),
        pytest.param([], None, id="empty"),
        pytest.param(["primary", None], None, id="malformed"),
        pytest.param(["auditor", "primary"], ["auditor", "primary"], id="populated"),
    ],
)
def test_response_log_serializes_common_metadata_independent_of_firewall_context(
    tmp_path,
    real_flow,
    mitm_ctx,
    with_firewall_context,
    route_candidates,
    expected_candidates,
):
    flow = real_flow(with_response=False, host="api.example.com", path="/items")
    log_path = str(tmp_path / "network.jsonl")
    flow.metadata.update(
        {
            metadata_keys.SANDBOX_RUN_ID: "run-abc-123",
            metadata_keys.SANDBOX_NETWORK_LOG_PATH: log_path,
            metadata_keys.ORIGINAL_URL: "https://api.example.com/items",
            metadata_keys.FIREWALL_ACTION: "DENY",
            metadata_keys.FIREWALL_ERROR: "ambiguous_connector_route",
            metadata_keys.CONNECTOR_ROUTE_REASON: "connector_intent_required",
        }
    )
    http_network_log.set_target(
        flow,
        url="https://api.example.com/items",
        host="api.example.com",
        port=443,
    )
    if route_candidates is not None:
        flow.metadata[metadata_keys.CONNECTOR_ROUTE_CANDIDATES] = route_candidates
    if with_firewall_context:
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_BASE: "https://api.example.com",
                metadata_keys.FIREWALL_NAME: "example",
                metadata_keys.FIREWALL_PERMISSION: "read",
                metadata_keys.FIREWALL_RULE_MATCH: "GET /items",
                metadata_keys.FIREWALL_BILLABLE: False,
            }
        )
    flow.response = tutils.tresp(status_code=409, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["firewall_error"] == "ambiguous_connector_route"
    assert entry["connector_route_reason"] == "connector_intent_required"
    if expected_candidates is None:
        assert "connector_route_candidates" not in entry
    else:
        assert entry["connector_route_candidates"] == expected_candidates
    if with_firewall_context:
        assert entry["firewall_base"] == "https://api.example.com"
        assert entry["firewall_name"] == "example"
    else:
        assert "firewall_base" not in entry
        assert "firewall_name" not in entry


@pytest.mark.parametrize(
    ("raw_url", "expected_url"),
    [
        (
            "https://target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path?access_token=secret#fragment",
        ),
        (
            "https://target.example.com:9443/path#fragment?access_token=secret",
            "https://target.example.com:9443/path#fragment?access_token=secret",
        ),
        (
            "https://[invalid.example.com/path?access_token=secret#fragment",
            "https://[invalid.example.com/path?access_token=secret#fragment",
        ),
        (
            "https://user:pass@[invalid.example.com/path?access_token=secret#fragment",
            "https://[invalid.example.com/path?access_token=secret#fragment",
        ),
        (
            "//user:pass@[invalid.example.com/path?access_token=secret#fragment",
            "//[invalid.example.com/path?access_token=secret#fragment",
        ),
        (
            "https://user:pass@target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path?access_token=secret#fragment",
        ),
        (
            "https:////user:pass@target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path?access_token=secret#fragment",
        ),
        (
            "https: //user:pass@target.example.com:9443/path?access_token=secret#fragment",
            "https://target.example.com:9443/path?access_token=secret#fragment",
        ),
        (
            "https://target.example.com:9443/users/alice@example.com?access_token=secret#fragment",
            "https://target.example.com:9443/users/alice@example.com?access_token=secret#fragment",
        ),
    ],
)
def test_network_log_target_url_preserves_query_and_fragment_but_redacts_userinfo(
    tmp_path, real_flow, mitm_ctx, raw_url, expected_url
):
    flow = real_flow(with_response=False, host="request.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.NETWORK_LOG_TARGET] = {
        "url": raw_url,
        "host": "target.example.com",
        "port": 9443,
    }
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "target.example.com"
    assert entry["port"] == 9443
    assert entry["url"] == expected_url
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == raw_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET]["url"] == raw_url


def test_network_log_preserves_large_url_without_caching_runtime_url(tmp_path, real_flow, mitm_ctx):
    raw_url = f"https://target.example.com/path?payload={'x' * 200_000}#fragment"
    flow = real_flow(with_response=False, host="target.example.com")
    log_path = str(tmp_path / "network.jsonl")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    urllib.parse.urlsplit.cache_clear()
    try:
        urllib.parse.urlsplit("https://stable-config.example.com")
        stable_cache = urllib.parse.urlsplit.cache_info()

        with mitm_ctx():
            mitm_addon.response(flow)

        assert urllib.parse.urlsplit.cache_info() == stable_cache
    finally:
        urllib.parse.urlsplit.cache_clear()

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["url"] == raw_url
    assert "url_truncated" not in entry
    assert "url_original_char_count" not in entry


def test_network_log_omits_url_above_processing_limit(tmp_path, real_flow, mitm_ctx):
    secret_userinfo = "network-log-user:network-log-password"
    raw_url = f"https://{secret_userinfo}@target.example.com/path?payload={'x' * 1_000_000}"
    flow = real_flow(with_response=False, host="target.example.com")
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    serialized = read_jsonl_text_after_flush(log_path)
    entry = json.loads(serialized)
    assert entry["url"] == "[truncated]"
    assert entry["url_truncated"] is True
    assert entry["url_original_char_count"] == len(raw_url)
    assert secret_userinfo not in serialized
    assert len(serialized.encode()) <= 1_000_000


def test_capture_headers_preserve_in_budget_sanitization(tmp_path, real_flow, mitm_ctx):
    raw_url = "https://target.example.com/path"
    flow = real_flow(
        host="target.example.com",
        request_headers=http.Headers(
            [
                (b"Content-Type", b"application/json"),
                (b"content-type", b"text/plain"),
                (b"Authorization", b"Bearer secret"),
            ]
        ),
        response_headers=http.Headers(
            [
                (b"Accept-Encoding", b"gzip, br"),
                (b"accept-encoding", b"zstd"),
                (b"Server", b"private-origin"),
            ]
        ),
    )
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["request_headers"] == {
        "Content-Type": "application/json",
        "Authorization": "***",
    }
    assert entry["response_headers"] == {
        "Accept-Encoding": "gzip, br",
        "Server": "***",
    }
    assert "request_headers_truncated" not in entry
    assert "response_headers_truncated" not in entry


def test_capture_headers_bound_both_sides_and_final_row(tmp_path, real_flow, mitm_ctx):
    raw_url = "https://target.example.com/path"
    request_headers = http.Headers(
        [(f"x-{index:04d}-{'a' * 249}".encode(), b"redacted") for index in range(1_000)]
    )
    response_headers = http.Headers([(f"y-{index:04d}".encode(), b"v") for index in range(1_000)])
    body = b"\x00" * BODY_CAPTURE_LIMIT
    flow = real_flow(
        host="target.example.com",
        request_headers=request_headers,
        request_body=body,
        response_headers=response_headers,
        response_body=body,
    )
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    serialized = read_jsonl_text_after_flush(log_path)
    entry = json.loads(serialized)
    assert len(serialized.encode()) <= 1_000_000
    assert entry["url"] == raw_url
    assert "url_truncated" not in entry
    assert "url_original_char_count" not in entry
    assert len(entry["request_headers"]) == 124
    assert f"x-{123:04d}-{'a' * 249}" in entry["request_headers"]
    assert f"x-{124:04d}-{'a' * 249}" not in entry["request_headers"]
    assert entry["request_headers_truncated"] is True
    assert len(entry["response_headers"]) == 512
    assert f"y-{511:04d}" in entry["response_headers"]
    assert f"y-{512:04d}" not in entry["response_headers"]
    assert entry["response_headers_truncated"] is True
    assert len(entry["request_body"]) == BODY_CAPTURE_LIMIT
    assert len(entry["response_body"]) == BODY_CAPTURE_LIMIT


def _body_capture_dependency_attack_fields(
    header_name: bytes, attack: str
) -> list[tuple[bytes, bytes]]:
    if attack == "oversized-single":
        return [(header_name, _DecodeGuardHeaderValue(b"x" * (32 * 1024 + 1)))]
    if attack == "malformed":
        value = b"not a media type" if header_name == b"Content-Type" else b"gzip,,br"
        return [(header_name, value)]
    if header_name == b"Content-Type":
        return [(header_name, b"text/plain")] * 512
    return [
        (b"X-Padding", b"x" * 32_700),
        (header_name, _DecodeGuardHeaderValue(b"a" * (16 * 1024))),
        (header_name, _DecodeGuardHeaderValue(b"b" * (16 * 1024))),
    ]


@pytest.mark.parametrize("side", ["request", "response"])
@pytest.mark.parametrize("streamed", [False, True], ids=["buffered", "streamed"])
@pytest.mark.parametrize(
    "header_name",
    [
        pytest.param(b"Content-Type", id="content-type"),
        pytest.param(b"Content-Encoding", id="content-encoding"),
    ],
)
@pytest.mark.parametrize("attack", ["oversized-single", "duplicate-amplification", "malformed"])
def test_body_capture_bounds_dependency_headers_and_writes_final_row(
    tmp_path,
    real_flow,
    mitm_ctx,
    side,
    streamed,
    header_name,
    attack,
):
    raw_url = "https://target.example.com/path"
    attack_headers = http.Headers(_body_capture_dependency_attack_fields(header_name, attack))
    valid_headers = header_map({"Content-Type": "text/plain"})
    request_headers = attack_headers if side == "request" else valid_headers
    response_headers = attack_headers if side == "response" else valid_headers
    flow = real_flow(
        host="target.example.com",
        method="POST",
        request_headers=request_headers,
        request_body=b"request body",
        response_headers=response_headers,
        response_body=b"response body",
    )
    if streamed and side == "request":
        set_request_stream_buffer(flow, b"request body", truncated=True)
    if streamed and side == "response":
        set_response_stream_buffer(flow, b"response body", truncated=True)

    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    serialized = read_jsonl_text_after_flush(log_path)
    entry = json.loads(serialized)
    assert len(serialized.encode()) <= 1_000_000
    assert entry["url"] == raw_url
    assert f"{side}_body" not in entry
    assert entry[f"{side}_body_encoding"] == "binary"
    if streamed:
        assert entry[f"{side}_body_truncated"] is True
    other_side = "response" if side == "request" else "request"
    assert entry[f"{other_side}_body"] == f"{other_side} body"
    assert entry[f"{other_side}_body_encoding"] == "utf-8"


def test_body_capture_preserves_bounded_valid_dependency_headers(tmp_path, real_flow, mitm_ctx):
    raw_url = "https://target.example.com/path"
    content_type = f"text/plain; boundary={'x' * 5_000}"
    flow = real_flow(
        host="target.example.com",
        method="POST",
        request_headers=header_map({"Content-Type": content_type, "Content-Encoding": "identity"}),
        request_body=b"request body",
        response_headers=header_map({"Content-Type": content_type, "Content-Encoding": "identity"}),
        response_body=b"response body",
    )
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["request_body"] == "request body"
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["response_body"] == "response body"
    assert entry["response_body_encoding"] == "utf-8"


def test_body_capture_decompresses_buffered_response_with_bounded_headers(
    tmp_path, real_flow, mitm_ctx
):
    raw_url = "https://target.example.com/path"
    flow = real_flow(
        host="target.example.com",
        response_headers=header_map({"Content-Type": "text/plain", "Content-Encoding": "gzip"}),
        response_body=gzip.compress(b"response body"),
    )
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["response_body"] == "response body"
    assert entry["response_body_encoding"] == "utf-8"


def test_body_capture_decompresses_concatenated_zstd_stream_buffer(tmp_path, real_flow, mitm_ctx):
    raw_url = "https://target.example.com/path"
    first = b"first response frame"
    second = b" and second response frame"
    compressor = zstandard.ZstdCompressor()
    streamed_body = compressor.compress(first) + compressor.compress(second)
    flow = real_flow(
        host="target.example.com",
        response_headers=header_map({"Content-Type": "text/plain", "Content-Encoding": "zstd"}),
        response_body=b"buffered response must be ignored",
    )
    set_response_stream_buffer(flow, streamed_body)
    log_path = tmp_path / "network.jsonl"
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    http_network_log.set_target(
        flow,
        url=raw_url,
        host="target.example.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(log_path)
    assert entry["response_body"] == (first + second).decode()
    assert entry["response_body_encoding"] == "utf-8"
    assert "response_body_truncated" not in entry


@pytest.mark.parametrize("delimiter", ["?", "#"], ids=["query", "fragment"])
def test_proxy_log_discards_large_suffix_before_url_processing(
    tmp_path, real_flow, mitm_ctx, delimiter
):
    retained_url = "https://target.example.com/path"
    raw_url = f"{retained_url}{delimiter}payload={'x' * 1_000_000}"
    proxy_log_path = tmp_path / "proxy.jsonl"
    flow = real_flow(with_response=False, host="target.example.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.response = tutils.tresp(status_code=500, headers=http.Headers())

    urllib.parse.urlsplit.cache_clear()
    try:
        urllib.parse.urlsplit("https://stable-config.example.com")
        stable_cache = urllib.parse.urlsplit.cache_info()

        tracemalloc.start()
        try:
            with mitm_ctx():
                mitm_addon.response(flow)
            peak_allocated_bytes = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()

        assert urllib.parse.urlsplit.cache_info() == stable_cache
    finally:
        urllib.parse.urlsplit.cache_clear()

    # Whole-query normalization or parsing materializes at least one query-sized intermediate.
    assert peak_allocated_bytes < len(raw_url)
    [entry] = read_jsonl_entries_after_flush(proxy_log_path)
    assert entry["message"] == f"Response 500: {retained_url}"
    assert "url_truncated" not in entry
    assert "url_original_char_count" not in entry


@pytest.mark.parametrize(
    "discarded_suffix",
    ["?token=secret#fragment", "#fragment?token=secret"],
    ids=["query-first", "fragment-first"],
)
def test_proxy_log_retains_query_free_url_at_processing_limit(
    tmp_path, real_flow, mitm_ctx, discarded_suffix
):
    prefix = "https://target.example.com/path/"
    retained_url = prefix + ("x" * (1_000_000 - len(prefix)))
    raw_url = f"{retained_url}{discarded_suffix}"
    proxy_log_path = tmp_path / "proxy.jsonl"
    flow = real_flow(with_response=False, host="target.example.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.response = tutils.tresp(status_code=500, headers=http.Headers())

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(proxy_log_path)
    assert entry["message"] == f"Response 500: {retained_url}"
    assert "secret" not in entry["message"]
    assert "fragment" not in entry["message"]
    assert "url_truncated" not in entry
    assert "url_original_char_count" not in entry


def test_proxy_log_omits_retained_url_above_processing_limit(tmp_path, real_flow, mitm_ctx):
    secret_userinfo = "proxy-log-user:proxy-log-password"
    raw_url = _BoundedFindUrl(
        f"https://{secret_userinfo}@target.example.com/path/" + ("x" * 1_000_000)
    )
    proxy_log_path = tmp_path / "proxy.jsonl"
    flow = real_flow(with_response=False, host="target.example.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
    flow.response = tutils.tresp(status_code=500, headers=http.Headers())

    with mitm_ctx():
        mitm_addon.response(flow)

    serialized = read_jsonl_text_after_flush(proxy_log_path)
    entry = json.loads(serialized)
    assert entry["message"] == "Response 500: [truncated]"
    assert entry["type"] == "http_error"
    assert entry["status"] == 500
    assert entry["url_truncated"] is True
    assert entry["url_original_char_count"] == len(raw_url)
    assert secret_userinfo not in serialized
    assert len(serialized.encode()) < 1_000
    assert raw_url.find_calls == [
        ("?", 0, 1_000_001),
        ("#", 0, 1_000_001),
    ]


@pytest.mark.parametrize(
    ("original_url", "expected_port"),
    [
        ("http://target.example.com:0/path", 0),
        ("https://target.example.com:0/path", 0),
        ("http://target.example.com/path", 80),
        ("https://target.example.com/path", 443),
    ],
)
def test_logs_typed_target_port(tmp_path, real_flow, mitm_ctx, original_url, expected_port):
    flow = real_flow(with_response=False, host="request.example.com", port=9443)
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = original_url
    http_network_log.set_target(
        flow,
        url=original_url,
        host="target.example.com",
        port=expected_port,
    )
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(Path(log_path))
    assert entry["host"] == "target.example.com"
    assert entry["port"] == expected_port
    assert entry["url"] == original_url


def test_missing_network_log_target_fails_response(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="fallback.example.com", port=9443)
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        "https://invalid.example.com:bad/path?secret=value#frag"
    )
    flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()
    flow.response = tutils.tresp(status_code=200, headers=header_map({"content-length": "0"}))
    request_streaming.configure_request_stream(flow)

    with mitm_ctx(), pytest.raises(KeyError, match=metadata_keys.NETWORK_LOG_TARGET):
        mitm_addon.response(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert flow.request.stream is False
    assert not Path(log_path).exists()


def test_response_size_tracks_streamed_bytes(tmp_path, real_flow, mitm_ctx):
    """response_size should use cumulative streamed bytes."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "999", "content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(b"x" * 40)
    response_stream(flow)(b"y" * 60)

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 100


def test_response_size_tracks_large_stream_without_body_buffer(tmp_path, real_flow, mitm_ctx):
    """A large ordinary response keeps exact size without retaining a prefix."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")
    body = b"x" * (STREAM_BUFFER_LIMIT + 4096)

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "12", "content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    assert response_stream(flow)(body[:123]) == body[:123]
    assert response_stream(flow)(body[123:]) == body[123:]
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == len(body)


def test_request_size_tracks_streamed_bytes_and_captures_stream_body(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(
        with_response=False,
        host="api.example.com",
        method="POST",
        request_body=b"should-be-ignored",
        request_content_type="text/plain",
    )
    log_path = str(tmp_path / "network.jsonl")
    body = b"x" * (STREAM_BUFFER_LIMIT + 17)

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.metadata[metadata_keys.CAPTURE_BODY] = True
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "0", "content-type": "application/json"}),
    )

    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    assert stream(body[:123]) == body[:123]
    assert stream(body[123:]) == body[123:]

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["request_size"] == len(body)
    assert entry["request_body"] == "x" * STREAM_BUFFER_LIMIT
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["request_body_truncated"] is True
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_firewalled_streamed_request_logs_size_and_capture_body(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Type", "text/plain"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 17)),
        ),
    )
    body = b"x" * (STREAM_BUFFER_LIMIT + 17)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        stream = flow.request.stream
        assert callable(stream)
        assert stream(body[:123]) == body[:123]
        assert stream(body[123:]) == body[123:]
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "0", "content-type": "application/json"}),
        )
        mitm_addon.response(flow)

    auth_fetch.assert_awaited_once()
    entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert entry["request_size"] == len(body)
    assert entry["request_body"] == "x" * STREAM_BUFFER_LIMIT
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["request_body_truncated"] is True
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_firewalled_partial_streamed_request_marks_capture_truncated(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        stream = flow.request.stream
        assert callable(stream)
        assert stream(b'{"partial":true') == b'{"partial":true'
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "0", "content-type": "application/json"}),
        )
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert entry["request_size"] == len(b'{"partial":true')
    assert entry["request_body"] == '{"partial":true'
    assert entry["request_body_encoding"] == "utf-8"
    assert entry["request_body_truncated"] is True


async def test_firewalled_empty_incomplete_streamed_request_marks_capture_truncated(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        method="POST",
        path="/repos/octocat/hello",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("Content-Type", "application/json"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        await await_requestheaders_result(requestheaders_result)
        assert callable(flow.request.stream)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "0", "content-type": "application/json"}),
        )
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert entry["request_size"] == 0
    assert "request_body" not in entry
    assert "request_body_encoding" not in entry
    assert entry["request_body_truncated"] is True
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_unknown_length_get_without_body_logs_zero_request_size(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="GET",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        assert callable(flow.request.stream)
        await mitm_addon.request(flow)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "2", "content-type": "text/plain"}),
            content=b"ok",
        )
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["request_size"] == 0
    assert "request_body" not in entry
    assert "request_body_encoding" not in entry
    assert "request_body_truncated" not in entry
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
    assert flow.request.stream is False


async def test_early_response_makes_late_request_hook_noop(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.okou.ai",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata
        stream = flow.request.stream
        assert callable(stream)
        assert stream(b"partial request") == b"partial request"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-length": "2", "content-type": "text/plain"}),
            content=b"ok",
        )
        mitm_addon.response(flow)
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        reg_path.write_text("{ broken registry")
        await mitm_addon.request(flow)

    assert flow.response.status_code == 200
    assert flow.response.content == b"ok"
    assert metadata_keys.FIREWALL_ERROR not in flow.metadata
    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


@pytest.mark.parametrize(
    ("content_length", "expected_size"),
    [
        pytest.param("50000", 50000, id="plain"),
    ],
)
def test_response_size_uses_content_length_without_stream_state(
    tmp_path, real_flow, mitm_ctx, content_length, expected_size
):
    """response_size should fall back to Content-Length without stream metadata."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-length": content_length})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == expected_size


def test_response_size_accepts_max_safe_content_length(tmp_path, real_flow, mitm_ctx):
    """response_size should accept the largest exactly representable JavaScript integer."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-length": "9007199254740991"})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 9007199254740991


def test_response_size_is_zero_without_stream_state_or_content_length(
    tmp_path, real_flow, mitm_ctx
):
    """response_size should be 0 when no streamed size or Content-Length exists."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-type": "application/json"})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


@pytest.mark.parametrize(
    "content_length",
    [
        pytest.param("not-an-int", id="malformed"),
        pytest.param("9007199254740992", id="above-max-safe-integer"),
    ],
)
def test_response_size_is_zero_for_invalid_content_length(
    tmp_path, real_flow, mitm_ctx, content_length
):
    """response_size should tolerate invalid Content-Length without stream metadata."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200, headers=header_map({"content-length": content_length})
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


def test_response_size_accepts_matching_repeated_content_length(tmp_path, real_flow, mitm_ctx):
    """Repeated matching Content-Length values should keep the advertised size."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=http.Headers([(b"content-length", b"50000"), (b"content-length", b"50000")]),
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 50000


def test_response_size_rejects_conflicting_repeated_content_length(tmp_path, real_flow, mitm_ctx):
    """Repeated conflicting Content-Length values should not be logged as a size."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=http.Headers([(b"content-length", b"50000"), (b"content-length", b"50001")]),
    )

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


def test_response_size_keeps_zero_streamed_bytes(tmp_path, real_flow, mitm_ctx):
    """response_size should not treat a streamed byte count of 0 as missing."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-length": "50000", "content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == 0


def test_response_size_tracks_large_unbounded_stream_without_length(tmp_path, real_flow, mitm_ctx):
    """response_size should not become 0 for chunked large streamed responses."""
    flow = real_flow(with_response=False, host="api.example.com")
    log_path = str(tmp_path / "network.jsonl")
    body = b"x" * (STREAM_BUFFER_LIMIT + 4096)

    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
    http_network_log.set_target(
        flow,
        url="https://api.example.com/",
        host="api.example.com",
        port=443,
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": "application/json"}),
    )

    mitm_addon.responseheaders(flow)
    response_stream(flow)(body[:123])
    response_stream(flow)(body[123:])
    assert metadata_keys.STREAM_BUFFER not in flow.metadata
    assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    with mitm_ctx():
        mitm_addon.response(flow)

    entry = read_jsonl_entries_after_flush(Path(log_path))[0]
    assert entry["response_size"] == len(body)


def test_error_status_logs_warning(tmp_path, real_flow, headers):
    """Response with status >= 400 writes to per-job proxy log."""
    flow = real_flow(with_response=False, host="api.example.com")
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"

    proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log)
    flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        "https://user:pass@api.example.com/fail?api_key=secret#frag"
    )

    flow.response = tutils.tresp(status_code=500, headers=http.Headers())

    mitm_addon.response(flow)

    assert jsonl_exists_after_flush(proxy_log)
    [entry] = read_jsonl_entries_after_flush(proxy_log)
    assert entry["message"] == "Response 500: https://api.example.com/fail"
    assert "user:pass" not in entry["message"]
    assert "api_key=secret" not in entry["message"]
    assert "#frag" not in entry["message"]
