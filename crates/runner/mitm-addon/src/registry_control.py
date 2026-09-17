"""Bounded control admission to the existing main-loop registry owner."""

import asyncio
import threading
from concurrent.futures import Future

import addon_process_logging
import registry
import registry_observation


class RegistryControl:
    def __init__(self, loop: asyncio.AbstractEventLoop, registry_path: str) -> None:
        self._loop = loop
        self._registry_path = registry_path
        self._lock = threading.Lock()
        self._pending: Future[dict[str, object] | None] | None = None
        self._closed = False

    def apply(self, digest: str) -> Future[dict[str, object] | None] | None:
        """Reserve until the owner finishes, independently of a control waiter."""
        with self._lock:
            if self._closed or self._pending is not None:
                return None
            future: Future[dict[str, object] | None] = Future()
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

    def _apply(self, digest: str, future: Future[dict[str, object] | None]) -> None:
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
            result: dict[str, object] | None = {
                "expectedDigest": digest,
                "state": outcome,
                "snapshot": registry_observation.snapshot(),
            }
        except Exception as error:
            # The owner reports failures even after its waiter times out. Do not
            # leave raw exceptions in shielded futures: asyncio can log them
            # after the control handler has gone. None maps to internal_error,
            # never a successful receipt or malformed registry input.
            addon_process_logging.emit_addon_process_event(
                "error", f"Registry control application failed ({type(error).__name__})"
            )
            result = None
        # Release completed owner work before waking the control thread;
        # receiving a receipt must permit a subsequent application.
        with self._lock:
            self._pending = None
        future.set_result(result)
