"""Cooperative, owner-loop response inspection with no input queue.

The version-locked transport bridge joins pending inspection before the next
body event and before the connection reads again. A callback retains one lazy
wire-input iterator, one decoded delivery and the parser's bounded state; it
never eagerly decodes or queues the rest of a compressed body.
"""

import asyncio
from collections.abc import Callable, Generator, Iterator

# Each step is at most one already-bounded row (including identity/reporting)
# or one decoder-chunk-bounded partial/discarded fragment. This is an aggregate
# quantum across ALL decoded deliveries, not a new allowance for each feed.
_STEPS_PER_TURN = 8
INSPECTION_INTERRUPTED = "response inspection interrupted"


class CooperativeResponseInspection:
    def __init__(
        self,
        steps: Callable[[bytes], Generator[None, None, None]],
        fail: Callable[[str], None],
    ) -> None:
        self._steps = steps
        self._fail = fail
        self._pending: Generator[None, None, None] | None = None
        self._draining: asyncio.Future[None] | None = None
        self._closed = False

    def has_pending(self) -> bool:
        return self._pending is not None

    def feed(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        if self._pending is not None:
            raise RuntimeError("response inspection must finish before the next wire callback")
        self._pending = self._steps(chunk)
        try:
            self._advance()
        except BaseException:
            self.close()
            raise

    def _advance(self) -> None:
        pending = self._pending
        if pending is None:
            return
        for _ in range(_STEPS_PER_TURN):
            try:
                next(pending)
            except StopIteration:
                self._pending = None
                return

    async def drain(self) -> None:
        """Join one owner; all other callers wait without replaying its work."""
        if self._draining is not None:
            await asyncio.shield(self._draining)
            return
        if self._pending is None:
            return
        completed = asyncio.get_running_loop().create_future()
        self._draining = completed
        try:
            while self._pending is not None:
                # Yield before the next quantum, including the first deferred
                # one, so another ready callback can run after stream() returns.
                await asyncio.sleep(0)
                self._advance()
        except BaseException:
            self.close()
            raise
        finally:
            self._draining = None
            completed.set_result(None)

    def close(self) -> None:
        """Release input, and make abandonment explicitly unparsed, not zero."""
        self._closed = True
        pending, self._pending = self._pending, None
        if pending is not None:
            pending.close()
            self._fail(INSPECTION_INTERRUPTED)


def decoded_steps(
    iter_chunks: Callable[[bytes], Iterator[bytes]],
    feed_steps: Callable[[bytes], Iterator[None]],
    chunk: bytes,
) -> Generator[None, None, None]:
    for decoded in iter_chunks(chunk):
        yield from feed_steps(decoded)
