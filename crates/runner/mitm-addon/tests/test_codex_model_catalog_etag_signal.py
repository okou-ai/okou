"""Bounded optional ETag acquisition through the real response-header hook."""

from collections.abc import Iterator
from unittest.mock import patch

import pytest

import codex_model_catalog_cache as catalog_cache
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    CATALOG_ETAG,
    catalog_flow,
    catalog_response,
    finish_response,
    install_catalog,
    prepare_miss,
    responses_flow,
)
from tests.flow_helpers import response_stream

_FIELD_LIMIT = 8 * 1024
_VALUE_LIMIT = 8 * 1024
_CONTENT_TYPE = (b"Content-Type", b"application/json")
_ETAG_NAME = b"x-models-etag"
_ETAG = CATALOG_ETAG.encode()


class _UnconvertedValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("unusable ETag signal was decoded")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("unusable ETag signal was stripped before rejection")


class _UnfoldedName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("irrelevant header name was folded")


class _UnvisitedFields(tuple[tuple[bytes, bytes], ...]):
    allow_traversal = False

    def __iter__(self) -> Iterator[tuple[bytes, bytes]]:
        if not self.allow_traversal:
            raise AssertionError("over-budget response fields were traversed")
        return super().__iter__()


_IGNORED_FIELDS = [
    pytest.param(
        _UnvisitedFields(
            (_CONTENT_TYPE, (_ETAG_NAME, _UnconvertedValue(_ETAG)))
            + ((b"Unrelated", b"value"),) * (_FIELD_LIMIT - 1)
        ),
        id="field-count-one-over-limit",
    ),
    pytest.param(
        _UnvisitedFields((_CONTENT_TYPE,) + ((_ETAG_NAME, _UnconvertedValue(_ETAG)),) * 65_536),
        id="large-duplicate-field-collection",
    ),
    pytest.param(
        (
            _CONTENT_TYPE,
            (_ETAG_NAME, _UnconvertedValue(_ETAG)),
            (b"X-Models-Etag", _UnconvertedValue(b'"catalog-v2"')),
        )
        + ((_UnfoldedName(_ETAG_NAME), b"unvisited"),) * 4096,
        id="early-duplicate-before-many-fields",
    ),
    pytest.param(
        (_CONTENT_TYPE, (_ETAG_NAME, b""), (b"X-MODELS-ETAG", _UnconvertedValue(_ETAG))),
        id="empty-first-duplicate",
    ),
    pytest.param(
        (_CONTENT_TYPE, (_ETAG_NAME, _UnconvertedValue(b"x" * (_VALUE_LIMIT + 1)))),
        id="raw-value-one-over-limit",
    ),
    pytest.param(
        (_CONTENT_TYPE, (_ETAG_NAME, _UnconvertedValue(b"x" * (1024 * 1024)))),
        id="megabyte-raw-value",
    ),
    pytest.param(
        (
            _CONTENT_TYPE,
            (_ETAG_NAME, _UnconvertedValue(b" " * (_VALUE_LIMIT - len(_ETAG) + 1) + _ETAG)),
        ),
        id="raw-padding-over-limit-before-strip",
    ),
    pytest.param((_CONTENT_TYPE, (_ETAG_NAME, b'"\xff"')), id="invalid-utf8"),
    pytest.param((_CONTENT_TYPE, (_ETAG_NAME, b'"' + b"x" * 511 + b'"')), id="etag-over-512"),
    pytest.param((_CONTENT_TYPE,), id="missing"),
]


async def _forward_and_complete_signal(signal) -> None:
    assert signal.response is not None
    upstream = signal.response
    fields = upstream.headers.fields
    status = upstream.status_code

    mitm_addon.responseheaders(signal)

    assert signal.response is upstream
    assert upstream.status_code == status
    assert upstream.headers.fields is fields
    if isinstance(fields, _UnvisitedFields):
        # The resource assertion covers the response-header hook. Terminal network
        # projection has its own bounded header inspection contract.
        fields.allow_traversal = True
    stream = response_stream(signal)
    chunks = (b"{", b"}", b"") if status == 200 else (b"",)
    for chunk in chunks:
        assert stream(chunk) == chunk
    await mitm_addon.responseinspection(signal)
    completion = mitm_addon.response(signal)
    if completion is not None:
        await completion
    assert upstream.stream is False
    assert upstream.headers.fields is fields
    assert upstream.status_code == status


