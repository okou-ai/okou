"""Tests for firewall auth cache behavior."""

import asyncio
import gc
import json
import threading
import time
import urllib.error
from collections.abc import Coroutine
from typing import Never
from unittest.mock import AsyncMock, patch

import pytest

import firewall_auth_cache as auth_cache
import registry as registry_cache
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import (
    auth_cache_key,
    auth_state_snapshot,
    cached_headers,
    force_refresh_pending,
    has_auth_state,
    last_force_refresh_monotonic_at,
    mark_force_refresh,
    require_cached_headers,
    require_last_force_refresh_monotonic_at,
    set_cached_headers,
    set_last_force_refresh_monotonic_at,
)
from tests.firewall_auth_helpers import firewall_auth_request, firewall_auth_success
from tests.firewall_helpers import cancel_pending_task


class TestFirewallHeaderCache:
    """Tests for get_firewall_headers caching and concurrency protection."""

    async def test_concurrent_fetches_coalesce(self, mitm_ctx):
        """Multiple concurrent get_firewall_headers calls should make only one HTTP request."""
        endpoint = FakeAuthEndpoint()
        release_response = threading.Event()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token"},
                expires_at=time.time() + 3600,
            ),
            release_event=release_response,
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            started = [asyncio.Event() for _ in range(3)]
            cache_key = auth_cache_key()
            auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})

            async def fetch_headers(started_event: asyncio.Event) -> dict:
                started_event.set()
                return await auth_cache.get_firewall_headers(cache_key, auth_request)

            tasks = [asyncio.create_task(fetch_headers(started_event)) for started_event in started]
            try:
                await asyncio.gather(*(started_event.wait() for started_event in started))
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                assert endpoint.request_count == 1
                release_response.set()
                results = await asyncio.gather(*tasks)
            finally:
                release_response.set()
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 1
        assert endpoint.requests[0].path == "/api/webhooks/agent/firewall/auth"
        for result in results:
            assert result["headers"] == {"Authorization": "Bearer token"}
            assert "cache_hit" in result
            assert type(result["cache_hit"]) is bool
        cache_hit_flags = [result["cache_hit"] for result in results]
        assert sum(flag is False for flag in cache_hit_flags) == 1
        assert sum(flag is True for flag in cache_hit_flags) == 2
        assert all(
            result["cache_entry_identity"] is results[0]["cache_entry_identity"]
            for result in results
        )
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer token"}

    async def test_cancelled_force_refresh_leader_keeps_shared_fetch(self, mitm_ctx):
        """A cancelled leader must leave its shared forced fetch available to a waiter."""
        endpoint = FakeAuthEndpoint()
        release_response = threading.Event()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer refreshed"},
                expires_at=time.time() + 3600,
            ),
            release_event=release_response,
        )
        cache_key = auth_cache_key()
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
        mark_force_refresh(cache_key)
        before_fetch = time.monotonic()

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            leader = asyncio.create_task(auth_cache.get_firewall_headers(cache_key, auth_request))
            waiter = None
            try:
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                leader.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await leader

                waiter_started = asyncio.Event()

                async def wait_for_headers() -> dict:
                    waiter_started.set()
                    return await auth_cache.get_firewall_headers(cache_key, auth_request)

                waiter = asyncio.create_task(wait_for_headers())
                await waiter_started.wait()
                release_response.set()
                result = await waiter
            finally:
                release_response.set()
                tasks = [task for task in (leader, waiter) if task is not None]
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 1
        assert endpoint.requests[0].json_body()["forceRefresh"] is True
        assert result["headers"] == {"Authorization": "Bearer refreshed"}
        assert result["cache_hit"] is True
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer refreshed"}
        assert not force_refresh_pending(cache_key)
        assert require_last_force_refresh_monotonic_at(cache_key) >= before_fetch

    async def test_cancelled_leader_shared_failure_allows_later_retry(self, mitm_ctx):
        """A failed surviving fetch must fail its waiter and leave the key retryable."""
        endpoint = FakeAuthEndpoint()
        release_failure = threading.Event()
        endpoint.queue_response(500, body=b"not-json", release_event=release_failure)
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer retry"},
                expires_at=time.time() + 3600,
            )
        )
        cache_key = auth_cache_key()
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            leader = asyncio.create_task(auth_cache.get_firewall_headers(cache_key, auth_request))
            waiter = None
            try:
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                leader.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await leader

                waiter_started = asyncio.Event()

                async def wait_for_headers() -> dict:
                    waiter_started.set()
                    return await auth_cache.get_firewall_headers(cache_key, auth_request)

                waiter = asyncio.create_task(wait_for_headers())
                await waiter_started.wait()
                release_failure.set()
                with pytest.raises(urllib.error.HTTPError):
                    await waiter

                assert endpoint.request_count == 1
                assert cached_headers(cache_key) is None

                retry = await auth_cache.get_firewall_headers(cache_key, auth_request)
            finally:
                release_failure.set()
                tasks = [task for task in (leader, waiter) if task is not None]
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert endpoint.request_count == 2
        assert retry["headers"] == {"Authorization": "Bearer retry"}
        assert retry["cache_hit"] is False
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer retry"}

    async def test_task_startup_failure_rolls_back_admission_and_allows_retry(self, recwarn):
        cache_key = auth_cache_key()
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
        task_factory_error = RuntimeError("task factory failed")

        def reject_task_creation(coroutine: Coroutine[object, object, object]) -> Never:
            raise task_factory_error

        with (
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 1),
            patch.object(auth_cache.asyncio, "create_task", new=reject_task_creation),
            pytest.raises(RuntimeError) as exc_info,
        ):
            await auth_cache.get_firewall_headers(cache_key, auth_request)

        assert exc_info.value is task_factory_error
        task_factory_error.__traceback__ = None
        del exc_info
        gc.collect()
        assert not any(
            warning.category is RuntimeWarning and "was never awaited" in str(warning.message)
            for warning in recwarn
        )
        assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0
        failed_state = auth_state_snapshot(cache_key)
        assert failed_state is not None
        assert not failed_state.has_in_flight_fetch

        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(headers={"Authorization": "Bearer recovered"})
        )
        with (
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 1),
            patch.object(auth_cache, "fetch_firewall_headers", mock_fetch),
        ):
            result = await auth_cache.get_firewall_headers(cache_key, auth_request)

        assert result["headers"] == {"Authorization": "Bearer recovered"}
        assert result["cache_hit"] is False
        assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0
        recovered_state = auth_state_snapshot(cache_key)
        assert recovered_state is not None
        assert not recovered_state.has_in_flight_fetch

    async def test_force_refresh_task_startup_failure_preserves_refresh_for_retry(self):
        cache_key = auth_cache_key()
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
        set_last_force_refresh_monotonic_at(cache_key, 1000.0)
        mark_force_refresh(cache_key)
        task_factory_error = RuntimeError("task factory failed")

        def reject_task_creation(coroutine: Coroutine[object, object, object]) -> Never:
            raise task_factory_error

        with (
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 1),
            patch.object(auth_cache.time, "monotonic", return_value=2000.0),
            patch.object(auth_cache.asyncio, "create_task", new=reject_task_creation),
            pytest.raises(RuntimeError) as exc_info,
        ):
            await auth_cache.get_firewall_headers(cache_key, auth_request)

        assert exc_info.value is task_factory_error
        assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0
        failed_state = auth_state_snapshot(cache_key)
        assert failed_state is not None
        assert not failed_state.has_in_flight_fetch
        assert failed_state.force_refresh_pending
        assert failed_state.last_force_refresh_monotonic_at == 1000.0

        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(headers={"Authorization": "Bearer refreshed"})
        )
        with (
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 1),
            patch.object(auth_cache.time, "monotonic", return_value=3000.0),
            patch.object(auth_cache, "fetch_firewall_headers", mock_fetch),
        ):
            result = await auth_cache.get_firewall_headers(cache_key, auth_request)

        assert result["headers"] == {"Authorization": "Bearer refreshed"}
        assert result["cache_hit"] is False
        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0
        recovered_state = auth_state_snapshot(cache_key)
        assert recovered_state is not None
        assert not recovered_state.has_in_flight_fetch
        assert not recovered_state.force_refresh_pending
        assert recovered_state.last_force_refresh_monotonic_at == 3000.0

    async def test_different_keys_fetch_independently(self, mitm_ctx):
        """Different auth cache keys should fetch independently."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-1"},
                expires_at=time.time() + 3600,
            )
        )
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-2"},
                expires_at=time.time() + 3600,
            )
        )

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            first_key = auth_cache_key(api_id="api-1")
            second_key = auth_cache_key(api_id="api-2")
            auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
            first, second = await asyncio.gather(
                auth_cache.get_firewall_headers(first_key, auth_request),
                auth_cache.get_firewall_headers(second_key, auth_request),
            )

        assert endpoint.request_count == 2
        assert first["cache_hit"] is False
        assert second["cache_hit"] is False
        cached_tokens = {
            require_cached_headers(cache_key).headers["Authorization"]
            for cache_key in (first_key, second_key)
        }
        assert cached_tokens == {"Bearer token-1", "Bearer token-2"}

    async def test_distinct_fetch_admission_bounds_active_and_waiting_work(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        release_first = threading.Event()
        release_second = threading.Event()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-1"},
                expires_at=time.time() + 3600,
            ),
            release_event=release_first,
        )
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-2"},
                expires_at=time.time() + 3600,
            ),
            release_event=release_second,
        )
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer token-3"},
                expires_at=time.time() + 3600,
            )
        )
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
        first_key = auth_cache_key(api_id="api-1")
        second_key = auth_cache_key(api_id="api-2")
        third_key = auth_cache_key(api_id="api-3")
        mark_force_refresh(third_key)

        tasks: list[asyncio.Task[dict]] = []
        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth_cache, "MAX_CONCURRENT_FIREWALL_AUTH_FETCHES", 1),
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 2),
        ):
            first = asyncio.create_task(auth_cache.get_firewall_headers(first_key, auth_request))
            tasks.append(first)
            try:
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)

                follower_started = asyncio.Event()
                second_started = asyncio.Event()

                async def fetch_after_start(
                    started: asyncio.Event, cache_key: auth_cache.FirewallAuthCacheKey
                ) -> dict:
                    started.set()
                    return await auth_cache.get_firewall_headers(cache_key, auth_request)

                follower = asyncio.create_task(fetch_after_start(follower_started, first_key))
                second = asyncio.create_task(fetch_after_start(second_started, second_key))
                tasks.extend((follower, second))
                await asyncio.gather(follower_started.wait(), second_started.wait())

                assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 2
                assert endpoint.request_count == 1
                with pytest.raises(auth_cache.FirewallAuthFetchSaturatedError):
                    await auth_cache.get_firewall_headers(third_key, auth_request)
                assert endpoint.request_count == 1
                assert force_refresh_pending(third_key)

                release_first.set()
                first_result, follower_result = await asyncio.gather(first, follower)
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 2)
                assert endpoint.request_count == 2

                release_second.set()
                second_result = await second
                assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0

                third_result = await auth_cache.get_firewall_headers(third_key, auth_request)
            finally:
                release_first.set()
                release_second.set()
                await asyncio.gather(*tasks, return_exceptions=True)

        assert first_result["headers"] == {"Authorization": "Bearer token-1"}
        assert first_result["cache_hit"] is False
        assert follower_result["headers"] == {"Authorization": "Bearer token-1"}
        assert follower_result["cache_hit"] is True
        assert second_result["headers"] == {"Authorization": "Bearer token-2"}
        assert third_result["headers"] == {"Authorization": "Bearer token-3"}
        assert endpoint.request_count == 3
        assert endpoint.requests[2].json_body()["forceRefresh"] is True
        assert not force_refresh_pending(third_key)

    async def test_cancelled_leader_keeps_admission_until_shared_failure(self, mitm_ctx):
        endpoint = FakeAuthEndpoint()
        release_failure = threading.Event()
        endpoint.queue_response(500, body=b"not-json", release_event=release_failure)
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer recovered"},
                expires_at=time.time() + 3600,
            )
        )
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
        first_key = auth_cache_key(api_id="api-1")
        second_key = auth_cache_key(api_id="api-2")

        with (
            endpoint.run(),
            mitm_ctx(api_url=endpoint.api_url),
            patch.object(auth_cache, "MAX_CONCURRENT_FIREWALL_AUTH_FETCHES", 1),
            patch.object(auth_cache, "MAX_ADMITTED_FIREWALL_AUTH_FETCHES", 1),
        ):
            leader = asyncio.create_task(auth_cache.get_firewall_headers(first_key, auth_request))
            follower = None
            try:
                assert await asyncio.to_thread(endpoint.wait_for_request_count, 1)
                leader.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await leader

                follower_started = asyncio.Event()

                async def follow_shared_fetch() -> dict:
                    follower_started.set()
                    return await auth_cache.get_firewall_headers(first_key, auth_request)

                follower = asyncio.create_task(follow_shared_fetch())
                await follower_started.wait()
                assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 1
                with pytest.raises(auth_cache.FirewallAuthFetchSaturatedError):
                    await auth_cache.get_firewall_headers(second_key, auth_request)
                assert endpoint.request_count == 1

                release_failure.set()
                with pytest.raises(urllib.error.HTTPError):
                    await follower
                assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0

                recovered = await auth_cache.get_firewall_headers(second_key, auth_request)
            finally:
                release_failure.set()
                tasks = [task for task in (leader, follower) if task is not None]
                await asyncio.gather(*tasks, return_exceptions=True)

        assert recovered["headers"] == {"Authorization": "Bearer recovered"}
        assert recovered["cache_hit"] is False
        assert endpoint.request_count == 2
        assert auth_cache.admitted_firewall_auth_fetches_for_tests() == 0

    async def test_same_run_and_api_with_different_auth_identities_fetch_independently(
        self, mitm_ctx
    ):
        """Same run/api pairs with different auth inputs must not share headers."""
        endpoint = FakeAuthEndpoint()
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer explicit"},
                expires_at=time.time() + 3600,
            )
        )
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer default"},
                expires_at=time.time() + 3600,
            )
        )

        explicit_key = auth_cache_key(auth_identity="explicit-permission")
        default_key = auth_cache_key(auth_identity="default-permission")

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})
            explicit = await auth_cache.get_firewall_headers(explicit_key, auth_request)
            default = await auth_cache.get_firewall_headers(default_key, auth_request)

        assert endpoint.request_count == 2
        assert explicit["headers"] == {"Authorization": "Bearer explicit"}
        assert default["headers"] == {"Authorization": "Bearer default"}
        assert not has_auth_state(explicit_key)
        assert require_cached_headers(default_key).headers == {"Authorization": "Bearer default"}

    async def test_stale_registry_generation_cannot_reacquire_replaced_identity(self):
        old_key = auth_cache_key(auth_identity="old-auth", registry_generation=1)
        new_key = auth_cache_key(auth_identity="new-auth", registry_generation=2)
        auth_request = firewall_auth_request()
        auth_fetch = AsyncMock(
            side_effect=(
                firewall_auth_success(headers={"Authorization": "Bearer old"}),
                firewall_auth_success(headers={"Authorization": "Bearer new"}),
                firewall_auth_success(headers={"Authorization": "Bearer detached-old"}),
            )
        )

        with patch.object(auth_cache, "fetch_firewall_headers", auth_fetch):
            auth_cache.reconcile_registry_cache_ownership({"run-1": 1})
            await auth_cache.get_firewall_headers(old_key, auth_request)

            auth_cache.reconcile_registry_cache_ownership({"run-1": 2})
            await auth_cache.get_firewall_headers(new_key, auth_request)
            stale_result = await auth_cache.get_firewall_headers(old_key, auth_request)

        assert stale_result["headers"] == {"Authorization": "Bearer detached-old"}
        assert not has_auth_state(old_key)
        assert require_cached_headers(new_key).headers == {"Authorization": "Bearer new"}
        assert auth_fetch.await_count == 3

    async def test_same_identity_reuses_state_across_registry_generations(self):
        old_key = auth_cache_key(registry_generation=1)
        new_key = auth_cache_key(registry_generation=2)
        auth_cache.reconcile_registry_cache_ownership({"run-1": 1})
        set_cached_headers(old_key, headers={"Authorization": "Bearer cached"})
        mark_force_refresh(old_key)
        set_last_force_refresh_monotonic_at(old_key, 123.0)

        auth_cache.reconcile_registry_cache_ownership({"run-1": 2})
        auth_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", auth_fetch):
            result = await auth_cache.get_firewall_headers(new_key, firewall_auth_request())

        assert result["headers"] == {"Authorization": "Bearer cached"}
        assert result["cache_hit"] is True
        assert force_refresh_pending(new_key)
        assert last_force_refresh_monotonic_at(new_key) == 123.0
        auth_fetch.assert_not_awaited()

    def test_cached_header_snapshot_is_detached_from_internal_state(self):
        """Seeded inputs and returned snapshots cannot mutate live cache state."""
        cache_key = auth_cache_key()
        headers = {"Authorization": "Bearer original"}
        resolved_secrets = ["TOKEN"]
        query = {"api_key": "original-key"}
        set_cached_headers(
            cache_key,
            headers=headers,
            resolved_secrets=resolved_secrets,
            query=query,
        )

        headers["Authorization"] = "Bearer changed"
        resolved_secrets.append("OTHER")
        query["api_key"] = "changed-key"

        snapshot = require_cached_headers(cache_key)
        assert snapshot.headers == {"Authorization": "Bearer original"}
        assert snapshot.resolved_secrets == ["TOKEN"]
        assert snapshot.query == {"api_key": "original-key"}

        snapshot.headers["Authorization"] = "Bearer mutated"
        snapshot.resolved_secrets.append("MUTATED")
        assert snapshot.query is not None
        snapshot.query["api_key"] = "mutated-key"

        fresh_snapshot = require_cached_headers(cache_key)
        assert fresh_snapshot.headers == {"Authorization": "Bearer original"}
        assert fresh_snapshot.resolved_secrets == ["TOKEN"]
        assert fresh_snapshot.query == {"api_key": "original-key"}

    async def test_returned_metadata_is_detached_from_cached_payload(self):
        cache_key = auth_cache_key()
        auth_request = firewall_auth_request(
            auth_headers={"Authorization": "template"},
            auth_query={"api_key": "template"},
        )
        auth_fetch = AsyncMock(
            return_value=firewall_auth_success(
                headers={"Authorization": "Bearer original"},
                resolved_secrets=["TOKEN"],
                query={"api_key": "original-key"},
            )
        )

        with patch.object(auth_cache, "fetch_firewall_headers", auth_fetch):
            fresh = await auth_cache.get_firewall_headers(cache_key, auth_request)
            cache_entry_identity = fresh["cache_entry_identity"]

            fresh["headers"]["Authorization"] = "Bearer mutated-fresh"
            fresh["resolved_secrets"].append("MUTATED_FRESH")
            fresh["query"]["api_key"] = "mutated-fresh-key"

            snapshot = require_cached_headers(cache_key)
            assert snapshot.headers == {"Authorization": "Bearer original"}
            assert snapshot.resolved_secrets == ["TOKEN"]
            assert snapshot.query == {"api_key": "original-key"}
            assert snapshot.cache_entry_identity is cache_entry_identity

            cached = await auth_cache.get_firewall_headers(cache_key, auth_request)
            assert cached["headers"] == {"Authorization": "Bearer original"}
            assert cached["resolved_secrets"] == ["TOKEN"]
            assert cached["query"] == {"api_key": "original-key"}

            cached["headers"]["Authorization"] = "Bearer mutated-cached"
            cached["resolved_secrets"].append("MUTATED_CACHED")
            cached["query"]["api_key"] = "mutated-cached-key"

            subsequent = await auth_cache.get_firewall_headers(cache_key, auth_request)

        assert fresh["cache_hit"] is False
        assert cached["cache_hit"] is True
        assert subsequent["cache_hit"] is True
        assert cached["cache_entry_identity"] is cache_entry_identity
        assert subsequent["cache_entry_identity"] is cache_entry_identity
        assert subsequent["headers"] == {"Authorization": "Bearer original"}
        assert subsequent["resolved_secrets"] == ["TOKEN"]
        assert subsequent["query"] == {"api_key": "original-key"}
        auth_fetch.assert_awaited_once_with(auth_request, force_refresh=False)

    async def test_fetch_failure_does_not_cache(self, mitm_ctx):
        """Failed fetch should not populate cache; next caller retries independently."""
        cache_key = auth_cache_key()
        endpoint = FakeAuthEndpoint()
        endpoint.queue_response(500, body=b"not-json")
        endpoint.queue_json_response(
            firewall_auth_success_response(
                {"Authorization": "Bearer retry"},
                expires_at=time.time() + 3600,
            )
        )
        auth_request = firewall_auth_request(auth_headers={"Authorization": "template"})

        with endpoint.run(), mitm_ctx(api_url=endpoint.api_url):
            with pytest.raises(urllib.error.HTTPError):
                await auth_cache.get_firewall_headers(cache_key, auth_request)

            assert endpoint.request_count == 1
            assert cached_headers(cache_key) is None

            retry = await auth_cache.get_firewall_headers(cache_key, auth_request)
            assert retry["headers"] == {"Authorization": "Bearer retry"}
            assert retry["cache_hit"] is False
            assert endpoint.request_count == 2
            assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer retry"}

            cached = await auth_cache.get_firewall_headers(cache_key, auth_request)
            assert cached["headers"] == {"Authorization": "Bearer retry"}
            assert cached["cache_hit"] is True
            assert endpoint.request_count == 2

    def test_registry_eviction_cleans_auth_state(self, tmp_path, mitm_ctx):
        """When a run is evicted from the registry, its auth state is removed."""
        cache_key = auth_cache_key(run_id="run-old")
        set_cached_headers(cache_key, headers={}, expires_at=None)

        registry = {"sandboxes": {"10.200.0.1": {"runId": "run-new", "billableFirewalls": []}}}
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry))

        with (
            mitm_ctx(registry_path=str(reg_path)),
        ):
            registry_cache.reset_cache_for_tests()
            registry_cache.load_registry(str(reg_path))

        assert not has_auth_state(cache_key)


class TestGetFirewallHeaders:
    async def test_cache_miss_fetches_and_caches(self, headers):
        mock_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = firewall_auth_success(headers=mock_headers)
        encrypted = "iv:tag:data"
        auth_templates = {"Authorization": "Bearer ${{ secrets.TOKEN }}"}
        cache_key = auth_cache_key(api_id="https://api.github.com")

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(
                    encrypted_secrets=encrypted,
                    auth_headers=auth_templates,
                ),
            )

        assert headers["headers"] == mock_headers
        assert headers["cache_hit"] is False
        assert headers["refreshed_connectors"] == []
        assert headers["refreshed_secrets"] == []
        mock_fetch.assert_called_once()
        assert mock_fetch.call_args.args == (
            firewall_auth_request(
                encrypted_secrets=encrypted,
                auth_headers=auth_templates,
            ),
        )
        assert mock_fetch.call_args.kwargs == {"force_refresh": False}

        assert cached_headers(cache_key)
        assert require_cached_headers(cache_key).headers == mock_headers

    async def test_cache_hit_returns_cached(self, headers):
        cache_key = auth_cache_key(api_id="https://api.github.com")
        cached_headers = {"Authorization": "Bearer cached-token"}
        set_cached_headers(cache_key, headers=cached_headers)

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_cache_hit_with_valid_ttl_returns_cached(self, headers):
        """Cached entry with expiresAt in the future should be returned without fetching."""
        cache_key = auth_cache_key()
        cached_headers = {"Authorization": "Bearer valid-token"}
        set_cached_headers(
            cache_key,
            headers=cached_headers,
            expires_at=time.time() + 3600,  # 1 hour from now
        )

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_expired_cache_entry_triggers_refetch(self, headers):
        """An expired entry is a cache miss and is replaced after a successful refetch."""
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=time.time() - 10,  # expired 10 seconds ago
        )

        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_result = firewall_auth_success(headers=fresh_headers, expires_at=time.time() + 3600)

        mock_fetch = AsyncMock(return_value=mock_result)
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        # Pin the TTL-expiry-to-refetch contract independently of the client transport.
        mock_fetch.assert_called_once()
        # Verify cache was updated with new entry
        assert require_cached_headers(cache_key).headers == fresh_headers

    async def test_expired_cache_entry_is_retained_when_refetch_fails(self):
        """Expired headers are not served, but a failed refetch retains the stored entry."""
        cache_key = auth_cache_key()
        stale_headers = {"Authorization": "Bearer stale-token"}
        expired_at = time.time() - 10
        set_cached_headers(
            cache_key,
            headers=stale_headers,
            expires_at=expired_at,
        )

        failed_fetch = AsyncMock(side_effect=ConnectionError("server unreachable"))
        with (
            patch.object(auth_cache, "fetch_firewall_headers", failed_fetch),
            pytest.raises(ConnectionError, match=r"^server unreachable$"),
        ):
            await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        failed_fetch.assert_awaited_once()
        retained = require_cached_headers(cache_key)
        assert retained.headers == stale_headers
        assert retained.expires_at == expired_at

        fresh_headers = {"Authorization": "Bearer fresh-token"}
        successful_fetch = AsyncMock(
            return_value=firewall_auth_success(
                headers=fresh_headers,
                expires_at=time.time() + 3600,
            )
        )
        with patch.object(auth_cache, "fetch_firewall_headers", successful_fetch):
            result = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert result["headers"] == fresh_headers
        assert result["cache_hit"] is False
        successful_fetch.assert_awaited_once()
        assert require_cached_headers(cache_key).headers == fresh_headers

    async def test_cache_with_null_expires_at_never_evicts(self, headers):
        """Cached entry with expiresAt=None (non-expiring) should never be evicted by TTL."""
        cache_key = auth_cache_key()
        cached_headers = {"Authorization": "Bearer permanent-token"}
        set_cached_headers(cache_key, headers=cached_headers, expires_at=None)

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_billable_cache_hit_requires_valid_expiry(self, headers):
        cache_key = auth_cache_key()
        cached_headers = {"Authorization": "Bearer cached-token"}
        set_cached_headers(cache_key, headers=cached_headers, expires_at=time.time() + 30)

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(firewall_billable=True),
            )

        assert headers["headers"] == cached_headers
        assert headers["cache_hit"] is True
        mock_fetch.assert_not_called()

    @pytest.mark.parametrize(
        ("expiry", "now"),
        [
            pytest.param(None, 100.0, id="none"),
            pytest.param(True, 0.0, id="bool-true"),
            pytest.param(False, -1.0, id="bool-false"),
            pytest.param("123", 100.0, id="string"),
            pytest.param(float("inf"), 100.0, id="infinity"),
            pytest.param(float("nan"), 100.0, id="nan"),
            pytest.param(100.0, 100.0, id="exact-now"),
        ],
    )
    def test_expiry_validation_rejects_invalid_values(self, expiry, now):
        assert auth_cache._has_valid_expiry(expiry, now=now) is False

    @pytest.mark.parametrize(
        "expiry",
        [
            True,
            "123",
            float("inf"),
            float("nan"),
            pytest.param(10**400, id="oversized-integer"),
        ],
    )
    async def test_cache_with_invalid_expiry_refetches(self, headers, expiry):
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer malformed-token"},
            expires_at=expiry,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(headers=fresh_headers, expires_at=None)
        )

        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()

    async def test_billable_cache_without_expiry_refetches(self, headers):
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=None,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        expires_at = int(time.time()) + 30
        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(headers=fresh_headers, expires_at=expires_at)
        )

        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(firewall_billable=True),
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()
        assert mock_fetch.call_args.args[0].firewall_billable is True
        assert require_cached_headers(cache_key).expires_at == expires_at

    async def test_billable_cache_with_expired_expiry_refetches(self, headers):
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer stale-token"},
            expires_at=time.time() - 1,
        )
        fresh_headers = {"Authorization": "Bearer fresh-token"}
        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(headers=fresh_headers, expires_at=time.time() + 30)
        )

        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            headers = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(firewall_billable=True),
            )

        assert headers["headers"] == fresh_headers
        assert headers["cache_hit"] is False
        mock_fetch.assert_called_once()

    @pytest.mark.parametrize(
        "expires_at",
        [
            pytest.param(None, id="none"),
            pytest.param(True, id="bool"),
            pytest.param("123", id="string"),
            pytest.param(float("inf"), id="infinity"),
            pytest.param(float("nan"), id="nan"),
            pytest.param(10**400, id="oversized-integer"),
            pytest.param(0, id="expired"),
        ],
    )
    async def test_billable_fetch_with_invalid_expiry_fails_closed(self, expires_at):
        cache_key = auth_cache_key()
        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(
                headers={"Authorization": "Bearer token"},
                expires_at=expires_at,
            )
        )

        with (
            patch.object(auth_cache, "fetch_firewall_headers", mock_fetch),
            pytest.raises(auth_cache.InvalidBillableAuthExpiryError),
        ):
            await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(firewall_billable=True),
            )
        assert cached_headers(cache_key) is None

    async def test_cache_hit_includes_base_when_present(self):
        """Cached entry with 'base' returns it on cache hit."""
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={},
            resolved_secrets=["WEBHOOK_URL"],
            base="https://discord.com/api/webhooks/123/abc",
            expires_at=None,
        )

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            result = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(auth_base="${{ secrets.WEBHOOK_URL }}"),
            )

        assert result["base"] == "https://discord.com/api/webhooks/123/abc"
        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()

    async def test_query_is_cached_and_returned_on_cache_hit(self):
        """auth.query is cached after a fetch and returned on cache hit."""
        cache_key = auth_cache_key()
        cached_query = {"api_key": "cached-key", "empty_auth": ""}
        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(
                headers={},
                resolved_secrets=["QUERY_KEY"],
                query=cached_query,
            )
        )
        request = firewall_auth_request(
            auth_query={
                "api_key": "${{ secrets.QUERY_KEY }}",
                "empty_auth": "${{ vars.EMPTY }}",
            }
        )

        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            first = await auth_cache.get_firewall_headers(cache_key, request)
            second = await auth_cache.get_firewall_headers(cache_key, request)

        assert first["query"] == cached_query
        assert first["cache_hit"] is False
        assert second["query"] == cached_query
        assert second["cache_hit"] is True
        mock_fetch.assert_called_once()
        assert require_cached_headers(cache_key).query == cached_query

    async def test_base_and_query_are_cached_together(self):
        """auth.base and auth.query survive the same cache entry."""
        cache_key = auth_cache_key()
        cached_base = "https://example.com/webhook/secret"
        cached_query = {"api_key": "cached-key", "empty_auth": ""}
        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(
                headers={},
                base=cached_base,
                query=cached_query,
            )
        )
        request = firewall_auth_request(
            auth_base="${{ secrets.WEBHOOK_URL }}",
            auth_query={
                "api_key": "${{ secrets.QUERY_KEY }}",
                "empty_auth": "${{ vars.EMPTY }}",
            },
        )

        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            first = await auth_cache.get_firewall_headers(cache_key, request)
            second = await auth_cache.get_firewall_headers(cache_key, request)

        assert first["base"] == cached_base
        assert first["query"] == cached_query
        assert first["cache_hit"] is False
        assert second["base"] == cached_base
        assert second["query"] == cached_query
        assert second["cache_hit"] is True
        mock_fetch.assert_called_once()
        cached = require_cached_headers(cache_key)
        assert cached.base == cached_base
        assert cached.query == cached_query

    async def test_cache_hit_omits_base_when_absent(self):
        """Cached entry without 'base' does not include it in result."""
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer tok"},
            resolved_secrets=["TOKEN"],
            expires_at=None,
        )

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            result = await auth_cache.get_firewall_headers(
                cache_key,
                firewall_auth_request(
                    auth_headers={"Authorization": "Bearer ${{ secrets.TOKEN }}"}
                ),
            )

        assert "base" not in result
        assert result["cache_hit"] is True

    async def test_force_refresh_marker_triggers_forced_fetch(self):
        """When a force-refresh marker is set, the next fetch passes
        force_refresh=True, the marker is cleared, and the consume timestamp
        is recorded so the cooldown can suppress re-marking (#9860)."""
        cache_key = auth_cache_key()
        mark_force_refresh(cache_key)
        before = time.monotonic()

        mock_fetch = AsyncMock(
            return_value=firewall_auth_success(headers={"Authorization": "Bearer new"})
        )
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        # force_refresh kwarg must be True
        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        # Marker cleared after consumption
        assert not force_refresh_pending(cache_key)
        # Consume timestamp recorded for cooldown enforcement
        assert require_last_force_refresh_monotonic_at(cache_key) >= before

    async def test_force_refresh_fetch_failure_still_consumes_marker(self):
        """A failed forced refresh burns the cooldown and does not cache headers."""
        cache_key = auth_cache_key()
        mark_force_refresh(cache_key)
        before = time.monotonic()

        mock_fetch = AsyncMock(side_effect=ConnectionError("server unreachable"))
        with (
            patch.object(auth_cache, "fetch_firewall_headers", mock_fetch),
            pytest.raises(ConnectionError),
        ):
            await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert mock_fetch.call_args.kwargs["force_refresh"] is True
        assert not force_refresh_pending(cache_key)
        assert require_last_force_refresh_monotonic_at(cache_key) >= before
        assert cached_headers(cache_key) is None

    def test_force_refresh_first_owned_state_is_allowed_without_previous_timestamp(self):
        """An owned auth state has no cooldown timestamp, so the first 401 marks."""
        cache_key = auth_cache_key()
        set_cached_headers(cache_key, headers={"Authorization": "Bearer cached-token"})

        with patch.object(auth_cache.time, "monotonic", return_value=10.0):
            auth_cache.request_force_refresh(cache_key)

        assert force_refresh_pending(cache_key)

    def test_force_refresh_inside_monotonic_cooldown_is_suppressed(self):
        """Repeated 401s inside the process-local cooldown do not re-mark."""
        cache_key = auth_cache_key()
        set_last_force_refresh_monotonic_at(cache_key, 1000.0)

        with patch.object(auth_cache.time, "monotonic", return_value=1119.0):
            auth_cache.request_force_refresh(cache_key)

        assert not force_refresh_pending(cache_key)

    def test_force_refresh_after_monotonic_cooldown_is_allowed(self):
        """A 401 after the monotonic cooldown elapsed can re-mark."""
        cache_key = auth_cache_key()
        set_last_force_refresh_monotonic_at(cache_key, 1000.0)

        with patch.object(auth_cache.time, "monotonic", return_value=1121.0):
            auth_cache.request_force_refresh(cache_key)

        assert force_refresh_pending(cache_key)

    async def test_force_refresh_records_monotonic_timestamp_before_fetch_returns(self):
        """The cooldown is burned before awaiting the forced auth fetch."""
        cache_key = auth_cache_key()
        mark_force_refresh(cache_key)

        async def delayed_fetch(*args, **kwargs):
            assert kwargs["force_refresh"] is True
            assert require_last_force_refresh_monotonic_at(cache_key) == 1234.0
            return firewall_auth_success(headers={"Authorization": "Bearer new"})

        with (
            patch.object(auth_cache.time, "monotonic", return_value=1234.0),
            patch.object(auth_cache, "fetch_firewall_headers", side_effect=delayed_fetch),
        ):
            await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert require_last_force_refresh_monotonic_at(cache_key) == 1234.0

    async def test_non_forced_fetch_does_not_cache_if_marker_appears_in_flight(self):
        """A 401 marker during a non-forced fetch must win over the cache write."""
        cache_key = auth_cache_key()
        fetch_entered = asyncio.Event()
        allow_fetch_return = asyncio.Event()
        first_force_refresh_values = []

        async def delayed_fetch(*args, **kwargs):
            force_refresh = kwargs["force_refresh"]
            first_force_refresh_values.append(force_refresh)
            fetch_entered.set()
            await allow_fetch_return.wait()
            return firewall_auth_success(
                headers={"Authorization": "Bearer maybe-stale"},
                expires_at=time.time() + 3600,
            )

        with patch.object(auth_cache, "fetch_firewall_headers", side_effect=delayed_fetch):
            task = asyncio.create_task(
                auth_cache.get_firewall_headers(cache_key, firewall_auth_request())
            )
            try:
                await asyncio.wait_for(fetch_entered.wait(), timeout=5)
                auth_cache.request_force_refresh(cache_key)
                allow_fetch_return.set()
                result = await task
            finally:
                allow_fetch_return.set()
                await cancel_pending_task(task)

        assert first_force_refresh_values == [False]
        assert result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert result["cache_hit"] is False
        assert cached_headers(cache_key) is None
        assert force_refresh_pending(cache_key)

        forced_headers = {"Authorization": "Bearer refreshed"}
        forced_fetch = AsyncMock(
            return_value=firewall_auth_success(
                headers=forced_headers, expires_at=time.time() + 3600
            )
        )
        before_forced = time.monotonic()

        with patch.object(auth_cache, "fetch_firewall_headers", forced_fetch):
            forced_result = await auth_cache.get_firewall_headers(
                cache_key, firewall_auth_request()
            )

        assert forced_fetch.call_args.kwargs["force_refresh"] is True
        assert forced_result["headers"] == forced_headers
        assert forced_result["cache_hit"] is False
        assert not force_refresh_pending(cache_key)
        assert require_last_force_refresh_monotonic_at(cache_key) >= before_forced
        assert require_cached_headers(cache_key).headers == forced_headers

    async def test_waiting_request_force_refreshes_after_in_flight_marker(self):
        """A same-key waiter must not reuse headers from the stale-prone leader fetch."""
        cache_key = auth_cache_key()
        first_fetch_entered = asyncio.Event()
        allow_first_fetch_return = asyncio.Event()
        force_refresh_values = []

        async def fetch_with_blocked_leader(*args, **kwargs):
            force_refresh = kwargs["force_refresh"]
            force_refresh_values.append(force_refresh)
            if not force_refresh:
                first_fetch_entered.set()
                await allow_first_fetch_return.wait()
                return firewall_auth_success(
                    headers={"Authorization": "Bearer maybe-stale"},
                    expires_at=time.time() + 3600,
                )
            return firewall_auth_success(
                headers={"Authorization": "Bearer refreshed"},
                expires_at=time.time() + 3600,
            )

        with patch.object(
            auth_cache, "fetch_firewall_headers", side_effect=fetch_with_blocked_leader
        ):
            leader = asyncio.create_task(
                auth_cache.get_firewall_headers(cache_key, firewall_auth_request())
            )
            waiter = None
            try:
                await asyncio.wait_for(first_fetch_entered.wait(), timeout=5)
                waiter = asyncio.create_task(
                    auth_cache.get_firewall_headers(cache_key, firewall_auth_request())
                )
                auth_cache.request_force_refresh(cache_key)
                allow_first_fetch_return.set()
                leader_result, waiter_result = await asyncio.gather(leader, waiter)
            finally:
                allow_first_fetch_return.set()
                for task in (leader, waiter):
                    await cancel_pending_task(task)

        assert force_refresh_values == [False, True]
        assert leader_result["headers"] == {"Authorization": "Bearer maybe-stale"}
        assert waiter_result["headers"] == {"Authorization": "Bearer refreshed"}
        assert require_cached_headers(cache_key).headers == {"Authorization": "Bearer refreshed"}
        assert not force_refresh_pending(cache_key)

    async def test_force_refresh_absent_passes_false(self):
        """Without a marker, fetch is called with force_refresh=False (#9860)."""
        cache_key = auth_cache_key(api_id="api-2")
        mock_fetch = AsyncMock(return_value=firewall_auth_success(headers={}))
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert mock_fetch.call_args.kwargs["force_refresh"] is False
        # No consume timestamp written when force-refresh didn't happen
        assert last_force_refresh_monotonic_at(cache_key) is None

    async def test_replacement_identity_does_not_inherit_force_refresh_marker(self):
        old_key = auth_cache_key(auth_identity="old-auth")
        new_key = auth_cache_key(auth_identity="new-auth")
        mark_force_refresh(old_key)

        mock_fetch = AsyncMock(return_value=firewall_auth_success(headers={}))
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            await auth_cache.get_firewall_headers(new_key, firewall_auth_request())

        assert mock_fetch.call_args.kwargs["force_refresh"] is False
        assert not has_auth_state(old_key)
        assert not force_refresh_pending(new_key)

    async def test_force_refresh_marker_ignored_on_cache_hit(self):
        """Fast-path cache hit does NOT consume the force-refresh marker —
        marker survives until the next actual fetch (#9860)."""
        cache_key = auth_cache_key()
        set_cached_headers(
            cache_key,
            headers={"Authorization": "Bearer cached"},
            expires_at=None,
        )
        mark_force_refresh(cache_key)

        mock_fetch = AsyncMock()
        with patch.object(auth_cache, "fetch_firewall_headers", mock_fetch):
            result = await auth_cache.get_firewall_headers(cache_key, firewall_auth_request())

        assert result["cache_hit"] is True
        mock_fetch.assert_not_called()
        # Marker preserved for next real fetch
        assert force_refresh_pending(cache_key)
