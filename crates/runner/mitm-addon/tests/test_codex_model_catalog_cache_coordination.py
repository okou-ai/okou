"""Integration coverage for Codex model catalog cache request coordination."""

import asyncio
from unittest.mock import patch

import pytest
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


async def test_singleflight_delivers_owner_response_to_follower(real_flow):
    first = catalog_flow(real_flow, version="concurrent")
    second = catalog_flow(real_flow, version="concurrent")
    await prepare_miss(first)
    second_prepare = asyncio.create_task(
        catalog_cache.prepare_request(second, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not second_prepare.done()
    assert second.request.headers["Accept-Encoding"] == "identity"

    first_body = b'{"models":[{"slug":"first"}]}'
    first.response = catalog_response(body=first_body)
    assert (await finish_response(first))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )
    await second_prepare
    assert second.response is not None
    assert second.response.content == first_body
    second_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(second, second_telemetry)
    assert second_telemetry["model_catalog_cache_status"] == "model_catalog_fresh_hit"

    hit = catalog_flow(real_flow, version="concurrent")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == first_body


async def test_prefetch_marker_is_stripped_and_roles_distinguish_consumers(real_flow):
    prefetch = catalog_flow(
        real_flow,
        version="prefetched",
        extra_headers={"X-Okou-Codex-Model-Catalog-Prefetch": "1"},
    )
    catalog_cache.capture_and_strip_prefetch_marker(prefetch)
    assert "X-Okou-Codex-Model-Catalog-Prefetch" not in prefetch.request.headers
    await prepare_miss(prefetch, expected_encoding="br")

    in_flight_consumer = catalog_flow(real_flow, version="prefetched")
    consumer_prepare = asyncio.create_task(
        catalog_cache.prepare_request(in_flight_consumer, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not consumer_prepare.done()

    prefetch.response = catalog_response(encoding="br")
    prefetch_telemetry = await finish_response(prefetch)
    assert prefetch_telemetry["model_catalog_prefetch_role"] == "producer"

    await consumer_prepare
    in_flight_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(in_flight_consumer, in_flight_telemetry)
    assert in_flight_telemetry["model_catalog_prefetch_role"] == "inflight_consumer"

    completed_consumer = catalog_flow(real_flow, version="prefetched")
    await catalog_cache.prepare_request(completed_consumer, request_end_stream=True)
    completed_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(completed_consumer, completed_telemetry)
    assert completed_telemetry["model_catalog_prefetch_role"] == "completed_consumer"
    catalog_cache.release_flow_state(prefetch)
    assert "_codex_model_catalog_prefetch_request" not in prefetch.metadata


async def test_failed_prefetch_releases_consumer_to_retry_upstream(real_flow):
    prefetch = catalog_flow(
        real_flow,
        version="prefetch-failure",
        extra_headers={"X-Okou-Codex-Model-Catalog-Prefetch": "1"},
    )
    catalog_cache.capture_and_strip_prefetch_marker(prefetch)
    await prepare_miss(prefetch, expected_encoding="br")

    consumer = catalog_flow(real_flow, version="prefetch-failure")
    consumer_prepare = asyncio.create_task(
        catalog_cache.prepare_request(consumer, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not consumer_prepare.done()

    prefetch.error = Error("upstream reset")
    catalog_cache.handle_error(prefetch)
    await consumer_prepare

    assert consumer.response is None
    assert consumer.request.headers["Accept-Encoding"] == "identity"
    consumer_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(consumer, consumer_telemetry)
    assert consumer_telemetry == {}
    catalog_cache.handle_error(consumer)


async def test_non_cacheable_identity_headers_release_singleflight_follower(real_flow):
    owner = catalog_flow(real_flow, version="identity-header-bypass")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="identity-header-bypass")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = catalog_response(
        encoding="identity",
        headers={"Cache-Control": "no-store"},
    )
    mitm_addon.responseheaders(owner)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    owner_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(owner, owner_telemetry)
    validation_latency = owner_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert owner_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": "response_cache_control",
        "model_catalog_cache_upstream_encoding": "identity",
    }
    catalog_cache.handle_error(follower)


@pytest.mark.parametrize(
    ("content_type", "etag", "reason"),
    [
        pytest.param(
            b"application/json",
            b'"\xff"',
            "response_etag",
            id="etag",
        ),
        pytest.param(
            b"application/\xffjson",
            CATALOG_ETAG.encode(),
            "response_content_type",
            id="content-type",
        ),
    ],
)
async def test_non_utf8_identity_headers_release_singleflight_follower(
    real_flow,
    content_type: bytes,
    etag: bytes,
    reason: str,
):
    version = f"non-utf8-{reason}"
    owner = catalog_flow(real_flow, version=version)
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version=version)
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = catalog_response()
    upstream_body = owner.response.raw_content
    owner.response.headers = http.Headers(
        [
            (b"Content-Type", content_type),
            (b"Content-Length", str(len(CATALOG_BODY)).encode()),
            (b"ETag", etag),
        ]
    )

    mitm_addon.responseheaders(owner)

    assert owner.response.status_code == 200
    assert owner.response.raw_content == upstream_body
    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"

    capacity_owners = [
        catalog_flow(real_flow, version=f"{version}-capacity-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS - 1)
    ]
    for capacity_owner in capacity_owners:
        await prepare_miss(capacity_owner)
        capacity_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(capacity_owner, capacity_telemetry)
        assert capacity_telemetry == {}
    for capacity_owner in capacity_owners:
        catalog_cache.handle_error(capacity_owner)

    owner_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(owner, owner_telemetry)
    validation_latency = owner_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert owner_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": reason,
        "model_catalog_cache_upstream_encoding": "identity",
    }

    follower_body = b'{"models":[{"slug":"replacement"}]}'
    follower.response = catalog_response(body=follower_body)
    assert (await finish_response(follower))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )

    hit = catalog_flow(real_flow, version=version)
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == follower_body


async def test_unsolicited_encoded_response_releases_follower_as_identity_owner(real_flow):
    owner = catalog_flow(real_flow, version="encoded-owner")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="encoded-owner")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = catalog_response(encoding="br")
    mitm_addon.responseheaders(owner)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert owner.response.status_code == 502
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    catalog_cache.handle_error(follower)


