"""Shared X connector flow and payload builders for mitm-addon tests."""

import json
from collections.abc import Callable
from pathlib import Path

from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import http_network_log
from tests.flow_helpers import header_map
from tests.stream_buffer_helpers import set_response_stream_buffer

RealFlowFactory = Callable[..., http.HTTPFlow]
_JSON_EXCESSIVE_NESTING_DEPTH = 10_000
_JSON_INTEGER_DIGIT_LIMIT_DIGITS = 10_000
_X_DENSE_OBJECT_COUNT = 30_000


def x_json_user_page(count: int = 1_000, *, representation: str = "escaped") -> bytes:
    """A supported users/search page with ordinary 160-character descriptions."""
    description = ("a" if representation == "ascii" else "中") * 160
    users = [
        {
            "id": str(10**18 + index),
            "name": f"User {index}",
            "username": f"user{index}",
            "description": description,
        }
        for index in range(count)
    ]
    return json.dumps(
        {"data": users, "meta": {"result_count": count}},
        ensure_ascii=representation != "utf8",
    ).encode()


def x_original_url(path: str, query: str = "") -> str:
    return f"https://api.x.com{path}?{query}" if query else f"https://api.x.com{path}"


def json_body_that_exceeds_nesting_limit() -> bytes:
    return (
        b'{"text":"hi","x":'
        + b"[" * _JSON_EXCESSIVE_NESTING_DEPTH
        + b"0"
        + b"]" * _JSON_EXCESSIVE_NESTING_DEPTH
        + b"}"
    )


def json_body_that_exceeds_integer_digit_limit() -> bytes:
    return b'{"n":' + b"1" * _JSON_INTEGER_DIGIT_LIMIT_DIGITS + b"}"


def json_body_that_exceeds_x_json_work_limit() -> bytes:
    return (
        b'{"data":{"id":"blocked"},"includes":{"users":[{},{},{}]},'
        b'"matching_rules":[' + b",".join([b"{}"] * _X_DENSE_OBJECT_COUNT) + b"]}"
    )


def make_x_response_flow(
    real_flow: RealFlowFactory,
    *,
    path: str = "/2/tweets",
    original_url: str | None = None,
    firewall_name: object = "x",
    firewall_billable: object = True,
    response_status: int = 200,
    content_type: str = "application/json",
    content_encoding: str = "",
    request_body: bytes | None = None,
    request_encoding: str | None = None,
) -> http.HTTPFlow:
    flow = real_flow(
        with_response=False,
        host="api.x.com",
        path=path,
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name
    flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        original_url if original_url is not None else x_original_url(path)
    )
    response_headers = {"content-type": content_type}
    if content_encoding:
        response_headers["content-encoding"] = content_encoding
    flow.response = tutils.tresp(
        status_code=response_status,
        headers=header_map(response_headers),
    )
    return flow


def make_x_usage_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    path: str = "/2/tweets",
    query: str = "",
    body: bytes = b"",
    status: int = 200,
    permission: str = "tweet.read",
    rule: str = "GET /2/tweets",
    content_encoding: str = "",
    request_body: bytes | None = None,
    request_encoding: str | None = None,
) -> http.HTTPFlow:
    flow = make_x_response_flow(
        real_flow,
        path=path,
        original_url=x_original_url(path, query),
        response_status=status,
        content_encoding=content_encoding,
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = "test-token"
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = permission
    flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = rule
    set_response_stream_buffer(flow, body)
    return flow


def make_x_pipeline_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    path: str = "/2/tweets",
    query: str = "",
    original_url: str | None = None,
    sandbox_run_id: str = "run-abc-123",
    sandbox_value: str = "test-token",
    firewall_action: str = "ALLOW",
    permission: str = "tweet.read",
    rule: str = "GET /2/tweets",
    response_status: int = 200,
    content_type: str = "application/json",
    content_encoding: str = "",
) -> http.HTTPFlow:
    resolved_original_url = (
        original_url if original_url is not None else x_original_url(path, query)
    )
    flow = make_x_response_flow(
        real_flow,
        path=path,
        original_url=resolved_original_url,
        response_status=response_status,
        content_type=content_type,
        content_encoding=content_encoding,
    )
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = sandbox_run_id
    flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "network.jsonl")
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
    flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = sandbox_value
    flow.metadata[metadata_keys.FIREWALL_ACTION] = firewall_action
    http_network_log.set_target(
        flow,
        url=resolved_original_url,
        host="api.x.com",
        port=flow.request.port,
    )
    flow.metadata[metadata_keys.FIREWALL_PERMISSION] = permission
    flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = rule
    return flow


def make_x_stream_pipeline_flow(
    real_flow: RealFlowFactory,
    tmp_path: Path,
    *,
    sandbox_value: str = "test-token",
) -> http.HTTPFlow:
    flow = make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_value=sandbox_value,
        rule="GET /2/tweets/search/stream",
    )
    flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "already_stream_decodable"
    return flow
