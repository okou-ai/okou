"""Bound Authorization prefix acquisition through the real request-header hook."""

from typing import SupportsIndex, overload

import pytest
from mitmproxy import http
from mitmproxy.net.http import http1, validate

import mitm_addon
import registry
import upstream_destination_binding
from tests.request_handler_helpers import _write_github_firewall_registry
from tests.requestheaders_helpers import _assert_no_request_stream
from tests.upstream_connection_helpers import seed_server_binding

_PREFIX_BYTES = 64
_LARGE_BEARER = b"Bearer " + b"x" * 1_048_576


class _PrefixOnlyValue(bytes):
    read_limit = _PREFIX_BYTES
    probe_finished = False

    def __bytes__(self) -> bytes:
        if self.probe_finished:
            return bytes.__getitem__(self, slice(None))
        raise AssertionError("prefix probe copied a complete Authorization value")

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        if self.probe_finished:
            return super().decode(encoding, errors)
        raise AssertionError("prefix probe decoded a complete Authorization value")

    def lstrip(self, chars: bytes | None = None) -> bytes:
        if self.probe_finished:
            return super().lstrip(chars)
        raise AssertionError("prefix probe stripped a complete Authorization value")

    @overload
    def __getitem__(self, key: SupportsIndex) -> int: ...

    @overload
    def __getitem__(self, key: slice) -> bytes: ...

    def __getitem__(self, key: SupportsIndex | slice) -> int | bytes:
        if self.probe_finished:
            return super().__getitem__(key)
        if isinstance(key, slice):
            assert key.start in (None, 0)
            assert key.stop is not None
            assert 0 <= key.stop <= self.read_limit
            assert key.step in (None, 1)
        else:
            assert 0 <= key.__index__() < self.read_limit
        return super().__getitem__(key)


class _UnreadValue(_PrefixOnlyValue):
    read_limit = 0


def _bound_flow(
    real_flow, values: tuple[bytes, ...], *, path: str = "/repos/octocat/hello"
) -> http.HTTPFlow:
    request = http1.read_request_head(
        [
            f"GET https://api.github.com{path} HTTP/1.1".encode(),
            b"Host: api.github.com",
            b"Content-Length: 0",
            *(b"aUtHoRiZaTiOn: " + value for value in values),
        ]
    )
    validate.validate_headers(request)
    assert http1.expected_http_body_size(request) == 0
    # Instrument equal native bytes after parsing, without replacing a header API.
    request.headers.fields = tuple(
        (name, _PrefixOnlyValue(value) if name.lower() == b"authorization" else value)
        for name, value in request.headers.fields
    )
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host="203.0.113.10",
        sni="api.github.com",
    )
    flow.request = request
    seed_server_binding(
        flow.server_conn,
        client=flow.client_conn,
        host="api.github.com",
        port=443,
        kinds=frozenset(("connector_auth",)),
        original_address=("203.0.113.10", 443),
    )
    flow.server_conn.address = ("api.github.com", 443)
    return flow


