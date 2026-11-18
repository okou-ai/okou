"""Bounded compressed-input traversal shared by codec-specific decoders."""

# Bound how much following compressed input a decoder can copy into a member tail.
# One KiB prevents full-body tails while keeping a 64 KiB source to at most
# 64 fresh source slices.
_DEFAULT_INPUT_CHUNK_SIZE = 1024


class CompressedInputCursor:
    """Advance source bytes once while prioritizing bounded decompressor tails."""

    def __init__(self, data: bytes, *, chunk_size: int = _DEFAULT_INPUT_CHUNK_SIZE) -> None:
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        self._source = memoryview(data)
        self._source_offset = 0
        self._pending_input = b""
        self._chunk_size = chunk_size

    def __bool__(self) -> bool:
        return self._source_offset < len(self._source) or self.has_pending

    @property
    def has_pending(self) -> bool:
        """Expose carried input separately from codec-owned buffered output."""
        return bool(self._pending_input)

    def take(self) -> bytes | memoryview:
        if self._pending_input:
            chunk = self._pending_input
            self._pending_input = b""
            return chunk
        chunk = self._source[self._source_offset : self._source_offset + self._chunk_size]
        self._source_offset += len(chunk)
        return chunk

    def carry(self, data: bytes) -> None:
        self._pending_input = data
