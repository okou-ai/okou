"""Bounded capture work through real response hooks and persisted network logs."""

import gzip
from collections.abc import Iterator

import pytest
from mitmproxy.net.http import http1

import mitm_addon
from tests.flow_helpers import response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _sandbox_without_firewalls, _write_registry


class _BudgetedHeaderFields(tuple[tuple[bytes, bytes], ...]):
    """Keep real raw fields while rejecting excessive terminal input traversal."""

    max_visits: int
    visits: int

    def __new__(cls, fields, max_visits: int):
        instance = super().__new__(cls, fields)
        instance.max_visits = max_visits
        instance.visits = 0
        return instance

    def __iter__(self) -> Iterator[tuple[bytes, bytes]]:
        for field in super().__iter__():
            self.visits += 1
            if self.visits > self.max_visits:
                raise AssertionError("terminal capture exceeded its raw-field work budget")
            yield field


async def _capture_response(
    tmp_path,
    real_flow,
    mitm_ctx,
    header_lines: list[bytes],
    body: bytes,
    *,
    max_visits: int,
) -> dict:
    registry_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="target.example.com")
    with mitm_ctx(registry_path=str(registry_path)):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)
        assert flow.response is None
        response = http1.read_response_head(
            [b"HTTP/1.1 200 OK", f"Content-Length: {len(body)}".encode(), *header_lines]
        )
        response.raw_content = body
        flow.response = response
        assert http1.expected_http_body_size(flow.request, response) == len(body)
        original_fields = response.headers.fields
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        if body:
            assert stream(body) == body
        assert stream(b"") == b""

        # Parsing and stream setup are separate owners. Bound terminal capture's
        # reads of the real raw-field input, without replacing addon functions.
        response.headers.fields = _BudgetedHeaderFields(original_fields, max_visits)
        mitm_addon.response(flow)

    assert response.status_code == 200
    assert response.headers.fields == original_fields
    assert response.raw_content == body
    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["status"] == 200
    assert entry["response_size"] == len(body)
    assert entry["response_headers"]["X-Unrelated"] == "***"
    assert entry["response_headers_truncated"] is True
    assert "response_body_truncated" not in entry
    return entry


@pytest.mark.parametrize("body", [b"", b"response body"], ids=["empty", "nonempty"])
@pytest.mark.parametrize("field_count", [2_049, 100_001], ids=["over-limit", "long-tail"])
@pytest.mark.parametrize(
    "late_headers",
    [
        pytest.param([], id="no-dependencies"),
        pytest.param([b"Content-Type: application/octet-stream"], id="late-content-type"),
        pytest.param([b"Content-Encoding: gzip"], id="late-encoding"),
    ],
)
async def test_response_capture_bounds_unrelated_header_tails(
    tmp_path, real_flow, mitm_ctx, body, field_count, late_headers
):
    entry = await _capture_response(
        tmp_path,
        real_flow,
        mitm_ctx,
        [b"Content-Type: text/plain"]
        + [b"X-Unrelated: private"] * (field_count - 2 - len(late_headers))
        + late_headers,
        body,
        max_visits=2_048,
    )
    assert entry["response_headers"] == {
        "Content-Length": str(len(body)),
        "Content-Type": "text/plain",
        "X-Unrelated": "***",
    }
    assert "response_body" not in entry
    if body:
        assert entry["response_body_encoding"] == "binary"
    else:
        assert "response_body_encoding" not in entry


async def test_empty_response_skips_dependency_discovery_after_serialization(
    tmp_path, real_flow, mitm_ctx
):
    entry = await _capture_response(
        tmp_path,
        real_flow,
        mitm_ctx,
        [b"X-Unrelated: private"] * 1_000 + [b"Content-Encoding: gzip"],
        b"",
        max_visits=513,
    )
    assert "response_body" not in entry
    assert "response_body_encoding" not in entry


@pytest.mark.parametrize("field_count", [2_047, 2_048], ids=["below-limit", "at-limit"])
@pytest.mark.parametrize(
    ("late_headers", "expected_body"),
    [
        pytest.param(
            [b"Content-Type: text/plain", b"Content-Encoding: gzip"],
            "response body",
            id="compressed-text",
        ),
        pytest.param([b"Content-Type: application/octet-stream"], None, id="binary"),
        pytest.param(
            [b"Content-Type: text/plain", b"content-type: text/plain"],
            None,
            id="ambiguous-content-type",
        ),
        pytest.param([b"Content-Encoding: gzip,,br"], None, id="malformed-encoding"),
    ],
)
async def test_response_capture_inspects_late_dependencies_within_work_budget(
    tmp_path, real_flow, mitm_ctx, field_count, late_headers, expected_body
):
    body = gzip.compress(b"response body")
    entry = await _capture_response(
        tmp_path,
        real_flow,
        mitm_ctx,
        [b"X-Unrelated: private"] * (field_count - 1 - len(late_headers)) + late_headers,
        body,
        max_visits=2_048,
    )
    assert entry["response_headers"] == {
        "Content-Length": str(len(body)),
        "X-Unrelated": "***",
    }
    if expected_body is None:
        assert "response_body" not in entry
        assert entry["response_body_encoding"] == "binary"
    else:
        assert entry["response_body"] == expected_body
        assert entry["response_body_encoding"] == "utf-8"
