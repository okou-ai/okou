"""Diagnostic header work limits and credential semantics through real addon hooks."""

import json

import pytest
from mitmproxy import http

import mitm_addon
from tests.connector_diagnostic_helpers import (
    connector_diagnostic_test_firewalls,
    write_connector_diagnostic_catalog_cache,
    write_shared_base_diagnostic_catalog,
)
from tests.flow_helpers import response_stream
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _single_firewall_sandbox,
    _write_registry,
)

_FIELD_LIMIT = 1024
_NAME_LIMIT = 1024
_TOTAL_NAME_LIMIT = 16 * 1024
_VALUE_LIMIT = 16 * 1024
_TOTAL_VALUE_LIMIT = 64 * 1024
_UPSTREAM_BODY = b"upstream auth error"


class _UnnormalizedName(bytes):
    def lower(self) -> bytes:
        raise AssertionError("normalized a name outside the diagnostic inspection budget")


class _UndecodedValue(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("decoded a value outside the diagnostic inspection budget")


async def _assert_response_diagnostic(
    tmp_path,
    real_flow,
    mitm_ctx,
    fields,
    *,
    expect_diagnostic: bool,
    streamed: bool,
    configured_names: tuple[str, ...] = ("Authorization",),
):
    firewalls = connector_diagnostic_test_firewalls()
    firewalls["fal"]["apis"][0]["auth"]["headers"] = dict.fromkeys(
        configured_names, "${{ secrets.FAL_TOKEN }}"
    )
    # Keep a credential-requiring candidate even when testing only generic headers.
    firewalls["fal"]["apis"][0]["auth"]["query"] = {"catalog_session": "${{ secrets.FAL_TOKEN }}"}
    write_connector_diagnostic_catalog_cache(tmp_path, firewalls=firewalls)
    reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="fal.run",
        path="/fal-ai/nano-banana-pro",
        method="POST",
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)
        assert flow.response is None
        # Establish real classification before supplying raw response-hook inputs.
        # Request lifecycle admission is exercised separately below.
        flow.request.headers = http.Headers(fields)
        request_fields = flow.request.headers.fields
        upstream = http.Response.make(
            401,
            _UPSTREAM_BODY,
            {"Content-Type": "text/plain", "X-Upstream": "preserved"},
        )
        flow.response = upstream
        upstream_fields = upstream.headers.fields

        if streamed:
            mitm_addon.responseheaders(flow)
            stream = response_stream(flow)
            if expect_diagnostic:
                assert stream(_UPSTREAM_BODY) == ()
                content = stream(b"")
                assert isinstance(content, bytes)
                assert json.loads(content)["error"] == "connector_not_configured_for_run"
            else:
                assert stream(_UPSTREAM_BODY) == _UPSTREAM_BODY
                assert stream(b"") == b""
                assert upstream.headers.fields == upstream_fields
        result = mitm_addon.response(flow)
        assert result is None

    assert flow.request.headers.fields == request_fields
    assert flow.response is upstream
    assert upstream.status_code == 401
    if expect_diagnostic:
        content = upstream.content
        assert content is not None
        assert json.loads(content)["error"] == "connector_not_configured_for_run"
    else:
        assert upstream.content == _UPSTREAM_BODY
        assert upstream.headers.fields == upstream_fields


