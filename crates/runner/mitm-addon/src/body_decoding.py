"""HTTP body decoding helpers shared by streaming and usage extraction paths.

Exports:

- Bounded streaming usage decoding for gzip, deflate, br; one-shot
  decompression for gzip, deflate, br, zstd.
- Request and response network-log capture decoding that hides failed bodies.
- JSON usage decompression with diagnostic error classification.
"""

import zlib
from collections.abc import Callable
from typing import Literal, NamedTuple

import brotli  # type: ignore[import-untyped]
import zstandard
from mitmproxy import http

import content_encoding
from body_limits import (
    DEFAULT_BODY_DECODE_LIMIT,
    LARGE_RESPONSE_DECOMPRESS_LIMIT,
    STREAM_DECODE_CHUNK_LIMIT,
    STREAM_DECODE_EXPANSION_GRACE,
    STREAM_DECODE_MAX_EXPANSION_RATIO,
)
from stream_capture import CapturedStreamBody
from zlib_decoding import decode_zlib_bounded
from zlib_input import ZlibInputCursor

# Brotli 1.2's output_buffer_limit is a soft allocation threshold, not a hard
# returned-byte cap. Keep small compressed inputs on tiny chunks as a second
# high-compression guard, but scale up for larger inputs to avoid thousands of
# Python-to-C calls.
_BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE = 16
_BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE = 1024
_BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS = 64
# zstd's Python decompression object has no zlib-style max_length argument.
# Keep validation input chunks small so the discarded decoded output is bounded.
_ZSTD_VALIDATE_INPUT_CHUNK_SIZE = 32
# Preserve ordinary concatenation with substantial headroom while capping
# per-frame decoder construction independently of compressed and decoded bytes.
_ZSTD_VALIDATE_MAX_FRAMES = 64
INVALID_COMPRESSED_BODY = "invalid compressed body"
INCOMPLETE_COMPRESSED_BODY = "incomplete compressed body"
DECODED_BODY_LIMIT_EXCEEDED = "decoded body limit exceeded"
COMPRESSED_FRAME_LIMIT_EXCEEDED = "compressed frame limit exceeded"
_CONTENT_ENCODING_HEADER_LIMIT_EXCEEDED = "content encoding header inspection limit exceeded"
_STREAM_ZLIB_WBITS_BY_ENCODING = {
    "gzip": 16 + zlib.MAX_WBITS,
    "deflate": zlib.MAX_WBITS,
}
_STREAM_DECODABLE_CONTENT_ENCODINGS = (*_STREAM_ZLIB_WBITS_BY_ENCODING, "br", "identity")
_SUPPORTED_ONE_SHOT_BODY_ENCODINGS = frozenset({"gzip", "deflate", "br", "zstd"})


class _BodyDecodeResult(NamedTuple):
    """Internal low-level bounded decode result.

    ``body`` may be original wire bytes, decoded bytes, partial decoded bytes,
    or ``b""`` depending on codec state and output limits. ``failed`` is only a
    primitive decode signal, not a general "body unusable" policy verdict.
    ``error`` is populated when a supported codec raises while decoding.
    """

    body: bytes
    failed: bool
    error: Exception | None = None


_StreamDecodeFeed = Callable[[bytes], None]
_StreamDecodeFinishError = Callable[[], str | None]
_StreamDecodeShouldContinue = Callable[[], bool]


class StreamDecodeSession(NamedTuple):
    """Incremental inspection decoder with transport-completion diagnostics.

    ``finish_error`` reports only decoder failures that remain authoritative.
    When a configured downstream parser permanently stops accepting input, the
    session intentionally abandons decoding and leaves final error reporting to
    that parser.
    """

    feed: _StreamDecodeFeed
    finish_error: _StreamDecodeFinishError


