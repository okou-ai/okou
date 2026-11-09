"""Flow-local SigV4 request representation, inspection, signing and release.

The pure signer owns AWS algorithms; auth owns credentials and hash-worker
lifetime. This adapter owns the bounded HTTPFlow representation and its cache.
"""

import urllib.parse
from dataclasses import dataclass, field

from mitmproxy import http

import aws_sigv4_body_admission
import flow_metadata_keys as metadata_keys
import http_header_syntax
from auth_base_transport import header_pairs
from aws_sigv4 import (
    AwsSigV4BodyHash,
    AwsSigV4Credentials,
    AwsSigV4RequestInspection,
    AwsSigV4SigningError,
    inspect_request,
    sign_request,
)
from runtime_url_parsing import split_runtime_url
from url_syntax import has_unsafe_runtime_url_syntax

# Managed SigV4 request inspection uses the pinned HTTP/2 stack's 64 KiB
# decompressed header-list policy. HPACK accounts for 32 bytes of overhead per
# field; using the same formula also bounds HTTP/1 header count before decoding.
MAX_AWS_SIGV4_REQUEST_TARGET_BYTES = 64 * 1024
MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES = 64 * 1024
AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES = 32
MAX_AWS_SIGV4_REQUEST_HEADER_FIELDS = (
    MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES // AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES
)
_MISSING_AWS_SIGV4_ORIGINAL_URL = object()


@dataclass(frozen=True)
class _AwsSigV4FlowRepresentationIdentity:
    """Immutable raw objects that identify one flow request representation."""

    original_url: object = field(repr=False)
    raw_path: bytes = field(repr=False)
    raw_header_fields: tuple[tuple[bytes, bytes], ...] = field(repr=False)

    def is_current(self, other: _AwsSigV4FlowRepresentationIdentity) -> bool:
        return (
            self.original_url is other.original_url
            and self.raw_path is other.raw_path
            and self.raw_header_fields is other.raw_header_fields
        )


@dataclass(frozen=True)
class _AwsSigV4RequestInput:
    """Bounded decoded input passed to the low-level SigV4 boundary."""

    url: str = field(repr=False)
    headers: tuple[tuple[str, str], ...] = field(repr=False)


@dataclass(frozen=True)
class _AwsSigV4FlowInspection:
    """Flow-local inspection result for one immutable raw representation."""

    identity: _AwsSigV4FlowRepresentationIdentity = field(repr=False)
    request_input: _AwsSigV4RequestInput | None = field(repr=False)
    inspection: AwsSigV4RequestInspection | None = field(repr=False)

    @property
    def requires_body(self) -> bool:
        if self.inspection is None:
            return True
        return self.inspection.requires_body


def _trusted_aws_sigv4_url(flow: http.HTTPFlow) -> str:
    url = flow.metadata.get(metadata_keys.ORIGINAL_URL)
    if not isinstance(url, str):
        raise AwsSigV4SigningError("AWS request URL is unavailable")
    if has_unsafe_runtime_url_syntax(url, allow_backslash=True):
        raise AwsSigV4SigningError("AWS request URL is malformed")

    try:
        original = split_runtime_url(url)
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e

    if has_unsafe_runtime_url_syntax(flow.request.path, allow_backslash=True):
        raise AwsSigV4SigningError("AWS request URL is malformed")
    try:
        current_query = split_runtime_url(flow.request.path).query
    except ValueError as e:
        raise AwsSigV4SigningError("AWS request URL is malformed") from e
    if current_query == original.query:
        return url
    return urllib.parse.urlunsplit(
        (original.scheme, original.netloc, original.path, current_query, original.fragment)
    )


def _aws_sigv4_flow_representation_identity(
    flow: http.HTTPFlow,
) -> _AwsSigV4FlowRepresentationIdentity:
    return _AwsSigV4FlowRepresentationIdentity(
        original_url=flow.metadata.get(
            metadata_keys.ORIGINAL_URL,
            _MISSING_AWS_SIGV4_ORIGINAL_URL,
        ),
        raw_path=flow.request.data.path,
        raw_header_fields=flow.request.headers.fields,
    )


