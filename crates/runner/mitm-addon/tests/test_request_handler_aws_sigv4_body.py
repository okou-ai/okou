"""Bounded-body and streaming integration tests for AWS SigV4 firewalls."""

import asyncio
import hashlib
import json
import threading
import urllib.parse
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import connection, http
from mitmproxy.websocket import WebSocketData

import auth
import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import matching
import mitm_addon
import registry
import request_classification
import request_streaming
import upstream_admission
import upstream_destination_binding
from aws_sigv4 import MAX_AWS_SIGV4_QUERY_PAIRS, AwsSigV4BodyHash, hash_request_body
from body_limits import STREAM_BUFFER_LIMIT
from tests.aws_sigv4_helpers import (
    RESOLVED_AWS_ACCESS_KEY_ID,
    STS_HOST,
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
    aws_sigv4_presigned_query_path,
    resolved_aws_sigv4_credentials,
)
from tests.buffered_auth_body_framing_cases import (
    BufferedAuthBodyFramingRejectionCase,
    buffered_auth_body_framing_case_id,
    buffered_auth_body_framing_rejection_cases,
)
from tests.firewall_auth_helpers import firewall_auth_response
from tests.firewall_aws_sigv4_helpers import aws_api_entry
from tests.firewall_helpers import cancel_pending_task
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import (
    _assert_no_request_stream,
    await_requestheaders_result,
    track_trusted_authority_validations,
)
from tests.upstream_connection_helpers import mark_connected_tls_upstream

_CLIENT_IP = "10.200.0.5"
_AWS_PERMISSION = "aws-request"
_HASH_WAIT_TIMEOUT_SECONDS = 2.0


class _ControlledBodyHasher:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.started = asyncio.Event()
        self.release = threading.Event()
        self.thread_id: int | None = None
        self._loop = loop

    def __call__(self, body: bytes | None) -> AwsSigV4BodyHash:
        self.thread_id = threading.get_ident()
        self._loop.call_soon_threadsafe(self.started.set)
        if not self.release.wait(timeout=_HASH_WAIT_TIMEOUT_SECONDS):
            raise AssertionError("controlled SigV4 body hash was not released before timeout")
        return hash_request_body(body)


async def _wait_for_hash_start(
    hasher: _ControlledBodyHasher,
    request_task: asyncio.Task[None],
) -> None:
    started_task = asyncio.create_task(hasher.started.wait())
    try:
        done, _pending = await asyncio.wait(
            (started_task, request_task),
            return_when=asyncio.FIRST_COMPLETED,
            timeout=_HASH_WAIT_TIMEOUT_SECONDS,
        )
        if started_task in done and started_task.result():
            return
        if request_task in done:
            _ = await request_task
            raise AssertionError("request finished before SigV4 body hashing started")
        raise AssertionError("SigV4 body hashing did not start before timeout")
    finally:
        await cancel_pending_task(started_task)


def _resolved_token_meta() -> dict[str, object]:
    return firewall_auth_response(
        headers={},
        aws_sigv4=resolved_aws_sigv4_credentials(),
    )


def _write_aws_registry(
    tmp_path: Path,
    *,
    base: str = f"https://{STS_HOST}",
    capture_body: bool = False,
    host_policy: dict[str, object] | None = None,
) -> Path:
    api_entry: dict[str, object] = dict(aws_api_entry(base=base))
    api_entry["permissions"] = [
        {
            "name": _AWS_PERMISSION,
            "rules": ["GET /{path*}", "POST /{path*}"],
        }
    ]
    if host_policy is not None:
        api_entry["hostPolicy"] = host_policy
    return _write_registry(
        tmp_path,
        client_ip=_CLIENT_IP,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="aws",
            api_entry=api_entry,
            network_policy={
                "allow": [_AWS_PERMISSION],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            sandbox_fields={"captureNetworkBodies": capture_body},
        ),
    )