def _feed_chunks(feed: _StreamDecodeFeed, data: bytes, max_decoded_chunk: int) -> None:
    for offset in range(0, len(data), max_decoded_chunk):
        feed(data[offset : offset + max_decoded_chunk])


def _no_stream_decode_error() -> str | None:
    return None


def _create_zlib_stream_decode_session(
    feed: _StreamDecodeFeed,
    *,
    encoding_label: str,
    wbits: int,
    max_decoded_chunk: int,
    should_continue: _StreamDecodeShouldContinue | None,
) -> StreamDecodeSession:
    obj = zlib.decompressobj(wbits)
    compressed_bytes_seen = 0
    decode_error: str | None = None
    decoded_bytes_emitted = 0
    inspection_stopped = False
    member_in_progress = False
    saw_input = False

    def decode(chunk: bytes) -> None:
        nonlocal compressed_bytes_seen, decode_error, decoded_bytes_emitted
        nonlocal inspection_stopped, member_in_progress, obj, saw_input
        if decode_error is not None or inspection_stopped:
            return
        if chunk:
            saw_input = True
            compressed_bytes_seen += len(chunk)
        input_cursor = ZlibInputCursor(chunk)
        # Input slicing can make zlib return partial parser chunks. Coalesce
        # only within this callback and member so existing delivery boundaries
        # and the max_decoded_chunk contract remain intact.
        pending_decoded = bytearray()
        while input_cursor:
            data = input_cursor.take()
            member_in_progress = True
            allowed_decoded_bytes = max(
                STREAM_DECODE_EXPANSION_GRACE,
                compressed_bytes_seen * STREAM_DECODE_MAX_EXPANSION_RATIO,
            )
            remaining_decoded_bytes = allowed_decoded_bytes - decoded_bytes_emitted
            probing_for_additional_output = remaining_decoded_bytes == 0
            max_length = (
                1
                if probing_for_additional_output
                else min(
                    max_decoded_chunk - len(pending_decoded),
                    remaining_decoded_bytes,
                )
            )
            try:
                decoded = obj.decompress(data, max_length=max_length)
            except zlib.error:
                if pending_decoded:
                    feed(bytes(pending_decoded))
                    if should_continue is not None and not should_continue():
                        inspection_stopped = True
                        return
                decode_error = INVALID_COMPRESSED_BODY
                return
            if probing_for_additional_output and decoded:
                if pending_decoded:
                    feed(bytes(pending_decoded))
                    if should_continue is not None and not should_continue():
                        inspection_stopped = True
                        return
                decode_error = DECODED_BODY_LIMIT_EXCEEDED
                return
            if decoded:
                decoded_bytes_emitted += len(decoded)
                pending_decoded.extend(decoded)
                if len(pending_decoded) == max_decoded_chunk:
                    feed(bytes(pending_decoded))
                    pending_decoded.clear()
                    if should_continue is not None and not should_continue():
                        inspection_stopped = True
                        return
            if obj.eof:
                if pending_decoded:
                    feed(bytes(pending_decoded))
                    pending_decoded.clear()
                    if should_continue is not None and not should_continue():
                        inspection_stopped = True
                        return
                # At an exact output boundary, zlib can expose the next member
                # through both unused_data and unconsumed_tail. Reset before
                # consulting unconsumed_tail so the next member makes progress.
                input_cursor.carry(obj.unused_data)
                obj = zlib.decompressobj(wbits)
                member_in_progress = False
                continue
            if obj.unconsumed_tail:
                input_cursor.carry(obj.unconsumed_tail)
        if pending_decoded:
            feed(bytes(pending_decoded))
            if should_continue is not None and not should_continue():
                inspection_stopped = True

    def finish_error() -> str | None:
        if decode_error is not None:
            return decode_error
        if inspection_stopped:
            return None
        if saw_input and member_in_progress:
            return INCOMPLETE_COMPRESSED_BODY
        return None

    return StreamDecodeSession(decode, finish_error)


