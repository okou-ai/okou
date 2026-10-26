"""Presence-only Vary inspection through real catalog response-header hooks."""

import asyncio
from unittest.mock import patch

import pytest
from mitmproxy import http

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


class _UninspectedValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("Vary presence must not decode values")

    def strip(self, chars: bytes | None = None) -> bytes:
        raise AssertionError("Vary presence must not strip values")

    def lower(self) -> bytes:
        raise AssertionError("Vary presence must not fold values")

    def __len__(self) -> int:
        raise AssertionError("Vary presence must not measure values")

    def __bytes__(self) -> bytes:
        raise AssertionError("Vary presence must not copy values")


class _UnfoldedName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("Vary presence folded an irrelevant or later name")


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
@pytest.mark.parametrize(
    ("extra_fields", "stored"),
    [
        pytest.param((), True, id="missing"),
        pytest.param(((b"X-Vary", b"Accept-Encoding"),), True, id="unrelated-name"),
        pytest.param(((b"Vary-Extra", b"*"), (b"Var", b"*")), True, id="lookalike-names"),
        pytest.param(((b"vArY", b"Accept-Encoding"),), False, id="mixed-case"),
        pytest.param(((b"Vary", b""),), False, id="empty"),
        pytest.param(((b"Vary", b"\xff"),), False, id="invalid-utf8"),
        pytest.param(((b"Vary", b"x" * (1024 * 1024)),), False, id="megabyte-value"),
        pytest.param(((b"VARY", b""), (b"vary", b"\xff")), False, id="empty-before-invalid-repeat"),
        pytest.param(
            ((b"Vary", b"*"), (b"vary", b"x" * (1024 * 1024))),
            False,
            id="early-presence-before-large-repeat",
        ),
    ],
)
async def test_vary_presence_preserves_storage_and_forwarding(
    real_flow, extra_fields, *, stored, prefetch
):
    owner = catalog_flow(real_flow)
    if prefetch:
        await prepare_prefetch_miss(owner)
    else:
        await prepare_miss(owner)
    owner.response = catalog_response(encoding="br" if prefetch else "identity")
    owner.response.headers.fields += tuple(
        (name, _UninspectedValue(value)) for name, value in extra_fields
    )
    upstream_response = owner.response
    fields = upstream_response.headers.fields
    wire_body = upstream_response.raw_content or b""
    subsequent = catalog_flow(real_flow)

    try:
        telemetry = await finish_response(owner)

        assert owner.response is upstream_response
        assert upstream_response.status_code == 200
        assert upstream_response.headers.fields is fields
        assert upstream_response.raw_content == wire_body
        assert response_stream(owner)(b"") == b""
        assert telemetry["model_catalog_cache_status"] == (
            "model_catalog_cold_stored" if stored else "model_catalog_cold_not_stored"
        )
        if not stored:
            assert telemetry["model_catalog_cache_bypass_reason"] == "response_vary"
            assert catalog_cache.finalize_response(owner) is None

        await catalog_cache.prepare_request(subsequent, request_end_stream=True)
        if stored:
            assert subsequent.response is not None
            assert subsequent.response.content == CATALOG_BODY
        else:
            assert subsequent.response is None
    finally:
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(subsequent)


@pytest.mark.parametrize(
    "extra_fields",
    [
        pytest.param(
            ((_UnfoldedName(b"x" * (1024 * 1024)), b"unused"), (b"Vary", b"")),
            id="length-before-folding",
        ),
        pytest.param(
            ((b"Vary", b""), (_UnfoldedName(b"vArY"), b"unused")),
            id="stop-after-first-presence",
        ),
    ],
)
async def test_vary_presence_bounds_name_inspection(real_flow, extra_fields):
    owner = catalog_flow(real_flow)
    await prepare_miss(owner)
    owner.response = catalog_response()
    owner.response.headers.fields += extra_fields
    fields = owner.response.headers.fields

    try:
        # Native mapping lookups also fold names for unrelated fields. Preserve
        # their normal byte semantics while guarding the addon's direct scans.
        with patch.object(http.Headers, "_kconv", staticmethod(bytes.lower)):
            mitm_addon.responseheaders(owner)

        telemetry: dict[str, object] = {}
        catalog_cache.add_network_log_fields(owner, telemetry)
        assert telemetry["model_catalog_cache_bypass_reason"] == "response_vary"
        assert owner.response.headers.fields is fields
        assert catalog_cache.finalize_response(owner) is None
    finally:
        catalog_cache.release_flow_state(owner)


@pytest.mark.parametrize("prefetch", [False, True], ids=["ordinary", "prefetch"])
async def test_vary_releases_capacity_and_follower_before_body(real_flow, *, prefetch):
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
    hit = catalog_flow(real_flow)
    try:
        await started.wait()
        assert not follower_prepare.done()
        owner.response = catalog_response(encoding="br" if prefetch else "identity")
        owner.response.headers.fields += ((b"Vary", _UninspectedValue(b"x" * (1024 * 1024))),)
        upstream_response = owner.response
        fields = upstream_response.headers.fields
        wire_body = upstream_response.raw_content or b""

        mitm_addon.responseheaders(owner)

        await asyncio.wait_for(follower_prepare, timeout=1)
        assert follower.response is None
        assert catalog_cache.finalize_response(owner) is None
        # Late, repeated cleanup must leave the replacement owner's slot intact.
        catalog_cache.release_flow_state(owner)
        catalog_cache.release_flow_state(owner)
        follower.response = catalog_response()
        telemetry = await finish_response(follower)
        assert telemetry["model_catalog_cache_status"] == "model_catalog_cold_stored"
        await catalog_cache.prepare_request(hit, request_end_stream=True)
        assert hit.response is not None
        assert hit.response.content == CATALOG_BODY

        assert owner.response is upstream_response
        assert upstream_response.status_code == 200
        assert upstream_response.headers.fields is fields
        stream = response_stream(owner)
        assert stream(wire_body[:3]) == wire_body[:3]
        assert stream(wire_body[3:]) == wire_body[3:]
        assert stream(b"") == b""
        assert upstream_response.raw_content == wire_body
    finally:
        if not follower_prepare.done():
            follower_prepare.cancel()
        await asyncio.gather(follower_prepare, return_exceptions=True)
        for flow in (owner, follower, hit, *other_owners):
            catalog_cache.release_flow_state(flow)