def _header_auth_flow(
    real_flow,
    headers,
    *,
    body: bytes | None = None,
    content_length: str | None = None,
    content_hash: str | None = None,
    transfer_encoding: str | None = None,
):
    extra_headers: list[tuple[str, str]] = []
    signed_headers = "host;x-amz-date"
    if content_length is not None:
        extra_headers.append(("Content-Length", content_length))
    if content_hash is not None:
        extra_headers.append(("X-Amz-Content-Sha256", content_hash))
        signed_headers = "host;x-amz-content-sha256;x-amz-date"
    if transfer_encoding is not None:
        extra_headers.append(("Transfer-Encoding", transfer_encoding))
    return real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=STS_HOST,
        method="POST",
        path="/",
        request_body=body,
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                authorization=aws_sigv4_authorization(
                    signed_headers=signed_headers,
                ),
                extra_headers=extra_headers,
            )
        ),
    )


def _s3_presigned_query_path_with_pair_count(pair_count: int) -> str:
    base_path = aws_sigv4_presigned_query_path(service="s3", leading_query="")
    base_query = urllib.parse.urlsplit(base_path).query
    base_pair_count = len(base_query.split("&"))
    assert pair_count >= base_pair_count
    leading_query = "&".join(("a=",) * (pair_count - base_pair_count))
    return aws_sigv4_presigned_query_path(service="s3", leading_query=leading_query)


def _raw_header_list_size(request_headers: http.Headers) -> int:
    return sum(
        len(name) + len(value) + auth.AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES
        for name, value in request_headers.fields
    )


@pytest.mark.parametrize("capture_body", [False, True])
async def test_payload_independent_sigv4_signs_before_streaming(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    capture_body: bool,
) -> None:
    registry_path = _write_aws_registry(tmp_path, capture_body=capture_body)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_hash="UNSIGNED-PAYLOAD",
        transfer_encoding="chunked",
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(
            auth,
            "hash_request_body",
            side_effect=AssertionError("body-independent signing submitted a body hash"),
        ),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

        assert callable(flow.request.stream)
        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
        callback = flow.request.stream
        streamed_body = b"x" * (STREAM_BUFFER_LIMIT + 17)
        assert callback(streamed_body) == streamed_body
        assert request_streaming.streamed_request_size(flow) == len(streamed_body)
        if capture_body:
            assert len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
        else:
            assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
            assert request_streaming.captured_request_stream_body(flow) is None

        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
        await mitm_addon.request(flow)

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


