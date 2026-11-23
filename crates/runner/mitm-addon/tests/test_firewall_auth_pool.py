"""Physical connection reuse and non-destructive reset generation retirement."""

import asyncio
import json
import os
import socket
import ssl
import struct
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from unittest.mock import patch

import pytest

import data_router
import firewall_auth_client as auth_client
import platform_http_pool
import platform_http_transport as transport
from tests.auth_endpoint_helpers import firewall_auth_success_response
from tests.firewall_auth_helpers import firewall_auth_request
from tests.test_firewall_auth_client import (
    _EMPTY_PROXY_ENVIRONMENT,
    _create_tls_server,
    _RawHttpRequest,
    _read_raw_http_request,
    _run_test_server,
)

type _Reply = Callable[[int, _RawHttpRequest, asyncio.StreamWriter], Awaitable[bool]]


def _response(*, persistent: bool = True) -> bytes:
    body = json.dumps(firewall_auth_success_response({})).encode()
    return (
        b"HTTP/1.1 200 OK\r\n"
        + f"Content-Length: {len(body)}\r\n".encode()
        + (b"" if persistent else b"Connection: close\r\n")
        + b"\r\n"
        + body
    )


async def _reply_success(
    _connection_id: int, _request: _RawHttpRequest, writer: asyncio.StreamWriter
) -> bool:
    writer.write(_response())
    await writer.drain()
    return True


def _reset(writer: asyncio.StreamWriter) -> None:
    writer.get_extra_info("socket").setsockopt(
        socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
    )
    writer.transport.abort()


@dataclass
class _Peer:
    reply: _Reply = _reply_success
    requests: list[tuple[int, _RawHttpRequest]] = field(default_factory=list)
    arrived: asyncio.Queue[tuple[int, _RawHttpRequest]] = field(default_factory=asyncio.Queue)
    closed: list[asyncio.Event] = field(default_factory=list)

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connection_id = len(self.closed)
        closed = asyncio.Event()
        self.closed.append(closed)
        try:
            while True:
                try:
                    request = await _read_raw_http_request(reader)
                except asyncio.IncompleteReadError, ConnectionError:
                    return
                self.requests.append((connection_id, request))
                self.arrived.put_nowait((connection_id, request))
                if not await self.reply(connection_id, request, writer):
                    return
        finally:
            closed.set()


async def _send(origin: str, path: str, *, credential: str = "synthetic-token") -> None:
    await data_router.post_registration(origin + path, b"{}", credential)


@pytest.fixture(autouse=True)
def _direct_environment(monkeypatch):
    for name in _EMPTY_PROXY_ENVIRONMENT:
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("tls", [False, True], ids=["http", "https"])
async def test_auth_and_registration_reuse_connection_without_sharing_request_auth(
    mitm_ctx, tmp_path, monkeypatch, tls: bool
):
    peer = _Peer()
    context = None
    if tls:
        context, ca = _create_tls_server(tmp_path)
        monkeypatch.setenv("SSL_CERT_FILE", str(ca))
        monkeypatch.setenv("SSL_CERT_DIR", "")
    async with _run_test_server(peer.serve, ssl_context=context) as port:
        origin = f"{'https://localhost' if tls else 'http://127.0.0.1'}:{port}"
        with mitm_ctx(api_url=origin):
            result = await auth_client.fetch_firewall_headers(firewall_auth_request())
            assert result.payload.headers == {}
            await _send(origin, "/api/webhooks/run/data-request", credential="different-synthetic")
            await _send(origin, "/third")
        assert [identity for identity, _ in peer.requests] == [0, 0, 0]
        assert len(peer.closed) == 1
        requests = [request for _, request in peer.requests]
        assert requests[0].headers["authorization"] != requests[1].headers["authorization"]
        assert requests[1].headers["authorization"] == "Bearer different-synthetic"
        assert len({request.headers["x-client-request-id"] for request in requests}) == 3
        assert [request.target for request in requests] == [
            "/api/webhooks/run/firewall/auth",
            "/api/webhooks/run/data-request",
            "/third",
        ]
        if tls:
            # A different trust context must establish a new TLS connection,
            # even when its CA happens to trust the same fixture server.
            transport._https_context = ssl.create_default_context()
            await _send(origin, "/new-trust-context")
            await _send(origin, "/new-trust-context-reused")
            assert [identity for identity, _ in peer.requests] == [0, 0, 0, 1, 1]
        transport.close_transport()
        await asyncio.wait_for(peer.closed[0].wait(), 2)


