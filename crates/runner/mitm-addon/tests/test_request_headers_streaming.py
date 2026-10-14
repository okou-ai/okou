"""Requestheaders request-stream setup and lifecycle tests."""

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import request_classification
from body_limits import STREAM_BUFFER_LIMIT
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _write_registry,
)
from tests.requestheaders_helpers import _assert_no_request_stream

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)


def _request_stream(flow):
    stream = flow.request.stream
    assert callable(stream)
    return stream


def test_capture_enabled_api_allow_installs_request_stream(tmp_path, real_flow, mitm_ctx):
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

    callback = _request_stream(flow)
    body = b"x" * (STREAM_BUFFER_LIMIT + 10)
    assert callback(body) == body
    assert len(flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER]) == STREAM_BUFFER_LIMIT
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
        "truncated": True,
        "total_bytes": STREAM_BUFFER_LIMIT + 10,
    }


def test_capture_enabled_browser_allow_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
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
        method="POST",
        request_headers=headers(("Host", "example.com"), ("User-Agent", _BROWSER_USER_AGENT)),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC in flow.metadata


def test_capture_enabled_final_allow_installs_request_stream(tmp_path, real_flow, mitm_ctx):
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
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


@pytest.mark.parametrize("capture_body", [False, True])
def test_small_bounded_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers, capture_body
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": capture_body}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Content-Length", "4")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


@pytest.mark.parametrize("capture_body", [False, True])
def test_body_at_stream_limit_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers, capture_body
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": capture_body}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


@pytest.mark.parametrize("capture_body", [False, True])
def test_explicit_zero_length_body_does_not_install_request_stream(
    tmp_path, real_flow, mitm_ctx, headers, capture_body
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": capture_body}
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="GET",
        request_headers=headers(("Host", "example.com"), ("Content-Length", "0")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


def test_capture_enabled_bodyless_method_without_content_length_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_sandbox_without_firewalls(
            tmp_path, sandbox_fields={"captureNetworkBodies": True}
        ),
    )
    for method in ("GET", "HEAD"):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="example.com",
            method=method,
            request_headers=headers(("Host", "example.com")),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            mitm_addon.requestheaders(flow)

        callback = _request_stream(flow)
        assert callback(b"body over http2") == b"body over http2"
        assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(b"body over http2")


def test_capture_enabled_body_over_stream_limit_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
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
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_enabled_preserves_preexisting_callable_stream(tmp_path, real_flow, mitm_ctx):
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
        method="POST",
    )

    def existing_stream(chunk: bytes) -> bytes:
        return b"existing:" + chunk

    flow.request.stream = existing_stream

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    assert flow.request.stream is existing_stream
    assert _request_stream(flow)(b"request body") == b"existing:request body"
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata


def test_capture_enabled_repeated_configuration_preserves_stream_state(
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
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        callback = _request_stream(flow)
        assert callback(b"first chunk") == b"first chunk"
        assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(b"first chunk")
        assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
            "truncated": False,
            "total_bytes": len(b"first chunk"),
        }

        mitm_addon.requestheaders(flow)

    assert flow.request.stream is callback
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(b"first chunk")
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
        "truncated": False,
        "total_bytes": len(b"first chunk"),
    }
    assert callback(b"second chunk") == b"second chunk"
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(
        b"first chunksecond chunk"
    )
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
        "truncated": False,
        "total_bytes": len(b"first chunksecond chunk"),
    }


def test_capture_enabled_replaces_boolean_stream_with_capture_callback(
    tmp_path, real_flow, mitm_ctx, headers
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
        method="POST",
        request_headers=headers(
            ("Host", "example.com"),
            ("Content-Length", str(STREAM_BUFFER_LIMIT + 1)),
        ),
    )
    flow.request.stream = True

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    callback = _request_stream(flow)
    assert callback(b"partial request") == b"partial request"
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER] == bytearray(b"partial request")
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE]["total_bytes"] == len(
        b"partial request"
    )


async def test_request_releases_cached_classification_after_stream_setup(
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
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY in flow.metadata
        await mitm_addon.request(flow)

    assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata


def test_capture_enabled_chunked_body_installs_request_stream(
    tmp_path, real_flow, mitm_ctx, headers
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
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Transfer-Encoding", "chunked")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    assert callable(flow.request.stream)
    assert metadata_keys.REQUEST_STREAM_BUFFER in flow.metadata


def test_capture_disabled_final_allow_installs_request_stream_without_body_capture(
    tmp_path, real_flow, mitm_ctx
):
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    callback = _request_stream(flow)
    body = b"uncaptured upload" * STREAM_BUFFER_LIMIT
    assert callback(body) == body
    assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
    assert flow.metadata[metadata_keys.REQUEST_STREAM_BUFFER_STATE] == {
        "truncated": False,
        "total_bytes": len(body),
    }


def test_non_stream_requestheaders_probe_restores_request_metadata(
    tmp_path, real_flow, mitm_ctx, headers
):
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="example.com",
        method="POST",
        request_headers=headers(("Host", "example.com"), ("Content-Length", "4")),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.requestheaders(flow)

    _assert_no_request_stream(flow)
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.ORIGINAL_URL not in flow.metadata
    assert metadata_keys.NETWORK_LOG_TARGET not in flow.metadata
    assert metadata_keys.CAPTURE_BODY not in flow.metadata
