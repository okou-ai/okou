"""Content-Encoding budgets through catalog hooks, replay, and single-flight recovery."""

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
from tests.content_encoding_cases import (
    BUDGET_CASES,
    VALUE_LIMIT,
    encoding_budget_fields,
    encoding_inspections,
)
from tests.flow_helpers import response_stream


@pytest.mark.parametrize("encoding", ["identity", "br"])
@pytest.mark.parametrize(("budget", "size", "in_budget"), BUDGET_CASES)
async def test_catalog_encoding_budget_bounds_conversion_and_storage(
    real_flow, encoding, budget, size, *, in_budget
):
    flow = catalog_flow(real_flow)
    if encoding == "br":
        await prepare_prefetch_miss(flow)
    else:
        await prepare_miss(flow)
    flow.response = catalog_response(encoding=encoding)
    ordinary_fields = tuple(
        (name, value)
        for name, value in flow.response.headers.fields
        if name.lower() != b"content-encoding"
    )
    fields = encoding_budget_fields(ordinary_fields, encoding, budget, size)
    flow.response.headers.fields = fields
    upstream_response = flow.response
    wire_body = flow.response.raw_content

    await finish_response(flow)

    assert bool(encoding_inspections(fields)) is in_budget
    assert flow.response is upstream_response
    assert flow.response.status_code == 200
    assert flow.response.raw_content == wire_body
    assert flow.response.headers.fields == fields
    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    # Catalog ignores blank list tokens, but Brotli's body decoder still rejects
    # the folded multi-value encoding when it validates a captured prefetch.
    stored = in_budget and not (encoding == "br" and budget == "aggregate")
    if stored:
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
        assert "Content-Encoding" not in subsequent.response.headers
    else:
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)


@pytest.mark.parametrize("encoding", ["identity", "br"])
async def test_exhausted_catalog_headers_release_follower_before_body(real_flow, encoding):
    other_owners = [
        catalog_flow(real_flow, version=f"other-owner-{index}")
        for index in range(catalog_cache.MAX_IN_FLIGHT_REQUESTS - 1)
    ]
    for other_owner in other_owners:
        await prepare_miss(other_owner)
    owner = catalog_flow(real_flow)
    if encoding == "br":
        await prepare_prefetch_miss(owner)
    else:
        await prepare_miss(owner)
    follower = catalog_flow(real_flow)
    follower_prepare = asyncio.create_task(
        catalog_cache.prepare_request(follower, request_end_stream=True)
    )
    try:
        await asyncio.sleep(0)
        assert not follower_prepare.done()
        owner.response = catalog_response()
        owner.response.headers.fields = encoding_budget_fields(
            owner.response.headers.fields, encoding, "single", VALUE_LIMIT + 1
        )

        mitm_addon.responseheaders(owner)

        await asyncio.wait_for(follower_prepare, timeout=1)
        assert follower.response is None
        assert follower.request.headers["Accept-Encoding"] == "identity"
        assert catalog_cache.finalize_response(owner) is None
        assert encoding_inspections(owner.response.headers.fields) == []

        # The replacement owner can store a response while the bypassed owner's
        # body has not completed; a later request observes the replacement.
        follower.response = catalog_response()
        await finish_response(follower)
        hit = catalog_flow(real_flow)
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == CATALOG_BODY
    finally:
        if not follower_prepare.done():
            follower_prepare.cancel()
        await asyncio.gather(follower_prepare, return_exceptions=True)
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(follower)
        for other_owner in other_owners:
            catalog_cache.release_flow_state(other_owner)


@pytest.mark.parametrize(
    ("values", "stored"),
    [
        pytest.param((), True, id="missing"),
        pytest.param((b"",), False, id="empty"),
        pytest.param((b" \tIdEnTiTy\t ",), True, id="mixed-case-whitespace"),
        pytest.param((b"\xc2\xa0identity\xc2\xa0",), True, id="unicode-whitespace"),
        pytest.param((b"identity", b""), True, id="blank-duplicate"),
        pytest.param((b"identity", b"identity"), False, id="duplicate-coding"),
        pytest.param((b",identity,",), True, id="empty-list-tokens"),
        pytest.param((b"identity, gzip",), False, id="multiple-codings"),
        pytest.param((b"\xff",), False, id="surrogateescape"),
    ],
)
async def test_catalog_preserves_single_coding_semantics(real_flow, values, *, stored):
    flow = catalog_flow(real_flow)
    await prepare_miss(flow)
    flow.response = catalog_response()
    flow.response.headers.fields += tuple((b"Content-Encoding", value) for value in values)

    if stored:
        await finish_response(flow)
        assert flow.response.status_code == 200
    else:
        mitm_addon.responseheaders(flow)
        assert flow.response.status_code == 502
        assert response_stream(flow)(CATALOG_BODY) == b""

    subsequent = catalog_flow(real_flow)
    await catalog_cache.prepare_request(subsequent, request_end_stream=True)
    if stored:
        assert subsequent.response is not None
        assert subsequent.response.content == CATALOG_BODY
    else:
        assert subsequent.response is None
        catalog_cache.handle_error(subsequent)
