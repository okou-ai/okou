"""Authority validation request hook integration tests."""

import encodings.punycode
import json
from unittest.mock import patch

import pytest

import flow_metadata_keys as metadata_keys
import host_normalization
import mitm_addon
import request_authority
import upstream_destination_binding
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.request_handler_helpers import _write_github_firewall_registry
from tests.upstream_connection_helpers import bind_flow_upstream, seed_server_binding

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)
_MAX_HOST_HEADER_BYTES = 4096


@pytest.mark.parametrize("host", ["xn--mgba3gch31f060k.example", "xn--11b2ezcw70k.example"])
async def test_matching_sni_and_host_reject_encoded_joiners_before_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, host
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni=host,
        path="/repos",
        request_headers=headers(("Host", host)),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["error"] == "invalid_sni"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


class _DecodeGuardHost(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("over-budget Host must not be decoded")


@pytest.mark.parametrize(
    ("request_port", "expected_original_url"),
    [
        (443, "https://attacker.example.com/repos"),
        (8443, "https://attacker.example.com:8443/repos"),
    ],
)
async def test_rejects_spoofed_host_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="attacker.example.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=request_port,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", request_port),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "authority_mismatch"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == expected_original_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": expected_original_url,
        "host": "attacker.example.com",
        "port": request_port,
    }
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))


async def test_authority_validation_deny_response_logs_network_target(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    raw_url = "https://attacker.example.com:8443/repos?code=secret#frag"
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=8443,
        sni="attacker.example.com",
        path="/repos?code=secret#frag",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    auth_fetch.assert_not_called()
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == raw_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET]["url"] == raw_url

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["type"] == "http"
    assert entry["action"] == "DENY"
    assert entry["host"] == "attacker.example.com"
    assert entry["port"] == 8443
    assert entry["url"] == raw_url
    assert entry["status"] == 403
    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata


async def test_authority_validation_deny_logs_malformed_fallback_target(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    fallback_url = "https://target.example:not-a-port/repos"
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="target.example:not-a-port",
        sni="",
        path="/repos",
        request_headers=headers(("Host", "request.example")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "missing_sni"
    auth_fetch.assert_not_called()
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "missing_sni"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == fallback_url
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": fallback_url,
        "host": "request.example",
        "port": 443,
    }

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "DENY"
    assert entry["firewall_error"] == "missing_sni"
    assert entry["host"] == "request.example"
    assert entry["port"] == 443
    assert entry["url"] == fallback_url
    assert entry["status"] == 403


async def test_browser_user_agent_marker_survives_authority_validation_block(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="attacker.example.com",
        path="/repos",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    auth_fetch.assert_not_called()

    with mitm_ctx():
        mitm_addon.response(flow)

    [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert entry["action"] == "DENY"
    assert entry["browser_user_agent"] is True


@pytest.mark.parametrize("http_version", ["HTTP/2.0", "HTTP/3"])
@pytest.mark.parametrize("regular_host", [None, "api.github.com"], ids=["authority-only", "host"])
async def test_valid_pseudo_authority_allows_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    http_version,
    regular_host,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    request_headers = headers() if regular_host is None else headers(("Host", regular_host))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=request_headers,
    )
    flow.request.http_version = http_version
    flow.request.authority = "api.github.com"
    bind_flow_upstream(flow)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize("http_version", ["HTTP/1.1", "HTTP/2.0", "HTTP/3"])
async def test_rejects_oversized_unicode_authority_before_punycode_encoding(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    http_version,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    oversized_label = "".join(chr(0x4E00 + index) for index in range(1365))
    assert len(oversized_label.encode()) == _MAX_HOST_HEADER_BYTES - 1
    request_headers = (
        headers(
            ("Host", oversized_label),
            ("Authorization", "Bearer sandbox-token"),
        )
        if http_version == "HTTP/1.1"
        else headers(("Authorization", "Bearer sandbox-token"))
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=request_headers,
    )
    flow.request.http_version = http_version
    if flow.request.is_http2 or flow.request.is_http3:
        flow.request.authority = oversized_label
    original_headers = tuple(flow.request.headers.fields)
    real_normalize_label_text = host_normalization._normalize_label_text

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
        patch.object(
            host_normalization,
            "_normalize_label_text",
            wraps=real_normalize_label_text,
        ) as normalize_label_text,
        patch.object(
            host_normalization,
            "_validate_normalized_label_text",
            side_effect=AssertionError("oversized authority reached normalized text validation"),
        ) as validate_normalized_label_text,
        patch.object(
            encodings.punycode,
            "punycode_encode",
            side_effect=AssertionError("oversized authority reached punycode encoder"),
        ),
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["error"] == "invalid_authority"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.headers["Authorization"] == "Bearer sandbox-token"
    auth_fetch.assert_not_called()
    normalize_label_text.assert_called_once_with(oversized_label)
    validate_normalized_label_text.assert_not_called()


@pytest.mark.parametrize(
    ("request_port", "request_authority", "expected_original_url"),
    [
        pytest.param(
            443,
            "API.GITHUB.COM.",
            "https://api.github.com/repos",
            id="normalized-host",
        ),
        pytest.param(
            8443,
            "api.github.com:8443",
            "https://api.github.com:8443/repos",
            id="matching-port",
        ),
    ],
)
async def test_valid_http1_request_target_authority_allows_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    request_authority,
    expected_original_url,
):
    firewall_base = (
        "https://api.github.com"
        if request_port == 443
        else f"https://api.github.com:{request_port}"
    )
    reg_path = _write_github_firewall_registry(tmp_path, base=firewall_base)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.request.authority = request_authority
    bind_flow_upstream(flow, port=request_port)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.request.http_version == "HTTP/1.1"
    assert flow.request.authority == request_authority
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == firewall_base
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == expected_original_url
    assert flow.request.headers["Authorization"] == "Bearer x"


@pytest.mark.parametrize("http_version", ["HTTP/2.0", "HTTP/3"])
@pytest.mark.parametrize(
    ("pseudo_authority", "regular_host"),
    [
        pytest.param(
            "attacker.example.com",
            "api.github.com",
            id="pseudo-authority-mismatch",
        ),
        pytest.param(
            "api.github.com",
            "attacker.example.com",
            id="regular-host-mismatch",
        ),
    ],
)
async def test_rejects_disagreement_between_pseudo_authority_and_host(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    http_version,
    pseudo_authority,
    regular_host,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", regular_host)),
    )
    flow.request.http_version = http_version
    flow.request.authority = pseudo_authority

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == pseudo_authority
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "authority_mismatch"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    ("request_port", "request_authority", "expected_reason", "expected_original_url"),
    [
        pytest.param(
            443,
            "attacker.example.com",
            "authority_mismatch",
            "https://api.github.com/repos",
            id="host-mismatch",
        ),
        pytest.param(
            443,
            "api.github.com:bad",
            "invalid_authority",
            "https://api.github.com/repos",
            id="malformed-port",
        ),
        pytest.param(
            443,
            "api.github.com:444",
            "authority_port_mismatch",
            "https://api.github.com/repos",
            id="port-mismatch",
        ),
        pytest.param(
            8443,
            "api.github.com",
            "authority_port_mismatch",
            "https://api.github.com:8443/repos",
            id="implicit-default-port-mismatch",
        ),
    ],
)
async def test_rejects_invalid_http1_request_target_authority_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    request_port,
    request_authority,
    expected_reason,
    expected_original_url,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        port=request_port,
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.request.authority = request_authority
    original_headers = tuple(flow.request.headers.fields)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == expected_reason
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == "api.github.com"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == expected_reason
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == expected_original_url
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.authority == request_authority
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_spoofed_host_before_vm0_api_auto_allow(
    registry_file, real_flow, mitm_ctx, headers
):
    flow = real_flow(
        with_response=False,
        host="203.0.113.10",
        sni="attacker.example.com",
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.okou.ai")),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_mismatch"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"


@pytest.mark.parametrize(
    ("http_version", "pseudo_authority", "expected_host_header"),
    [
        pytest.param(
            "HTTP/1.1",
            "",
            "attacker.example.com, api.github.com",
            id="http1",
        ),
        pytest.param(
            "HTTP/3",
            "api.github.com",
            "api.github.com",
            id="http3",
        ),
    ],
)
async def test_rejects_duplicate_host_authority_before_firewall_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    headers,
    http_version,
    pseudo_authority,
    expected_host_header,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(
            ("Host", "attacker.example.com"),
            ("Host", "api.github.com"),
        ),
    )
    flow.request.http_version = http_version
    flow.request.authority = pseudo_authority
    original_headers = tuple(flow.request.headers.fields)
    original_path = flow.request.path

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] == expected_host_header
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.path == original_path
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