@pytest.mark.parametrize("tls", [False, True], ids=["http", "https"])
async def test_reset_retires_idle_siblings_and_drains_headers_body_and_late_failure(
    tmp_path, monkeypatch, tls: bool
):
    gates = {path: asyncio.Event() for path in ["/headers", "/body", "/reset", "/late"]}
    body_started = asyncio.Event()

    async def reply(_identity, request, writer):
        path = request.target
        if path in gates:
            if path == "/body":
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nab")
                await writer.drain()
                body_started.set()
            await gates[path].wait()
            if path in ["/reset", "/late"]:
                _reset(writer)
                return False
            if path == "/body":
                writer.write(b"cd")
                await writer.drain()
                return True
        return await _reply_success(_identity, request, writer)

    peer = _Peer(reply)
    context = None
    if tls:
        context, ca = _create_tls_server(tmp_path)
        monkeypatch.setenv("SSL_CERT_FILE", str(ca))
        monkeypatch.setenv("SSL_CERT_DIR", "")
    async with _run_test_server(peer.serve, ssl_context=context) as port:
        origin = f"{'https://localhost' if tls else 'http://127.0.0.1'}:{port}"
        async with asyncio.TaskGroup() as tasks:
            headers = tasks.create_task(_send(origin, "/headers"))
            body = tasks.create_task(_send(origin, "/body"))

            async def expect_reset(path):
                with pytest.raises(ConnectionResetError):
                    await _send(origin, path)

            reset = tasks.create_task(expect_reset("/reset"))
            late = tasks.create_task(expect_reset("/late"))
            active = {}
            for _ in gates:
                identity, request = await asyncio.wait_for(peer.arrived.get(), 2)
                active[request.target] = identity
            await asyncio.wait_for(body_started.wait(), 2)

            # Two completed siblings are idle in the old pool, while four
            # independent requests retain their own old-generation sockets.
            await _send(origin, "/idle-one")
            idle_identity, _ = await peer.arrived.get()
            idle_two_gate = asyncio.Event()
            original_reply = peer.reply

            async def hold_idle(identity, request, writer):
                if request.target == "/idle-two":
                    await idle_two_gate.wait()
                return await original_reply(identity, request, writer)

            peer.reply = hold_idle
            idle_two = tasks.create_task(_send(origin, "/idle-two"))
            idle_two_identity, _ = await asyncio.wait_for(peer.arrived.get(), 2)
            await _send(origin, "/idle-three")
            second_idle_identity, _ = await peer.arrived.get()
            idle_two_gate.set()
            await idle_two
            assert idle_two_identity == idle_identity
            assert second_idle_identity != idle_identity

            gates["/reset"].set()
            await reset
            for identity in [idle_identity, second_idle_identity]:
                await asyncio.wait_for(peer.closed[identity].wait(), 2)
            assert not headers.done()
            assert not body.done()
            assert not peer.closed[active["/headers"]].is_set()
            assert not peer.closed[active["/body"]].is_set()

            await _send(origin, "/replacement")
            replacement_identity, _ = await peer.arrived.get()
            assert replacement_identity not in {
                *active.values(),
                idle_identity,
                second_idle_identity,
            }
            gates["/late"].set()
            await late
            await _send(origin, "/replacement-reused")
            assert (await peer.arrived.get())[0] == replacement_identity

            gates["/headers"].set()
            gates["/body"].set()
            await headers
            await body
            await asyncio.wait_for(peer.closed[active["/headers"]].wait(), 2)
            await asyncio.wait_for(peer.closed[active["/body"]].wait(), 2)
            await _send(origin, "/replacement-still-reused")
            assert (await peer.arrived.get())[0] == replacement_identity
        assert len([r for _, r in peer.requests if r.target == "/reset"]) == 1
        assert len([r for _, r in peer.requests if r.target == "/late"]) == 1


