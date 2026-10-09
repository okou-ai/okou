"""Bound repeated outage work without delaying fail-closed catalog recovery."""

import errno
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy import ctx

import builtin_firewall_cache
import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
import registry_observation
import state_file
from tests.registry_builtin_helpers import cache_firewall, write_registry_with_cache
from tests.registry_helpers import builtin_sandbox, inline_sandbox, write_multi_sandbox_registry
from tests.requestheaders_helpers import await_requestheaders_result


def _write_outage_files(tmp_path: Path) -> tuple[Path, Path]:
    firewall = cache_firewall("example", "https://cache.example.com")
    firewall["apis"][0]["auth"] = {"headers": {"Authorization": "Bearer ${{ secrets.TEST_TOKEN }}"}}
    sandboxes = {}
    for index in range(16):
        sandbox = inline_sandbox(f"run-inline-{index}")
        api = sandbox["firewalls"][0]["firewall"]["apis"][0]
        api["auth"] = {}
        api["permissions"][0]["rules"] = [f"GET /resources/{index}/{{id}}"]
        sandbox["networkPolicies"] = {
            "example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}
        }
        sandboxes[f"10.200.0.{index + 3}"] = sandbox
    for index in range(2):
        sandboxes[f"10.200.0.{index + 1}"] = {
            **builtin_sandbox(f"run-builtin-{index}", "example"),
            "sandboxToken": "test-token",
            "encryptedSecrets": "iv:tag:data",
            "networkPolicies": {
                "example": {"allow": ["read"], "deny": [], "unknownPolicy": "deny"}
            },
        }
    return write_registry_with_cache(tmp_path, sandboxes, {"example": firewall})


async def _request_pair(flow) -> None:
    pending = mitm_addon.requestheaders(flow)
    if pending is not None:
        await await_requestheaders_result(pending)
    await mitm_addon.request(flow)


@contextmanager
def _catalog_outage(
    cache_path: Path, registry_path: Path, failure: str
) -> Iterator[dict[str, int]]:
    if failure in {"read", "open", "permission"}:
        # Invalidate the healthy path-stat hit so a genuine load is attempted.
        replacement = cache_path.with_suffix(".replacement")
        replacement.write_bytes(cache_path.read_bytes())
        replacement.chmod(0o600)
        replacement.replace(cache_path)
    catalog_stat = cache_path.stat()
    registry_stat = registry_path.stat()
    saved_path = cache_path.with_suffix(".saved")
    if failure == "missing":
        cache_path.rename(saved_path)
    elif failure == "untrusted":
        cache_path.chmod(0o620)
    counts = {"opens": 0, "reads": 0, "registry_reads": 0}
    real_open = os.open
    real_read = os.read

    def open_file(path, flags, *args, **kwargs):
        if path == cache_path:
            counts["opens"] += 1
            if failure in {"open", "permission"}:
                code = errno.EACCES if failure == "permission" else errno.EIO
                raise OSError(code, "injected catalog open failure")
        return real_open(path, flags, *args, **kwargs)

    def read(fd: int, size: int) -> bytes:
        opened_stat = os.fstat(fd)
        identity = (opened_stat.st_dev, opened_stat.st_ino)
        if identity == (registry_stat.st_dev, registry_stat.st_ino):
            counts["registry_reads"] += 1
        if identity == (catalog_stat.st_dev, catalog_stat.st_ino):
            counts["reads"] += 1
            if failure == "read":
                raise OSError(errno.EIO, "injected catalog read failure")
        return real_read(fd, size)

    try:
        with (
            patch.object(state_file.os, "open", side_effect=open_file),
            patch.object(state_file.os, "read", side_effect=read),
        ):
            yield counts
    finally:
        if failure == "missing":
            saved_path.rename(cache_path)
        elif failure == "untrusted":
            cache_path.chmod(0o600)