async def test_bounded_payload_independent_sigv4_classifies_once_before_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=b"",
        content_length="0",
        content_hash="UNSIGNED-PAYLOAD",
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())
    validated_flows = track_trusted_authority_validations(monkeypatch)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(
            registry,
            "load_registry_state",
            wraps=registry.load_registry_state,
        ) as registry_load,
        patch.object(
            matching,
            "match_compiled_firewall_request",
            wraps=matching.match_compiled_firewall_request,
        ) as firewall_match,
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)

        assert validated_flows == [flow]
        assert registry_load.call_count == 1
        assert firewall_match.call_count == 1

        await await_requestheaders_result(requestheaders_result)
        await mitm_addon.request(flow)
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_independent_large_fixed_length_bypasses_buffer_limit(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body_size = aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES + 1
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length=str(body_size),
        content_hash=hashlib.sha256(b"expected body").hexdigest(),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

    get_headers.assert_awaited_once()
    assert callable(flow.request.stream)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert flow.error is None


async def test_payload_independent_sigv4_cancellation_restores_inspection_state(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="0",
        content_hash="UNSIGNED-PAYLOAD",
    )
    original_headers = flow.request.headers.fields
    original_url = flow.request.url
    get_headers = AsyncMock(side_effect=asyncio.CancelledError)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        pytest.raises(asyncio.CancelledError),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

    get_headers.assert_awaited_once()
    assert flow.request.headers.fields == original_headers
    assert flow.request.url == original_url
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


@pytest.mark.parametrize(
    ("target_size", "accepted"),
    [
        (auth.MAX_AWS_SIGV4_REQUEST_TARGET_BYTES, True),
        (auth.MAX_AWS_SIGV4_REQUEST_TARGET_BYTES + 1, False),
    ],
    ids=["exact-limit", "over-limit"],
)
async def test_sigv4_request_target_inspection_boundary(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    target_size: int,
    accepted: bool,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="0",
        content_hash="UNSIGNED-PAYLOAD",
    )
    target_prefix = "/?padding="
    flow.request.path = target_prefix + "a" * (target_size - len(target_prefix))
    assert len(flow.request.data.path) == target_size
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if accepted:
            await await_requestheaders_result(requestheaders_result)
            assert flow.response is None
            assert (
                f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
            )
            await mitm_addon.request(flow)
            flow.response = http.Response.make(200, b"ok")
        else:
            assert requestheaders_result is None
            assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION in flow.metadata
            await mitm_addon.request(flow)
            assert flow.response is not None
            assert flow.response.status_code == 502
            assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
            assert "AWS request target is too large" in flow.response.json()["message"]
            assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]

        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    ("pair_count", "accepted"),
    [
        (MAX_AWS_SIGV4_QUERY_PAIRS, True),
        (MAX_AWS_SIGV4_QUERY_PAIRS + 1, False),
    ],
    ids=["exact-limit", "over-limit"],
)
async def test_presigned_s3_query_pair_count_inspection_boundary(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    pair_count: int,
    accepted: bool,
) -> None:
    host = "bucket.s3.amazonaws.com"
    registry_path = _write_aws_registry(tmp_path, base=f"https://{host}")
    path = _s3_presigned_query_path_with_pair_count(pair_count)
    assert len(path.encode()) < auth.MAX_AWS_SIGV4_REQUEST_TARGET_BYTES
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=host,
        method="GET",
        path=path,
        request_headers=headers(
            ("Host", host),
            ("Content-Length", "0"),
        ),
    )
    original_url = flow.request.url
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if accepted:
            await await_requestheaders_result(requestheaders_result)
            assert flow.response is None
            assert callable(flow.request.stream)
            assert f"X-Amz-Credential={RESOLVED_AWS_ACCESS_KEY_ID}%2F" in flow.request.url
            signed_query = urllib.parse.urlsplit(flow.request.url).query
            assert len(signed_query.split("&")) == MAX_AWS_SIGV4_QUERY_PAIRS + 1
            flow.response = http.Response.make(200, b"ok")
        else:
            assert requestheaders_result is None
            assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION in flow.metadata
            await mitm_addon.request(flow)

            assert flow.response is not None
            assert flow.response.status_code == 502
            assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
            assert flow.response.json()["message"] == ("AWS request has too many query parameters")
            assert flow.request.url == original_url
            assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.url

        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
        mitm_addon.response(flow)
        assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


