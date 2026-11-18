"""Bounded HTTP/1 idle reuse; active leases outlive a retired generation."""

import asyncio
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

    def close(self, loop: asyncio.AbstractEventLoop) -> None:
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
    expiry: asyncio.TimerHandle | None = None


class PoolGeneration:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.retired = False
        self._idle: list[_IdleConnection] = []

    def _discard(self, idle: _IdleConnection) -> None:
        self._idle.remove(idle)
        if idle.expiry is not None:
            idle.expiry.cancel()
        idle.connection.close(self.loop)

    def take(self, key: Hashable) -> HttpConnection | None:
        for idle in reversed(self._idle):
            if idle.key != key:
                continue
            self._idle.remove(idle)
            if idle.expiry is not None:
                idle.expiry.cancel()
            connection = idle.connection
            if not connection.stream.reader.at_eof() and not connection.stream.writer.is_closing():
                return connection
            connection.close(self.loop)
        return None

    def release(self, key: Hashable, connection: HttpConnection) -> bool:
        if self.retired or self.loop.is_closed() or not connection.reusable():
            return False
        connection.protocol.start_next_cycle()
        if len(self._idle) >= MAX_IDLE_CONNECTIONS:
            self._discard(self._idle[0])
        idle = _IdleConnection(key, connection)
        self._idle.append(idle)
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
