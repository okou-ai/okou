"""Application evidence through real control sockets and the normal registry owner."""

import asyncio
import hashlib
import json
import os
import threading
from uuid import uuid4

import pytest

import logging_utils
import mitm_addon
import registry
import registry_control
import runner_control
from tests.control_helpers import (
    control_connection,
    exchange,
    frame,
    log_flush_request,
    read_reply,
    registry_apply_request,
    registry_status_request,
)
from tests.registry_builtin_helpers import (
    cache_firewall,
    github_cache_firewall,
    write_catalog_cache,
)
from tests.registry_helpers import (
    builtin_sandbox,
    write_multi_sandbox_registry,
    write_simple_registry,
)


@pytest.fixture
async def control(tmp_path):
    owner = registry_control.RegistryControl(
        asyncio.get_running_loop(), str(tmp_path / "registry.json")
    )
    server = runner_control.ControlServer(tmp_path, "generation-1", owner)
    server.start()
    try:
        yield owner
    finally:
        owner.close()
        server.stop()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def apply(directory, expected):
    response = await asyncio.to_thread(exchange, directory, registry_apply_request(expected))
    return response_data(response)


def response_data(response):
    assert response["type"] == "result", response
    data = response["data"]
    assert isinstance(data, dict)
    return data


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"digest": "A" * 64},
        {"digest": "a" * 63},
        {"digest": 1},
        {"digest": "a" * 64, "path": "/caller-chosen-registry"},
    ],
)
async def test_apply_rejects_noncanonical_identity_and_caller_paths(tmp_path, control, params):
    request = registry_apply_request("a" * 64)
    request["params"] = params
    assert exchange(tmp_path, request)["code"] == "invalid_request"
    assert exchange(tmp_path, registry_status_request())["data"] == {"state": "unobserved"}


async def test_actual_bytes_and_request_time_unavailability(tmp_path, control, mitm_ctx, real_flow):
    path = tmp_path / "registry.json"
    write_simple_registry(path)
    expected = digest(path)
    assert exchange(tmp_path, registry_status_request())["data"] == {"state": "unobserved"}
    with mitm_ctx(registry_path=str(path)):
        result = await apply(tmp_path, expected)
        assert result["state"] == "applied"
        assert result["snapshot"]["digest"] == expected
        assert result["snapshot"]["file"]["inode"] == path.stat().st_ino
        assert result["snapshot"]["catalog"] == {"state": "not_used"}
        assert result["snapshot"]["validEntries"] == 1

        replacement = tmp_path / "replacement.json"
        write_simple_registry(replacement, run_id="run-replacement")
        replacement.replace(path)
        superseded = await apply(tmp_path, expected)
        assert superseded["state"] == "superseded"
        assert superseded["snapshot"]["digest"] == digest(path)

        path.unlink()
        # Cached control status neither reloads nor pretends to check disk.
        assert exchange(tmp_path, registry_status_request())["data"] == superseded["snapshot"]
        flow = real_flow(with_response=False)
        await mitm_addon.request(flow)
        assert flow.response.status_code == 503
        assert json.loads(flow.response.content)["error"] == "registry_unavailable"
        assert (
            response_data(exchange(tmp_path, registry_status_request()))["state"] == "unavailable"
        )