@pytest.mark.parametrize("stop", ["cancel", "deadline", "shutdown"])
async def test_active_exchange_lifecycle_closes_only_its_owned_connection(stop, monkeypatch):
    release = asyncio.Event()

    async def reply(identity, request, writer):
        if request.target == "/held":
            await release.wait()
        return await _reply_success(identity, request, writer)

    peer = _Peer(reply)
    async with _run_test_server(peer.serve) as port:
        origin = f"http://127.0.0.1:{port}"
        await _send(origin, "/prime")
        prime_identity, _ = await peer.arrived.get()
        async with asyncio.TaskGroup() as tasks:

            async def held_call():
                if stop == "deadline":
                    with pytest.raises(TimeoutError):
                        await _send(origin, "/held")
                else:
                    await _send(origin, "/held")

            if stop == "deadline":
                monkeypatch.setattr(transport, "REQUEST_DEADLINE_SECONDS", 0.05)
            held = tasks.create_task(held_call())
            identity, _ = await asyncio.wait_for(peer.arrived.get(), 2)
            assert identity == prime_identity
            if stop == "shutdown":
                await _send(origin, "/idle")
                idle_identity, _ = await peer.arrived.get()
                transport.close_transport()
                await asyncio.wait_for(peer.closed[idle_identity].wait(), 2)
                assert not held.done()
                assert not peer.closed[identity].is_set()
                with pytest.raises(RuntimeError, match="closed"):
                    await _send(origin, "/after-shutdown")
            elif stop == "cancel":
                held.cancel()
                with suppress(asyncio.CancelledError):
                    await held
            else:
                await held
            release.set()
            with suppress(asyncio.CancelledError):
                await held
            await asyncio.wait_for(peer.closed[identity].wait(), 2)
            if stop != "shutdown":
                await _send(origin, "/healthy")
                assert (await peer.arrived.get())[0] != identity


@pytest.mark.parametrize("framing", ["close", "http10", "trailing"])
async def test_non_reusable_response_does_not_reenter_pool(framing):
    async def reply(_identity, _request, writer):
        response = _response(persistent=framing != "close")
        if framing == "http10":
            response = response.replace(b"HTTP/1.1", b"HTTP/1.0")
        if framing == "trailing":
            response += b"unexpected-next-response"
        writer.write(response)
        await writer.drain()
        return True

    peer = _Peer(reply)
    async with _run_test_server(peer.serve) as port:
        origin = f"http://127.0.0.1:{port}"
        await _send(origin, "/first")
        await asyncio.wait_for(peer.closed[0].wait(), 2)
        await _send(origin, "/second")
        assert [identity for identity, _ in peer.requests] == [0, 1]


@pytest.mark.parametrize("expiry", [False, True], ids=["idle-capacity", "idle-expiry"])
async def test_idle_limit_and_idle_expiry_release_sockets(monkeypatch, expiry):
    gate = asyncio.Event()

    async def reply(identity, request, writer):
        await gate.wait()
        return await _reply_success(identity, request, writer)

    peer = _Peer(reply)
    monkeypatch.setattr(platform_http_pool, "MAX_IDLE_CONNECTIONS", 2)
    if expiry:
        monkeypatch.setattr(platform_http_pool, "IDLE_LIFETIME_SECONDS", 0.05)
    async with _run_test_server(peer.serve) as port:
        origin = f"http://127.0.0.1:{port}"
        async with asyncio.TaskGroup() as tasks:
            for index in range(3):
                tasks.create_task(_send(origin, f"/{index}"))
            for _ in range(3):
                await asyncio.wait_for(peer.arrived.get(), 2)
            gate.set()
        if not expiry:
            await asyncio.wait_for(peer.closed[0].wait(), 2)
            assert not peer.closed[1].is_set()
            assert not peer.closed[2].is_set()
            transport.close_transport()
        for closed in peer.closed:
            await asyncio.wait_for(closed.wait(), 2)
        if expiry:
            await _send(origin, "/fresh")
            assert peer.requests[-1][0] == 3


