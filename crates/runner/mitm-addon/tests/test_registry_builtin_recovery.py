"""Recovery contracts for catalog reads and dependent registry snapshots."""

import errno
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

import builtin_firewall_cache
import matching
import mitm_addon
import registry
import state_file
from tests.registry_builtin_helpers import cache_firewall, write_registry_with_cache
from tests.registry_helpers import builtin_sandbox, inline_sandbox


def _write_recovery_files(tmp_path: Path) -> tuple[Path, Path]:
    firewall = cache_firewall("example", "https://cache.example.com")
    firewall["apis"][0]["auth"] = {"headers": {"Authorization": "Bearer ${{ secrets.TEST_TOKEN }}"}}
    sandboxes = {
        client_ip: {
            **builtin_sandbox(f"run-{suffix}", "example"),
            "sandboxToken": "test-token",
            "encryptedSecrets": "iv:tag:data",
            "networkPolicies": {
                "example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}
            },
        }
        for client_ip, suffix in [("10.200.0.1", "one"), ("10.200.0.2", "two")]
    }
    sandboxes["10.200.0.3"] = inline_sandbox("run-inline")
    return write_registry_with_cache(tmp_path, sandboxes, {"example": firewall})


@contextmanager
def _fail_catalog_reads(cache_path: Path) -> Iterator[None]:
    catalog_stat = cache_path.stat()
    real_read = os.read

    def read(fd: int, size: int) -> bytes:
        opened_stat = os.fstat(fd)
        if (opened_stat.st_dev, opened_stat.st_ino) == (
            catalog_stat.st_dev,
            catalog_stat.st_ino,
        ):
            raise OSError(errno.EIO, "injected catalog read failure")
        return real_read(fd, size)

    with patch.object(state_file.os, "read", side_effect=read):
        yield


@contextmanager
def _foreign_catalog_owner(cache_path: Path) -> Iterator[None]:
    catalog_stat = cache_path.stat()
    real_stat = os.stat
    real_fstat = os.fstat

    def foreign_owner(st: os.stat_result) -> os.stat_result:
        if (st.st_dev, st.st_ino) != (catalog_stat.st_dev, catalog_stat.st_ino):
            return st
        fields = list(st)
        fields[4] = st.st_uid + 1
        # The sequence alone loses nanosecond timestamps and other extra fields.
        # Python 3.14 rejects named sequence fields repeated in the extra map.
        extra_fields = {
            name: getattr(st, name)
            for name in dir(st)
            if name.startswith("st_")
            and name
            not in {"st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size"}
        }
        return os.stat_result(fields, extra_fields)

    def stat_path(path, *args, **kwargs) -> os.stat_result:
        return foreign_owner(real_stat(path, *args, **kwargs))

    def fstat(fd: int) -> os.stat_result:
        return foreign_owner(real_fstat(fd))

    with (
        patch.object(os, "stat", side_effect=stat_path),
        patch.object(os, "fstat", side_effect=fstat),
    ):
        yield


def test_catalog_recovers_after_same_identity_read_error(tmp_path, mitm_ctx):
    _, cache_path = _write_recovery_files(tmp_path)

    with mitm_ctx() as log:
        with _fail_catalog_reads(cache_path):
            failed = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            for _ in range(3):
                repeated = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
                assert repeated.catalog is None
                assert repeated.unavailable_reason == "cache_invalid"

        recovered = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        assert recovered.catalog is not None
        assert recovered.catalog.firewalls["example"]["apis"][0]["base"] == (
            "https://cache.example.com"
        )
        assert recovered.dependency_file_key == failed.dependency_file_key
        assert recovered.unavailable_reason is None
        assert log.warn.call_count == 1

        with patch.object(state_file.os, "read", side_effect=AssertionError("unexpected reread")):
            cached = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        assert cached.catalog is recovered.catalog