def _create_brotli_stream_decode_session(
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int,
    should_continue: _StreamDecodeShouldContinue | None,
) -> StreamDecodeSession:
    obj = brotli.Decompressor()
    compressed_bytes_seen = 0
    decode_error: str | None = None
    decoded_bytes_emitted = 0
    inspection_stopped = False
    saw_input = False

    def decode(chunk: bytes) -> None:
        nonlocal compressed_bytes_seen, decode_error, decoded_bytes_emitted
        nonlocal inspection_stopped, saw_input
        if decode_error is not None or inspection_stopped:
            return
        if chunk:
            saw_input = True
            compressed_bytes_seen += len(chunk)

        pending_input = chunk
        while True:
            allowed_decoded_bytes = max(
                STREAM_DECODE_EXPANSION_GRACE,
                compressed_bytes_seen * STREAM_DECODE_MAX_EXPANSION_RATIO,
            )
            remaining_decoded_bytes = allowed_decoded_bytes - decoded_bytes_emitted
            try:
                decoded = obj.process(
                    pending_input,
                    output_buffer_limit=min(max_decoded_chunk, remaining_decoded_bytes + 1),
                )
            except brotli.error:
                decode_error = INVALID_COMPRESSED_BODY
                return
            pending_input = b""

            accepted = decoded[:remaining_decoded_bytes]
            for offset in range(0, len(accepted), max_decoded_chunk):
                decoded_chunk = accepted[offset : offset + max_decoded_chunk]
                decoded_bytes_emitted += len(decoded_chunk)
                feed(decoded_chunk)
                if should_continue is not None and not should_continue():
                    inspection_stopped = True
                    return
            if len(decoded) > remaining_decoded_bytes:
                decode_error = DECODED_BODY_LIMIT_EXCEEDED
                return
            if obj.is_finished():
                return
            if not decoded and obj.can_accept_more_data():
                return

    def finish_error() -> str | None:
        if decode_error is not None:
            return decode_error
        if inspection_stopped:
            return None
        if saw_input and not obj.is_finished():
            return INCOMPLETE_COMPRESSED_BODY
        return None

    return StreamDecodeSession(decode, finish_error)


def stream_decodable_content_encodings() -> tuple[str, ...]:
    """Return ordered content codings supported by streaming inspection."""
    return _STREAM_DECODABLE_CONTENT_ENCODINGS


def _stream_decode_skip_reason(encoding: str | None) -> str | None:
    if encoding is None:
        return _CONTENT_ENCODING_HEADER_LIMIT_EXCEEDED
    if not encoding or encoding in stream_decodable_content_encodings():
        return None
    if encoding == "zstd":
        return "zstd streaming output cannot be hard-bounded"
    return "unsupported content encoding"


def stream_decode_skip_reason(headers: http.Headers) -> str | None:
    """Return a fixed reason when usage streams cannot decode the response."""
    encoding = content_encoding.read_folded(headers)
    return _stream_decode_skip_reason(encoding)


def can_stream_decode_usage(headers: http.Headers) -> bool:
    """Return whether usage parsers can safely consume this response stream."""
    return stream_decode_skip_reason(headers) is None


def can_decode_json_usage_body(headers: http.Headers) -> bool:
    """Return whether bounded terminal JSON usage decoding supports the response."""
    encoding = content_encoding.read_folded(headers)
    return encoding is not None and (
        not encoding or encoding == "identity" or encoding in _SUPPORTED_ONE_SHOT_BODY_ENCODINGS
    )