async def test_released_owner_wakes_singleflight_follower(real_flow):
    owner = catalog_flow(real_flow, version="released-owner")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="released-owner")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    catalog_cache.release_flow_state(owner)
    await follower_prepare

    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    catalog_cache.handle_error(follower)


async def test_cancelled_follower_does_not_cancel_singleflight_owner(real_flow):
    owner = catalog_flow(real_flow, version="cancelled-follower")
    await prepare_miss(owner)

    cancelled_follower = asyncio.create_task(
        catalog_cache.prepare_request(
            catalog_flow(real_flow, version="cancelled-follower"),
            request_end_stream=True,
        )
    )
    await asyncio.sleep(0)
    cancelled_follower.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled_follower

    surviving_follower = catalog_flow(real_flow, version="cancelled-follower")
    surviving_prepare = asyncio.create_task(
        catalog_cache.prepare_request(surviving_follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not surviving_prepare.done()

    owner.response = catalog_response()
    await finish_response(owner)
    await surviving_prepare
    assert surviving_follower.response is not None
    assert surviving_follower.response.content == CATALOG_BODY


async def test_singleflight_wait_is_bounded_without_canceling_owner(real_flow):
    owner = catalog_flow(real_flow, version="bounded-wait")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="bounded-wait")

    with patch.object(catalog_cache, "MAX_IN_FLIGHT_WAIT_SECONDS", 0):
        await catalog_cache.prepare_request(follower, request_end_stream=True)

    follower_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(follower, follower_telemetry)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    assert follower_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    owner.response = catalog_response()
    await finish_response(owner)
    hit = catalog_flow(real_flow, version="bounded-wait")
    await catalog_cache.prepare_request(hit, request_end_stream=True)
    assert hit.response is not None
    assert hit.response.content == CATALOG_BODY


async def test_singleflight_wait_deadline_spans_replacement_owners(real_flow):
    with patch.object(catalog_cache, "time") as cache_time:
        cache_time.monotonic.return_value = 100.0
        first_owner = catalog_flow(real_flow, version="bounded-retry")
        await prepare_miss(first_owner)
        follower = catalog_flow(real_flow, version="bounded-retry")
        follower_prepare = asyncio.create_task(
            catalog_cache.prepare_request(follower, request_end_stream=True)
        )
        await asyncio.sleep(0)
        assert not follower_prepare.done()

        catalog_cache.handle_error(first_owner)
        replacement_owner = catalog_flow(real_flow, version="bounded-retry")
        await prepare_miss(replacement_owner)
        cache_time.monotonic.return_value = 100.0 + catalog_cache.MAX_IN_FLIGHT_WAIT_SECONDS

        await asyncio.wait_for(follower_prepare, timeout=0.1)
        follower_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(follower, follower_telemetry)
        assert follower.response is None
        assert follower.request.headers["Accept-Encoding"] == "identity"
        assert follower_telemetry == {
            "model_catalog_cache_status": "model_catalog_bypass",
            "model_catalog_cache_bypass_reason": "request_capacity",
        }
        catalog_cache.handle_error(replacement_owner)


async def test_singleflight_rechecks_entry_after_etag_invalidation(real_flow):
    owner = catalog_flow(real_flow, version="invalidated-inflight")
    await prepare_miss(owner)
    follower = catalog_flow(real_flow, version="invalidated-inflight")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    owner.response = catalog_response()
    await finish_response(owner)
    invalidation = responses_flow(real_flow, etag='"catalog-v2"')
    mitm_addon.responseheaders(invalidation)

    await asyncio.wait_for(follower_prepare, timeout=0.1)
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"
    catalog_cache.handle_error(follower)


async def test_etag_signal_supersedes_in_flight_owner_and_releases_follower(real_flow):
    superseded_owner = catalog_flow(real_flow, version="superseded-owner")
    matching_owner = catalog_flow(real_flow, version="matching-owner")
    isolated_owner = catalog_flow(
        real_flow,
        version="isolated-owner",
        auth_value="auth-b",
    )
    for owner in (superseded_owner, matching_owner, isolated_owner):
        await prepare_miss(owner)

    follower = catalog_flow(real_flow, version="superseded-owner")
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    await asyncio.sleep(0)
    assert not follower_prepare.done()

    signal = responses_flow(real_flow, etag='"catalog-v2"')
    mitm_addon.responseheaders(signal)

    matching_body = b'{"models":[{"slug":"matching"}]}'
    matching_owner.response = catalog_response(
        body=matching_body,
        etag='"catalog-v2"',
        encoding="identity",
    )
    assert (await finish_response(matching_owner))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )

    isolated_body = b'{"models":[{"slug":"isolated"}]}'
    isolated_owner.response = catalog_response(
        body=isolated_body,
        etag='"catalog-v1"',
        encoding="identity",
    )
    assert (await finish_response(isolated_owner))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )

    superseded_owner.response = catalog_response(etag='"catalog-v1"')
    superseded_telemetry = await finish_response(superseded_owner)
    await asyncio.wait_for(follower_prepare, timeout=0.1)

    validation_latency = superseded_telemetry.pop("model_catalog_cache_validation_latency_ms")
    assert isinstance(validation_latency, int)
    assert validation_latency >= 0
    assert superseded_telemetry == {
        "model_catalog_cache_status": "model_catalog_cold_not_stored",
        "model_catalog_cache_bypass_reason": "concurrent_change",
        "model_catalog_cache_upstream_encoding": "identity",
    }
    assert follower.response is None
    assert follower.request.headers["Accept-Encoding"] == "identity"

    replacement_body = b'{"models":[{"slug":"replacement"}]}'
    follower.response = catalog_response(
        body=replacement_body,
        etag='"catalog-v2"',
        encoding="identity",
    )
    assert (await finish_response(follower))["model_catalog_cache_status"] == (
        "model_catalog_cold_stored"
    )

    expected_hits = (
        (catalog_flow(real_flow, version="superseded-owner"), replacement_body),
        (catalog_flow(real_flow, version="matching-owner"), matching_body),
        (
            catalog_flow(
                real_flow,
                version="isolated-owner",
                auth_value="auth-b",
            ),
            isolated_body,
        ),
    )
    for hit, expected_body in expected_hits:
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == expected_body