@pytest.mark.parametrize(
    ("header_list_size", "accepted"),
    [
        (auth.MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES, True),
        (auth.MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES + 1, False),
    ],
    ids=["exact-limit", "over-limit"],
)
async def test_sigv4_request_header_list_inspection_boundary(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    header_list_size: int,
    accepted: bool,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="0",
        content_hash="UNSIGNED-PAYLOAD",
    )
    padding_name = "X-Padding"
    padding_value_size = (
        header_list_size
        - _raw_header_list_size(flow.request.headers)
        - len(padding_name.encode())
        - auth.AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES
    )
    assert padding_value_size >= 0
    flow.request.headers[padding_name] = "x" * padding_value_size
    assert _raw_header_list_size(flow.request.headers) == header_list_size
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_result = mitm_addon.requestheaders(flow)
        if accepted:
            await await_requestheaders_result(requestheaders_result)
            assert flow.response is None
            assert (
                f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
            )
            await mitm_addon.request(flow)
            flow.response = http.Response.make(200, b"ok")
        else:
            assert requestheaders_result is None
            assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION in flow.metadata
            await mitm_addon.request(flow)
            assert flow.response is not None
            assert flow.response.status_code == 502
            assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
            assert "AWS request headers are too large" in flow.response.json()["message"]
            assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]

        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_sigv4_request_hook_header_field_count_fails_closed(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="0",
        content_hash="UNSIGNED-PAYLOAD",
    )
    additional_fields = (
        auth.MAX_AWS_SIGV4_REQUEST_HEADER_FIELDS + 1 - len(flow.request.headers.fields)
    )
    flow.request.headers = http.Headers(
        (*flow.request.headers.fields, *((b"X-Padding", b""),) * additional_fields)
    )
    assert len(flow.request.headers.fields) == auth.MAX_AWS_SIGV4_REQUEST_HEADER_FIELDS + 1
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await mitm_addon.request(flow)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert flow.response.json()["error"] == "aws_sigv4_auth_failed"
        assert "AWS request headers are too large" in flow.response.json()["message"]
        assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]
        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_independent_sigv4_disconnect_during_auth_falls_back_without_credentials(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="93.184.216.34",
        sni=STS_HOST,
        method="POST",
        path="/",
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                authorization=aws_sigv4_authorization(
                    signed_headers="host;x-amz-content-sha256;x-amz-date",
                ),
                extra_headers=[
                    ("Content-Length", "4"),
                    ("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"),
                ],
            )
        ),
    )
    mark_connected_tls_upstream(
        flow,
        sni=STS_HOST,
        server_address=("93.184.216.34", 443),
        peername=("93.184.216.34", 443),
    )
    original_headers = flow.request.headers.fields
    original_url = flow.request.url
    auth_resolution_entered = asyncio.Event()
    release_auth_resolution = asyncio.Event()

    async def resolve_auth(*_args, **_kwargs):
        auth_resolution_entered.set()
        await release_auth_resolution.wait()
        return _resolved_token_meta()

    get_headers = AsyncMock(side_effect=resolve_auth)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        requestheaders_task = asyncio.create_task(
            await_requestheaders_result(mitm_addon.requestheaders(flow))
        )
        try:
            await asyncio.wait_for(auth_resolution_entered.wait(), timeout=1)
            flow.server_conn.state = connection.ConnectionState.CLOSED
            mitm_addon.server_disconnected(SimpleNamespace(server=flow.server_conn))
            release_auth_resolution.set()
            await requestheaders_task
        finally:
            release_auth_resolution.set()
            await cancel_pending_task(requestheaders_task)

        assert flow.request.stream is False
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert flow.request.headers.fields == original_headers
        assert flow.request.url == original_url
        assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.url
        assert aws_sigv4_body_admission.state_for_tests() == (1, 4)
        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION in flow.metadata
        mitm_addon.error(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata


async def test_payload_dependent_sigv4_holds_admission_until_terminal_cleanup(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION in flow.metadata
        get_headers.assert_not_awaited()

        await mitm_addon.request(flow)
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata


async def test_bounded_payload_dependent_sigv4_classifies_once_before_buffering(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())
    validated_flows = track_trusted_authority_validations(monkeypatch)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(
            registry,
            "load_registry_state",
            wraps=registry.load_registry_state,
        ) as registry_load,
        patch.object(
            matching,
            "match_compiled_firewall_request",
            wraps=matching.match_compiled_firewall_request,
        ) as firewall_match,
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert validated_flows == [flow]
        assert registry_load.call_count == 1
        assert firewall_match.call_count == 1
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))

        await mitm_addon.request(flow)
        assert f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]

        flow.response = http.Response.make(200, b"ok")
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


def test_bounded_sigv4_classification_failure_restores_probe_metadata(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(
            matching,
            "match_compiled_firewall_request",
            side_effect=RuntimeError("bounded classification failed"),
        ),
        pytest.raises(RuntimeError, match="bounded classification failed"),
    ):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert metadata_keys.TRUSTED_AUTHORITY_HOST not in flow.metadata
    assert metadata_keys.NETWORK_LOG_TARGET not in flow.metadata
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