def create_stream_decode_session(
    headers: http.Headers,
    feed: _StreamDecodeFeed,
    *,
    max_decoded_chunk: int = STREAM_DECODE_CHUNK_LIMIT,
    should_continue: _StreamDecodeShouldContinue | None = None,
) -> StreamDecodeSession | None:
    """Create a bounded streaming decoder session for usage-parser chunks.

    Usage parsers are bounded-state scanners and may need to inspect long
    responses, so this helper does not enforce a fixed total decoded-byte cap.
    For compressed encodings, one response-scoped budget bounds cumulative
    decoded output to the larger of the streaming grace or compressed bytes
    seen times the maximum expansion ratio. The budget is shared across
    callbacks and concatenated zlib members. Each decoded parser chunk is
    bounded independently.

    Brotli 1.2's ``output_buffer_limit`` is a soft allocation threshold and a
    call may return more bytes than requested. Supporting Brotli streaming
    intentionally accepts that transient overshoot. Returned output is still
    split before parser delivery and charged against the response-scoped
    expansion budget, but this helper does not promise a byte-exact bound on
    the Brotli binding's temporary output allocation.

    Returns None when a content encoding cannot be decoded incrementally or
    its raw headers exceed the inspection budget.

    The returned session exposes ``finish_error()`` so billing paths can reject
    parser state from compressed streams that never reached a valid frame/member
    ending. Best-effort capture paths should continue to use ``decompress_body``.

    ``should_continue`` is an optional permanent-parser capability. It is
    checked after each decoded delivery. Once false, the session suppresses
    later parser callbacks and decompression without classifying the abandoned
    compressed member as incomplete. Recoverable event or line parsers must not
    supply this capability.
    """
    if max_decoded_chunk <= 0:
        raise ValueError("max_decoded_chunk must be positive")
    encoding = content_encoding.read_folded(headers)
    if _stream_decode_skip_reason(encoding) is not None:
        return None
    if not encoding or encoding == "identity":
        if should_continue is None:
            return StreamDecodeSession(feed, _no_stream_decode_error)
        inspection_stopped = False

        def feed_until_stopped(chunk: bytes) -> None:
            nonlocal inspection_stopped
            if inspection_stopped:
                return
            feed(chunk)
            if not should_continue():
                inspection_stopped = True

        return StreamDecodeSession(feed_until_stopped, _no_stream_decode_error)
    if encoding == "br":
        return _create_brotli_stream_decode_session(
            feed,
            max_decoded_chunk=max_decoded_chunk,
            should_continue=should_continue,
        )
    return _create_zlib_stream_decode_session(
        feed,
        encoding_label=encoding,
        wbits=_STREAM_ZLIB_WBITS_BY_ENCODING[encoding],
        max_decoded_chunk=max_decoded_chunk,
        should_continue=should_continue,
    )


def decompress_body(
    data: bytes, headers: http.Headers, max_output: int = DEFAULT_BODY_DECODE_LIMIT
) -> bytes:
    """Decompress response body based on Content-Encoding header.

    The stream callback receives raw wire bytes.  When the server uses
    gzip/deflate/br/zstd encoding, we must decompress before capturing.
    Uses incremental decompression so truncated compressed data still
    yields whatever decompressed bytes are available.

    Output is capped at *max_output* bytes to guard against decompression
    bombs.  Cap enforcement varies by codec:

    - gzip/deflate: hard cap via ``decompressobj.decompress(data, max_length=)``;
      zlib stops decoding once the cap is reached. Concatenated members are
      decoded until the shared cap is exhausted.
    - zstd: hard cap via ``ZstdDecompressor.stream_reader(data).read(max_output)``;
      zstd reads incrementally so total memory is bounded by
      ``max_output`` plus library internal buffers.
    - br: exact accumulator cap over adaptive compressed-input chunks.
      Brotli 1.2's ``output_buffer_limit`` keeps transient output near the
      remaining budget, plus library allocation blocks; returned chunks may
      exceed that soft threshold and are sliced to the exact cap.

    Returns the original data unchanged when the encoding is missing,
    ``identity``, unrecognised, beyond the header inspection budget, or invalid
    before any compressed member completes. Once a member has completed, later
    invalid trailing data is ignored on this best-effort path. A valid frame
    that decodes to an empty body returns ``b""`` — callers that short-circuit
    via ``if not body`` rely on that (see #10287).
    """
    return _decode_body_bounded(data, headers, max_output=max_output).body


