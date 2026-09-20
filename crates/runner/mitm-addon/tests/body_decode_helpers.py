"""Shared compression helpers for mitm-addon body decoding tests."""

import zlib

import brotli
import zstandard


def track_zlib_decompressor(
    monkeypatch,
    target: str = "body_decoding.zlib.decompressobj",
    *,
    max_output: int | None = None,
) -> dict[str, int]:
    """Retain real zlib decoding while tracking input and enforcing an output budget."""
    real_factory = zlib.decompressobj
    stats = {
        "calls": 0,
        "input_bytes": 0,
        "objects": 0,
        "max_input": 0,
        "max_unused_data": 0,
        "max_output_request": 0,
        "output_bytes": 0,
    }

    class NonConcatenableUnusedData(bytes):
        def __add__(self, _other: object) -> bytes:
            raise TypeError("zlib unused data must not be concatenated")

    class TrackingDecompressionObj:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def decompress(self, chunk, *args, **kwargs):
            stats["calls"] += 1
            stats["input_bytes"] += len(chunk)
            stats["max_input"] = max(stats["max_input"], len(chunk))

            max_length = kwargs.get("max_length", args[0] if args else 0)
            stats["max_output_request"] = max(stats["max_output_request"], max_length)
            if max_output is not None:
                assert max_length > 0, "zlib decompress must set a positive max_length"
                assert max_length <= max_output - stats["output_bytes"], (
                    "zlib decompress exceeds the remaining output budget"
                )

            output = self._wrapped.decompress(chunk, *args, **kwargs)
            if max_output is not None:
                assert len(output) <= max_length, "zlib returned more than max_length"
            stats["output_bytes"] += len(output)
            return output

        @property
        def eof(self):
            return self._wrapped.eof

        @property
        def unused_data(self):
            unused_data = NonConcatenableUnusedData(self._wrapped.unused_data)
            stats["max_unused_data"] = max(stats["max_unused_data"], len(unused_data))
            return unused_data

        @property
        def unconsumed_tail(self):
            return self._wrapped.unconsumed_tail

    def factory(*args, **kwargs):
        stats["objects"] += 1
        return TrackingDecompressionObj(real_factory(*args, **kwargs))

    monkeypatch.setattr(target, factory)
    return stats


def track_zstd_reader(monkeypatch, max_output: int) -> dict[str, int]:
    """Enforce a shared output budget while retaining real zstd decoding."""
    real_factory = zstandard.ZstdDecompressor
    stats = {"max_read": 0, "output_bytes": 0}

    class BoundedReader:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def __enter__(self):
            self._wrapped.__enter__()
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            return self._wrapped.__exit__(exc_type, exc_value, traceback)

        def read(self, size: int = -1) -> bytes:
            assert size >= 0, "zstd read must be bounded"
            assert size <= max_output - stats["output_bytes"], "zstd read exceeds output budget"
            stats["max_read"] = max(stats["max_read"], size)
            output = self._wrapped.read(size)
            assert len(output) <= size
            stats["output_bytes"] += len(output)
            return output

    class TrackingDecompressor:
        def stream_reader(self, *args, **kwargs):
            return BoundedReader(real_factory().stream_reader(*args, **kwargs))

    monkeypatch.setattr("body_decoding.zstandard.ZstdDecompressor", TrackingDecompressor)
    return stats


def track_brotli_decompressor(monkeypatch):
    real_decompressor = brotli.Decompressor
    stats = {
        "calls": 0,
        "max_input": 0,
        "max_output": 0,
        "max_output_buffer_limit": 0,
    }

    class CountingDecompressor:
        def __init__(self):
            self._inner = real_decompressor()

        def process(self, chunk: bytes, output_buffer_limit: int = 0) -> bytes:
            stats["calls"] += 1
            stats["max_input"] = max(stats["max_input"], len(chunk))
            stats["max_output_buffer_limit"] = max(
                stats["max_output_buffer_limit"],
                output_buffer_limit,
            )
            out = self._inner.process(chunk, output_buffer_limit=output_buffer_limit)
            stats["max_output"] = max(stats["max_output"], len(out))
            return out

        def is_finished(self) -> bool:
            return self._inner.is_finished()

        def can_accept_more_data(self) -> bool:
            return self._inner.can_accept_more_data()

    monkeypatch.setattr("body_decoding.brotli.Decompressor", CountingDecompressor)
    return stats


def pseudo_random_ascii(size: int) -> bytes:
    state = 0x12345678
    body = bytearray()
    for _ in range(size):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        body.append(32 + (state % 95))
    return bytes(body)