@pytest.mark.parametrize("recover_catalog_first", [False, True])
def test_registry_recovers_after_same_identity_catalog_read_error(
    tmp_path, mitm_ctx, recover_catalog_first
):
    registry_path, cache_path = _write_recovery_files(tmp_path)

    with mitm_ctx(registry_path=str(registry_path)) as log:
        with _fail_catalog_reads(cache_path):
            for _ in range(3):
                failed = registry.load_registry_state(str(registry_path))
                assert not isinstance(failed, registry.RegistryUnavailable)
                assert set(failed.invalid_sandboxes) == {"10.200.0.1", "10.200.0.2"}
                assert set(failed.sandboxes) == {"10.200.0.3"}
                assert "10.200.0.1" not in failed.compiled_firewalls
                assert "10.200.0.2" not in failed.compiled_firewalls
            assert log.warn.call_count == 2

        if recover_catalog_first:
            # Isolate the outer cache even when the inner loader already recovered.
            builtin_firewall_cache.clear_cache()
            catalog = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            assert catalog.catalog is not None

        recovered = registry.load_registry_state(str(registry_path))
        assert not isinstance(recovered, registry.RegistryUnavailable)
        assert recovered.invalid_sandboxes == {}
        assert recovered.loaded_key == failed.loaded_key
        assert recovered.builtin_firewall_catalog_snapshot is not None
        assert failed.builtin_firewall_catalog_snapshot is not None
        assert recovered.builtin_firewall_catalog_snapshot.dependency_file_key == (
            failed.builtin_firewall_catalog_snapshot.dependency_file_key
        )
        for client_ip in ("10.200.0.1", "10.200.0.2"):
            compiled = recovered.compiled_firewalls[client_ip]
            policies = recovered.compiled_network_policies[client_ip]
            allowed = matching.match_compiled_firewall_request(
                "https://cache.example.com/items", "GET", compiled, policies
            )
            blocked = matching.match_compiled_firewall_request(
                "https://cache.example.com/items", "POST", compiled, policies
            )
            assert isinstance(allowed, matching.FirewallAllow)
            assert isinstance(blocked, matching.FirewallBlock)
            assert blocked.reason == "unknown_endpoint"
        assert log.warn.call_count == 2