@pytest.mark.parametrize("failure", ["missing", "untrusted", "read", "open", "permission"])
async def test_equal_catalog_failures_retry_without_rebuilding_registry(
    tmp_path, mitm_ctx, real_flow, fake_firewall_headers, failure
):
    registry_path, cache_path = _write_outage_files(tmp_path)
    with (
        mitm_ctx(registry_path=str(registry_path)) as log,
        fake_firewall_headers(headers={"Authorization": "Bearer recovered"}) as auth_fetch,
    ):
        healthy = real_flow(with_response=False, host="cache.example.com", path="/items")
        await _request_pair(healthy)
        assert healthy.response is None
        assert healthy.request.headers["Authorization"] == "Bearer recovered"
        auth_fetch.reset_mock()

        # Structural counters supplement real authorization and recovery outcomes.
        with (
            patch.object(
                registry, "_read_registry_sandboxes", wraps=registry._read_registry_sandboxes
            ) as parse,
            patch.object(
                registry, "_compile_registry", wraps=registry._compile_registry
            ) as compile_,
        ):
            with _catalog_outage(cache_path, registry_path, failure) as counts:
                transition_reads = 0
                for index in range(5):
                    before = counts["opens"]
                    flow = real_flow(
                        with_response=False,
                        client_ip="10.200.0.3",
                        host="api.example.com",
                        path="/resources/0/123",
                    )
                    await _request_pair(flow)
                    assert flow.response is None
                    assert flow.error is None
                    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
                    assert flow.request.headers.get("Authorization") is None
                    assert counts["opens"] > before
                    if index == 0:
                        transition_reads = counts["registry_reads"]
                        assert transition_reads > 0
                    else:
                        assert counts["registry_reads"] == transition_reads

                blocked = real_flow(with_response=False, host="cache.example.com", path="/items")
                await _request_pair(blocked)
                assert blocked.response is not None
                assert blocked.response.status_code == 503
                assert blocked.response.json()["error"] == "invalid_registry_sandbox"
                assert blocked.request.headers.get("Authorization") is None
                auth_fetch.assert_not_called()
                assert parse.call_count == 1
                assert compile_.call_count == 1
                if failure == "read":
                    assert counts["reads"] == counts["opens"]
                warnings = log.warn.call_count
                assert warnings == (2 if failure == "read" else 1)

            recovered = real_flow(with_response=False, host="cache.example.com", path="/items")
            await _request_pair(recovered)
            assert recovered.response is None
            assert recovered.request.headers["Authorization"] == "Bearer recovered"
            assert parse.call_count == 2
            assert compile_.call_count == 2
            assert log.warn.call_count == warnings


async def test_changed_catalog_failure_path_and_reason_are_published(tmp_path, mitm_ctx, real_flow):
    registry_path, cache_path = _write_outage_files(tmp_path)
    missing_path = tmp_path / "other-catalog.json"
    with (
        mitm_ctx(registry_path=str(registry_path), builtin_firewall_catalog_cache_path=""),
        patch.object(
            registry, "_read_registry_sandboxes", wraps=registry._read_registry_sandboxes
        ) as parse,
    ):
        for path, reason in [
            ("", "cache_path_missing"),
            (str(missing_path), "cache_file_missing"),
            (str(cache_path), "cache_untrusted"),
        ]:
            if path == str(cache_path):
                cache_path.chmod(0o620)
            ctx.options.okou_builtin_firewall_catalog_cache_path = path
            before = parse.call_count
            for _ in range(3):
                flow = real_flow(with_response=False, host="cache.example.com", path="/items")
                await _request_pair(flow)
                assert flow.response is not None
                assert flow.response.status_code == 503
                assert reason in flow.response.json()["message"]
                if path:
                    assert path in flow.response.json()["message"]
                observation = registry_observation.snapshot()
                assert observation["catalog"] == {
                    "state": "unavailable",
                    "file": None,
                    "reason": reason,
                }
            assert parse.call_count == before + 1


async def test_failed_catalog_identity_changes_and_inner_recovery_are_observed(
    tmp_path, mitm_ctx, real_flow, fake_firewall_headers
):
    registry_path, cache_path = _write_outage_files(tmp_path)
    with (
        mitm_ctx(registry_path=str(registry_path)),
        patch.object(
            registry, "_read_registry_sandboxes", wraps=registry._read_registry_sandboxes
        ) as parse,
        fake_firewall_headers(headers={"Authorization": "Bearer recovered"}),
    ):
        with _catalog_outage(cache_path, registry_path, "read"):
            for _ in range(3):
                flow = real_flow(with_response=False, host="cache.example.com", path="/items")
                await _request_pair(flow)
                assert flow.response is not None
                assert flow.response.status_code == 503
            assert parse.call_count == 1
            old_stat = cache_path.stat()
            os.utime(cache_path, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns + 1_000_000))
            changed = real_flow(with_response=False, host="cache.example.com", path="/items")
            await _request_pair(changed)
            assert changed.response is not None
            assert changed.response.status_code == 503
            assert parse.call_count == 2
            assert registry_observation.snapshot()["catalog"] == {
                "state": "unavailable",
                "file": {
                    "device": old_stat.st_dev,
                    "inode": old_stat.st_ino,
                    "mtimeNs": old_stat.st_mtime_ns + 1_000_000,
                    "size": old_stat.st_size,
                },
                "reason": "cache_invalid",
            }

        # Recover the inner loader without changing either file or the outer cache.
        builtin_firewall_cache.clear_cache()
        recovered_catalog = builtin_firewall_cache.load_catalog_snapshot(str(cache_path))
        assert recovered_catalog.catalog is not None
        flow = real_flow(with_response=False, host="cache.example.com", path="/items")
        await _request_pair(flow)
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer recovered"
        assert parse.call_count == 3