def test_bounded_sigv4_revalidates_public_destination_after_prebind(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    monkeypatch,
) -> None:
    registry_path = _write_aws_registry(
        tmp_path,
        host_policy={"kind": "publicDestination"},
    )
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())
    ensure_bound_destination = upstream_admission.ensure_bound_destination

    def connect_private_destination_after_prebind(
        current_flow: http.HTTPFlow,
        *,
        kind: upstream_destination_binding.BindingKind,
        api_url: str,
        platform_connector_auth: bool = False,
    ) -> bool:
        admitted = ensure_bound_destination(
            current_flow,
            kind=kind,
            api_url=api_url,
            platform_connector_auth=platform_connector_auth,
        )
        if admitted:
            mark_connected_tls_upstream(
                current_flow,
                sni=STS_HOST,
                server_address=(STS_HOST, 443),
                peername=("10.0.0.1", 443),
            )
        return admitted

    monkeypatch.setattr(
        upstream_admission,
        "ensure_bound_destination",
        connect_private_destination_after_prebind,
    )

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    get_headers.assert_not_called()
    assert flow.response is None
    assert flow.error is not None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "unsafe_public_destination"
    assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_sigv4_revalidates_network_policy_before_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    original_authorization = flow.request.headers["authorization"]
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata

        registry_payload = json.loads(registry_path.read_text())
        policy = registry_payload["sandboxes"][_CLIENT_IP]["networkPolicies"]["aws"]
        policy["allow"] = []
        policy["deny"] = [_AWS_PERMISSION]
        registry_payload["updatedAt"] = 1
        registry_path.write_text(json.dumps(registry_payload))

        await mitm_addon.request(flow)

    get_headers.assert_not_awaited()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["reason"] == "permission_denied"
    assert flow.request.headers["authorization"] == original_authorization
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_sigv4_hashing_allows_event_loop_progress(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())
    event_loop_thread_id = threading.get_ident()
    hasher = _ControlledBodyHasher(asyncio.get_running_loop())
    request_task: asyncio.Task[None] | None = None

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(auth, "hash_request_body", hasher),
    ):
        assert mitm_addon.requestheaders(flow) is None
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_hash_start(hasher, request_task)

            assert hasher.thread_id is not None
            assert hasher.thread_id != event_loop_thread_id
            assert not request_task.done()
            assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]

            progressed = asyncio.create_task(asyncio.sleep(0, result=True))
            assert await progressed is True
            assert not request_task.done()

            hasher.release.set()
            _ = await request_task

            assert (
                f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/" in flow.request.headers["authorization"]
            )
            assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))

            flow.response = http.Response.make(200, b"ok")
            mitm_addon.response(flow)
        finally:
            hasher.release.set()
            await cancel_pending_task(request_task)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_sigv4_cancellation_waits_for_hash_completion(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())
    hasher = _ControlledBodyHasher(asyncio.get_running_loop())
    request_task: asyncio.Task[None] | None = None

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(auth, "hash_request_body", hasher),
    ):
        assert mitm_addon.requestheaders(flow) is None
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_hash_start(hasher, request_task)

            request_task.cancel()
            await asyncio.sleep(0)
            assert not request_task.done()
            request_task.cancel()
            await asyncio.sleep(0)
            assert not request_task.done()
            assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
            assert metadata_keys.AWS_SIGV4_BODY_ADMISSION in flow.metadata

            hasher.release.set()
            with pytest.raises(asyncio.CancelledError):
                _ = await request_task
        finally:
            hasher.release.set()
            await cancel_pending_task(request_task)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