async def test_catalog_updates_and_omission_belong_to_actual_snapshot(tmp_path, control, mitm_ctx):
    path = tmp_path / "registry.json"
    cache = tmp_path / "catalog.json"
    write_multi_sandbox_registry(path, {"10.200.0.1": builtin_sandbox("run-1", "github")})
    write_catalog_cache(
        cache,
        digest="sha256:" + "a" * 64,
        version="a",
        firewalls={"github": github_cache_firewall()},
    )
    expected = digest(path)
    with mitm_ctx(registry_path=str(path), builtin_firewall_catalog_cache_path=str(cache)):
        first = await apply(tmp_path, expected)
        assert first["snapshot"]["catalog"]["digest"] == "a" * 64
        assert first["snapshot"]["omittedEntries"] == 0
        replacement = tmp_path / "catalog-next.json"
        write_catalog_cache(
            replacement,
            digest="sha256:" + "b" * 64,
            version="b",
            firewalls={"retained": cache_firewall("retained", "https://retained.example.com")},
        )
        replacement.replace(cache)
        second = await apply(tmp_path, expected)
        assert second["state"] == "applied"
        assert second["snapshot"]["catalog"]["file"]["inode"] == cache.stat().st_ino
        assert second["snapshot"]["catalog"]["digest"] == "b" * 64
        assert second["snapshot"]["omittedEntries"] == 1
        assert second["snapshot"]["entries"] == [
            {
                "sourceIp": "10.200.0.1",
                "reason": "omitted_intents",
                "builtinCount": 1,
                "customCount": 0,
            }
        ]
        cache.unlink()
        unavailable = await apply(tmp_path, expected)
        assert unavailable["snapshot"]["catalog"]["state"] == "unavailable"
        assert unavailable["snapshot"]["catalog"]["reason"] == "cache_file_missing"
        write_catalog_cache(
            cache,
            digest="sha256:" + "a" * 64,
            version="a",
            firewalls={"github": github_cache_firewall()},
        )
        recovered = await apply(tmp_path, expected)
        assert recovered["snapshot"]["omittedEntries"] == 0


async def test_rejected_input_and_bounded_redacted_entry_outcomes(tmp_path, control, mitm_ctx):
    path = tmp_path / "registry.json"
    path.write_text("{invalid secret bytes")
    with mitm_ctx(registry_path=str(path)):
        result = await apply(tmp_path, digest(path))
        assert result["state"] == "rejected"
        assert result["snapshot"]["reason"] == "parse_failed"
        assert result["snapshot"]["digest"] == digest(path)
        assert "secret" not in json.dumps(result)
        # Invalid source keys and entry messages are not a raw data return path.
        write_multi_sandbox_registry(path, {f"credential-{i}": "private" for i in range(100)})
        partial = await apply(tmp_path, digest(path))
        snapshot = partial["snapshot"]
        assert partial["state"] == "applied"
        assert snapshot["rejectedEntries"] == 100
        assert len(snapshot["entries"]) == 32
        assert snapshot["truncated"] is True
        assert snapshot["entries"][0] == {"sourceIp": None, "reason": "invalid_sandbox_entry"}
        assert "credential" not in json.dumps(partial)
        assert "private" not in json.dumps(partial)


@pytest.mark.parametrize("disconnect", [False, True])
async def test_stalled_application_retains_admission_and_allows_status_and_logs(
    tmp_path, control, mitm_ctx, monkeypatch, disconnect
):
    path = tmp_path / "registry.json"
    write_simple_registry(path)
    expected = digest(path)
    inode = path.stat().st_ino
    entered = threading.Event()
    release = threading.Event()
    real_read = os.read

    def blocked_read(fd, count):
        if os.fstat(fd).st_ino == inode:
            entered.set()
            assert release.wait(10), "test peer did not release the filesystem read"
        return real_read(fd, count)

    def peer():
        try:
            with control_connection(tmp_path) as connection:
                connection.sendall(frame(json.dumps(registry_apply_request(expected)).encode()))
                assert entered.wait(5)
                assert exchange(tmp_path)["data"] == {"state": "running"}
                assert exchange(tmp_path, registry_status_request())["data"] == {
                    "state": "unobserved"
                }
                run_id = str(uuid4())
                log_path = tmp_path / f"network-{run_id}.jsonl"
                logging_utils.log_proxy_entry(str(log_path), "info", "independent log")
                assert (
                    response_data(exchange(tmp_path, log_flush_request(log_path, run_id)))["state"]
                    == "processed"
                )
                if disconnect:
                    connection.close()
                else:
                    assert read_reply(connection)["code"] == "deadline"
                assert exchange(tmp_path, registry_apply_request(expected))["code"] == "busy"
        finally:
            release.set()

    with mitm_ctx(registry_path=str(path)):
        monkeypatch.setattr(os, "read", blocked_read)
        await asyncio.to_thread(peer)
        assert response_data(exchange(tmp_path, registry_status_request()))["digest"] == expected
        # Owner completion, not client completion, makes another apply possible.
        assert (await apply(tmp_path, expected))["state"] == "applied"