def _decode_single_zlib_stream_for_network_log_capture(
    data: bytes,
    *,
    wbits: int,
    max_output: int,
    require_complete: bool,
) -> bytes | None:
    if not data or max_output <= 0:
        return b""

    obj = zlib.decompressobj(wbits)
    input_cursor = ZlibInputCursor(data)
    out = bytearray()
    while input_cursor and len(out) < max_output:
        try:
            decoded = obj.decompress(
                input_cursor.take(),
                max_length=max_output - len(out),
            )
        except zlib.error:
            return None
        out.extend(decoded)
        if obj.eof:
            break
        if obj.unconsumed_tail:
            input_cursor.carry(obj.unconsumed_tail)

    if require_complete and len(out) < max_output and not obj.eof:
        return None
    return bytes(out)


def _decode_zstd_for_network_log_capture(data: bytes, max_output: int) -> bytes | None:
    if not data or max_output <= 0:
        return b""

    try:
        with zstandard.ZstdDecompressor().stream_reader(
            data,
            read_across_frames=True,
        ) as reader:
            body = reader.read(max_output)
    except zstandard.ZstdError:
        return None

    if len(body) >= max_output:
        return body
    if _validate_complete_zstd_frames(data, max_output) is not None:
        return None
    return body


def decode_response_body_for_network_log_capture(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int = DEFAULT_BODY_DECODE_LIMIT,
) -> bytes | None:
    """Decode a buffered response body with bounded mitmproxy-compatible semantics.

    Missing or ``identity`` encoding returns ``data`` unchanged. A supported
    encoding returns decoded bytes on success, including ``b""`` for a
    successful empty result. ``None`` means that the encoding is unsupported or
    that decoding failed. For supported encodings, decoded output is bounded by
    ``max_output``; reaching that bound returns the successful decoded prefix,
    even when the compressed input has not reached a complete frame where the
    codec policy permits that result.

    The supported codec compatibility is intentionally aligned with mitmproxy:

    - ``gzip`` accepts gzip and zlib wrappers and may return output from an
      incomplete stream.
    - ``deflate`` tries the zlib wrapper and then the raw-deflate wrapper, and
      requires a complete stream unless the decoded-output bound is reached.
    - ``br`` rejects invalid or incomplete input, except that reaching the
      decoded-output bound returns the bounded prefix.
    - ``zstd`` reads concatenated frames up to ``max_output`` bytes and rejects
      malformed, incomplete, or strict-frame-budget-exceeding input unless the
      decoded-output bound is reached.

    This is stricter than the best-effort ``decompress_body()`` path used for
    retained streaming buffers, which can preserve original wire bytes or
    partial decoded output after a decode problem.
    """
    encoding = content_encoding.read_folded(headers)
    if encoding is None:
        return None
    if not encoding or encoding == "identity":
        return data
    if encoding == "gzip":
        # mitmproxy uses zlib's gzip/zlib auto-detection and accepts partial
        # output when a gzip stream ends before its trailer.
        return _decode_single_zlib_stream_for_network_log_capture(
            data,
            wbits=32 + zlib.MAX_WBITS,
            max_output=max_output,
            require_complete=False,
        )
    if encoding == "deflate":
        body = _decode_single_zlib_stream_for_network_log_capture(
            data,
            wbits=zlib.MAX_WBITS,
            max_output=max_output,
            require_complete=True,
        )
        if body is not None:
            return body
        return _decode_single_zlib_stream_for_network_log_capture(
            data,
            wbits=-zlib.MAX_WBITS,
            max_output=max_output,
            require_complete=True,
        )
    if encoding == "br":
        body, error = _decode_supported_body_with_complete_status(data, encoding, max_output)
        if error is not None and error != DECODED_BODY_LIMIT_EXCEEDED:
            return None
        return body
    if encoding == "zstd":
        return _decode_zstd_for_network_log_capture(data, max_output)
    return None


