"""Bounded control admission to the existing main-loop registry owner."""

import asyncio
import threading
from concurrent.futures import Future

import registry
import registry_observation


class RegistryControl:
    def __init__(self, loop: asyncio.AbstractEventLoop, registry_path: str) -> None:
        self._loop = loop
        self._registry_path = registry_path
        self._lock = threading.Lock()
        self._pending: Future[dict[str, object]] | None = None
        self._closed = False

    def apply(self, digest: str) -> Future[dict[str, object]] | None:
        """Reserve until the owner finishes, independently of a control waiter."""
        with self._lock:
            if self._closed or self._pending is not None:
                return None
            future: Future[dict[str, object]] = Future()
            self._pending = future
            try:
                self._loop.call_soon_threadsafe(self._apply, digest, future)
            except RuntimeError:
                self._pending = None
                raise
            return future

    def close(self) -> None:
        """Called on the registry owner loop before control shutdown."""
        with self._lock:
            self._closed = True
            if self._pending is not None:
                self._pending.cancel()
                self._pending = None

    def _apply(self, digest: str, future: Future[dict[str, object]]) -> None:
        with self._lock:
            if self._closed:
                return
        try:
            state = registry.load_registry_state(self._registry_path)
            outcome = (
                "rejected"
                if isinstance(state, registry.RegistryUnavailable)
                else ("applied" if state.digest == digest else "superseded")
            )
            result: dict[str, object] = {
                "expectedDigest": digest,
                "state": outcome,
                "snapshot": registry_observation.snapshot(),
            }
        except Exception as error:
            # Propagate internal invariant failures to the operation boundary;
            # do not label them malformed input or expose the exception text.
            with self._lock:
                self._pending = None
            future.set_exception(error)
        else:
            # Release completed owner work before waking the control thread;
            # receiving a receipt must permit a subsequent application.
            with self._lock:
                self._pending = None
            future.set_result(result)
