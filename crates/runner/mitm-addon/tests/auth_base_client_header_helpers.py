"""Raw header-value guards for auth.base selection regressions."""


class UnconvertedHeaderValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("decoded a discarded auth.base client header value")

    def __bytes__(self) -> bytes:
        raise AssertionError("copied a discarded auth.base client header value")

    def strip(self, chars=None) -> bytes:
        raise AssertionError("stripped a discarded auth.base client header value")

    def split(self, sep=None, maxsplit: int = -1) -> list[bytes]:
        raise AssertionError("split a discarded auth.base client header value")
