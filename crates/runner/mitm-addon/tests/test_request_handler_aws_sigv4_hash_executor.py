"""Real worker-start, admission, and shutdown regressions for SigV4 hashing."""

import asyncio
import gc
import json
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

import pytest
from mitmproxy import http

import auth
import aws_sigv4_body_admission as admission
import aws_sigv4_hash_executor
import flow_metadata_keys as metadata_keys
import mitm_addon
import thread_pool
from aws_sigv4 import AwsSigV4BodyHash, hash_request_body
from tests.aws_sigv4_helpers import RESOLVED_AWS_ACCESS_KEY_ID
from tests.test_request_handler_aws_sigv4_body import (
    _header_auth_flow,
    _resolved_token_meta,
    _write_aws_registry,
)


class _TrackedBody(bytes):
    """Observe release of real bytes without retaining them in the test."""

    identifier: int
    released: list[int]

    def __new__(cls, identifier: int, size: int, released: list[int]):
        body = super().__new__(cls, bytes([identifier]) * size)
        body.identifier = identifier
        body.released = released
        return body

    def __del__(self) -> None:
        self.released.append(self.identifier)


class _ControlledHashes:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.started: asyncio.Queue[threading.Thread] = asyncio.Queue()
        self.release = threading.Event()
        self._loop = loop

    def __call__(self, body: bytes | None) -> AwsSigV4BodyHash:
        self._loop.call_soon_threadsafe(self.started.put_nowait, threading.current_thread())
        if not self.release.wait(timeout=2):
            raise AssertionError("controlled SigV4 hash was not released")
        return hash_request_body(body)


@pytest.mark.parametrize("capture_body", [False, True])
@pytest.mark.parametrize("failed_worker", [0, 3], ids=["first-worker", "partial-start"])
async def test_worker_start_failures_release_bodies_and_recover(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    capture_body: bool,
    failed_worker: int,
) -> None:
    loop = asyncio.get_running_loop()
    default_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sigv4-test-default")
    loop.set_default_executor(default_executor)
    registry_path = _write_aws_registry(tmp_path, capture_body=capture_body)
    original_start = threading.Thread.start
    owned_threads: list[threading.Thread] = []
    executors: list[ThreadPoolExecutor] = []
    released: list[int] = []
    flows: list[weakref.ReferenceType[http.HTTPFlow]] = []
    hashed: list[int] = []
    size = admission.MAX_AWS_SIGV4_REQUEST_BODY_BYTES

    def create_executor(*, max_workers: int, thread_name_prefix: str) -> ThreadPoolExecutor:
        executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix=thread_name_prefix
        )
        executors.append(executor)
        return executor

    def fail_start(thread: threading.Thread) -> None:
        if thread.name.startswith(("aws-sigv4-hash_", "sigv4-test-default_")):
            owned_threads.append(thread)
            if thread.name.endswith(f"_{failed_worker}"):
                raise RuntimeError("can't start new thread")
        original_start(thread)

    def observe_hash(body: bytes | None) -> AwsSigV4BodyHash:
        if isinstance(body, _TrackedBody):
            hashed.append(body.identifier)
        return hash_request_body(body)

    try:
        with (
            mitm_ctx(registry_path=str(registry_path)),
            patch.object(
                auth, "get_firewall_headers", AsyncMock(return_value=_resolved_token_meta())
            ),
            patch.object(auth, "hash_request_body", observe_hash),
            patch.object(thread_pool, "ThreadPoolExecutor", side_effect=create_executor),
        ):
            with patch.object(threading.Thread, "start", fail_start):
                # Five distinct maximum-size bodies exceed the aggregate 128 MiB bound.
                for identifier in range(5):
                    flow = _header_auth_flow(
                        real_flow,
                        headers,
                        body=_TrackedBody(identifier, size, released),
                        content_length=str(size),
                    )
                    flows.append(weakref.ref(flow))
                    assert mitm_addon.requestheaders(flow) is None
                    assert admission.state_for_tests() == (1, size)
                    with pytest.raises(RuntimeError, match="can't start new thread"):
                        await mitm_addon.request(flow)
                    assert flow.response is not None
                    assert flow.response.status_code == 500
                    assert json.loads(flow.response.content)["error"] == "request_processing_failed"
                    mitm_addon.response(flow)
                    assert admission.state_for_tests() == (0, 0)
                    del flow

            # Skip the heap scan only once both release oracles are complete.
            if any(flow_ref() is not None for flow_ref in flows) or len(released) != len(flows):
                gc.collect()
            assert all(flow_ref() is None for flow_ref in flows)
            assert sorted(released) == list(range(5))
            assert hashed == []
            assert all(not thread.is_alive() for thread in owned_threads)
            for executor in executors:
                with pytest.raises(RuntimeError, match="shutdown"):
                    executor.submit(lambda: None)

            healthy = _header_auth_flow(real_flow, headers, body=b"healthy", content_length="7")
            assert mitm_addon.requestheaders(healthy) is None
            await mitm_addon.request(healthy)
            assert healthy.response is None
            assert (
                f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/"
                in healthy.request.headers["authorization"]
            )
            healthy.response = http.Response.make(200, b"ok")
            mitm_addon.response(healthy)
            assert admission.state_for_tests() == (0, 0)
            assert hashed == []
            assert await loop.run_in_executor(None, lambda: "unrelated work") == "unrelated work"
    finally:
        aws_sigv4_hash_executor.reset_for_tests()
        default_executor.shutdown(wait=True, cancel_futures=True)
        for executor in executors:
            executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.parametrize(
    ("body_size", "accepted_count"),
    [(1, 16), (32 * 1024 * 1024, 4)],
    ids=["request-count", "body-bytes"],
)
async def test_active_hashes_remain_bounded_without_starting_more_workers(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    body_size: int,
    accepted_count: int,
) -> None:
    loop = asyncio.get_running_loop()
    hasher = _ControlledHashes(loop)
    registry_path = _write_aws_registry(tmp_path)
    tasks: list[asyncio.Task[None]] = []
    flows: list[http.HTTPFlow] = []
    worker_threads: set[threading.Thread] = set()
    original_start = threading.Thread.start

    def fail_hash_worker_start(thread: threading.Thread) -> None:
        if thread.name.startswith("aws-sigv4-hash_"):
            raise RuntimeError("can't start new thread")
        original_start(thread)

    with (
        mitm_ctx(registry_path=str(registry_path)),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=_resolved_token_meta())),
        patch.object(auth, "hash_request_body", hasher),
    ):
        try:
            first = _header_auth_flow(
                real_flow, headers, body=b"a" * body_size, content_length=str(body_size)
            )
            flows.append(first)
            assert mitm_addon.requestheaders(first) is None
            tasks.append(asyncio.create_task(mitm_addon.request(first)))
            worker_threads.add(await asyncio.wait_for(hasher.started.get(), timeout=2))

            # An active hash owns capacity while new worker creation is unavailable.
            with patch.object(threading.Thread, "start", fail_hash_worker_start):
                for identifier in range(1, accepted_count):
                    flow = _header_auth_flow(
                        real_flow,
                        headers,
                        body=bytes([identifier]) * body_size,
                        content_length=str(body_size),
                    )
                    flows.append(flow)
                    assert mitm_addon.requestheaders(flow) is None
                    tasks.append(asyncio.create_task(mitm_addon.request(flow)))
                    worker_threads.add(await asyncio.wait_for(hasher.started.get(), timeout=2))

                assert len(worker_threads) == accepted_count
                assert admission.state_for_tests() == (accepted_count, accepted_count * body_size)
                overflow = _header_auth_flow(real_flow, headers, content_length=str(body_size))
                assert mitm_addon.requestheaders(overflow) is None
                assert overflow.error is not None
                assert (
                    overflow.metadata[metadata_keys.FIREWALL_ERROR]
                    == auth.AWS_SIGV4_REQUEST_BODY_ADMISSION_SATURATED_ERROR
                )
                tasks[0].cancel()
                await asyncio.sleep(0)
                assert not tasks[0].done()
                assert admission.state_for_tests() == (accepted_count, accepted_count * body_size)
                assert await loop.run_in_executor(None, lambda: "progress") == "progress"

                hasher.release.set()
                results = await asyncio.gather(*tasks, return_exceptions=True)
                assert isinstance(results[0], asyncio.CancelledError)
                assert results[1:] == [None] * (accepted_count - 1)
                for flow in flows[1:]:
                    assert flow.response is None
                    assert (
                        f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/"
                        in flow.request.headers["authorization"]
                    )
                    flow.response = http.Response.make(200, b"ok")
                    mitm_addon.response(flow)
                assert admission.state_for_tests() == (0, 0)
        finally:
            hasher.release.set()
            await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("catalog_shutdown_fails", [False, True])