async def test_origin_and_proxy_credentials_partition_connections(monkeypatch):
    first = _Peer()
    second = _Peer()
    async with _run_test_server(first.serve) as a, _run_test_server(second.serve) as b:
        origin = f"http://127.0.0.1:{a}"
        other = f"http://127.0.0.1:{b}"
        await _send(origin, "/direct")
        await _send(other, "/other")
        await _send(origin, "/direct-again")
        assert [identity for identity, _ in first.requests] == [0, 0]
        assert len(second.closed) == 1
        # A real HTTP proxy receives absolute-form requests and its own auth;
        # changing proxy credentials must not reuse the previous proxy socket.
        with patch.dict(os.environ, {"http_proxy": f"http://one:secret@127.0.0.1:{b}"}):
            await _send("http://platform.invalid", "/via-one")
        with patch.dict(os.environ, {"http_proxy": f"http://two:secret@127.0.0.1:{b}"}):
            await _send("http://platform.invalid", "/via-two")
        assert [identity for identity, _ in second.requests] == [0, 1, 2]
        assert second.requests[1][1].target == "http://platform.invalid/via-one"
        assert (
            second.requests[1][1].headers["proxy-authorization"]
            != second.requests[2][1].headers["proxy-authorization"]
        )


@pytest.mark.parametrize("fault", ["reset", "unsolicited-data"])
async def test_idle_peer_fault_is_observed_before_next_dispatch(fault):
    release_fault = asyncio.Event()

    async def reply(identity, request, writer):
        await _reply_success(identity, request, writer)
        await release_fault.wait()
        if fault == "reset":
            _reset(writer)
            return False
        writer.write(b"unsolicited-next-response")
        await writer.drain()
        return True

    faulty = _Peer(reply)
    healthy = _Peer()
    async with _run_test_server(faulty.serve) as a, _run_test_server(healthy.serve) as b:
        await _send(f"http://127.0.0.1:{a}", "/idle-fault")
        origin = f"http://127.0.0.1:{b}"
        await _send(origin, "/idle-sibling")
        release_fault.set()
        if fault == "reset":
            # The idle reset must retire its whole generation even though no
            # new request is currently reading from the failed connection.
            await asyncio.wait_for(healthy.closed[0].wait(), 2)
        else:
            await asyncio.wait_for(faulty.closed[0].wait(), 2)
            assert not healthy.closed[0].is_set()
        await _send(origin, "/after-fault")
        assert [identity for identity, _ in healthy.requests] == (
            [0, 1] if fault == "reset" else [0, 0]
        )
        assert len(faulty.requests) == 1


@pytest.mark.parametrize("tls", [False, True], ids=["http", "https"])
async def test_idle_bytes_arriving_during_borrow_cannot_be_the_next_response(
    tmp_path, monkeypatch, tls: bool
):
    writers: list[asyncio.StreamWriter] = []

    async def reply(identity, request, writer):
        writers.append(writer)
        return await _reply_success(identity, request, writer)

    peer = _Peer(reply)
    context = None
    if tls:
        context, ca = _create_tls_server(tmp_path)
        monkeypatch.setenv("SSL_CERT_FILE", str(ca))
        monkeypatch.setenv("SSL_CERT_DIR", "")
    async with _run_test_server(peer.serve, ssl_context=context) as port:
        origin = f"{'https://localhost' if tls else 'http://127.0.0.1'}:{port}"
        await _send(origin, "/first")
        # Queue peer bytes, then borrow without yielding to the idle reader.
        # Cancelling that reader can leave these bytes buffered during checkout.
        writers[0].write(b"HTTP/1.1 418 Unsolicited\r\nContent-Length: 0\r\n\r\n")
        await _send(origin, "/second")
        await _send(origin, "/third")
        assert [identity for identity, _ in peer.requests] == [0, 1, 1]
        assert [request.target for _, request in peer.requests] == [
            "/first",
            "/second",
            "/third",
        ]