async def test_payload_dependent_sigv4_revalidates_upstream_after_hashing(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())
    hasher = _ControlledBodyHasher(asyncio.get_running_loop())
    request_task: asyncio.Task[None] | None = None

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
        patch.object(auth, "hash_request_body", hasher),
    ):
        assert mitm_addon.requestheaders(flow) is None
        request_task = asyncio.create_task(mitm_addon.request(flow))
        try:
            await _wait_for_hash_start(hasher, request_task)

            flow.server_conn.state = connection.ConnectionState.CLOSED
            mitm_addon.server_disconnected(SimpleNamespace(server=flow.server_conn))
            hasher.release.set()
            _ = await request_task

            assert flow.response is not None
            assert flow.response.status_code == 403
            assert flow.response.content is not None
            assert json.loads(flow.response.content)["error"] == "upstream_destination_unbound"
            assert RESOLVED_AWS_ACCESS_KEY_ID not in flow.request.headers["authorization"]
            assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))

            mitm_addon.response(flow)
        finally:
            hasher.release.set()
            await cancel_pending_task(request_task)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_sigv4_holds_admission_until_websocket_end(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"body"
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=body,
        content_length=str(len(body)),
    )
    flow.request.headers["Connection"] = "Upgrade"
    flow.request.headers["Upgrade"] = "websocket"
    flow.request.headers["Sec-WebSocket-Key"] = "MDEyMzQ1Njc4OWFiY2RlZg=="
    flow.request.headers["Sec-WebSocket-Version"] = "13"
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

        flow.response = http.Response.make(
            101,
            b"",
            {
                "Connection": "Upgrade",
                "Upgrade": "websocket",
            },
        )
        flow.websocket = WebSocketData()
        mitm_addon.response(flow)

        assert aws_sigv4_body_admission.state_for_tests() == (1, len(body))
        assert metadata_keys.AWS_SIGV4_BODY_ADMISSION in flow.metadata

        mitm_addon.websocket_end(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


@pytest.mark.parametrize(
    "framing_case",
    [
        *buffered_auth_body_framing_rejection_cases(
            max_body_bytes=aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES
        ),
        BufferedAuthBodyFramingRejectionCase(
            id="indeterminate",
            header_pairs=(),
            kind="length_required",
        ),
    ],
    ids=buffered_auth_body_framing_case_id,
)
def test_payload_dependent_sigv4_rejects_unbounded_framing_before_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    framing_case: BufferedAuthBodyFramingRejectionCase,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=STS_HOST,
        method="POST",
        path="/",
        request_headers=headers(
            *aws_sigv4_header_auth_headers(extra_headers=framing_case.header_pairs)
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    expected_error = (
        auth.AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR
        if framing_case.kind == "too_large"
        else auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR
    )
    get_headers.assert_not_called()
    assert flow.error is not None
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_error
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


def test_malformed_sigv4_placeholder_uses_bounded_fallback(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=STS_HOST,
        method="POST",
        path="/",
        request_headers=headers(
            ("Host", STS_HOST),
            ("Authorization", "AWS4-HMAC-SHA256 malformed"),
            ("Transfer-Encoding", "chunked"),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    get_headers.assert_not_called()
    assert flow.error is not None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR]
        == auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR
    )
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata


@pytest.mark.parametrize(
    ("limit_name", "limit_value"),
    [
        ("MAX_ADMITTED_AWS_SIGV4_REQUESTS", 0),
        ("MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES", 3),
    ],
    ids=["request-count", "body-bytes"],
)
def test_payload_dependent_sigv4_rejects_saturated_admission_before_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    limit_name: str,
    limit_value: int,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="4",
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(aws_sigv4_body_admission, limit_name, limit_value),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    get_headers.assert_not_called()
    assert flow.error is not None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR]
        == auth.AWS_SIGV4_REQUEST_BODY_ADMISSION_SATURATED_ERROR
    )
    assert flow.metadata[metadata_keys.SUPPRESS_REQUEST_BODY_CAPTURE] is True
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