@pytest.mark.parametrize(
    "host_values",
    [
        pytest.param(
            (_DecodeGuardHost(b"a" * (_MAX_HOST_HEADER_BYTES + 1)),),
            id="single-field",
        ),
        pytest.param(
            (
                _DecodeGuardHost(b"a" * 2048),
                _DecodeGuardHost(b"b" * 2047),
            ),
            id="folded-duplicate-fields",
        ),
    ],
)
async def test_rejects_over_budget_host_without_decoding_or_auth(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    host_values,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    request_headers = mitm_addon.http.Headers(
        [(b"Host", value) for value in host_values] + [(b"Authorization", b"Bearer sandbox-token")]
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=request_headers,
    )
    original_headers = tuple(flow.request.headers.fields)
    real_normalize_hostname = request_authority.normalize_hostname

    def normalize_trusted_sni(host: str) -> str:
        assert host == "api.github.com"
        return real_normalize_hostname(host)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
        patch.object(
            request_authority,
            "normalize_hostname",
            side_effect=normalize_trusted_sni,
        ),
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_authority"
    assert body["sni"] == "api.github.com"
    assert body["host_header"] is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_authority"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    assert flow.metadata[metadata_keys.NETWORK_LOG_TARGET] == {
        "url": "https://api.github.com/repos",
        "host": "api.github.com",
        "port": 443,
    }
    assert tuple(flow.request.headers.fields) == original_headers
    assert flow.request.headers["Authorization"] == "Bearer sandbox-token"
    auth_fetch.assert_not_called()

    [proxy_log_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
    assert proxy_log_entry["type"] == "authority_validation"
    assert proxy_log_entry["reason"] == "invalid_authority"
    assert proxy_log_entry["host_header"] is None


async def test_redacts_over_budget_host_from_network_log(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        sandbox_fields={"captureNetworkBodies": True},
    )
    oversized_host = b"a" * (_MAX_HOST_HEADER_BYTES + 1)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=mitm_addon.http.Headers(
            [
                (b"Host", oversized_host),
                (b"Authorization", b"Bearer sandbox-token"),
            ]
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert json.loads(flow.response.content)["host_header"] is None
    auth_fetch.assert_not_called()

    with mitm_ctx():
        mitm_addon.response(flow)

    [network_log_entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
    assert network_log_entry["action"] == "DENY"
    assert network_log_entry["firewall_error"] == "invalid_authority"
    assert network_log_entry["request_headers"] == {
        "Host": "***",
        "Authorization": "***",
    }
    assert "a" * 256 not in json.dumps(network_log_entry)


async def test_rejects_host_authority_port_mismatch_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
        path="/repos",
        request_headers=headers(("Host", "api.github.com:444")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "authority_port_mismatch"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "authority_port_mismatch"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://api.github.com/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_missing_https_sni_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )
    flow.client_conn.sni = None

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "missing_sni"
    assert body["sni"] is None
    assert body["request_host"] == "203.0.113.10"
    assert body["host_header"] == "api.github.com"
    assert body["request_port"] == 443
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "missing_sni"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://203.0.113.10/repos"
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_rejects_invalid_https_sni_logs_proxy_entry_before_firewall_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="...",
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    body = json.loads(flow.response.content)
    assert body["error"] == "invalid_sni"
    assert body["sni"] == "..."
    assert body["request_host"] == "203.0.113.10"
    assert body["host_header"] == "api.github.com"
    assert body["request_port"] == 443
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_sni"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "https://203.0.113.10/repos"
    proxy_log_entry = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")[0]
    assert proxy_log_entry["type"] == "authority_validation"
    assert proxy_log_entry["reason"] == "invalid_sni"
    assert proxy_log_entry["sni"] == "..."
    assert proxy_log_entry["request_host"] == "203.0.113.10"
    assert proxy_log_entry["host_header"] == "api.github.com"
    assert proxy_log_entry["request_port"] == 443
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_http_host_spoof_does_not_match_domain_firewall(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(tmp_path, base="http://api.github.com")
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        scheme="http",
        host="203.0.113.10",
        port=80,
        path="/repos",
        request_headers=headers(("Host", "api.github.com")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "http://203.0.113.10/repos"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    auth_fetch.assert_not_called()
    assert "Authorization" not in flow.request.headers


async def test_http_host_spoof_does_not_trigger_vm0_api_auto_allow(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="http://203.0.113.10/api/runs",
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        scheme="http",
        host="203.0.113.10",
        port=80,
        path="/api/runs/heartbeat",
        request_headers=headers(("Host", "api.okou.ai")),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "http://203.0.113.10/api/runs"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "insecure_transport"
    assert flow.metadata[metadata_keys.ORIGINAL_URL] == "http://203.0.113.10/api/runs/heartbeat"
    assert "Authorization" not in flow.request.headers
    body = json.loads(flow.response.content)
    assert body["error"] == "insecure_transport"