async def test_request_recovers_after_catalog_read_error(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    registry_path, cache_path = _write_recovery_files(tmp_path)
    failed_flow = real_flow(
        with_response=False, client_ip="10.200.0.1", host="cache.example.com", path="/items"
    )
    recovered_flow = real_flow(
        with_response=False, client_ip="10.200.0.1", host="cache.example.com", path="/items"
    )

    with (
        mitm_ctx(registry_path=str(registry_path)),
        fake_firewall_headers(headers={"Authorization": "Bearer recovered"}) as auth_fetch,
    ):
        with _fail_catalog_reads(cache_path):
            await mitm_addon.request(failed_flow)
        assert failed_flow.response is not None
        assert failed_flow.response.status_code == 503
        assert failed_flow.response.json()["error"] == "invalid_registry_sandbox"
        assert failed_flow.request.headers.get("Authorization") is None
        auth_fetch.assert_not_called()

        await mitm_addon.request(recovered_flow)

    assert recovered_flow.response is None
    assert recovered_flow.request.headers["Authorization"] == "Bearer recovered"


@pytest.mark.parametrize("cached", [False, True], ids=["cold-load", "cached-owner-change"])
async def test_request_rejects_foreign_catalog_owner_and_recovers(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, cached
):
    registry_path, cache_path = _write_recovery_files(tmp_path)
    cache_path.chmod(0o644)
    original_stat = cache_path.stat()
    original_contents = cache_path.read_bytes()
    assert original_stat.st_uid == os.geteuid()

    with (
        mitm_ctx(registry_path=str(registry_path)),
        fake_firewall_headers(headers={"Authorization": "Bearer recovered"}) as auth_fetch,
    ):
        if cached:
            healthy = real_flow(with_response=False, host="cache.example.com", path="/items")
            await mitm_addon.request(healthy)
            assert healthy.response is None
            assert healthy.request.headers["Authorization"] == "Bearer recovered"
            auth_fetch.assert_called_once()
            auth_fetch.reset_mock()

        with _foreign_catalog_owner(cache_path):
            foreign_stat = cache_path.stat()
            assert foreign_stat.st_uid != os.geteuid()
            assert foreign_stat.st_mode == original_stat.st_mode
            assert (
                foreign_stat.st_dev,
                foreign_stat.st_ino,
                foreign_stat.st_size,
                foreign_stat.st_mtime_ns,
            ) == (
                original_stat.st_dev,
                original_stat.st_ino,
                original_stat.st_size,
                original_stat.st_mtime_ns,
            )

            blocked = real_flow(with_response=False, host="cache.example.com", path="/items")
            # Enter the request before probing either cache, including the warm case.
            await mitm_addon.request(blocked)
            assert blocked.response is not None
            assert blocked.response.status_code == 503
            assert blocked.response.json()["error"] == "invalid_registry_sandbox"
            assert "cache_untrusted" in blocked.response.json()["message"]
            assert "Authorization" not in blocked.request.headers
            auth_fetch.assert_not_called()

            snapshot = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
            assert snapshot.catalog is None
            assert snapshot.unavailable_reason == "cache_untrusted"

        recovered = real_flow(with_response=False, host="cache.example.com", path="/items")
        await mitm_addon.request(recovered)
        assert recovered.response is None
        assert recovered.request.headers["Authorization"] == "Bearer recovered"
        auth_fetch.assert_called_once()

    restored_stat = cache_path.stat()
    for field in ("st_uid", "st_mode", "st_dev", "st_ino", "st_size", "st_mtime_ns"):
        assert getattr(restored_stat, field) == getattr(original_stat, field)
    assert cache_path.read_bytes() == original_contents


@pytest.mark.parametrize("invalid_content", ["json", "schema", "oversized"])
def test_invalid_catalog_content_keeps_negative_cache(tmp_path, mitm_ctx, invalid_content):
    registry_path, cache_path = _write_recovery_files(tmp_path)
    if invalid_content == "json":
        cache_path.write_text("{ broken")
    elif invalid_content == "schema":
        cache_path.write_text('{"schemaVersion": -1}')
    limit = cache_path.stat().st_size - (invalid_content == "oversized")

    with (
        mitm_ctx(registry_path=str(registry_path)) as log,
        patch.object(builtin_firewall_cache, "BUILTIN_FIREWALL_CATALOG_MAX_BYTES", limit),
    ):
        first_catalog = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        first_registry = registry.load_registry_state(str(registry_path))
        assert first_catalog.catalog is None
        assert first_catalog.unavailable_reason == "cache_invalid"
        assert not isinstance(first_registry, registry.RegistryUnavailable)
        assert set(first_registry.invalid_sandboxes) == {"10.200.0.1", "10.200.0.2"}

        with patch.object(state_file.os, "read", side_effect=AssertionError("unexpected reread")):
            for _ in range(3):
                cached_catalog = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
                cached_registry = registry.load_registry_state(str(registry_path))
                assert cached_catalog.catalog is None
                assert cached_registry is first_registry
        assert log.warn.call_count == 2


@pytest.mark.parametrize("unavailable", ["missing", "untrusted"])
def test_unavailable_catalog_recovers_without_rewriting_registry(tmp_path, mitm_ctx, unavailable):
    registry_path, cache_path = _write_recovery_files(tmp_path)
    saved_path = cache_path.with_suffix(".saved")
    if unavailable == "missing":
        cache_path.rename(saved_path)
    else:
        cache_path.chmod(0o620)

    with mitm_ctx(registry_path=str(registry_path)) as log:
        for _ in range(3):
            failed = registry.load_registry_state(str(registry_path))
            assert not isinstance(failed, registry.RegistryUnavailable)
            assert set(failed.invalid_sandboxes) == {"10.200.0.1", "10.200.0.2"}
        assert log.warn.call_count == 1

        if unavailable == "missing":
            saved_path.rename(cache_path)
        else:
            cache_path.chmod(0o600)
        recovered = registry.load_registry_state(str(registry_path))
        assert not isinstance(recovered, registry.RegistryUnavailable)
        assert recovered.invalid_sandboxes == {}
        assert recovered.loaded_key == failed.loaded_key

        # A new failure following recovery must still produce a rejection warning.
        cache_path.rename(saved_path)
        failed_again = registry.load_registry_state(str(registry_path))
        assert not isinstance(failed_again, registry.RegistryUnavailable)
        assert set(failed_again.invalid_sandboxes) == {"10.200.0.1", "10.200.0.2"}
        assert log.warn.call_count == 2
