"""Catalog Content-Type work budgets, folded replay and single-flight recovery."""

import asyncio

import pytest

import codex_model_catalog_cache as catalog_cache
import mitm_addon
from tests.codex_model_catalog_cache_helpers import (
    CATALOG_BODY,
    catalog_flow,
    catalog_response,
    finish_response,
    prepare_miss,
    prepare_prefetch_miss,
)
from tests.flow_helpers import response_stream

_VALUE_LIMIT = 256
_FIELD_LIMIT = 8 * 1024
_PARAMETER_PREFIX = b"application/json; x="


class _TrackedContentType(bytes):
    def __init__(self, value: bytes) -> None:
        self.decoded_sizes: list[int] = []

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        self.decoded_sizes.append(len(self))
        return super().decode(encoding, errors)


class _UnconvertedHeaderName(bytes):
    def lower(self) -> bytes:
        pytest.fail("catalog acquisition converted an unrelated oversized header name")


def _parameter_value(size: int) -> bytes:
    return _PARAMETER_PREFIX + b"x" * (size - len(_PARAMETER_PREFIX))


@pytest.mark.parametrize(
    ("raw_values", "in_budget", "stored"),
    [
        pytest.param((_parameter_value(_VALUE_LIMIT),), True, True, id="exact-single"),
        pytest.param((_parameter_value(_VALUE_LIMIT + 1),), False, False, id="over-single"),
        pytest.param((_parameter_value(1024 * 1024),), False, False, id="megabyte-single"),
        pytest.param((_parameter_value(128), b"x" * 126), True, True, id="exact-folded-repeat"),
        pytest.param((_parameter_value(128), b"x" * 127), False, False, id="separator-overflow"),
        pytest.param(
            (_parameter_value(128), b"x" * 129), False, False, id="raw-aggregate-overflow"
        ),
        pytest.param((_parameter_value(254), b""), True, True, id="exact-with-empty-repeat"),
        pytest.param(
            (_parameter_value(254), b"", b""), False, False, id="empty-separator-overflow"
        ),
        pytest.param((_PARAMETER_PREFIX + b"\xc3\xa9" * 118,), True, True, id="exact-utf8-bytes"),
        pytest.param(
            (_PARAMETER_PREFIX + b"\xc3\xa9" * 118 + b"x",),
            False,
            False,
            id="over-utf8-bytes-under-character-limit",
        ),
        pytest.param((_PARAMETER_PREFIX + b"\xff",), True, False, id="invalid-utf8-parameter"),
        pytest.param(
            (_PARAMETER_PREFIX + b"\xc3", b"\xa9"),
            True,
            False,
            id="utf8-cannot-span-fields",
        ),
    ],
)
async def test_content_type_budget_bounds_conversion_and_preserves_replay(
    real_flow, raw_values, *, in_budget, stored
):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    del owner.response.headers["Content-Type"]
    values = tuple(_TrackedContentType(value) for value in raw_values)
    owner.response.headers.fields += tuple((b"cOnTeNt-TyPe", value) for value in values)
    upstream_response = owner.response
    fields = upstream_response.headers.fields

    telemetry = await finish_response(owner)

    if in_budget:
        assert any(value.decoded_sizes for value in values)
    else:
        assert all(value.decoded_sizes == [] for value in values)
    assert owner.response is upstream_response
    assert owner.response.status_code == 200
    assert owner.response.headers.fields == fields
    assert owner.response.raw_content == CATALOG_BODY
    assert telemetry["model_catalog_cache_status"] == (
        "model_catalog_cold_stored" if stored else "model_catalog_cold_not_stored"
    )
    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    if stored:
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
        assert subsequent.response.headers["Content-Type"] == b", ".join(raw_values).decode()
    else:
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_content_type"
        assert catalog_cache.finalize_response(owner) is None
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)