@pytest.mark.parametrize("after_deadline", [False, True])
async def test_internal_failure_remains_owned_and_redacted_after_waiter_deadline(
    tmp_path, control, mitm_ctx, monkeypatch, caplog, after_deadline
):
    path = tmp_path / "registry.json"
    write_simple_registry(path)
    expected = digest(path)
    inode = path.stat().st_ino
    entered = threading.Event()
    release = threading.Event()
    real_read = os.read

    def failed_read(fd, count):
        if os.fstat(fd).st_ino == inode:
            entered.set()
            assert release.wait(10), "test peer did not release the filesystem read"
            raise RuntimeError("private registry failure detail")
        return real_read(fd, count)

    def peer():
        try:
            with control_connection(tmp_path) as connection:
                connection.sendall(frame(json.dumps(registry_apply_request(expected)).encode()))
                assert entered.wait(5)
                if after_deadline:
                    assert read_reply(connection)["code"] == "deadline"
                    assert exchange(tmp_path, registry_apply_request(expected))["code"] == "busy"
                else:
                    release.set()
                    assert read_reply(connection)["code"] == "internal_error"
        finally:
            release.set()

    with mitm_ctx(registry_path=str(path)) as log:
        monkeypatch.setattr(os, "read", failed_read)
        await asyncio.to_thread(peer)
        monkeypatch.setattr(os, "read", real_read)
        # A new real request proves the owner and control loop have progressed
        # beyond the failed operation, including its completion callbacks.
        assert (await apply(tmp_path, expected))["state"] == "applied"
        assert "private registry failure detail" not in caplog.text
        assert "exception was never retrieved" not in caplog.text
        log.error.assert_called_once_with("Registry control application failed (RuntimeError)")


async def test_shutdown_cancels_queued_application_without_loading_files(tmp_path, control):
    path = tmp_path / "registry.json"
    write_simple_registry(path)
    # A queued callback cannot run until this owner-loop turn yields.
    future = control.apply(digest(path))
    assert future is not None
    control.close()
    await asyncio.sleep(0)
    assert future.cancelled()
    assert exchange(tmp_path, registry_status_request())["data"] == {"state": "unobserved"}
    assert exchange(tmp_path, registry_apply_request(digest(path)))["code"] == "busy"


async def test_apply_uses_the_opened_file_when_path_is_replaced(
    tmp_path, control, mitm_ctx, monkeypatch
):
    path = tmp_path / "registry.json"
    write_simple_registry(path)
    expected = digest(path)
    old_inode = path.stat().st_ino
    next_path = tmp_path / "next.json"
    write_simple_registry(next_path, run_id="replacement")
    replacement_digest = digest(next_path)
    real_read = os.read

    def replace_after_open(fd, count):
        if os.fstat(fd).st_ino == old_inode and next_path.exists():
            next_path.replace(path)
        return real_read(fd, count)

    with mitm_ctx(registry_path=str(path)):
        monkeypatch.setattr(os, "read", replace_after_open)
        applied = await apply(tmp_path, expected)
        assert applied["state"] == "applied"
        assert applied["snapshot"]["file"]["inode"] == old_inode
        assert applied["snapshot"]["digest"] == expected
        current = await apply(tmp_path, expected)
        assert current["state"] == "superseded"
        assert current["snapshot"]["digest"] == replacement_digest
        assert registry.load_registry(str(path))["10.200.0.1"]["runId"] == "replacement"
