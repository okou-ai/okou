"""Connector-intent classification for omitted runtime targets."""

import tracemalloc

import pytest

import connector_intent
import request_classification
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _shared_route_sandbox,
    _single_firewall_sandbox,
    _write_registry,
)

_API_URL = "https://api.okou.ai"
_CLIENT_IP = "10.200.0.5"
_CONNECTOR_INTENT_HEADER = "X-Okou-Connector-Intent"


@pytest.mark.parametrize(
    ("omitted_builtin", "omitted_custom", "intent"),
    [
        (["removed-builtin"], [], "removed-builtin"),
        ([], ["removed-custom"], "removed-custom"),
        (["removed-overlap"], ["removed-overlap"], "removed-overlap"),
    ],
    ids=["builtin-only", "custom-only", "both"],
)
def test_omitted_connector_intent_does_not_bypass_multiple_active_owners(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    omitted_builtin,
    omitted_custom,
    intent,
):
    sandbox = _shared_route_sandbox(tmp_path)
    sandbox["omittedBuiltinFirewalls"] = omitted_builtin
    sandbox["omittedCustomConnectorIds"] = omitted_custom
    registry_path = _write_registry(tmp_path, client_ip=_CLIENT_IP, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            (_CONNECTOR_INTENT_HEADER, intent),
        ),
    )
    connector_intent.capture_and_strip(flow)

    with mitm_ctx(registry_path=str(registry_path), api_url=_API_URL):
        classification = request_classification.classify_request(
            flow,
            registry_path=str(registry_path),
            api_url=_API_URL,
            tls_admission=None,
        )

    assert isinstance(classification, request_classification.FirewallAmbiguous)
    assert classification.firewall_ambiguous.reason == "connector_intent_not_candidate"
    assert _CONNECTOR_INTENT_HEADER not in flow.request.headers


@pytest.mark.parametrize(
    ("omitted_field", "intent"),
    [
        ("omittedBuiltinFirewalls", "removed-builtin"),
        ("omittedCustomConnectorIds", "removed-custom"),
    ],
)
def test_omitted_connector_intent_still_enforces_sole_owner_denial(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    omitted_field,
    intent,
):
    sandbox = _single_firewall_sandbox(
        tmp_path,
        firewall_name="active",
        api_entry={
            "base": "https://shared.example.com",
            "auth": {"headers": {"Authorization": "Bearer ${{ secrets.ACTIVE_TOKEN }}"}},
            "permissions": [{"name": "items-read", "rules": ["GET /items/{id}"]}],
        },
        network_policy={
            "allow": [],
            "deny": ["items-read"],
            "ask": [],
            "unknownPolicy": "deny",
        },
        sandbox_fields={omitted_field: [intent]},
    )
    registry_path = _write_registry(tmp_path, client_ip=_CLIENT_IP, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        path="/items/123",
        request_headers=headers(
            ("Host", "shared.example.com"),
            (_CONNECTOR_INTENT_HEADER, intent),
        ),
    )
    connector_intent.capture_and_strip(flow)

    with mitm_ctx(registry_path=str(registry_path), api_url=_API_URL):
        classification = request_classification.classify_request(
            flow,
            registry_path=str(registry_path),
            api_url=_API_URL,
            tls_admission=None,
        )

    assert isinstance(classification, request_classification.FirewallBlock)
    assert classification.firewall_block.name == "active"
    assert classification.firewall_block.reason == "permission_denied"
    assert _CONNECTOR_INTENT_HEADER not in flow.request.headers