def _bounded_aws_sigv4_request_input(flow: http.HTTPFlow) -> _AwsSigV4RequestInput:
    raw_path = flow.request.data.path
    if len(raw_path) > MAX_AWS_SIGV4_REQUEST_TARGET_BYTES:
        raise AwsSigV4SigningError("AWS request target is too large")

    raw_header_fields = flow.request.headers.fields
    if not http_header_syntax.raw_header_list_within_budget(
        raw_header_fields,
        max_fields=MAX_AWS_SIGV4_REQUEST_HEADER_FIELDS,
        max_bytes=MAX_AWS_SIGV4_REQUEST_HEADER_LIST_BYTES,
        field_overhead_bytes=AWS_SIGV4_REQUEST_HEADER_FIELD_OVERHEAD_BYTES,
    ):
        raise AwsSigV4SigningError("AWS request headers are too large")

    return _AwsSigV4RequestInput(
        url=_trusted_aws_sigv4_url(flow),
        headers=tuple(header_pairs(flow.request.headers)),
    )


def inspect_flow(flow: http.HTTPFlow) -> _AwsSigV4FlowInspection:
    identity = _aws_sigv4_flow_representation_identity(flow)
    cached = flow.metadata.get(metadata_keys.AWS_SIGV4_REQUEST_INSPECTION)
    if isinstance(cached, _AwsSigV4FlowInspection):
        if cached.identity.is_current(identity):
            return cached
        # Restoration or reclassification may replace immutable containers with
        # equal values. Value comparison is safe only after the cached input passed
        # the target/header bounds; rebind once so later consumers use the O(1) path.
        if cached.request_input is not None and cached.identity == identity:
            rebound = _AwsSigV4FlowInspection(
                identity=identity,
                request_input=cached.request_input,
                inspection=cached.inspection,
            )
            flow.metadata[metadata_keys.AWS_SIGV4_REQUEST_INSPECTION] = rebound
            return rebound

    try:
        request_input = _bounded_aws_sigv4_request_input(flow)
    except AwsSigV4SigningError:
        result = _AwsSigV4FlowInspection(
            identity=identity,
            request_input=None,
            inspection=None,
        )
    else:
        try:
            inspection = inspect_request(
                url=request_input.url,
                headers=list(request_input.headers),
            )
        except AwsSigV4SigningError:
            inspection = None
        result = _AwsSigV4FlowInspection(
            identity=identity,
            request_input=request_input,
            inspection=inspection,
        )
    flow.metadata[metadata_keys.AWS_SIGV4_REQUEST_INSPECTION] = result
    return result


def release_inspection(flow: http.HTTPFlow) -> None:
    """Release reusable SigV4 request state from one flow."""
    flow.metadata.pop(metadata_keys.AWS_SIGV4_REQUEST_INSPECTION, None)


def requires_body_for_signing(flow: http.HTTPFlow) -> bool:
    """Conservatively classify whether a configured SigV4 request needs its body."""
    return inspect_flow(flow).requires_body


def sign_flow_request(
    flow: http.HTTPFlow,
    credentials: AwsSigV4Credentials,
    *,
    precomputed_body_hash: AwsSigV4BodyHash | None = None,
) -> None:
    state = inspect_flow(flow)
    try:
        if state.inspection is not None and state.requires_body:
            aws_sigv4_body_admission.require_from_flow(flow)
        request_input = state.request_input or _bounded_aws_sigv4_request_input(flow)
        signed_url, signed_headers = sign_request(
            method=flow.request.method,
            url=request_input.url,
            headers=list(request_input.headers),
            body=flow.request.raw_content,
            credentials=credentials,
            precomputed_body_hash=precomputed_body_hash,
            inspection=state.inspection,
        )
        flow.request.url = signed_url
        flow.request.headers = http.Headers(
            [(name.encode(), value.encode()) for name, value in signed_headers]
        )
    finally:
        release_inspection(flow)
