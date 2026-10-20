"""Public request.stream validation with a bounded final-byte holdback."""

import asyncio
from collections.abc import Callable

from mitmproxy import connection, http

import flow_metadata_keys as metadata_keys
from managed_openrouter_json import PolicyError, PolicyJsonValidator

PARSE_BYTES = 4096
_active: set["StreamBody"] = set()


class BodyError(ValueError):
    """Content-free framing failure."""


class StreamBody:
    def __init__(self, length: int, validator: PolicyJsonValidator) -> None:
        self.length = length
        self.received = 0
        self.validator: PolicyJsonValidator | None = validator
        self.validated = False
        self.closed = False
        self.failure: str | None = None
        self.tail = b""
        self.header_ready = asyncio.Event()
        self.writable = asyncio.Event()
        self.protocol_bound = False
        self.reader_bound = False
        self.observe: Callable[[bytes], object] | None = None
        self.revalidate: Callable[[], bool] | None = None
        self.reject: Callable[[str], None] | None = None
        self.flow: http.HTTPFlow | None = None
        _active.add(self)

    def __call__(self, chunk: bytes) -> bytes:
        if self.closed:
            return b""
        self.received += len(chunk)
        if self.observe is not None:
            self.observe(chunk)
        if self.failure is not None:
            return b""
        try:
            return self._forward(chunk)
        except (PolicyError, BodyError) as error:
            self.failure = str(error)
            self.validator = None
            self.tail = b""
            self.revalidate = None
            reject, self.reject = self.reject, None
            # Discard the remaining input until genuine EOF or native timeout.
            # Retain only accounting and reader ownership, never parser state.
            self.header_ready.set()
            self.writable.set()
            if reject is not None:
                reject(self.failure)
            return b""

    def _forward(self, chunk: bytes) -> bytes:
        if self.validated:
            raise BodyError("incomplete_body")
        if chunk:
            if self.received > self.length or self.validator is None:
                raise BodyError("incomplete_body")
            for offset in range(0, len(chunk), PARSE_BYTES):
                self.validator.feed(chunk[offset : offset + PARSE_BYTES])
            if self.received == self.length:
                self.validator.finish()
                self.validator = None
                # Native EOF follows separately. Hold only the last byte
                # until trailers and current authorization have been checked.
                self.tail = chunk[-1:]
                return chunk[:-1]
            return chunk
        if self.received != self.length or self.validator is not None:
            raise BodyError("incomplete_body")
        if self.flow is None or self.flow.request.trailers:
            raise BodyError("trailers")
        if self.revalidate is None or not self.revalidate():
            raise BodyError("authorization_changed")
        self.validated = True
        tail, self.tail = self.tail, b""
        self.observe = self.revalidate = self.reject = None
        if not self.protocol_bound:
            self.upload_complete()
        return tail

    async def wait_ready(self) -> None:
        await self.header_ready.wait()
        await self.writable.wait()

    @property
    def upload_pending(self) -> bool:
        """Include native protocol queues and an undrained socket writer."""
        return self in _active

    def upload_complete(self, *, socket_drained: bool = False) -> None:
        """Protocol completion can precede the owning reader's socket drain."""
        if self.closed or not self.reader_bound or socket_drained:
            _active.discard(self)
        self.writable.set()

    def close(self) -> None:
        self.closed = True
        self.validator = None
        self.tail = b""
        self.observe = self.revalidate = self.reject = None
        self.flow = None
        self.header_ready.set()
        self.upload_complete()


def attach(flow: http.HTTPFlow, body: StreamBody) -> None:
    release(flow)
    body.flow = flow
    flow.metadata[metadata_keys.MANAGED_OPENROUTER_BODY] = body


def get(flow: http.HTTPFlow) -> StreamBody | None:
    value = flow.metadata.get(metadata_keys.MANAGED_OPENROUTER_BODY)
    return value if isinstance(value, StreamBody) else None


def from_request(request: http.Request) -> StreamBody | None:
    value = request.stream
    return value if isinstance(value, StreamBody) else None


def release(flow: http.HTTPFlow) -> None:
    body = flow.metadata.pop(metadata_keys.MANAGED_OPENROUTER_BODY, None)
    if isinstance(body, StreamBody):
        body.close()
        if flow.request.stream is body:
            flow.request.stream = False


def state_for_tests() -> tuple[int, int]:
    return len(_active), sum(body.length for body in _active)


def close_all() -> None:
    """Release all active validators during addon shutdown."""
    for body in tuple(_active):
        body.close()


def reset_for_tests() -> None:
    close_all()


def is_uploading_to(upstream: connection.Connection) -> bool:
    """Identify the opposite native reader of an unfinished managed upload."""
    return any(body.flow is not None and body.flow.server_conn is upstream for body in _active)