def _decompress_zlib_best_effort_bounded(
    data: bytes, encoding: Literal["gzip", "deflate"], max_output: int
) -> _BodyDecodeResult:
    if max_output <= 0:
        return _BodyDecodeResult(b"", False)

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    input_cursor = ZlibInputCursor(data)
    out = bytearray()
    # A full-input zlib call exposes no partial output when that member raises.
    # Commit each member only at EOF so bounded slicing preserves that policy.
    member_out = bytearray()
    completed_member = False
    obj = zlib.decompressobj(wbits)

    while input_cursor and len(out) < max_output:
        member_data = input_cursor.take()
        try:
            decoded = obj.decompress(
                member_data,
                max_length=max_output - len(out) - len(member_out),
            )
        except zlib.error as exc:
            if completed_member:
                return _BodyDecodeResult(bytes(out), False)
            return _BodyDecodeResult(data, True, exc)

        member_out.extend(decoded)
        if len(out) + len(member_out) >= max_output:
            out.extend(member_out)
            return _BodyDecodeResult(bytes(out), False)
        if obj.eof:
            out.extend(member_out)
            member_out.clear()
            completed_member = True
            input_cursor.carry(obj.unused_data)
            if input_cursor:
                obj = zlib.decompressobj(wbits)
        elif obj.unconsumed_tail:
            input_cursor.carry(obj.unconsumed_tail)

    out.extend(member_out)
    return _BodyDecodeResult(bytes(out), False)


def _decode_body_bounded(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int,
) -> _BodyDecodeResult:
    """Decode supported content encodings with a bounded best-effort contract.

    Missing and ``identity`` encodings return original bytes. Unsupported
    encodings also pass through original bytes because unsupported encoding is a
    caller policy decision, not a codec failure. Supported invalid compressed
    bodies return ``failed=True`` with original bytes when no compressed member
    completed. Gzip/deflate trailing garbage after a completed member keeps the
    decoded prefix. Truncated gzip/deflate may return partial decoded output.
    Valid empty compressed frames return ``b""``. ``max_output`` caps decoded
    output and may return a truncated decoded prefix without marking failure.
    """
    encoding = content_encoding.read_folded(headers)
    if not encoding or encoding == "identity":
        return _BodyDecodeResult(data, False)
    try:
        if encoding in ("gzip", "deflate"):
            return _decompress_zlib_best_effort_bounded(data, encoding, max_output)
        if encoding == "br":
            return _BodyDecodeResult(_decompress_brotli_bounded(data, max_output), False)
        if encoding == "zstd":
            # stream_reader.read(n) reads *up to* n bytes: the full frame if
            # smaller than n, exactly n if larger — so total memory is bounded
            # by n plus ZSTD_DStream{In,Out}Size (~128 KB library buffers).
            with zstandard.ZstdDecompressor().stream_reader(data) as reader:
                return _BodyDecodeResult(reader.read(max_output), False)
    except (zlib.error, brotli.error, zstandard.ZstdError) as exc:
        return _BodyDecodeResult(data, True, exc)
    return _BodyDecodeResult(data, False)


