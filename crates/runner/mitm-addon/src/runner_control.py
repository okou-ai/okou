"""Private, bounded Runner control I/O, independent of the proxy event loop.

The managed launch directory owns the socket until Runner reaps the process tree.
Never unlink an existing endpoint here, including after a failed bind or shutdown.
Status and log flush share transport; the JSONL writer owns pending prefixes.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import struct
import threading
from concurrent.futures import Future
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING
from uuid import UUID

import addon_process_logging
import jsonl_writer
import registry_observation

if TYPE_CHECKING:
    import registry_control

MAX_FRAME_BYTES = 64 * 1024
MAX_CONNECTIONS = 16
CONNECTION_TIMEOUT_SECONDS = 5.0
LIFECYCLE_TIMEOUT_SECONDS = 5.0
SOCKET_NAME = "control.sock"
LOG_FLUSH_TIMEOUT_SECONDS = 4.0
LOG_FLUSH_POLL_SECONDS = 0.05


def _identifier(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", value) is None:
        raise ValueError("invalid control identifier")
    return value


def _json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate control field")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise ValueError("invalid JSON constant")


def _bind(directory: Path) -> socket.socket:
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(directory_fd)
        if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
            raise PermissionError("control directory must be private to the addon user")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            # Directory-FD aliases avoid sockaddr_un's pathname limit without
            # changing process cwd or moving ownership outside the launch.
            listener.bind(f"/proc/self/fd/{directory_fd}/{SOCKET_NAME}")
            os.chmod(SOCKET_NAME, 0o600, dir_fd=directory_fd)
            listener.setblocking(False)
            listener.listen(MAX_CONNECTIONS)
            return listener
        except BaseException:
            listener.close()
            raise
    finally:
        os.close(directory_fd)


class ControlServer:
    """One launch's I/O owner; callers must stop it before blocking addon drains."""

    def __init__(
        self,
        directory: Path,
        generation: str,
        registry_owner: registry_control.RegistryControl | None = None,
    ) -> None:
        self._directory = directory
        self._generation = _identifier(generation)
        self._registry_owner = registry_owner
        self._started: Future[None] = Future()
        self._shutdown: Future[None] = Future()
        self._tasks: set[asyncio.Task[None]] = set()
        self._connections: set[socket.socket] = set()
        self._thread = threading.Thread(target=self._run, name="runner-control", daemon=True)

    def start(self) -> None:
        self._thread.start()
        try:
            self._started.result(timeout=LIFECYCLE_TIMEOUT_SECONDS)
        except BaseException:
            self.stop()
            raise

    def stop(self) -> None:
        if not self._shutdown.done():
            self._shutdown.set_result(None)
        if self._thread.ident is not None:
            self._thread.join(timeout=LIFECYCLE_TIMEOUT_SECONDS)
            if self._thread.is_alive():
                raise TimeoutError("addon control thread did not stop")

    def _run(self) -> None:
        try:
            asyncio.run(self._serve())
        except Exception as error:
            if not self._started.done():
                self._started.set_exception(error)
            else:
                addon_process_logging.emit_addon_process_event(
                    "error", f"Addon control server stopped ({type(error).__name__})"
                )

    async def _serve(self) -> None:
        with _bind(self._directory) as listener:
            accept = asyncio.create_task(self._accept(listener))
            try:
                self._started.set_result(None)
                shutdown = asyncio.wrap_future(self._shutdown)
                completed, _ = await asyncio.wait(
                    (accept, shutdown), return_when=asyncio.FIRST_COMPLETED
                )
                if accept in completed:
                    accept.result()
            finally:
                accept.cancel()
                await asyncio.gather(accept, return_exceptions=True)
                # A task can be cancelled before its coroutine starts, so its
                # finally block alone cannot own every accepted socket.
                for connection in self._connections:
                    connection.close()
                tasks = tuple(self._tasks)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                self._connections.clear()

    async def _accept(self, listener: socket.socket) -> None:
        loop = asyncio.get_running_loop()
        while not self._shutdown.done():
            # sock_accept can complete synchronously for an always-full backlog;
            # let admitted handlers, timeouts and shutdown run between accepts.
            await asyncio.sleep(0)
            connection, _ = await loop.sock_accept(listener)
            if self._shutdown.done() or len(self._tasks) >= MAX_CONNECTIONS:
                # Nothing has been read: no correlation can be acknowledged.
                connection.close()
                continue
            self._connections.add(connection)
            task = asyncio.create_task(self._handle(connection))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _handle(self, connection: socket.socket) -> None:
        try:
            async with asyncio.timeout(CONNECTION_TIMEOUT_SECONDS):
                size = struct.unpack("!I", await _read_exact(connection, 4))[0]
                if not 0 < size <= MAX_FRAME_BYTES:
                    return
                response = await self._reply(await _read_exact(connection, size))
                payload = json.dumps(response, separators=(",", ":"), allow_nan=False).encode()
                if len(payload) > MAX_FRAME_BYTES:
                    raise ValueError("control response exceeds frame limit")
                await asyncio.get_running_loop().sock_sendall(
                    connection, struct.pack("!I", len(payload)) + payload
                )
        except (TimeoutError, OSError, EOFError):
            # A disconnected/slow peer has no outcome to acknowledge. This
            # writer retains any pending flush ticket independently of this peer.
            pass
        finally:
            connection.close()
            self._connections.discard(connection)

    async def _reply(self, payload: bytes) -> dict[str, object]:
        request_id: str | None = None
        try:
            request: object = json.loads(
                payload.decode("utf-8"),
                object_pairs_hook=_json_object,
                parse_constant=_reject_constant,
            )
            if not isinstance(request, dict):
                return self._error(None, "invalid_request")
            request_id = _identifier(request.get("requestId"))
            if set(request) != {"requestId", "generation", "method", "params"}:
                return self._error(request_id, "invalid_request")
            generation = _identifier(request["generation"])
            method = _identifier(request["method"])
            if not isinstance(request["params"], dict):
                return self._error(request_id, "invalid_request")
            if generation != self._generation:
                return self._error(request_id, "stale_generation")
            if method == "logs.flush":
                return await self._flush_logs(request_id, request["params"])
            if method == "registry.apply":
                return await self._apply_registry(request_id, request["params"])
            if method == "registry.status":
                if request["params"]:
                    return self._error(request_id, "invalid_request")
                return self._result(request_id, registry_observation.snapshot())
            if method != "proxy.status":
                return self._error(request_id, "unknown_method")
            if request["params"]:
                return self._error(request_id, "invalid_request")
        except (ValueError, RecursionError):
            return self._error(request_id, "invalid_request")
        return {
            "requestId": request_id,
            "generation": self._generation,
            "type": "result",
            "data": {"state": "running"},
        }

    def _result(self, request_id: str, data: dict[str, object]) -> dict[str, object]:
        return {
            "requestId": request_id,
            "generation": self._generation,
            "type": "result",
            "data": data,
        }

    async def _apply_registry(
        self, request_id: str, params: dict[str, object]
    ) -> dict[str, object]:
        digest = params.get("digest")
        if (
            set(params) != {"digest"}
            or not isinstance(digest, str)
            or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        ):
            return self._error(request_id, "invalid_request")
        if self._registry_owner is None:
            return self._error(request_id, "not_ready")
        future = self._registry_owner.apply(digest)
        if future is None:
            return self._error(request_id, "busy")
        try:
            async with asyncio.timeout(4.0):
                result = await asyncio.shield(asyncio.wrap_future(future))
        except TimeoutError:
            return self._error(request_id, "deadline")
        except Exception as error:
            addon_process_logging.emit_addon_process_event(
                "error", f"Registry control application failed ({type(error).__name__})"
            )
            return self._error(request_id, "internal_error")
        return self._result(request_id, result)

    async def _flush_logs(self, request_id: str, params: dict[str, object]) -> dict[str, object]:
        if set(params) != {"runId", "path"}:
            return self._error(request_id, "invalid_request")
        run_id = params["runId"]
        path = params["path"]
        if not isinstance(run_id, str) or str(UUID(run_id)) != run_id:
            return self._error(request_id, "invalid_request")
        if not isinstance(path, str) or "\x00" in path:
            return self._error(request_id, "invalid_request")
        log_path = PurePosixPath(path)
        if (
            not log_path.is_absolute()
            or str(log_path) != path
            or ".." in log_path.parts
            or log_path.name != f"network-{run_id}.jsonl"
        ):
            return self._error(request_id, "invalid_request")
        # This host-only request observes an exact writer key. It neither opens
        # a supplied path nor resolves a now-unregistered run through a reused IP.
        boundary = jsonl_writer.capture_flush_boundary(path)
        if boundary is None:
            return self._error(request_id, "busy")
        deadline = asyncio.get_running_loop().time() + LOG_FLUSH_TIMEOUT_SECONDS
        while pending := boundary.pending_count():
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            await asyncio.sleep(min(LOG_FLUSH_POLL_SECONDS, remaining))
        return {
            "requestId": request_id,
            "generation": self._generation,
            "type": "result",
            "data": {
                "runId": run_id,
                "path": path,
                "boundary": boundary.sequence,
                "pending": pending,
                "state": "deadline" if pending else "processed",
            },
        }

    def _error(self, request_id: str | None, code: str) -> dict[str, object]:
        return {
            "requestId": request_id,
            "generation": self._generation,
            "type": "error",
            "code": code,
        }


async def _read_exact(connection: socket.socket, size: int) -> bytes:
    payload = bytearray()
    loop = asyncio.get_running_loop()
    while len(payload) < size:
        chunk = await loop.sock_recv(connection, size - len(payload))
        if not chunk:
            raise EOFError("incomplete control frame")
        payload.extend(chunk)
    return bytes(payload)
