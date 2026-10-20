"""One streamed upload owner; no declared-size or request-count reservation."""

import asyncio
from collections.abc import Callable, Iterable
from enum import Enum, auto
from typing import Protocol
from weakref import WeakSet

from mitmproxy import http

import flow_metadata_keys as keys

_uploads: WeakSet["Upload"] = WeakSet()
PARSE_SLICE = 4096


class UploadRejectedError(ValueError):
    """A fixed reason without request content."""


class DocumentValidator(Protocol):
    def feed(self, chunk: bytes) -> None: ...
    def finish(self) -> None: ...


class Phase(Enum):
    RECEIVING = auto()
    REJECTED = auto()
    COMPLETE = auto()
    CLOSED = auto()


class Upload:
    def __init__(self, flow: http.HTTPFlow, length: int, validator: DocumentValidator) -> None:
        self.flow: http.HTTPFlow | None = flow
        self.length = length
        self.received = 0
        self.validator: DocumentValidator | None = validator
        self.phase = Phase.RECEIVING
        self.failure: str | None = None
        self.tail = b""
        self.ready = asyncio.Event()
        self.native_h2 = False
        self.transport_pending = True
        self.detach_reader: Callable[[], None] | None = None
        self.observe: Callable[[bytes], object] | None = None
        self.authorized: Callable[[], bool] | None = None
        self.on_reject: Callable[[str], None] | None = None
        _uploads.add(self)

    def __call__(self, chunk: bytes) -> bytes | Iterable[bytes]:
        if self.phase is Phase.CLOSED:
            return ()
        self.received += len(chunk)
        if self.observe is not None:
            self.observe(chunk)
        if self.phase is Phase.REJECTED:
            return ()
        try:
            return self._validated_bytes(chunk)
        except UploadRejectedError as error:
            self.failure = str(error)
            self.phase = Phase.REJECTED
            self.validator = None
            self.tail = b""
            self.authorized = None
            callback, self.on_reject = self.on_reject, None
            self.ready.set()
            if callback is not None:
                callback(self.failure)
            # Empty bytes still produces a native data command. Discard emits
            # no command, including behind an exhausted H2 window or stream slot.
            return ()

    def _validated_bytes(self, chunk: bytes) -> bytes:
        if self.phase is Phase.COMPLETE:
            raise UploadRejectedError("incomplete_body")
        if chunk:
            if self.received > self.length or self.validator is None:
                raise UploadRejectedError("incomplete_body")
            for offset in range(0, len(chunk), PARSE_SLICE):
                self.validator.feed(chunk[offset : offset + PARSE_SLICE])
            if self.received == self.length:
                self.validator.finish()
                self.validator = None
                self.tail = chunk[-1:]
                return chunk[:-1]
            return chunk
        if self.received != self.length or self.validator is not None:
            raise UploadRejectedError("incomplete_body")
        if self.flow is None or self.flow.request.trailers:
            raise UploadRejectedError("trailers")
        if self.authorized is None or not self.authorized():
            raise UploadRejectedError("authorization_changed")
        self.phase = Phase.COMPLETE
        result, self.tail = self.tail, b""
        self.observe = self.authorized = self.on_reject = None
        return result

    def drained(self) -> None:
        """The owning reader finished native protocol and socket draining."""
        self.transport_pending = False
        detach, self.detach_reader = self.detach_reader, None
        if detach is not None:
            detach()

    def close(self) -> None:
        self.phase = Phase.CLOSED
        self.validator = None
        self.tail = b""
        self.observe = self.authorized = self.on_reject = None
        self.flow = None
        self.ready.set()
        self.drained()
        _uploads.discard(self)


def attach(flow: http.HTTPFlow, upload: Upload) -> None:
    release(flow)
    flow.metadata[keys.MANAGED_OPENROUTER_UPLOAD] = upload


def get(flow: http.HTTPFlow) -> Upload | None:
    value = flow.metadata.get(keys.MANAGED_OPENROUTER_UPLOAD)
    return value if isinstance(value, Upload) else None


def from_request(request: http.Request) -> Upload | None:
    value = request.stream
    return value if isinstance(value, Upload) else None


def release(flow: http.HTTPFlow) -> None:
    upload = flow.metadata.pop(keys.MANAGED_OPENROUTER_UPLOAD, None)
    if isinstance(upload, Upload):
        upload.close()
        if flow.request.stream is upload:
            flow.request.stream = False


def close_all() -> None:
    for upload in tuple(_uploads):
        upload.close()
