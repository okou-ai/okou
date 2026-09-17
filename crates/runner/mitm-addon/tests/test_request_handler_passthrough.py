"""Ordinary and browser pass-through tests for the request hook."""

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
)
_MAX_BROWSER_USER_AGENT_BYTES = 4096
_BROWSER_USER_AGENTS = (
    pytest.param(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        id="chrome",
    ),
    pytest.param(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chromium/126.0.0.0 Safari/537.36",
        id="chromium",
    ),
    pytest.param(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
        id="edge",
    ),
    pytest.param(
        "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
        id="firefox",
    ),
    pytest.param(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0",
        id="opera",
    ),
    pytest.param(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        id="safari",
    ),
    pytest.param(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 "
        "Mobile/15E148 Safari/604.1",
        id="ios",
    ),
    pytest.param(_BROWSER_USER_AGENT, id="headless-chrome"),
    pytest.param(
        _BROWSER_USER_AGENT.ljust(_MAX_BROWSER_USER_AGENT_BYTES, "x"),
        id="at-limit",
    ),
)


class _DecodeGuardUserAgent(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("oversized User-Agent must not be decoded")


async def test_allowed_domain_passes_through(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.anthropic.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"),
    ):
        await mitm_addon.request(flow)

    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"


async def test_tracks_start_time(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, host="api.anthropic.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"),
    ):
        await mitm_addon.request(flow)

    assert metadata_keys.HTTP_REQUEST_START_MONOTONIC in flow.metadata


async def test_unregistered_sandbox_passes_through(registry_file, real_flow, mitm_ctx):
    flow = real_flow(with_response=False, client_ip="192.168.99.99", host="anything.com")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"),
    ):
        await mitm_addon.request(flow)

    # No 403, no metadata set
    assert flow.response is None
    assert metadata_keys.FIREWALL_ACTION not in flow.metadata


async def test_mitm_allowed_passes_through(registry_file, real_flow, mitm_ctx):
    """Allowed request passes through without rewrite."""
    flow = real_flow(with_response=False, host="api.anthropic.com", path="/v1/messages")

    with (
        mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"),
    ):
        await mitm_addon.request(flow)

    # Request should pass through without rewrite
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata.get(metadata_keys.ORIGINAL_URL) == "https://api.anthropic.com/v1/messages"


async def test_firewall_no_base_match_passes_through(tmp_path, real_flow, mitm_ctx, headers):
    """URL not matching any firewall base → pass-through (not block)."""
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    # Request to example.com — not a firewall match, passes through
    flow = real_flow(
        with_response=False, client_ip="10.200.0.5", host="api.example.com", path="/data"
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    # No firewall match → pass-through, not blocked (dispatcher's final
    # fall-through sets firewall_action=ALLOW; handler never reached so
    # firewall_base is absent).
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata


@pytest.mark.parametrize("browser_user_agent", _BROWSER_USER_AGENTS)
async def test_browser_passthrough_skips_firewall_auth_injection(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers, browser_user_agent
):
    """Browser-looking UAs use the short-term passthrough heuristic."""
    control_root = tmp_path / "delivery-control"
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="stripe",
            billable_firewalls=["stripe"],
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", browser_user_agent),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_PERMISSION not in flow.metadata
    assert metadata_keys.FIREWALL_RULE_MATCH not in flow.metadata
    assert metadata_keys.FIREWALL_PARAMS not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata
    assert metadata_keys.MODEL_USAGE_PROVIDER not in flow.metadata
    assert metadata_keys.AUTH_RESOLVED_SECRETS not in flow.metadata
    assert metadata_keys.AUTH_URL_REWRITE not in flow.metadata
    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["browser_user_agent"] is True
    assert "firewall_base" not in network_log_entry


@pytest.mark.parametrize(
    "user_agent_values",
    [
        pytest.param(
            (_DecodeGuardUserAgent(b"Mozilla/5.0 " + b"x" * 4096),),
            id="single-field",
        ),
        pytest.param(
            (
                _DecodeGuardUserAgent(b"Mozilla/5.0 " + b"x" * (2048 - 12)),
                _DecodeGuardUserAgent(b"x" * 2047),
            ),
            id="combined-fields",
        ),
    ],
)
async def test_oversized_browser_user_agent_uses_firewall_without_decoding(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, user_agent_values
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="stripe",
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )
    request_headers = mitm_addon.http.Headers(
        [(b"Host", b"api.stripe.com")] + [(b"User-Agent", value) for value in user_agent_values]
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=request_headers,
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.stripe.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "stripe"
    assert metadata_keys.BROWSER_USER_AGENT not in flow.metadata


async def test_non_browser_firewall_match_still_injects_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Non-browser firewall allows keep the existing connector auth behavior."""
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="stripe",
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", "curl/8.5.0"),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_awaited_once()
    assert flow.response is None
    assert flow.request.headers["Authorization"] == "Bearer x"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.stripe.com"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "stripe"


async def test_browser_passthrough_skips_denied_unknown_policy_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips unknown-policy firewall matching."""
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="stripe",
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [],
            },
            network_policy={
                "allow": [],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_pages/cs_test_123/init",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata


async def test_browser_passthrough_skips_denied_permission_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips denied-permission matching."""
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="stripe",
            billable_firewalls=["stripe"],
            api_entry={
                "base": "https://api.stripe.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.STRIPE_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "payment_method_write",
                        "rules": ["POST /v1/payment_methods"],
                    },
                ],
            },
            network_policy={
                "allow": [],
                "deny": ["payment_method_write"],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.stripe.com",
        method="POST",
        path="/v1/payment_methods",
        request_headers=headers(
            ("Host", "api.stripe.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert "Authorization" not in flow.request.headers
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert metadata_keys.FIREWALL_API_ID not in flow.metadata

    flow.response = mitm_addon.http.Response.make(200)
    mitm_addon.response(flow)
    network_log_entry = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")[0]
    assert network_log_entry["browser_user_agent"] is True
    assert "firewall_base" not in network_log_entry


async def test_browser_passthrough_skips_unsafe_path_firewall_match(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    """Browser passthrough intentionally skips unsafe-path firewall matching."""
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [
                    {
                        "name": "full-access",
                        "rules": ["ANY /{path+}"],
                    },
                ],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )

    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="api.github.com",
        path="/repos/%2e%2e/admin",
        request_headers=headers(
            ("Host", "api.github.com"),
            ("User-Agent", _BROWSER_USER_AGENT),
        ),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as mock_headers,
    ):
        await mitm_addon.request(flow)

    mock_headers.assert_not_called()
    assert flow.response is None
    assert flow.metadata[metadata_keys.BROWSER_USER_AGENT] is True
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_BILLABLE] is False
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_NAME not in flow.metadata
    assert "Authorization" not in flow.request.headers
