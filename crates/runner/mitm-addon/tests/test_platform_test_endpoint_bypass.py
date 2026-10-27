"""Bound test-endpoint bypass conversion without changing connector admission."""

import pytest
from mitmproxy import http
from mitmproxy.net.http import http1, validate

import flow_metadata_keys as metadata_keys
import mitm_addon
import upstream_admission
import upstream_destination_binding
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry

_BYPASS_HEADER = b"x-okou-test-endpoint-bypass"
_EXPECTED_BYPASS = "preview-secret"


class _UnconvertedValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("ineligible bypass values must not be decoded")

    def __bytes__(self) -> bytes:
        raise AssertionError("ineligible bypass values must not be copied")


def _native_request(values: tuple[bytes, ...], *, guard_values: bool = False) -> http.Request:
    request = http1.read_request_head(
        [
            b"GET https://api.okou.ai/api/test/oauth-provider/echo HTTP/1.1",
            b"Host: api.okou.ai",
            b"Content-Length: 0",
            *(b"X-Okou-Test-Endpoint-Bypass: " + value for value in values),
        ]
    )
    validate.validate_headers(request)
    assert http1.expected_http_body_size(request) == 0
    if guard_values:
        # Preserve validated bytes; instrument only the addon acquisition boundary.
        request.headers.fields = tuple(
            (name, _UnconvertedValue(value) if name.lower() == _BYPASS_HEADER else value)
            for name, value in request.headers.fields
        )
    return request


@pytest.mark.parametrize(
    ("expected", "values", "matches"),
    [
        pytest.param(_EXPECTED_BYPASS, (), False, id="missing"),
        pytest.param(_EXPECTED_BYPASS, (b"",), False, id="empty"),
        pytest.param(_EXPECTED_BYPASS, (b"preview-secre",), False, id="one-byte-short"),
        pytest.param(_EXPECTED_BYPASS, (b"preview-secret",), True, id="exact-boundary"),
        pytest.param(_EXPECTED_BYPASS, (b"PREVIEW-SECRET",), False, id="case-sensitive-value"),
        pytest.param(_EXPECTED_BYPASS, (b"preview-secretx",), False, id="first-extra-byte"),
        pytest.param("preview, secret", (b"preview", b"secret"), True, id="folded-boundary"),
        pytest.param("preview, secret", (b"secret", b"preview"), False, id="folded-order"),
        pytest.param(", preview", (b"", b"preview"), True, id="empty-first-field"),
        pytest.param("preview, ", (b"preview", b""), True, id="empty-last-field"),
        pytest.param("a, , b", (b"a", b"", b"b"), True, id="empty-middle-field"),
        pytest.param("préview", (b"pr\xc3\xa9view",), True, id="utf8-byte-boundary"),
        pytest.param("pr\udce9view", (b"pr\xe9view",), True, id="surrogateescape"),
    ],
)
def test_bypass_preserves_exact_folded_equality(real_flow, monkeypatch, expected, values, matches):
    flow = real_flow(with_response=False)
    flow.request = _native_request(values)
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", expected)

    assert upstream_admission._request_has_platform_test_endpoint_bypass(flow) is matches


@pytest.mark.parametrize(
    "values",
    [
        pytest.param((b"x" * (len(_EXPECTED_BYPASS) + 1),), id="first-over-budget-byte"),
        pytest.param((b"x" * 1_048_576,), id="oversized-single"),
        pytest.param((b"preview", b"secret"), id="aggregate-includes-separator"),
        pytest.param((b"x", b"x" * 1_048_576), id="oversized-later-field"),
        pytest.param((b"x" * 1_048_576, b"x"), id="oversized-first-field"),
    ],
)
def test_bypass_rejects_over_budget_before_converting_any_value(real_flow, monkeypatch, values):
    flow = real_flow(with_response=False)
    flow.request = _native_request(values, guard_values=True)
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", _EXPECTED_BYPASS)

    assert upstream_admission._request_has_platform_test_endpoint_bypass(flow) is False


@pytest.mark.parametrize(
    ("expected", "path"),
    [
        pytest.param(None, "/api/test/oauth-provider/echo", id="unset-configuration"),
        pytest.param("", "/api/test/oauth-provider/echo", id="empty-configuration"),
        pytest.param(_EXPECTED_BYPASS, "/mcp", id="other-platform-path"),
        pytest.param(
            _EXPECTED_BYPASS, "/api/test/../oauth-provider/echo", id="noncanonical-test-path"
        ),
    ],
)
def test_bypass_gates_precede_value_conversion(real_flow, monkeypatch, expected, path):
    flow = real_flow(with_response=False)
    flow.request = _native_request((b"preview-secret",), guard_values=True)
    flow.request.path = path
    if expected is None:
        monkeypatch.delenv("VERCEL_AUTOMATION_BYPASS_SECRET", raising=False)
    else:
        monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", expected)

    assert upstream_admission._request_has_platform_test_endpoint_bypass(flow) is False


@pytest.mark.parametrize(
    ("expected", "values", "allowed", "guard_values"),
    [
        pytest.param(_EXPECTED_BYPASS, (b"preview-secret",), True, False, id="exact-match"),
        pytest.param("preview, secret", (b"preview", b"secret"), True, False, id="folded-match"),
        pytest.param("préview", (b"pr\xc3\xa9view",), True, False, id="utf8-match"),
        pytest.param("pr\udce9view", (b"pr\xe9view",), True, False, id="surrogateescape-match"),
        pytest.param(_EXPECTED_BYPASS, (b"PREVIEW-SECRET",), False, False, id="wrong-value"),
        pytest.param(_EXPECTED_BYPASS, (b"x" * 1_048_576,), False, True, id="oversized-single"),
        pytest.param(
            _EXPECTED_BYPASS, (b"preview", b"secret"), False, True, id="separator-overflow"
        ),
        pytest.param(
            _EXPECTED_BYPASS,
            (b"x", b"x" * 1_048_576),
            False,
            True,
            id="oversized-later-field",
        ),
        pytest.param(None, (b"preview-secret",), False, True, id="unset-configuration"),
        pytest.param("", (b"preview-secret",), False, True, id="empty-configuration"),
    ],
)
async def test_native_bypass_admission_through_both_request_hooks(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch,
    expected,
    values,
    allowed,
    guard_values,
):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.okou.ai/api/test/oauth-provider",
                "auth": {"headers": {"Authorization": "Bearer x"}},
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy={"allow": ["echo"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.okou.ai",
    )
    flow.request = _native_request(values, guard_values=guard_values)
    original_fields = flow.request.headers.fields
    if expected is None:
        monkeypatch.delenv("VERCEL_AUTOMATION_BYPASS_SECRET", raising=False)
    else:
        monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", expected)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        auth_fetch.assert_not_called()
        assert "Authorization" not in flow.request.headers
        assert (
            flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()
        ) is allowed
        flow.request.raw_content = b""
        await mitm_addon.request(flow)

    if allowed:
        auth_fetch.assert_awaited_once()
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer x"
        binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
        assert binding.host == "api.okou.ai"
        assert binding.kinds == frozenset(("connector_auth",))
    else:
        auth_fetch.assert_not_called()
        assert flow.response is not None
        assert flow.response.status_code == 403
        assert flow.response.json()["error"] == "upstream_destination_unbound"
        assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "upstream_destination_unbound"
        assert "Authorization" not in flow.request.headers
        assert flow.server_conn.id not in upstream_destination_binding.binding_snapshot_for_tests()
        assert flow.request.headers.fields == original_fields