def test_omitted_connector_intent_without_active_owner_uses_ordinary_fallback(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
):
    sandbox = _sandbox_without_firewalls(
        tmp_path,
        sandbox_fields={"omittedBuiltinFirewalls": ["removed-builtin"]},
    )
    registry_path = _write_registry(tmp_path, client_ip=_CLIENT_IP, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="unowned.example.com",
        path="/items",
        request_headers=headers(
            ("Host", "unowned.example.com"),
            (_CONNECTOR_INTENT_HEADER, "removed-builtin"),
        ),
    )
    connector_intent.capture_and_strip(flow)

    with mitm_ctx(registry_path=str(registry_path), api_url=_API_URL):
        classification = request_classification.classify_request(
            flow,
            registry_path=str(registry_path),
            api_url=_API_URL,
            tls_admission=None,
        )

    assert isinstance(classification, request_classification.Allow)
    assert _CONNECTOR_INTENT_HEADER not in flow.request.headers


@pytest.mark.parametrize(
    ("intent_headers", "reason"),
    [
        (((_CONNECTOR_INTENT_HEADER, "not-omitted"),), "connector_intent_not_candidate"),
        (
            (
                (_CONNECTOR_INTENT_HEADER, "first"),
                (_CONNECTOR_INTENT_HEADER, "second"),
            ),
            "malformed_connector_intent",
        ),
        ((), "connector_intent_required"),
    ],
    ids=["present-no-match", "malformed", "absent"],
)
def test_non_omitted_intent_continues_to_firewall_classification(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
    intent_headers,
    reason,
):
    sandbox = _shared_route_sandbox(tmp_path)
    sandbox["omittedBuiltinFirewalls"] = ["removed-builtin"]
    sandbox["omittedCustomConnectorIds"] = ["removed-custom"]
    registry_path = _write_registry(tmp_path, client_ip=_CLIENT_IP, sandbox_info=sandbox)
    flow = real_flow(
        with_response=False,
        client_ip=_CLIENT_IP,
        host="shared.example.com",
        path="/items/123",
        request_headers=headers(("Host", "shared.example.com"), *intent_headers),
    )
    connector_intent.capture_and_strip(flow)

    with mitm_ctx(registry_path=str(registry_path), api_url=_API_URL):
        classification = request_classification.classify_request(
            flow,
            registry_path=str(registry_path),
            api_url=_API_URL,
            tls_admission=None,
        )

    assert isinstance(classification, request_classification.FirewallAmbiguous)
    assert classification.firewall_ambiguous.reason == reason


def test_omitted_connector_lookup_allocation_does_not_scale_with_target_count(
    tmp_path,
    real_flow,
    mitm_ctx,
    headers,
):
    peak_by_target_count: dict[int, int] = {}

    for target_count in (1, 10_000):
        registry_dir = tmp_path / f"targets-{target_count}"
        registry_dir.mkdir()
        omitted_custom = [f"omitted-{index}" for index in range(target_count)]
        sandbox = _sandbox_without_firewalls(
            registry_dir,
            sandbox_fields={"omittedCustomConnectorIds": omitted_custom},
        )
        registry_path = _write_registry(
            registry_dir,
            client_ip=_CLIENT_IP,
            sandbox_info=sandbox,
        )

        def new_flow():
            flow = real_flow(
                with_response=False,
                client_ip=_CLIENT_IP,
                host="target.example.com",
                path="/items",
                request_headers=headers(
                    ("Host", "target.example.com"),
                    (_CONNECTOR_INTENT_HEADER, "not-omitted"),
                ),
            )
            connector_intent.capture_and_strip(flow)
            return flow

        with mitm_ctx(registry_path=str(registry_path), api_url=_API_URL):
            warm_classification = request_classification.classify_request(
                new_flow(),
                registry_path=str(registry_path),
                api_url=_API_URL,
                tls_admission=None,
            )
            assert isinstance(warm_classification, request_classification.Allow)

            measured_flow = new_flow()
            tracemalloc.start()
            try:
                classification = request_classification.classify_request(
                    measured_flow,
                    registry_path=str(registry_path),
                    api_url=_API_URL,
                    tls_admission=None,
                )
                peak_by_target_count[target_count] = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()

        assert isinstance(classification, request_classification.Allow)

    assert peak_by_target_count[10_000] <= peak_by_target_count[1] + 16 * 1024
