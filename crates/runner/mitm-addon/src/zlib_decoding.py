"""Bounded complete-stream traversal for zlib-backed encodings."""

import zlib
from dataclasses import dataclass
from typing import Literal

from compressed_input import CompressedInputCursor

ZlibDecodeStatus = Literal[
    "complete",
    "invalid",
    "incomplete",
    "trailing_data",
    "output_limit_exceeded",
]


@dataclass(frozen=True, slots=True)
class ZlibDecodeResult:
    """Structural result from bounded complete-stream zlib traversal.

    ``body`` contains at most ``max_output`` decoded bytes produced before
    ``status`` became terminal. ``completed_members`` advances only when a
    decompressor reaches EOF. Caller-specific failure and compatibility policy
    stays outside this result.
    """

    body: bytes
    status: ZlibDecodeStatus
    completed_members: int


def decode_zlib_bounded(
    data: bytes,
    *,
    wbits: int,
    max_output: int,
    max_members: int | None = None,
) -> ZlibDecodeResult:
    """Decode complete zlib-backed members under one output cap.

    Input is traversed once in bounded chunks. At an exact output boundary,
    each decompressor call may materialize one temporary probe byte so the
    result can distinguish complete empty tails from real overflow. The probe
    byte is never retained in ``body``.

    When ``max_members`` is set, input remaining after that many complete
    members is reported as ``trailing_data`` without interpreting another
    member. Otherwise, remaining input starts another member with the same
    ``wbits`` value.
    """
    if max_output < 0:
        raise ValueError("max_output must be non-negative")
    if max_members is not None and max_members <= 0:
        raise ValueError("max_members must be positive")

    input_cursor = CompressedInputCursor(data)
    if not input_cursor:
        return ZlibDecodeResult(b"", "complete", 0)

    out = bytearray()
    completed_members = 0
    obj = zlib.decompressobj(wbits)

    while input_cursor:
        remaining_output = max_output - len(out)
        try:
            decoded = obj.decompress(
                input_cursor.take(),
                max_length=remaining_output + 1,
            )
        except zlib.error:
            return ZlibDecodeResult(bytes(out), "invalid", completed_members)

        if len(decoded) > remaining_output:
            out.extend(decoded[:remaining_output])
            return ZlibDecodeResult(
                bytes(out),
                "output_limit_exceeded",
                completed_members,
            )
        out.extend(decoded)

        if obj.eof:
            completed_members += 1
            input_cursor.carry(obj.unused_data)
            if not input_cursor:
                return ZlibDecodeResult(bytes(out), "complete", completed_members)
            if max_members is not None and completed_members >= max_members:
                return ZlibDecodeResult(bytes(out), "trailing_data", completed_members)
            obj = zlib.decompressobj(wbits)
        elif obj.unconsumed_tail:
            input_cursor.carry(obj.unconsumed_tail)

    return ZlibDecodeResult(bytes(out), "incomplete", completed_members)