async def test_singleflight_waiter_bound_bypasses_excess_requests(real_flow):
    owner = catalog_flow(real_flow, version="waiter-capacity")
    await prepare_miss(owner)
    waiters = [
        asyncio.create_task(
            catalog_cache.prepare_request(
                catalog_flow(real_flow, version="waiter-capacity"),
                request_end_stream=True,
            )
        )
        for _ in range(catalog_cache.MAX_WAITERS_PER_KEY)
    ]
    await asyncio.sleep(0)
    assert all(not waiter.done() for waiter in waiters)

    overflow = catalog_flow(real_flow, version="waiter-capacity")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }

    for waiter in waiters:
        waiter.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    catalog_cache.handle_error(owner)


async def test_singleflight_total_waiter_bound_spans_catalog_keys(real_flow):
    owner_count = catalog_cache.MAX_TOTAL_WAITERS // catalog_cache.MAX_WAITERS_PER_KEY + 1
    overflow_owner_index = owner_count - 1
    assert catalog_cache.MAX_TOTAL_WAITERS // owner_count < catalog_cache.MAX_WAITERS_PER_KEY
    owners = [
        catalog_flow(real_flow, version=f"total-waiter-capacity-{index}")
        for index in range(owner_count)
    ]
    for owner in owners:
        await prepare_miss(owner)

    waiters = [
        asyncio.create_task(
            catalog_cache.prepare_request(
                catalog_flow(
                    real_flow,
                    version=f"total-waiter-capacity-{index % owner_count}",
                ),
                request_end_stream=True,
            )
        )
        for index in range(catalog_cache.MAX_TOTAL_WAITERS)
    ]
    overflow = catalog_flow(
        real_flow,
        version=f"total-waiter-capacity-{overflow_owner_index}",
    )
    overflow_prepare = asyncio.create_task(
        catalog_cache.prepare_request(overflow, request_end_stream=True)
    )
    tasks = [*waiters, overflow_prepare]
    try:
        await asyncio.sleep(0)
        assert all(not waiter.done() for waiter in waiters)
        assert overflow_prepare.done()
        assert not await overflow_prepare

        overflow_telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
        assert overflow_telemetry == {
            "model_catalog_cache_status": "model_catalog_bypass",
            "model_catalog_cache_bypass_reason": "request_capacity",
        }
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for owner in owners:
            catalog_cache.handle_error(owner)


async def test_in_flight_capacity_bypasses_without_changing_request_encoding(real_flow):
    active_flows = [
        catalog_flow(real_flow, version=f"active-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS)
    ]
    for flow in active_flows:
        await prepare_miss(flow)

    overflow = catalog_flow(real_flow, version="overflow")
    await catalog_cache.prepare_request(overflow, request_end_stream=True)
    overflow_telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(overflow, overflow_telemetry)
    assert overflow_telemetry == {
        "model_catalog_cache_status": "model_catalog_bypass",
        "model_catalog_cache_bypass_reason": "request_capacity",
    }
    assert overflow.request.headers["Accept-Encoding"] == "identity"

    catalog_cache.handle_error(active_flows.pop())
    admitted = catalog_flow(real_flow, version="admitted")
    telemetry = await install_catalog(admitted)
    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"

    for flow in active_flows:
        catalog_cache.handle_error(flow)