@pytest.mark.parametrize(
    ("values", "path", "aws_signal"),
    [
        pytest.param((), "/repos", False, id="no-authorization"),
        pytest.param((_LARGE_BEARER,), "/repos", False, id="large-bearer"),
        pytest.param((_LARGE_BEARER, _LARGE_BEARER), "/repos", False, id="duplicate-bearer"),
        pytest.param((b"AWS4-",), "/repos", True, id="exact-scheme"),
        pytest.param((b"aws4-",), "/repos", False, id="case-sensitive-scheme"),
        pytest.param((b"AWS4",), "/repos", False, id="complete-partial-scheme"),
        pytest.param((b"",), "/repos", False, id="complete-empty-value"),
        pytest.param((b"\xc2\xa0",), "/repos", False, id="complete-whitespace"),
        pytest.param(
            (b"\xc2\xa0\t\xe1\x9a\x80\xe2\x80\x83\xe3\x80\x80AWS4-",),
            "/repos",
            True,
            id="unicode-whitespace",
        ),
        pytest.param((b"\xc2\xa0" + _LARGE_BEARER,), "/repos", False, id="unicode-bearer"),
        pytest.param((b"\xe2\x80\x8bAWS4-",), "/repos", False, id="unicode-non-whitespace"),
        pytest.param((b"\xffAWS4-",), "/repos", False, id="surrogateescape-nonmatch"),
        pytest.param((b"AWS4-\xff",), "/repos", True, id="invalid-utf8-after-scheme"),
        pytest.param(
            (b"\xc2\xa0" + b" " * 57 + b"AWS4-",),
            "/repos",
            True,
            id="scheme-at-exact-sample-end",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 57 + b"AWS4x" + _LARGE_BEARER,),
            "/repos",
            False,
            id="mismatch-at-sample-end",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 60 + b"AWS4-",),
            "/repos",
            True,
            id="partial-scheme-at-sample-end",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 62 + b"AWS4-",),
            "/repos",
            True,
            id="scheme-after-sample-end",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 62 + _LARGE_BEARER,),
            "/repos",
            True,
            id="inconclusive-whitespace",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 61 + b"\xc2\xa0AWS4-",),
            "/repos",
            True,
            id="split-two-byte-whitespace",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 61 + b"\xe3\x80\x80AWS4-",),
            "/repos",
            True,
            id="split-three-byte-whitespace-first-byte",
        ),
        pytest.param(
            (b"\xc2\xa0" + b" " * 60 + b"\xe3\x80\x80AWS4-",),
            "/repos",
            True,
            id="split-three-byte-whitespace-second-byte",
        ),
        pytest.param((_LARGE_BEARER, b"AWS4-"), "/repos", True, id="later-aws-field"),
        pytest.param((b"AWS4-", _LARGE_BEARER), "/repos", True, id="early-aws-field"),
        pytest.param(
            (_LARGE_BEARER,),
            "/repos?X-Amz-Algorithm=AWS4-HMAC-SHA256",
            True,
            id="query-signal",
        ),
    ],
)
def test_prebound_prefix_decision_has_bounded_acquisition(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, monkeypatch, values, path, aws_signal
):
    registry_path = _write_github_firewall_registry(tmp_path)
    flow = _bound_flow(real_flow, values, path=path)
    if values and values[0] == b"AWS4-":
        seen_first = False
        fields: list[tuple[bytes, bytes]] = []
        for name, value in flow.request.headers.fields:
            if name.lower() == b"authorization":
                if seen_first:
                    value = _UnreadValue(bytes.__getitem__(value, slice(None)))
                seen_first = True
            fields.append((name, value))
        flow.request.headers.fields = tuple(fields)
    original_fields = flow.request.headers.fields
    registry_reads: list[str] = []
    load_registry_state = registry.load_registry_state
    prefix_signals: list[bool] = []
    request_may_use_aws_sigv4 = mitm_addon._request_may_use_aws_sigv4

    def track_prefix_probe(candidate: http.HTTPFlow) -> bool:
        assert not registry_reads
        signal = request_may_use_aws_sigv4(candidate)
        prefix_signals.append(signal)
        return signal

    def track_registry_read(path: str) -> registry.RegistryState:
        registry_reads.append(path)
        # The canonical owner may inspect complete values under its own budget.
        # Release acquisition instrumentation here without changing native bytes.
        for _name, value in flow.request.headers.fields:
            if isinstance(value, _PrefixOnlyValue):
                value.probe_finished = True
        return load_registry_state(path)

    monkeypatch.setattr(registry, "load_registry_state", track_registry_read)
    monkeypatch.setattr(mitm_addon, "_request_may_use_aws_sigv4", track_prefix_probe)
    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None

    assert prefix_signals == [aws_signal]
    assert registry_reads == [str(registry_path)]
    auth_fetch.assert_not_called()
    assert flow.response is None
    assert flow.error is None
    _assert_no_request_stream(flow)
    assert flow.request.headers.fields == original_fields
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