@pytest.mark.parametrize(
    ("values", "stored"),
    [
        pytest.param((), False, id="missing"),
        pytest.param((b"",), False, id="blank"),
        pytest.param((b"application/json",), True, id="json"),
        pytest.param((b"application/problem+json",), True, id="json-suffix"),
        pytest.param(
            (b" \tApPlIcAtIoN/JsOn\t ; Charset=UTF-8",), True, id="case-whitespace-parameter"
        ),
        pytest.param(
            (b"\xc2\xa0application/json\xc2\xa0; x=\xc3\xa9",),
            True,
            id="unicode-whitespace-and-parameter",
        ),
        pytest.param(
            (b"application/json; charset=utf-8", b"application/other"),
            True,
            id="parameterized-repeat-remains-eligible",
        ),
        pytest.param(
            (b"application/json", b"application/json"),
            False,
            id="unparameterized-repeat-remains-ineligible",
        ),
        pytest.param((b"text/plain; x=application/json",), False, id="non-json"),
    ],
)
async def test_content_type_semantics_preserve_forwarding_and_replay(real_flow, values, *, stored):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    owner.response.headers.set_all("Content-Type", values)
    upstream_response = owner.response
    fields = upstream_response.headers.fields

    telemetry = await finish_response(owner)

    assert owner.response is upstream_response
    assert owner.response.status_code == 200
    assert owner.response.headers.fields == fields
    assert owner.response.raw_content == CATALOG_BODY
    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    if stored:
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
        assert subsequent.response.headers["Content-Type"] == b", ".join(values).decode()
    else:
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_content_type"
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
async def test_oversized_content_type_releases_follower_and_capacity_before_body(
    real_flow, *, prefetch
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
        owner.response = catalog_response(encoding="br" if prefetch else "identity")
        value = _TrackedContentType(_parameter_value(_VALUE_LIMIT + 1))
        owner.response.headers.set_all("Content-Type", [value])
        upstream_response = owner.response
        fields = upstream_response.headers.fields
        wire_body = upstream_response.raw_content or b""

        mitm_addon.responseheaders(owner)

        await asyncio.wait_for(follower_prepare, timeout=1)
        assert follower.response is None
        assert value.decoded_sizes == []
        assert catalog_cache.finalize_response(owner) is None
        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(owner, telemetry)
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_content_type"
        # Late cleanup of the old owner must not release the replacement owner.
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(owner)
        follower.response = catalog_response()
        replacement_telemetry = await finish_response(follower)
        assert replacement_telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
        hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == CATALOG_BODY

        assert owner.response is upstream_response
        assert owner.response.status_code == 200
        assert owner.response.headers.fields == fields
        stream = response_stream(owner)
        assert stream(wire_body[:3]) == wire_body[:3]
        assert stream(wire_body[3:]) == wire_body[3:]
        assert stream(b"") == b""
        assert owner.response.raw_content == wire_body
    finally:
        if not follower_prepare.done():
            follower_prepare.cancel()
        await asyncio.gather(follower_prepare, return_exceptions=True)
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(follower)
        for other_owner in other_owners:
            catalog_cache.release_flow_state(other_owner)


async def test_catalog_content_type_skips_unrelated_oversized_name_before_bypass(real_flow):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    del owner.response.headers["Content-Type"]
    value = _TrackedContentType(_parameter_value(_VALUE_LIMIT + 1))
    owner.response.headers.fields += (
        (_UnconvertedHeaderName(b"X" * (1024 * 1024)), b"unrelated"),
        (b"Content-Type", value),
    )
    upstream_response = owner.response
    fields = upstream_response.headers.fields

    assert catalog_cache.handle_response_headers(owner)

    assert value.decoded_sizes == []
    assert owner.response is upstream_response
    assert owner.response.status_code == 200
    assert owner.response.headers.fields == fields
    telemetry: dict[str, object] = {}
    catalog_cache.add_network_log_fields(owner, telemetry)
    assert telemetry["model_catalog_cache_bypass_reason"] == "response_content_type"
    assert catalog_cache.finalize_response(owner) is None


@pytest.mark.parametrize("field_count", [_FIELD_LIMIT, _FIELD_LIMIT + 1])
async def test_catalog_content_type_preserves_existing_field_traversal_limit(
    real_flow, field_count
):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    fields = owner.response.headers.fields
    owner.response.headers.fields = ((b"X-Padding", b""),) * (field_count - len(fields)) + fields

    telemetry = await finish_response(owner)

    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    if field_count == _FIELD_LIMIT:
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
    else:
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_encoding"
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)
