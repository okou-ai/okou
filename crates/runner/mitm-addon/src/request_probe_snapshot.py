"""Raw request target and header rollback for header-auth probes."""

from dataclasses import dataclass
from typing import Self

from mitmproxy import http


@dataclass(frozen=True, repr=False)
class RequestProbeSnapshot:
    """Keep probe rollback separate from metadata and request body ownership."""

    scheme: bytes
    host: str
    port: int
    authority: bytes
    path: bytes
    header_fields: tuple[tuple[bytes, bytes], ...]

    @classmethod
    def capture(cls, request: http.Request) -> Self:
        header_fields = http.Headers(request.headers.fields).fields
        return cls(
            scheme=request.data.scheme,
            host=request.data.host,
            port=request.data.port,
            authority=request.data.authority,
            path=request.data.path,
            header_fields=header_fields,
        )

    def restore(self, request: http.Request) -> None:
        # The URL setter reparses as ASCII and cannot restore native non-ASCII
        # query bytes. Rollback must preserve the exact admitted target instead.
        (
            request.data.scheme,
            request.data.host,
            request.data.port,
            request.data.authority,
            request.data.path,
        ) = (self.scheme, self.host, self.port, self.authority, self.path)
        request.headers = http.Headers(self.header_fields)
