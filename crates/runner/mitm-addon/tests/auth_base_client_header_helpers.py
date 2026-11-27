"""Header fixtures and raw-value guards for auth.base regressions."""

from itertools import batched


class UnconvertedHeaderValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("decoded a discarded auth.base client header value")

    def __bytes__(self) -> bytes:
        raise AssertionError("copied a discarded auth.base client header value")

    def strip(self, chars=None) -> bytes:
        raise AssertionError("stripped a discarded auth.base client header value")

    def split(self, sep=None, maxsplit: int = -1) -> list[bytes]:
        raise AssertionError("split a discarded auth.base client header value")


def connection_nominations(count: int) -> str:
    """Join batches of distinct test nominations without building a full name list."""
    names = (f"x{index:06x}" for index in range(count))
    return ",".join(",".join(batch) for batch in batched(names, 1024, strict=False))