def _decompress_brotli_bounded_with_status(
    data: bytes,
    max_output: int,
    *,
    validate_complete_input: bool,
) -> tuple[bytes, bool, bool]:
    if max_output <= 0:
        return b"", False, bool(data)

    chunk_size = min(
        _BROTLI_DECOMPRESS_MAX_INPUT_CHUNK_SIZE,
        max(
            _BROTLI_DECOMPRESS_MIN_INPUT_CHUNK_SIZE,
            (len(data) + _BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS - 1)
            // _BROTLI_DECOMPRESS_TARGET_INPUT_CHUNKS,
        ),
    )

    dec = brotli.Decompressor()
    out = bytearray()
    for offset in range(0, len(data), chunk_size):
        chunk = data[offset : offset + chunk_size]
        remaining = max_output - len(out)
        # The binding may return more than this soft threshold because it fills
        # allocation blocks before checking. Using one probe byte beyond the
        # remaining budget means a paused decoder has already proven overflow;
        # non-overflow results consume the complete input chunk, so another
        # nonempty chunk remains safe without an empty-input drain loop.
        decoded = dec.process(chunk, output_buffer_limit=remaining + 1)
        if len(decoded) > remaining:
            out.extend(decoded[:remaining])
            return bytes(out), dec.is_finished(), True
        out.extend(decoded)
        if not validate_complete_input and len(out) == max_output:
            return bytes(out), dec.is_finished(), False

    return bytes(out), dec.is_finished(), False


def _decompress_brotli_bounded(data: bytes, max_output: int) -> bytes:
    body, _finished, _limited = _decompress_brotli_bounded_with_status(
        data,
        max_output,
        validate_complete_input=False,
    )
    return body


def _decompress_zlib_json_usage_body(
    data: bytes,
    encoding: Literal["gzip", "deflate"],
    max_output: int,
) -> tuple[bytes, str | None]:
    if max_output <= 0:
        return b"", DECODED_BODY_LIMIT_EXCEEDED if data else None

    wbits = 16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS
    result = decode_zlib_bounded(data, wbits=wbits, max_output=max_output)
    if result.status == "complete":
        return result.body, None
    if result.status == "incomplete":
        return result.body, INCOMPLETE_COMPRESSED_BODY
    if result.status == "output_limit_exceeded":
        return result.body, DECODED_BODY_LIMIT_EXCEEDED
    # Unlimited member traversal cannot produce ``trailing_data``. Treat it
    # defensively like any other structurally invalid compressed body.
    return b"", INVALID_COMPRESSED_BODY


def _validate_complete_zstd_frames(data: bytes, max_output: int) -> str | None:
    # stream_reader can silently accept a valid frame followed by a truncated
    # frame, so strict JSON usage decoding needs a separate complete-frame pass.
    if max_output <= 0:
        return DECODED_BODY_LIMIT_EXCEEDED if data else None

    source = memoryview(data)
    source_offset = 0
    pending_input = b""
    decoded_size = 0
    validated_frames = 0
    while source_offset < len(source) or pending_input:
        if validated_frames >= _ZSTD_VALIDATE_MAX_FRAMES:
            return COMPRESSED_FRAME_LIMIT_EXCEEDED
        validated_frames += 1
        obj = zstandard.ZstdDecompressor().decompressobj()

        while source_offset < len(source) or pending_input:
            if pending_input:
                chunk = pending_input
                pending_input = b""
            else:
                chunk = source[source_offset : source_offset + _ZSTD_VALIDATE_INPUT_CHUNK_SIZE]
                source_offset += len(chunk)
            try:
                decoded = obj.decompress(chunk)
            except zstandard.ZstdError:
                return INVALID_COMPRESSED_BODY

            decoded_size += len(decoded)
            if decoded_size > max_output:
                return DECODED_BODY_LIMIT_EXCEEDED
            if obj.eof:
                pending_input = obj.unused_data
                break
            pending_input = obj.unconsumed_tail
        else:
            return INCOMPLETE_COMPRESSED_BODY
    return None


def _decompress_zstd_json_usage_body(
    data: bytes,
    max_output: int,
) -> tuple[bytes, str | None]:
    if max_output <= 0:
        return b"", DECODED_BODY_LIMIT_EXCEEDED if data else None

    try:
        with zstandard.ZstdDecompressor().stream_reader(data, read_across_frames=True) as reader:
            body = reader.read(max_output)
            # Force validation of any trailing frame without accumulating it.
            extra = reader.read(1)
    except zstandard.ZstdError:
        return b"", INVALID_COMPRESSED_BODY

    if extra:
        return body, DECODED_BODY_LIMIT_EXCEEDED
    return body, _validate_complete_zstd_frames(data, max_output)