def test_payload_dependent_sigv4_releases_new_admission_after_attach_failure(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        content_length="4",
    )
    original_admission = aws_sigv4_body_admission.reserve(4)
    aws_sigv4_body_admission.attach_to_flow(flow, original_admission)

    try:
        with (
            mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
            pytest.raises(RuntimeError, match="already attached"),
        ):
            mitm_addon.requestheaders(flow)

        assert flow.metadata[metadata_keys.AWS_SIGV4_BODY_ADMISSION] is original_admission
        assert aws_sigv4_body_admission.state_for_tests() == (1, 4)
    finally:
        aws_sigv4_body_admission.release_from_flow(flow)

    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_payload_dependent_sigv4_cancellation_releases_admission(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=b"body",
        content_length="4",
    )
    get_headers = AsyncMock(side_effect=asyncio.CancelledError)

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION in flow.metadata
        with pytest.raises(asyncio.CancelledError):
            await mitm_addon.request(flow)

    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata
    assert metadata_keys.AWS_SIGV4_REQUEST_INSPECTION not in flow.metadata


async def test_payload_dependent_sigv4_auth_failure_releases_at_local_response_terminal(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    flow = _header_auth_flow(
        real_flow,
        headers,
        body=b"body",
        content_length="4",
    )
    get_headers = AsyncMock(side_effect=RuntimeError("auth unavailable"))

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None
        await mitm_addon.request(flow)

        assert flow.response is not None
        assert flow.response.status_code == 502
        assert aws_sigv4_body_admission.state_for_tests() == (1, 4)
        mitm_addon.response(flow)

    get_headers.assert_awaited_once()
    assert aws_sigv4_body_admission.state_for_tests() == (0, 0)


async def test_direct_oversized_sigv4_request_returns_413_without_auth(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    registry_path = _write_aws_registry(tmp_path)
    body = b"x" * (aws_sigv4_body_admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES + 1)
    flow = _header_auth_flow(real_flow, headers, body=body)
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await mitm_addon.request(flow)

    get_headers.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 413
    assert flow.response.content is not None
    assert json.loads(flow.response.content)["error"] == (
        auth.AWS_SIGV4_REQUEST_BODY_TOO_LARGE_ERROR
    )


async def test_presigned_s3_request_signs_before_streaming(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    host = "bucket.s3.amazonaws.com"
    registry_path = _write_aws_registry(tmp_path, base=f"https://{host}")
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=host,
        method="GET",
        path=aws_sigv4_presigned_query_path(
            service="s3",
            leading_query="",
        ),
        request_headers=headers(
            ("Host", host),
            ("Transfer-Encoding", "chunked"),
        ),
    )
    get_headers = AsyncMock(return_value=_resolved_token_meta())

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))

    get_headers.assert_awaited_once()
    assert callable(flow.request.stream)
    assert f"X-Amz-Credential={RESOLVED_AWS_ACCESS_KEY_ID}%2F" in flow.request.url
    assert metadata_keys.AWS_SIGV4_BODY_ADMISSION not in flow.metadata


def test_public_destination_presigned_s3_uses_bounded_fallback(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
) -> None:
    host = "bucket.s3.amazonaws.com"
    registry_path = _write_aws_registry(
        tmp_path,
        base=f"https://{host}",
        host_policy={"kind": "publicDestination"},
    )
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host=host,
        method="GET",
        path=aws_sigv4_presigned_query_path(
            service="s3",
            leading_query="",
        ),
        request_headers=headers(
            ("Host", host),
            ("Transfer-Encoding", "chunked"),
        ),
    )
    get_headers = AsyncMock()

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        patch.object(auth, "get_firewall_headers", get_headers),
    ):
        assert mitm_addon.requestheaders(flow) is None

    get_headers.assert_not_called()
    _assert_no_request_stream(flow)
    assert flow.error is not None
    assert (
        flow.metadata[metadata_keys.FIREWALL_ERROR]
        == auth.AWS_SIGV4_REQUEST_BODY_LENGTH_REQUIRED_ERROR
    )
