"""Bounded cache-policy inspection through real catalog response-header hooks."""

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

_VALUE_LIMIT = 8 * 1024


class _TrackedPolicyValue(bytes):
    def __init__(self, value: bytes) -> None:
        self.inspections: list[str] = []

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        self.inspections.append("decode")
        return super().decode(encoding, errors)

    def strip(self, chars: bytes | None = None) -> bytes:
        self.inspections.append("strip")
        return super().strip(chars)

    def lower(self) -> bytes:
        self.inspections.append("lower")
        return super().lower()


@pytest.mark.parametrize(
    ("policy_fields", "stored"),
    [
        pytest.param(
            ((b"Cache-Control", b"x" * (_VALUE_LIMIT + 1)),),
            False,
            id="oversized-single-value",
        ),
        pytest.param(
            ((b"Cache-Control", b"x=0," * (256 * 1024) + b"public"),),
            False,
            id="megabyte-comma-heavy-value",
        ),
        pytest.param(
            ((b"Pragma", b"," * (_VALUE_LIMIT + 1)),),
            False,
            id="oversized-pragma",
        ),
        pytest.param(
            ((b"Cache-Control", b"x" * 4096), (b"cAcHe-CoNtRoL", b"x" * 4097)),
            False,
            id="repeated-cache-control-overflow",
        ),
        pytest.param(
            ((b"Pragma", b"," * 4096), (b"pRaGmA", b"," * 4097)),
            False,
            id="repeated-pragma-overflow",
        ),
        pytest.param(
            ((b"Cache-Control", b"x" * 4096), (b"Pragma", b"," * 4097)),
            False,
            id="combined-policy-overflow",
        ),
        pytest.param(
            ((b"Pragma", b"," * 4096), (b"Cache-Control", b"x" * 4097)),
            False,
            id="reversed-combined-policy-overflow",
        ),
        pytest.param(
            ((b"Cache-Control", b"no-store"), (b"Pragma", b"," * _VALUE_LIMIT)),
            False,
            id="unsafe-prefix-still-checks-budget-before-conversion",
        ),
        pytest.param(
            ((b"Cache-Control", b"x" * _VALUE_LIMIT),),
            True,
            id="exact-single-value",
        ),
        pytest.param(
            ((b"Cache-Control", b"x=0," * (_VALUE_LIMIT // 4)),),
            True,
            id="exact-comma-heavy-value",
        ),
        pytest.param(
            ((b"Pragma", b"," * _VALUE_LIMIT),),
            True,
            id="exact-pragma-value",
        ),
        pytest.param(
            ((b"Cache-Control", b"x" * 4096), (b"cAcHe-CoNtRoL", b"x" * 4096)),
            True,
            id="exact-repeated-value-total",
        ),
        pytest.param(
            ((b"Cache-Control", b"x" * 4096), (b"Pragma", b"," * 4096)),
            True,
            id="exact-combined-value-total",
        ),
    ],
)
async def test_policy_budget_bounds_conversion_and_preserves_forwarding(
    real_flow, policy_fields, *, stored
):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    values = tuple(_TrackedPolicyValue(value) for _, value in policy_fields)
    owner.response.headers.fields += tuple(
        (name, value) for (name, _), value in zip(policy_fields, values, strict=True)
    )
    upstream_response = owner.response
    fields = upstream_response.headers.fields

    telemetry = await finish_response(owner)

    assert owner.response is upstream_response
    assert owner.response.status_code == 200
    assert owner.response.headers.fields == fields
    assert owner.response.raw_content == CATALOG_BODY
    if stored:
        assert all(value.inspections for value in values)
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
    else:
        assert all(value.inspections == [] for value in values)
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_not_stored"
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_cache_control"
        assert catalog_cache.finalize_response(owner) is None

    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    if stored:
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
    else:
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)


@pytest.mark.parametrize(
    ("policy_fields", "stored"),
    [
        pytest.param((), True, id="missing"),
        pytest.param(((b"Cache-Control", b""), (b"Pragma", b"")), True, id="blank"),
        pytest.param(
            ((b"cAcHe-CoNtRoL", b" \tPuBlIc, , x-extension=1, public\t "),),
            True,
            id="case-whitespace-extensions-duplicates",
        ),
        pytest.param(
            ((b"Cache-Control", b"\xc2\xa0public\xc2\xa0, x=\xff"),),
            True,
            id="unicode-whitespace-and-surrogateescape",
        ),
        pytest.param(
            ((b"Pragma", b"no-cache=1, x-no-cache"),),
            True,
            id="pragma-requires-complete-token",
        ),
        pytest.param(
            ((b"Cache-Control", b'x="a,b", x-no-store, no-store-extension'),),
            True,
            id="existing-comma-and-extension-semantics",
        ),
        pytest.param(((b"Expires", b""),), False, id="empty-expires-is-present"),
        pytest.param(
            ((b"Expires", b"x" * (1024 * 1024)),), False, id="expires-presence-without-decode"
        ),
        *(
            pytest.param(
                ((b"Cache-Control", b"public"), (b"cAcHe-CoNtRoL", directive)),
                False,
                id=directive.decode(),
            )
            for directive in (
                b"must-revalidate",
                b"no-cache",
                b"no-store",
                b"proxy-revalidate",
                b"max-age=300",
                b"s-maxage=0",
                b"no-transform",
            )
        ),
        pytest.param(
            ((b"Cache-Control", b"public, \xc2\xa0NO-STORE\xc2\xa0 = value"),),
            False,
            id="unsafe-name-whitespace-case-and-argument",
        ),
        pytest.param(((b"Pragma", b"extension, \tNO-CACHE\t "),), False, id="pragma-no-cache"),
        pytest.param(
            ((b"Cache-Control", b"x=0," * 2044 + b"no-store"),),
            False,
            id="late-unsafe-comma-heavy-cache-control",
        ),
        pytest.param(
            ((b"Pragma", b"," * 8184 + b"no-cache"),),
            False,
            id="late-unsafe-comma-heavy-pragma",
        ),
        pytest.param(
            ((b"X-Unrelated", b"x" * (1024 * 1024)), (b"Cache-Control", b"public")),
            True,
            id="unrelated-value-does-not-consume-budget",
        ),
    ],
)
async def test_policy_semantics_preserve_storage_and_response(real_flow, policy_fields, *, stored):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    values = tuple(_TrackedPolicyValue(value) for _, value in policy_fields)
    owner.response.headers.fields += tuple(
        (name, value) for (name, _), value in zip(policy_fields, values, strict=True)
    )
    upstream_response = owner.response
    fields = upstream_response.headers.fields

    telemetry = await finish_response(owner)

    assert owner.response is upstream_response
    assert owner.response.headers.fields == fields
    assert owner.response.status_code == 200
    assert owner.response.raw_content == CATALOG_BODY
    for (name, _), value in zip(policy_fields, values, strict=True):
        if name.lower() in (b"expires", b"x-unrelated"):
            assert value.inspections == []
    assert telemetry["model_catalog_cache_status"] == (
        "model_catalog_cold_stored" if stored else "model_catalog_cold_not_stored"
    )
    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    if stored:
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
    else:
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_cache_control"
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)


@pytest.mark.parametrize("header_name", [b"Cache-Control", b"Pragma"])
@pytest.mark.parametrize("unsafe_first", [True, False], ids=["early", "late"])
async def test_unsafe_policy_stops_decoding_later_fields(real_flow, header_name, *, unsafe_first):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    unsafe = b"no-store" if header_name == b"Cache-Control" else b"no-cache"
    values = tuple(
        _TrackedPolicyValue(value)
        for value in ((unsafe, b"extension") if unsafe_first else (b"extension", unsafe))
    )
    owner.response.headers.fields += tuple((header_name, value) for value in values)

    telemetry = await finish_response(owner)

    assert telemetry["model_catalog_cache_bypass_reason"] == "response_cache_control"
    assert values[0].inspections == ["decode"]
    assert values[1].inspections == ([] if unsafe_first else ["decode"])


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
async def test_exhausted_policy_releases_capacity_and_follower_before_body(real_flow, *, prefetch):
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
        value = _TrackedPolicyValue(b"x=0," * (_VALUE_LIMIT // 4) + b"public")
        owner.response.headers.fields += ((b"Cache-Control", value),)
        upstream_response = owner.response
        fields = upstream_response.headers.fields
        wire_body = upstream_response.raw_content or b""

        mitm_addon.responseheaders(owner)

        await asyncio.wait_for(follower_prepare, timeout=1)
        assert follower.response is None
        assert value.inspections == []
        assert catalog_cache.finalize_response(owner) is None
        # Old-owner terminal cleanup must not retire the replacement owner.
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(owner)
        follower.response = catalog_response()
        telemetry = await finish_response(follower)
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
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