def _decode_supported_body_with_complete_status(
    data: bytes,
    encoding: str,
    max_output: int,
) -> tuple[bytes, str | None]:
    if encoding in ("gzip", "deflate"):
        return _decompress_zlib_json_usage_body(
            data,
            encoding,
            max_output,
        )
    if encoding == "br":
        try:
            body, finished, limited = _decompress_brotli_bounded_with_status(
                data,
                max_output,
                validate_complete_input=True,
            )
        except brotli.error:
            return b"", INVALID_COMPRESSED_BODY
        if limited:
            return body, DECODED_BODY_LIMIT_EXCEEDED
        if data and not finished:
            return body, INCOMPLETE_COMPRESSED_BODY
        return body, None
    if encoding == "zstd":
        return _decompress_zstd_json_usage_body(data, max_output)
    raise ValueError(f"unsupported content encoding: {encoding}")


def decode_request_body_for_network_log_capture(
    data: bytes,
    headers: http.Headers,
    *,
    max_output: int = DEFAULT_BODY_DECODE_LIMIT,
) -> bytes | None:
    """Decode a request body for persistent network-log capture.

    Request capture hides unsupported encodings and supported-codec decode
    failures instead of keeping best-effort fallback bytes. This helper is
    intentionally separate from billing inspection, which has a stricter
    fail-closed policy.
    """
    encoding = content_encoding.read_folded(headers)
    if encoding is None:
        return None
    if not encoding or encoding == "identity":
        return data
    if encoding not in _SUPPORTED_ONE_SHOT_BODY_ENCODINGS:
        return None

    body, error = _decode_supported_body_with_complete_status(data, encoding, max_output)
    if error is not None and error != DECODED_BODY_LIMIT_EXCEEDED:
        return None
    return body


def decode_captured_json_usage_body(
    captured_body: CapturedStreamBody,
    headers: http.Headers,
) -> tuple[bytes, str | None]:
    """Admit only complete captured responses to bounded JSON usage decoding.

    A retained prefix may contain complete compressed frames and valid JSON
    even when an unseen suffix invalidates the response. Reject capture
    truncation before decoding; incremental inspectors own their completion
    checks independently of this forensic buffer.
    """
    if captured_body.truncated:
        return b"", INCOMPLETE_COMPRESSED_BODY
    if not captured_body.buffer:
        return b"", None
    return decompress_json_usage_body(
        bytes(captured_body.buffer), headers, max_output=LARGE_RESPONSE_DECOMPRESS_LIMIT
    )


def decompress_json_usage_body(
    data: bytes,
    headers: http.Headers,
    max_output: int = LARGE_RESPONSE_DECOMPRESS_LIMIT,
) -> tuple[bytes, str | None]:
    """Decompress a JSON usage response body with an observable empty-prefix error.

    ``decompress_body`` intentionally treats truncated compressed prefixes as an
    empty body because body capture can still mark those responses truncated
    from stream metadata. JSON usage fallback only has the final buffer, so it
    needs to distinguish a valid compressed empty response from an incomplete
    compressed frame that produced no JSON bytes. Strict zstd validation also
    rejects bodies that exceed its per-body frame budget.

    """
    encoding = content_encoding.read_folded(headers)
    if encoding is None:
        return b"", _CONTENT_ENCODING_HEADER_LIMIT_EXCEEDED
    if encoding in _SUPPORTED_ONE_SHOT_BODY_ENCODINGS:
        return _decode_supported_body_with_complete_status(
            data,
            encoding,
            max_output,
        )
    if encoding and encoding != "identity" and data:
        return b"", "unsupported content encoding"
    return data, None
