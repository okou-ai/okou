"""Bounded HTTP/1 idle reuse; active leases outlive a retired generation."""

import asyncio
import errno
import socket
from collections.abc import Hashable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import NamedTuple

import h11

MAX_IDLE_CONNECTIONS = 4
IDLE_LIFETIME_SECONDS = 60.0


class ConnectedStream(NamedTuple):
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    socket: socket.socket


@dataclass(eq=False)
class HttpConnection:
    stream: ConnectedStream
    protocol: h11.Connection
    _read_ahead: asyncio.Task[bytes] | None = field(default=None, repr=False)

    def start_read_ahead(self) -> asyncio.Task[bytes]:
        probe = asyncio.create_task(self.stream.reader.read(1), eager_start=True)
        self._read_ahead = probe
        return probe

    async def read(self, size: int) -> bytes:
        probe = self._read_ahead
        if probe is None:
            return await self.stream.reader.read(size)
        self._read_ahead = None
        return await probe

    def close(self, loop: asyncio.AbstractEventLoop) -> None:
        probe, self._read_ahead = self._read_ahead, None
        if probe is not None:
            if not loop.is_closed():
                probe.cancel()
            if probe.done() and not probe.cancelled():
                probe.exception()
        try:
            if not loop.is_closed():
                self.stream.writer.transport.abort()
        finally:
            with suppress(OSError):
                self.stream.socket.shutdown(socket.SHUT_RDWR)
            with suppress(OSError):
                self.stream.socket.close()

    def reusable(self) -> bool:
        return (
            self.protocol.our_state is h11.DONE
            and self.protocol.their_state is h11.DONE
            and not self.protocol.trailing_data[0]
            and not self.protocol.trailing_data[1]
            and not self.stream.reader.at_eof()
            and not self.stream.writer.is_closing()
        )


@dataclass(eq=False)
class _IdleConnection:
    key: Hashable = field(repr=False)
    connection: HttpConnection = field(repr=False)
    probe: asyncio.Task[bytes] = field(repr=False)
    expiry: asyncio.TimerHandle | None = None


def is_connection_reset(error: BaseException | None) -> bool:
    return isinstance(error, ConnectionResetError) or (
        isinstance(error, OSError) and error.errno == errno.ECONNRESET
    )


class PoolGeneration:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.retired = False
        self._idle: list[_IdleConnection] = []

    def _discard(self, idle: _IdleConnection) -> None:
        # The idle reader and expiry callback may both become ready before
        # either observes borrowing or retirement.
        if idle not in self._idle:
            return
        self._idle.remove(idle)
        if idle.expiry is not None:
            idle.expiry.cancel()
        idle.connection.close(self.loop)

    def _probe_finished(self, idle: _IdleConnection) -> None:
        error = None if idle.probe.cancelled() else idle.probe.exception()
        if idle not in self._idle:
            return
        if is_connection_reset(error):
            self.retire()
        else:
            # EOF or unsolicited bytes cannot be the next request's response.
            self._discard(idle)

    async def take(self, key: Hashable) -> HttpConnection | None:
        for idle in reversed(self._idle):
            if idle.key != key:
                continue
            self._idle.remove(idle)
            if idle.expiry is not None:
                idle.expiry.cancel()
            connection = idle.connection
            idle.probe.cancel()
            try:
                outcome = (await asyncio.gather(idle.probe, return_exceptions=True))[0]
            except BaseException:
                connection.close(self.loop)
                raise
            error = connection.stream.reader.exception()
            if is_connection_reset(error) or (
                isinstance(outcome, BaseException) and is_connection_reset(outcome)
            ):
                connection.close(self.loop)
                self.retire()
                return None
            if (
                isinstance(outcome, asyncio.CancelledError)
                and error is None
                and not connection.stream.reader.at_eof()
                and not connection.stream.writer.is_closing()
            ):
                # Cancellation can leave newly arrived bytes in StreamReader.
                # Inspect them eagerly, then transfer a pending read to the
                # request without another cancellation/yield before dispatch.
                probe = connection.start_read_ahead()
                if not probe.done():
                    return connection
                error = None if probe.cancelled() else probe.exception()
                if is_connection_reset(error):
                    connection.close(self.loop)
                    self.retire()
                    return None
            connection.close(self.loop)
        return None

    def release(self, key: Hashable, connection: HttpConnection) -> bool:
        if self.retired or self.loop.is_closed() or not connection.reusable():
            return False
        connection.protocol.start_next_cycle()
        if len(self._idle) >= MAX_IDLE_CONNECTIONS:
            self._discard(self._idle[0])
        probe = connection.start_read_ahead()
        idle = _IdleConnection(key, connection, probe)
        self._idle.append(idle)
        probe.add_done_callback(lambda _task: self._probe_finished(idle))
        idle.expiry = self.loop.call_later(IDLE_LIFETIME_SECONDS, self._discard, idle)
        return True

    def retire(self) -> None:
        self.retired = True
        while self._idle:
            self._discard(self._idle[-1])


class ConnectionPools:
    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.current = PoolGeneration(self.loop)
        self.closed = False

    def acquire_generation(self) -> PoolGeneration:
        if self.closed:
            raise RuntimeError("Platform HTTP transport is closed")
        if self.current.retired:
            self.current = PoolGeneration(self.loop)
        return self.current

    def retire(self, failed: PoolGeneration) -> None:
        # Active requests retain their generation through complete responses.
        # A late old failure cannot replace a newer healthy pool.
        if not self.closed and self.current is failed:
            failed.retire()
            self.current = PoolGeneration(self.loop)

    def close(self) -> None:
        self.closed = True
        self.current.retire()
