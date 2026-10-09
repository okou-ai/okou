"""Integration coverage for Codex model catalog cache entry lifecycle."""

import asyncio
import json
from unittest.mock import patch

from mitmproxy import http
from mitmproxy.flow import Error

import codex_model_catalog_cache as catalog_cache
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    CATALOG_ETAG,
    catalog_flow,
    catalog_response,
    finish_response,
    install_catalog,
    prepare_miss,
    responses_flow,
)


async def test_fresh_hit_is_partitioned_and_expiry_never_uses_conditions(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        cold = catalog_flow(real_flow)
        assert await install_catalog(cold) == {
            "model_catalog_cache_status": "model_catalog_cold_stored",
            "model_catalog_cache_validation_latency_ms": 0,
            "model_catalog_cache_upstream_encoding": "identity",
        }

        monotonic.return_value = 150.0
        hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.status_code == 200
        assert hit.response.content == CATALOG_BODY
        assert hit.response.headers["ETag"] == CATALOG_ETAG
        assert "Content-Encoding" not in hit.response.headers
        mitm_addon.responseheaders(hit)
        assert hit.response.stream is False
        hit_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(hit, hit_telemetry)
        assert hit_telemetry == {
            "model_catalog_cache_status": "model_catalog_fresh_hit",
            "model_catalog_cache_entry_age_ms": 50_000,
        }

        isolated_flows = [
            catalog_flow(real_flow, auth_value="auth-b"),
            catalog_flow(real_flow, account="account-b"),
            catalog_flow(real_flow, version="0.146.0"),
        ]
        for isolated in isolated_flows:
            await prepare_miss(isolated)

        monotonic.return_value = 161.0
        expired = catalog_flow(real_flow)
        await prepare_miss(expired)

        for flow in (*isolated_flows, expired):
            catalog_cache.handle_error(flow)


async def test_distinct_credential_tuples_with_equal_concatenation_are_partitioned(real_flow):
    await install_catalog(catalog_flow(real_flow, auth_value="a", account="bc"))

    distinct_tuple = catalog_flow(real_flow, auth_value="ab", account="c")
    await prepare_miss(distinct_tuple)
    catalog_cache.handle_error(distinct_tuple)


async def test_transport_error_after_expiry_never_serves_old_entry(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await install_catalog(catalog_flow(real_flow))
        monotonic.return_value = 161.0
        flow = catalog_flow(real_flow)
        await prepare_miss(flow)
        flow.error = Error("upstream reset")

        catalog_cache.handle_error(flow)

        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(flow, telemetry)
        assert telemetry == {
            "model_catalog_cache_status": "model_catalog_cold_not_stored",
            "model_catalog_cache_bypass_reason": "transport_error",
            "model_catalog_cache_entry_age_ms": 61_000,
            "model_catalog_cache_validation_latency_ms": 0,
        }
        assert flow.response is None

        retry = catalog_flow(real_flow)
        await prepare_miss(retry)
        catalog_cache.handle_error(retry)


async def test_authenticated_models_etag_renews_only_confirmed_credential_until_deadline(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await install_catalog(catalog_flow(real_flow))
        await install_catalog(catalog_flow(real_flow, auth_value="auth-b"))

        monotonic.return_value = 150.0
        confirmation = responses_flow(real_flow)
        mitm_addon.responseheaders(confirmation)

        # Both original entries expire at t=160; only the confirmed credential is renewed.
        monotonic.return_value = 161.0
        confirmed_hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(confirmed_hit, request_end_stream=True)
        assert confirmed_hit.response is not None
        assert confirmed_hit.response.status_code == 200
        assert confirmed_hit.response.content == CATALOG_BODY
        assert confirmed_hit.response.headers["ETag"] == CATALOG_ETAG

        other_credential = catalog_flow(real_flow, auth_value="auth-b")
        await prepare_miss(other_credential)
        catalog_cache.handle_error(other_credential)

        # The hit at t=161 must not extend the renewed deadline of t=210.
        monotonic.return_value = 210.0
        expired = catalog_flow(real_flow)
        await prepare_miss(expired)
        catalog_cache.handle_error(expired)


async def test_authenticated_models_etag_confirmation_and_partitioned_invalidation(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await install_catalog(catalog_flow(real_flow))
        await install_catalog(catalog_flow(real_flow, auth_value="auth-b"))
        await install_catalog(
            catalog_flow(real_flow, version="0.144.0"),
            etag='"catalog-legacy"',
        )

        monotonic.return_value = 150.0
        confirmation = responses_flow(real_flow)
        mitm_addon.responseheaders(confirmation)
        confirmation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(confirmation, confirmation_telemetry)
        assert confirmation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_confirmed",
            "model_catalog_cache_entry_age_ms": 50_000,
        }

        confirmed_hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(confirmed_hit, request_end_stream=True)
        assert confirmed_hit.response is not None

        invalidated_version = catalog_flow(real_flow, version="0.144.0")
        await prepare_miss(invalidated_version)
        catalog_cache.handle_error(invalidated_version)

        invalidation = responses_flow(real_flow, etag='"catalog-v2"')
        mitm_addon.responseheaders(invalidation)
        invalidation_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(invalidation, invalidation_telemetry)
        assert invalidation_telemetry == {
            "model_catalog_cache_status": "model_catalog_etag_invalidated",
        }

        invalidated = catalog_flow(real_flow)
        await prepare_miss(invalidated)
        catalog_cache.handle_error(invalidated)

        other_credential = catalog_flow(real_flow, auth_value="auth-b")
        await catalog_cache.prepare_request(other_credential, request_end_stream=True)
        assert other_credential.response is not None


async def test_failed_responses_etag_does_not_invalidate_catalog(real_flow):
    await install_catalog(catalog_flow(real_flow))

    failed_response = responses_flow(real_flow, etag='"catalog-v2"', status=401)
    mitm_addon.responseheaders(failed_response)

    hit = catalog_flow(real_flow)
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(failed_response, telemetry)
    assert telemetry == {}


async def test_non_utf8_authenticated_models_etag_does_not_change_entry(real_flow):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await install_catalog(catalog_flow(real_flow))

        monotonic.return_value = 150.0
        signal = responses_flow(real_flow)
        assert signal.response is not None
        signal.response.headers = http.Headers(
            [
                (b"Content-Type", b"text/event-stream"),
                (b"x-models-etag", b'"\xff"'),
            ]
        )

        mitm_addon.responseheaders(signal)

        signal_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(signal, signal_telemetry)
        assert signal_telemetry == {}
        preserved_hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(preserved_hit, request_end_stream=True)
        assert preserved_hit.response is not None
        assert preserved_hit.response.content == CATALOG_BODY

        monotonic.return_value = 161.0
        expired = catalog_flow(real_flow)
        await prepare_miss(expired)
        catalog_cache.handle_error(expired)


async def test_non_utf8_authenticated_models_etag_does_not_change_in_flight_owner(real_flow):
    owner = catalog_flow(real_flow, version="invalid-signal-owner")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="invalid-signal-owner")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    signal = responses_flow(real_flow)
    assert signal.response is not None
    signal.response.headers = http.Headers(
        [
            (b"Content-Type", b"text/event-stream"),
            (b"x-models-etag", b'"\xff"'),
        ]
    )

    mitm_addon.responseheaders(signal)

    await asyncio.sleep(0)
    assert not follower_prepare.done()
    signal_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(signal, signal_telemetry)
    assert signal_telemetry == {}

    owner_body = b'{"models":[{"slug":"unaffected-owner"}]}'
    owner.response = catalog_response(body=owner_body)
    assert (await finish_response(owner))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )
    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is not None
    assert follower.response.content == owner_body


async def test_fresh_hit_changes_count_bound_eviction_order(real_flow):
    small_body = b'{"models":[]}'
    for index in range(catalog_cache.MAX_ENTRIES):
        await install_catalog(
            catalog_flow(real_flow, version=f"lru-{index}"),
            body=small_body,
            etag=f'"lru-{index}"',
        )

    recently_used = catalog_flow(real_flow, version="lru-0")
    await catalog_cache.prepare_request(recently_used, request_end_stream=True)
    assert recently_used.response is not None

    await install_catalog(
        catalog_flow(real_flow, version="lru-overflow"),
        body=small_body,
        etag='"lru-overflow"',
    )

    untouched = catalog_flow(real_flow, version="lru-1")
    await prepare_miss(untouched)
    catalog_cache.handle_error(untouched)

    retained = catalog_flow(real_flow, version="lru-0")
    await catalog_cache.prepare_request(retained, request_end_stream=True)
    assert retained.response is not None


async def test_count_and_byte_bounds_evict_least_recent_entries(real_flow):
    small_body = b'{"models":[]}'
    for index in range(catalog_cache.MAX_ENTRIES + 1):
        await install_catalog(
            catalog_flow(real_flow, version=f"count-{index}"),
            body=small_body,
            etag=f'"count-{index}"',
        )

    count_oldest = catalog_flow(real_flow, version="count-0")
    await prepare_miss(count_oldest)
    catalog_cache.handle_error(count_oldest)
    count_newest = catalog_flow(real_flow, version=f"count-{catalog_cache.MAX_ENTRIES}")
    await catalog_cache.prepare_request(count_newest, request_end_stream=True)
    assert count_newest.response is not None

    catalog_cache.reset_for_tests()
    large_padding = "x" * (catalog_cache.MAX_ENTRY_BYTES - 64)
    large_body = json.dumps({"models": [], "padding": large_padding}).encode()
    assert len(large_body) <= catalog_cache.MAX_ENTRY_BYTES
    entry_count = catalog_cache.MAX_TOTAL_BYTES // len(large_body) + 1
    for index in range(entry_count):
        await install_catalog(
            catalog_flow(real_flow, version=f"bytes-{index}"),
            body=large_body,
            etag=f'"bytes-{index}"',
        )

    byte_oldest = catalog_flow(real_flow, version="bytes-0")
    await prepare_miss(byte_oldest)
    catalog_cache.handle_error(byte_oldest)
    byte_newest = catalog_flow(real_flow, version=f"bytes-{entry_count - 1}")
    await catalog_cache.prepare_request(byte_newest, request_end_stream=True)
    assert byte_newest.response is not None
