"""Ordinary catalog ETag acquisition through real response hooks and cache replay."""

import asyncio

import pytest

import codex_model_catalog_cache as catalog_cache
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    CATALOG_ETAG,
    catalog_flow,
    catalog_response,
    finish_response,
    prepare_miss,
    prepare_prefetch_miss,
)
from tests.flow_helpers import response_stream

_FIELD_LIMIT = 8 * 1024
_VALUE_LIMIT = 8 * 1024
_ETAG = CATALOG_ETAG.encode()


class _TrackedValue(bytes):
    def __init__(self, value: bytes) -> None:
        self.inspections: list[tuple[str, int]] = []

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        self.inspections.append(("decode", len(self)))
        return super().decode(encoding, errors)

    def strip(self, chars: bytes | None = None) -> bytes:
        self.inspections.append(("strip", len(self)))
        stripped = _TrackedValue(super().strip(chars))
        stripped.inspections = self.inspections
        return stripped


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
@pytest.mark.parametrize(
    ("raw_values", "etag", "converted"),
    [
        pytest.param((_ETAG,), CATALOG_ETAG, True, id="strong"),
        pytest.param((b'W/"catalog-v1"',), 'W/"catalog-v1"', True, id="weak"),
        pytest.param((b'""',), '""', True, id="empty-opaque-tag"),
        pytest.param((b" \t" + _ETAG + b"\t ",), CATALOG_ETAG, True, id="http-whitespace"),
        pytest.param(
            ("\u00a0".encode() + _ETAG + "\u2003".encode(),),
            CATALOG_ETAG,
            True,
            id="unicode-whitespace",
        ),
        pytest.param(
            (b" " * (_VALUE_LIMIT - len(_ETAG)) + _ETAG,),
            CATALOG_ETAG,
            True,
            id="inclusive-raw-padding-budget",
        ),
        pytest.param(
            (b" " * (_VALUE_LIMIT - len(_ETAG) + 1) + _ETAG,),
            None,
            False,
            id="raw-padding-one-over-budget",
        ),
        pytest.param(
            (
                "\u2003".encode() * ((_VALUE_LIMIT - len(_ETAG)) // 3)
                + b" " * ((_VALUE_LIMIT - len(_ETAG)) % 3)
                + _ETAG,
            ),
            CATALOG_ETAG,
            True,
            id="inclusive-multibyte-padding-budget",
        ),
        pytest.param(
            (b'"' + b"x" * 510 + b'"',),
            '"' + "x" * 510 + '"',
            True,
            id="trimmed-512-bytes",
        ),
        pytest.param(
            (b'W/"' + b"x" * 508 + b'"',),
            'W/"' + "x" * 508 + '"',
            True,
            id="weak-trimmed-512-bytes",
        ),
        pytest.param(
            (('"' + "\u00e9" * 255 + '"').encode(),),
            '"' + "\u00e9" * 255 + '"',
            True,
            id="multibyte-trimmed-512-bytes",
        ),
        pytest.param((b'"' + b"x" * 511 + b'"',), None, True, id="trimmed-513-bytes"),
        pytest.param(
            (('"' + "\u00e9" * 256 + '"').encode(),),
            None,
            True,
            id="multibyte-trimmed-over-512-bytes",
        ),
        pytest.param(
            (b'"' + b"x" * (_VALUE_LIMIT - 2) + b'"',),
            None,
            True,
            id="raw-budget-does-not-replace-trimmed-limit",
        ),
        pytest.param(
            (b'"' + b"x" * (_VALUE_LIMIT - 1) + b'"',),
            None,
            False,
            id="raw-value-one-over-budget",
        ),
        pytest.param(
            (b'"' + b"x" * (1024 * 1024 - 2) + b'"',),
            None,
            False,
            id="megabyte-singleton",
        ),
        pytest.param((b'"\xff"',), None, True, id="invalid-utf8"),
        pytest.param((b"",), None, True, id="blank"),
        pytest.param((), None, False, id="missing"),
        pytest.param((_ETAG, _ETAG), None, False, id="duplicate"),
        pytest.param((b"", _ETAG), None, False, id="empty-first-duplicate"),
        pytest.param((_ETAG,) * 4096, None, False, id="early-duplicate-before-many-values"),
    ],
)
async def test_catalog_etag_bounds_conversion_and_preserves_forwarding(
    real_flow, raw_values, etag, *, converted, prefetch
):
    owner = catalog_flow(real_flow)
    if prefetch:
        await prepare_prefetch_miss(owner)
    else:
        await prepare_miss(owner)
    owner.response = catalog_response(etag=None, encoding="br" if prefetch else "identity")
    values = tuple(_TrackedValue(value) for value in raw_values)
    owner.response.headers.fields += tuple(
        (b"eTaG" if index == 0 else b"ETAG", value) for index, value in enumerate(values)
    )
    upstream = owner.response
    fields = upstream.headers.fields
    wire_body = upstream.raw_content

    telemetry = await finish_response(owner)

    assert owner.response is upstream
    assert upstream.status_code == 200
    assert upstream.headers.fields is fields
    assert upstream.raw_content == wire_body
    assert response_stream(owner)(b"") == b""
    inspections = [inspection for value in values for inspection in value.inspections]
    if converted:
        assert any(operation == "decode" for operation, _ in inspections)
        assert all(size <= _VALUE_LIMIT for _, size in inspections)
    else:
        assert inspections == []
    if etag is not None:
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    else:
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_etag"
        assert catalog_cache.finalize_response(owner) is None

    completion = mitm_addon.response(owner)
    if completion is not None:
        await completion
    assert upstream.stream is False
    assert upstream.headers.fields is fields

    subsequent = catalog_flow(real_flow)
    try:
        await catalog_cache.prepare_request(subsequent, request_end_stream=True)
        if etag is not None:
            assert subsequent.response is not None
            assert subsequent.response.content == CATALOG_BODY
            assert subsequent.response.headers["ETag"] == etag
        else:
            assert subsequent.response is None
            assert subsequent.request.headers["Accept-Encoding"] == "identity"
    finally:
        catalog_cache.release_flow_state(subsequent)


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
@pytest.mark.parametrize("extra", ["field-limit", "long-name", "long-value"])
async def test_catalog_etag_ignores_unrelated_fields_and_accepts_field_limit(
    real_flow, extra, *, prefetch
):
    owner = catalog_flow(real_flow)
    if prefetch:
        await prepare_prefetch_miss(owner)
    else:
        await prepare_miss(owner)
    owner.response = catalog_response(encoding="br" if prefetch else "identity")
    if extra == "field-limit":
        padding = ((b"Unrelated", b"value"),) * (_FIELD_LIMIT - len(owner.response.headers.fields))
    elif extra == "long-name":
        padding = ((b"x" * (1024 * 1024), _TrackedValue(b"irrelevant")),)
    else:
        padding = ((b"Unrelated", _TrackedValue(b"x" * (1024 * 1024))),)
    owner.response.headers.fields += padding
    upstream = owner.response
    fields = upstream.headers.fields

    telemetry = await finish_response(owner)

    assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    assert owner.response is upstream
    assert upstream.headers.fields is fields
    assert all(not value.inspections for _, value in padding if isinstance(value, _TrackedValue))
    hit = catalog_flow(real_flow)
    try:
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == CATALOG_BODY
        assert hit.response.headers["ETag"] == CATALOG_ETAG
    finally:
        catalog_cache.release_flow_state(hit)
        catalog_cache.release_flow_state(owner)


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
@pytest.mark.parametrize("duplicate", [False, True], ids=["oversized", "duplicate"])
async def test_unusable_etag_releases_capacity_and_follower_before_body(
    real_flow, *, prefetch, duplicate
):
    other_owners = [
        catalog_flow(real_flow, version=f"other-owner-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS - 1)
    ]
    for other_owner in other_owners:
        await prepare_miss(other_owner)
    owner = catalog_flow(real_flow)
    if prefetch:
        await prepare_prefetch_miss(owner)
    else:
        await prepare_miss(owner)
    follower = catalog_flow(real_flow)
    started = asyncio.Event()

    async def prepare_follower() -> None:
        started.set()
        await catalog_cache.prepare_request(follower, request_end_stream=True)

    follower_prepare = asyncio.create_task(prepare_follower())
    try:
        await started.wait()
        assert not follower_prepare.done()
        owner.response = catalog_response(etag=None, encoding="br" if prefetch else "identity")
        values = tuple(
            _TrackedValue(value)
            for value in ((_ETAG, _ETAG) if duplicate else (b"x" * (_VALUE_LIMIT + 1),))
        )
        owner.response.headers.fields += tuple((b"ETag", value) for value in values)
        upstream = owner.response
        fields = upstream.headers.fields
        wire_body = upstream.raw_content or b""

        mitm_addon.responseheaders(owner)

        await asyncio.wait_for(follower_prepare, timeout=1)
        assert follower.response is None
        assert follower.request.headers["Accept-Encoding"] == "identity"
        assert all(value.inspections == [] for value in values)
        assert catalog_cache.finalize_response(owner) is None
        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(owner, telemetry)
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_etag"

        # Repeated old-owner cleanup must preserve the replacement's admission.
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(owner)
        follower.response = catalog_response()
        stored = await finish_response(follower)
        assert stored["model_catalog_cache_status"] == "model_catalog_cold_stored"
        hit = catalog_flow(real_flow)
        try:
            await catalog_cache.prepare_request(hit, request_end_stream=True)
            assert hit.response is not None
            assert hit.response.content == CATALOG_BODY
        finally:
            catalog_cache.release_flow_state(hit)

        assert owner.response is upstream
        assert upstream.status_code == 200
        assert upstream.headers.fields is fields
        stream = response_stream(owner)
        for chunk in (wire_body[:3], wire_body[3:], b""):
            assert stream(chunk) == chunk
        assert upstream.raw_content == wire_body
        completion = mitm_addon.response(owner)
        if completion is not None:
            await completion
        assert upstream.stream is False
    finally:
        if not follower_prepare.done():
            follower_prepare.cancel()
        await asyncio.gather(follower_prepare, return_exceptions=True)
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(follower)
        for other_owner in other_owners:
            catalog_cache.release_flow_state(other_owner)
