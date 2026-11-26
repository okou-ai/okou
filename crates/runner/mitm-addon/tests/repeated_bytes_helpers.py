"""Bounded construction of repeated byte regions in protocol fixtures."""


def repeat_bytes(prefix: bytes, marker: bytes, repetitions: int, suffix: bytes) -> bytes:
    """Join bounded repeated pieces into the original complete fixture bytes."""
    if repetitions <= 0:
        return prefix + suffix
    blocks, tail = divmod(repetitions, 1024)
    pieces = (marker * 1024,) * blocks if blocks else ()
    return b"".join((prefix, *pieces, marker * tail, suffix))


def join_repeated_bytes(
    separator: bytes,
    item: bytes,
    repetitions: int,
    *,
    prefix: bytes = b"",
    suffix: bytes = b"",
) -> bytes:
    """Build a separated fixture without a list entry for every item."""
    if repetitions <= 0:
        return prefix + suffix
    return repeat_bytes(prefix, item + separator, repetitions - 1, item + suffix)


def repeat_marker(envelope: bytes, marker: bytes, repetitions: int) -> bytes:
    """Expand the first known marker without a full-size replacement buffer."""
    prefix, suffix = envelope.split(marker, 1)
    return repeat_bytes(prefix, marker, repetitions, suffix)