@pytest.mark.parametrize("streamed", [False, True], ids=["buffered", "streamed"])
@pytest.mark.parametrize("over_limit", [False, True], ids=["exact", "over"])
@pytest.mark.parametrize("budget", ["fields", "name", "total-names", "value", "total-values"])
async def test_header_budget_boundaries(
    tmp_path, real_flow, mitm_ctx, budget, over_limit, streamed
):
    extra = int(over_limit)
    if budget == "fields":
        fields = ((b"X", b""),) * (_FIELD_LIMIT + extra)
    elif budget == "name":
        fields = ((b"X" * (_NAME_LIMIT + extra), b""),)
    elif budget == "total-names":
        fields = ((b"X" * _NAME_LIMIT, b""),) * (_TOTAL_NAME_LIMIT // _NAME_LIMIT)
        if over_limit:
            fields += ((b"X", b""),)
    elif budget == "value":
        fields = ((b"Authorization", b" " * (_VALUE_LIMIT + extra)),)
    else:
        fields = tuple(
            (name, b" " * _VALUE_LIMIT)
            for name in (b"Authorization", b"X-API-Key", b"API-Key", b"AUTHORIZATION")
        )
        assert sum(len(value) for _, value in fields) == _TOTAL_VALUE_LIMIT
        if over_limit:
            fields += ((b"X-API-Key", b" "),)

    await _assert_response_diagnostic(
        tmp_path,
        real_flow,
        mitm_ctx,
        fields,
        expect_diagnostic=not over_limit,
        streamed=streamed,
    )


# The independent browser heuristic stops at this oversized User-Agent without
# decoding it. That keeps name guards specific to diagnostic inspection while
# still running the real response hooks and the real browser check.
_GUARDED_USER_AGENT = ((b"User-Agent", _UndecodedValue(b"x" * (64 * 1024))),)


@pytest.mark.parametrize("streamed", [False, True], ids=["buffered", "streamed"])
@pytest.mark.parametrize(
    ("fields", "expect_diagnostic"),
    [
        pytest.param(
            ((_UnnormalizedName(b"X" * (_NAME_LIMIT + 1)), b""),),
            False,
            id="name-before-normalization",
        ),
        pytest.param(
            ((b"X" * _NAME_LIMIT, b""),) * 15
            + ((b"X" * (_NAME_LIMIT - len(b"User-Agent")), b""),)
            + ((_UnnormalizedName(b"X"), b""),),
            False,
            id="aggregate-names-before-normalization",
        ),
        pytest.param(
            ((b"X", b""),) * (_FIELD_LIMIT - 1)
            + ((_UnnormalizedName(b"X"), _UndecodedValue(b"")),),
            False,
            id="field-limit-before-normalization",
        ),
        pytest.param(
            ((b"Authorization", _UndecodedValue(b" " * (_VALUE_LIMIT + 1))),),
            False,
            id="value-before-decoding",
        ),
        pytest.param(
            ((b"Authorization", _UndecodedValue("\u2003".encode() * (_VALUE_LIMIT // 3 + 1))),),
            False,
            id="value-budget-counts-bytes",
        ),
        pytest.param(
            ((b"Authorization", b" " * _VALUE_LIMIT),) * 4
            + ((b"X-API-Key", _UndecodedValue(b" ")),),
            False,
            id="aggregate-values-before-decoding",
        ),
        pytest.param(
            (
                (b"Authorization", b"Key synthetic"),
                (b"Authorization", _UndecodedValue(b"x" * (1024 * 1024))),
            ),
            False,
            id="credential-before-large-duplicate",
        ),
        pytest.param(
            ((b"Authorization", b"Key synthetic"),)
            + ((_UnnormalizedName(b"Authorization"), _UndecodedValue(b"Bearer")),)
            * (_FIELD_LIMIT + 1),
            False,
            id="credential-before-dense-trailing-fields",
        ),
        pytest.param(
            ((b"X-Unrelated", _UndecodedValue(b"x" * (1024 * 1024))),),
            True,
            id="unrelated-value-never-decoded",
        ),
    ],
)
async def test_header_inspection_stops_before_expensive_work(
    tmp_path, real_flow, mitm_ctx, fields, expect_diagnostic, streamed
):
    await _assert_response_diagnostic(
        tmp_path,
        real_flow,
        mitm_ctx,
        _GUARDED_USER_AGENT + fields,
        expect_diagnostic=expect_diagnostic,
        streamed=streamed,
    )


@pytest.mark.parametrize("streamed", [False, True], ids=["buffered", "streamed"])
@pytest.mark.parametrize(
    ("fields", "configured_names", "expect_diagnostic"),
    [
        pytest.param(((b"aUtHoRiZaTiOn", b"Bearer synthetic"),), (), False, id="mixed-case"),
        pytest.param(((b"X-API-Key", b"Bearer"),), (), False, id="generic-api-key"),
        pytest.param(((b"API-Key", b"synthetic"),), (), False, id="generic-key"),
        pytest.param(
            ((b"x-custom-auth", b"Bearer"),), ("X-CUSTOM-AUTH",), False, id="configured-key"
        ),
        pytest.param(
            (("x-\u00e9".encode(), b"synthetic"),),
            ("X-\u00c9",),
            False,
            id="configured-unicode-name",
        ),
        pytest.param(
            (("x-\u00c9".encode(), b"synthetic"),),
            ("X-\u00c9",),
            True,
            id="raw-name-keeps-byte-case-semantics",
        ),
        pytest.param(((b"Authorization", b"CustomScheme"),), (), False, id="unknown-scheme"),
        pytest.param(((b"Authorization", b"\xff"),), (), False, id="surrogateescape"),
        pytest.param(
            ((b"Authorization", "\u2003BeArEr\u00a0synthetic\u2003".encode()),),
            (),
            False,
            id="unicode-credential-whitespace",
        ),
        pytest.param(
            ((b"Authorization", "\u2003Bearer\u00a0".encode()),),
            (),
            True,
            id="unicode-empty-scheme",
        ),
        pytest.param(((b"X-API-Key", "\u2003\u00a0".encode()),), (), True, id="unicode-blank"),
        pytest.param(
            ((b"Authorization", b"Bearer"), (b"AUTHORIZATION", b"Key synthetic")),
            (),
            False,
            id="credential-in-later-duplicate",
        ),
        pytest.param(((b"Proxy-Authorization", b"Basic synthetic"),), (), True, id="proxy-only"),
        pytest.param(
            ((b"Proxy-Authorization", b"Basic synthetic"),),
            ("Proxy-Authorization",),
            False,
            id="configured-proxy",
        ),
        pytest.param(
            ((b"Proxy-Authorization", b"Basic "),),
            ("Proxy-Authorization",),
            True,
            id="configured-proxy-empty",
        ),
    ],
)
async def test_accepted_header_credential_semantics(
    tmp_path, real_flow, mitm_ctx, fields, configured_names, expect_diagnostic, streamed
):
    await _assert_response_diagnostic(
        tmp_path,
        real_flow,
        mitm_ctx,
        fields,
        expect_diagnostic=expect_diagnostic,
        streamed=streamed,
        configured_names=configured_names,
    )


@pytest.mark.parametrize(
    "scheme", ["api-key", "apikey", "basic", "bearer", "digest", "key", "oauth", "oauth2", "token"]
)
async def test_known_schemes_without_credentials_still_receive_diagnostics(
    tmp_path, real_flow, mitm_ctx, scheme
):
    await _assert_response_diagnostic(
        tmp_path,
        real_flow,
        mitm_ctx,
        ((b"Authorization", b" \t" + scheme.upper().encode() + b"\t "),),
        expect_diagnostic=True,
        streamed=False,
    )


@pytest.mark.parametrize("over_limit", [False, True], ids=["exact", "over"])
@pytest.mark.parametrize("budget", ["fields", "name", "total-names", "encoded-name"])
async def test_configured_name_lookup_is_bounded(tmp_path, real_flow, mitm_ctx, budget, over_limit):
    extra = int(over_limit)
    if budget == "fields":
        names = tuple(f"X-{index}" for index in range(_FIELD_LIMIT + extra))
    elif budget == "name":
        names = ("X" * (_NAME_LIMIT + extra),)
    elif budget == "encoded-name":
        names = ("\u00c9" * (_NAME_LIMIT // 2 + extra),)
    else:
        names = tuple(f"X-{index:02}" + "x" * (_NAME_LIMIT - 4) for index in range(16))
        if over_limit:
            names += ("X",)

    await _assert_response_diagnostic(
        tmp_path,
        real_flow,
        mitm_ctx,
        (),
        expect_diagnostic=not over_limit,
        streamed=False,
        configured_names=names,
    )


@pytest.mark.parametrize("over_limit", [False, True], ids=["exact", "over"])
@pytest.mark.parametrize("budget", ["fields", "name", "value", "total-values"])
async def test_shared_base_request_lifecycle_keeps_normal_auth_when_inspection_exhausted(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, budget, over_limit
):
    write_shared_base_diagnostic_catalog(
        tmp_path,
        active_permissions=[{"name": "active-read", "rules": ["GET /active"]}],
        inactive_permissions=[{"name": "inactive-read", "rules": ["GET /inactive"]}],
    )
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="active-shared",
            api_entry={
                "base": "https://shared.example.com",
                "auth": {"headers": {"X-Active-Auth": "${{ secrets.ACTIVE_TOKEN }}"}},
                "permissions": [{"name": "active-read", "rules": ["GET /active"]}],
            },
            network_policy={"allow": ["active-read"], "unknownPolicy": "allow"},
        ),
    )
    extra = int(over_limit)
    if budget == "fields":
        fields = ((b"X", b""),) * (_FIELD_LIMIT - 1 + extra)
    elif budget == "name":
        fields = ((b"X" * (_NAME_LIMIT + extra), b""),)
    elif budget == "value":
        fields = (
            ((b"Authorization", _UndecodedValue(b" " * (_VALUE_LIMIT + 1))),)
            if over_limit
            else ((b"Authorization", b" " * _VALUE_LIMIT),)
        )
    else:
        fields = ((b"Authorization", b" " * _VALUE_LIMIT),) * 4
        if over_limit:
            fields += ((b"X-API-Key", _UndecodedValue(b" ")),)
    fields = ((b"Host", b"shared.example.com"), *fields)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="shared.example.com",
        path="/inactive",
        request_body=b"",
        request_headers=http.Headers(fields),
    )

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"X-Active-Auth": "synthetic"}),
    ):
        result = mitm_addon.requestheaders(flow)
        assert result is None
        await mitm_addon.request(flow)

    assert flow.error is None
    if over_limit:
        assert flow.response is None
        assert flow.request.headers.fields == (*fields, (b"X-Active-Auth", b"synthetic"))
    else:
        assert flow.response is not None
        assert flow.response.status_code == 424
        content = flow.response.content
        assert content is not None
        assert json.loads(content)["connector"] == "inactive-shared"
        assert flow.request.headers.fields == fields