@pytest.mark.parametrize("status", [200, 101])
@pytest.mark.parametrize("fields", _IGNORED_FIELDS)
async def test_ignored_signal_preserves_entries_expiry_and_in_flight_catalog(
    real_flow, fields, status
):
    if isinstance(fields, _UnvisitedFields):
        fields = _UnvisitedFields(tuple.__iter__(fields))
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        for version, etag in (("matching", CATALOG_ETAG), ("mismatching", '"catalog-old"')):
            await install_catalog(catalog_flow(real_flow, version=version), etag=etag)
        owner = catalog_flow(real_flow, version="in-flight")
        await prepare_miss(owner)
        signal = responses_flow(real_flow, status=status)
        assert signal.response is not None
        signal.response.headers.fields = fields

        try:
            monotonic.return_value = 150.0
            await _forward_and_complete_signal(signal)

            for version, etag in (("matching", CATALOG_ETAG), ("mismatching", '"catalog-old"')):
                hit = catalog_flow(real_flow, version=version)
                await catalog_cache.prepare_request(hit, request_end_stream=True)
                assert hit.response is not None
                assert hit.response.content == CATALOG_BODY
                assert hit.response.headers["ETag"] == etag
                catalog_cache.release_flow_state(hit)

            owner.response = catalog_response(etag='"owner-v2"')
            await finish_response(owner)
            owner_hit = catalog_flow(real_flow, version="in-flight")
            await catalog_cache.prepare_request(owner_hit, request_end_stream=True)
            assert owner_hit.response is not None
            assert owner_hit.response.headers["ETag"] == '"owner-v2"'
            catalog_cache.release_flow_state(owner_hit)

            monotonic.return_value = 161.0
            for version in ("matching", "mismatching"):
                expired = catalog_flow(real_flow, version=version)
                await prepare_miss(expired)
                catalog_cache.release_flow_state(expired)
        finally:
            catalog_cache.release_flow_state(owner)


@pytest.mark.parametrize("status", [200, 101])
@pytest.mark.parametrize(
    ("raw_etag", "etag", "extra_fields"),
    [
        pytest.param(_ETAG, CATALOG_ETAG, (), id="strong"),
        pytest.param(b'W/"catalog-v1"', 'W/"catalog-v1"', (), id="weak"),
        pytest.param('"caf\u00e9"'.encode(), '"caf\u00e9"', (), id="utf8"),
        pytest.param(b" \t" + _ETAG + b"\t ", CATALOG_ETAG, (), id="http-whitespace"),
        pytest.param(
            "\u00a0".encode() + _ETAG + "\u2003".encode(), CATALOG_ETAG, (), id="unicode-whitespace"
        ),
        pytest.param(
            b" " * (_VALUE_LIMIT - len(_ETAG)) + _ETAG,
            CATALOG_ETAG,
            (),
            id="inclusive-raw-value-limit",
        ),
        pytest.param(b'"' + b"x" * 510 + b'"', '"' + "x" * 510 + '"', (), id="etag-512"),
        pytest.param(
            _ETAG,
            CATALOG_ETAG,
            ((b"Unrelated", b"value"),) * (_FIELD_LIMIT - 2),
            id="inclusive-field-limit",
        ),
        pytest.param(
            _ETAG,
            CATALOG_ETAG,
            ((_UnfoldedName(b"x" * (1024 * 1024)), _UnconvertedValue(b"irrelevant")),),
            id="long-unrelated-name",
        ),
        pytest.param(
            _ETAG,
            CATALOG_ETAG,
            ((b"Unrelated", _UnconvertedValue(b"x" * (1024 * 1024))),),
            id="unrelated-value-does-not-consume-budget",
        ),
    ],
)
async def test_in_budget_signal_preserves_etag_semantics_and_renews_catalog(
    real_flow, raw_etag, etag, extra_fields, status
):
    with patch.object(catalog_cache.time, "monotonic", return_value=100.0) as monotonic:
        await install_catalog(catalog_flow(real_flow), etag=etag)
        signal = responses_flow(real_flow, status=status)
        assert signal.response is not None
        signal.response.headers.fields = (
            _CONTENT_TYPE,
            (b"X-MoDeLs-EtAg", raw_etag),
            *extra_fields,
        )

        monotonic.return_value = 150.0
        await _forward_and_complete_signal(signal)

        monotonic.return_value = 161.0
        hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == CATALOG_BODY
        assert hit.response.headers["ETag"] == etag
        catalog_cache.release_flow_state(hit)

        monotonic.return_value = 210.0
        expired = catalog_flow(real_flow)
        await prepare_miss(expired)
        catalog_cache.release_flow_state(expired)
