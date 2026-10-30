"""Unicode work bounds through real header and request classification hooks."""

import json
import unicodedata
import urllib.parse
from pathlib import Path
from typing import Literal

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from path_security import MAX_PATH_VALIDATION_CHARACTERS
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry
from tests.requestheaders_helpers import await_requestheaders_result


@pytest.fixture
def path_firewall_registry(tmp_path: Path) -> Path:
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
        ),
    )


@pytest.mark.parametrize(
    ("segment", "decode_passes"),
    [
        pytest.param("a" + "\u0315\u0300" * 16000, 0, id="long-alternating"),
        pytest.param("a" + "\u0300" * 16000 + "\u0315" * 16000, 0, id="long-ordered"),
        pytest.param("a" + "\u0315\u0300" * 4096, 1, id="long-percent-encoded"),
        pytest.param("\u0300" * 31, 0, id="leading-nonstarters"),
        pytest.param("a" + "\u0344" * 16, 0, id="decomposition-expansion"),
        pytest.param("a" + "\u0f73" * 16, 0, id="class-zero-decomposition"),
        pytest.param("a" + "\uff9e" * 31, 0, id="compatibility-nonstarter"),
        pytest.param("\u00e9" + "\u0300" * 30, 0, id="precomposed-trailing-mark"),
        pytest.param("a" + "\u0315\u0300" * 16, 2, id="nested-percent-encoded"),
        pytest.param("a" + "\u0f73" * 16, 5, id="final-decode-pass"),
        pytest.param("a" + "\u0300" * 15 + "%CC%80" * 16, 0, id="mixed-raw-and-encoded"),
    ],
)
async def test_path_normalization_budget_blocks_before_unbounded_work(
    path_firewall_registry,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    monkeypatch: pytest.MonkeyPatch,
    segment: str,
    decode_passes: int,
):
    encoded_segment = segment
    for _ in range(decode_passes):
        encoded_segment = urllib.parse.quote(encoded_segment, safe="")
    path = f"/repos/{encoded_segment}"
    assert len(path) < 65536
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com", path=path)
    normalize = unicodedata.normalize
    rejected_segment = urllib.parse.unquote(segment)
    decomposed_characters = 0

    def bounded_normalize(form: Literal["NFC", "NFD", "NFKC", "NFKD"], text: str) -> str:
        nonlocal decomposed_characters
        if form == "NFKD":
            assert len(text) == 1, "budget checks must only decompose single code points"
            decomposed_characters += 1
        else:
            assert text != rejected_segment, "rejected segments must not reach normalization"
        return normalize(form, text)

    monkeypatch.setattr(unicodedata, "normalize", bounded_normalize)
    with (
        mitm_ctx(registry_path=str(path_firewall_registry)),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(flow) is None
        header_characters = decomposed_characters
        assert header_characters > 0
        assert "Authorization" not in flow.request.headers

        await mitm_addon.request(flow)
        assert decomposed_characters > header_characters

    auth_fetch.assert_not_called()
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["reason"] == "unsafe_path"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "DENY"
    assert flow.request.path == path
    assert "Authorization" not in flow.request.headers


async def test_oversized_encoded_base_rejects_before_connector_credentials(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="example",
            api_entry={
                "base": "https://api.example.com/v2",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.API_TOKEN }}"}},
                "permissions": [{"name": "read", "rules": ["GET /files/{path+}"]}],
            },
            network_policy={"allow": ["read"], "deny": [], "unknownPolicy": "allow"},
        ),
    )
    path = "/v%2532/files/" + "a" * MAX_PATH_VALIDATION_CHARACTERS
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.example.com", path=path)
    with mitm_ctx(registry_path=str(reg_path)), fake_firewall_headers() as auth_fetch:
        header_result = mitm_addon.requestheaders(flow)
        if header_result is not None:
            await await_requestheaders_result(header_result)
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 403
    assert json.loads(flow.response.content)["reason"] == "unsafe_path"
    assert flow.request.path == path
    assert "Authorization" not in flow.request.headers
    auth_fetch.assert_not_awaited()


@pytest.mark.parametrize(
    "segment",
    [
        pytest.param("a" + "\u0315\u0300" * 15, id="at-limit"),
        pytest.param("\u0300" * 30, id="leading-at-limit"),
        pytest.param("a" + "\u0344" * 15, id="expansion-at-limit"),
        pytest.param("a" + "\u0f73" * 15, id="class-zero-at-limit"),
        pytest.param("\u00e9" + "\u0300" * 29, id="precomposed-at-limit"),
        pytest.param(("a" + "\u0315\u0300" * 15) * 1000, id="starter-resets"),
        pytest.param("\u6587" * 32000, id="long-unicode"),
        pytest.param(
            "caf\u00e9/\u6587\u6863/\uac01/\U0001f469\u200d\U0001f4bb", id="ordinary-unicode"
        ),
        pytest.param("caf%C3%A9/%E6%96%87%E6%A1%A3", id="encoded-unicode"),
    ],
)
async def test_path_normalization_budget_preserves_supported_requests(
    path_firewall_registry, real_flow, mitm_ctx, fake_firewall_headers, segment: str
):
    path = f"/repos/{segment}"
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com", path=path)
    with (
        mitm_ctx(registry_path=str(path_firewall_registry)),
        fake_firewall_headers(headers={"Authorization": "Bearer resolved"}) as auth_fetch,
    ):
        await await_requestheaders_result(mitm_addon.requestheaders(flow))
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.request.headers["Authorization"] == "Bearer resolved"
    assert flow.request.path == path
