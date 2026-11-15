"""Bounded construction of repeated byte regions in protocol fixtures."""


def repeat_marker(envelope: bytes, marker: bytes, repetitions: int) -> bytes:
    """Expand the first known marker without a full-size replacement buffer."""
    prefix, suffix = envelope.split(marker, 1)
    blocks, tail = divmod(max(repetitions, 0), 1024)
    pieces = (marker * 1024,) * blocks if blocks else ()
    return b"".join((prefix, *pieces, marker * tail, suffix))