async def test_done_joins_hashes_and_closes_hashing(
    tmp_path,
    real_flow,
    headers,
    mitm_ctx,
    fresh_usage_executor,
    catalog_shutdown_fails: bool,
) -> None:
    hasher = _ControlledHashes(asyncio.get_running_loop())
    registry_path = _write_aws_registry(tmp_path)
    tasks: list[asyncio.Task[None]] = []
    flows: list[http.HTTPFlow] = []

    with (
        mitm_ctx(registry_path=str(registry_path)),
        patch.object(auth, "get_firewall_headers", AsyncMock(return_value=_resolved_token_meta())),
        patch.object(auth, "hash_request_body", hasher),
    ):
        try:
            for _ in range(2):
                flow = _header_auth_flow(real_flow, headers, body=b"body", content_length="4")
                flows.append(flow)
                assert mitm_addon.requestheaders(flow) is None
                tasks.append(asyncio.create_task(mitm_addon.request(flow)))
                await asyncio.wait_for(hasher.started.get(), timeout=2)
            workers = [
                thread
                for thread in threading.enumerate()
                if thread.name.startswith("aws-sigv4-hash_")
            ]
            assert workers
            tasks[0].cancel()
            await asyncio.sleep(0)
            assert not tasks[0].done()
            hasher.release.set()

            if catalog_shutdown_fails:
                with (
                    patch.object(
                        mitm_addon.codex_model_catalog_cache,
                        "shutdown",
                        side_effect=RuntimeError("catalog shutdown failed"),
                    ),
                    pytest.raises(RuntimeError, match="catalog shutdown failed"),
                ):
                    mitm_addon.done()
            else:
                mitm_addon.done()

            assert all(not worker.is_alive() for worker in workers)
            results = await asyncio.gather(*tasks, return_exceptions=True)
            assert isinstance(results[0], asyncio.CancelledError)
            assert results[1] is None
            assert (
                f"Credential={RESOLVED_AWS_ACCESS_KEY_ID}/"
                in flows[1].request.headers["authorization"]
            )
            flows[1].response = http.Response.make(200, b"ok")
            mitm_addon.response(flows[1])

            rejected = _header_auth_flow(real_flow, headers, body=b"body", content_length="4")
            assert mitm_addon.requestheaders(rejected) is None
            with pytest.raises(RuntimeError, match="AWS SigV4 hashing is shut down"):
                await mitm_addon.request(rejected)
            assert rejected.response is not None
            assert rejected.response.status_code == 500
            assert admission.state_for_tests() == (0, 0)
        finally:
            hasher.release.set()
            await asyncio.gather(*tasks, return_exceptions=True)