@pytest.mark.parametrize("transition", ["missing-to-present", "present-to-missing"])
async def test_rebuild_uses_one_catalog_probe_even_if_path_changes_after_it(
    tmp_path, mitm_ctx, real_flow, fake_firewall_headers, transition
):
    registry_path, cache_path = _write_outage_files(tmp_path)
    saved_path = cache_path.with_suffix(".saved")
    with (
        mitm_ctx(registry_path=str(registry_path)),
        fake_firewall_headers(headers={"Authorization": "Bearer recovered"}),
    ):
        registry.load_registry_state(str(registry_path))
        cache_path.rename(saved_path)
        if transition == "present-to-missing":
            registry.load_registry_state(str(registry_path))
            saved_path.rename(cache_path)
        catalog_stat = saved_path.stat() if saved_path.exists() else cache_path.stat()
        real_open = os.open
        real_close = os.close
        probes = 0
        changed = False

        def open_file(path, flags, *args, **kwargs):
            nonlocal probes
            if path == cache_path:
                probes += 1
            try:
                return real_open(path, flags, *args, **kwargs)
            except FileNotFoundError:
                if path == cache_path and transition == "missing-to-present":
                    saved_path.rename(cache_path)
                raise

        def close(fd: int) -> None:
            nonlocal changed
            opened = os.fstat(fd)
            real_close(fd)
            if (
                transition == "present-to-missing"
                and not changed
                and (opened.st_dev, opened.st_ino) == (catalog_stat.st_dev, catalog_stat.st_ino)
            ):
                changed = True
                cache_path.unlink()

        with (
            patch.object(state_file.os, "open", side_effect=open_file),
            patch.object(state_file.os, "close", side_effect=close),
        ):
            state = registry.load_registry_state(str(registry_path))
        assert not isinstance(state, registry.RegistryUnavailable)
        assert probes == 1
        if transition == "missing-to-present":
            assert set(state.invalid_sandboxes) == {"10.200.0.1", "10.200.0.2"}
            assert registry_observation.snapshot()["catalog"] == {
                "state": "unavailable",
                "file": None,
                "reason": "cache_file_missing",
            }
        else:
            assert state.invalid_sandboxes == {}
            assert registry_observation.snapshot()["validEntries"] == 18
            assert state.builtin_firewall_catalog_snapshot is not None
            assert state.builtin_firewall_catalog_snapshot.catalog is not None

        # The next independent lookup immediately observes the new state.
        flow = real_flow(with_response=False, host="cache.example.com", path="/items")
        await _request_pair(flow)
        if transition == "missing-to-present":
            assert flow.response is None
            assert flow.request.headers["Authorization"] == "Bearer recovered"
        else:
            assert flow.response is not None
            assert flow.response.status_code == 503
            assert flow.request.headers.get("Authorization") is None


async def test_registry_updates_and_open_failures_override_equal_catalog_failure(
    tmp_path, mitm_ctx, real_flow
):
    registry_path, cache_path = _write_outage_files(tmp_path)
    cache_path.unlink()
    with mitm_ctx(registry_path=str(registry_path)):
        allowed = real_flow(
            with_response=False,
            client_ip="10.200.0.3",
            host="api.example.com",
            path="/resources/0/123",
        )
        await _request_pair(allowed)
        assert allowed.response is None
        assert allowed.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"

        denied_sandbox = inline_sandbox("run-denied")
        denied_sandbox["firewalls"][0]["firewall"]["apis"][0]["auth"] = {}
        denied_sandbox["networkPolicies"] = {
            "example": {"allow": [], "deny": ["read"], "unknownPolicy": "deny"}
        }
        write_multi_sandbox_registry(
            registry_path,
            {
                "10.200.0.1": builtin_sandbox("run-builtin", "example"),
                "10.200.0.3": denied_sandbox,
            },
        )
        denied = real_flow(
            with_response=False, client_ip="10.200.0.3", host="api.example.com", path="/items"
        )
        await _request_pair(denied)
        assert denied.response is not None
        assert denied.response.status_code == 403
        assert denied.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"

        saved_path = registry_path.with_suffix(".saved")
        registry_path.rename(saved_path)
        unavailable = real_flow(
            with_response=False, client_ip="10.200.0.3", host="api.example.com", path="/items"
        )
        await _request_pair(unavailable)
        assert unavailable.response is not None
        assert unavailable.response.status_code == 503
        assert unavailable.response.json()["error"] == "registry_unavailable"
        saved_path.rename(registry_path)
        recovered = real_flow(
            with_response=False, client_ip="10.200.0.3", host="api.example.com", path="/items"
        )
        await _request_pair(recovered)
        assert recovered.response is not None
        assert recovered.response.status_code == 403
