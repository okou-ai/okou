"""Real request/control observations across a catalog-only publication change."""

import json

import pytest

import mitm_addon
import registry
from tests.registry_builtin_helpers import write_catalog_cache
from tests.run_usage_helpers import (
    admit,
    json_response,
    payload,
    read_usage,
    write_registration,
)
from tests.run_usage_helpers import (
    control as control,
)


@pytest.fixture
def builtin_usage_registry(tmp_path):
    path = write_registration(tmp_path)
    document = json.loads(path.read_text())
    sandbox = document["sandboxes"]["10.200.0.5"]
    firewall = sandbox["firewalls"][0]["firewall"]
    name = firewall["name"]
    for api in firewall["apis"]:
        api.pop("id", None)
    sandbox["firewalls"] = [{"kind": "builtin", "name": name}]
    path.write_text(json.dumps(document))
    cache = tmp_path / "builtin-firewall-catalog-cache.json"
    write_catalog_cache(
        cache, digest="sha256:" + "a" * 64, version="usage-recovery", firewalls={name: firewall}
    )
    return path, cache


@pytest.mark.parametrize("catalog_state", ["healthy", "missing", "untrusted"])
async def test_catalog_recovery_initializes_cumulative_usage_without_registry_rewrite(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    builtin_usage_registry,
    catalog_state,
):
    path, cache = builtin_usage_registry
    original_registry = path.read_bytes()
    saved = tmp_path / "catalog.saved"
    if catalog_state == "missing":
        cache.rename(saved)
    elif catalog_state == "untrusted":
        cache.chmod(0o620)
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        if catalog_state != "healthy":
            denied = real_flow(
                with_response=False,
                host="openrouter.ai",
                client_ip="10.200.0.5",
                method="POST",
                path="/api/v1/responses",
            )
            await mitm_addon.request(denied)
            assert denied.response.status_code == 503
            assert denied.response.json()["error"] == "invalid_registry_sandbox"
            mitm_addon.response(denied)
            if catalog_state == "missing":
                saved.rename(cache)
            else:
                cache.chmod(0o600)
        for identity in ("recovered-1", "recovered-2"):
            flow = await admit(real_flow)
            json_response(flow, payload(identity))
        state = registry.load_registry_state(str(path))
        assert not isinstance(state, registry.RegistryUnavailable)
        assert state.invalid_sandboxes == {}
        assert path.read_bytes() == original_registry
        observed = read_usage(control)
        assert observed["state"] == "available"
        assert observed["observedResponses"] == 2
        assert observed["totals"]["total"] == 140
        assert observed["complete"] is True
        document = json.loads(path.read_text())
        document["updatedAt"] = 1
        path.write_text(json.dumps(document))
        flow = await admit(real_flow)
        json_response(flow, payload("after-registry-rewrite"))
        rewritten = read_usage(control)
        assert rewritten["observedResponses"] == 3
        assert rewritten["totals"]["total"] == 210


async def test_catalog_republication_retains_cumulative_totals_and_response_deduplication(
    tmp_path,
    control,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    builtin_usage_registry,
):
    path, cache = builtin_usage_registry
    original_registry = path.read_bytes()
    with mitm_ctx(registry_path=str(path)), fake_firewall_headers():
        flow = await admit(real_flow)
        json_response(flow, payload("before-catalog-recovery"))
        before = read_usage(control)
        assert before["observedResponses"] == 1
        assert before["totals"]["total"] == 70
        saved = tmp_path / "catalog.saved"
        cache.rename(saved)
        denied = real_flow(
            with_response=False,
            host="openrouter.ai",
            client_ip="10.200.0.5",
            method="POST",
            path="/api/v1/responses",
        )
        await mitm_addon.request(denied)
        assert denied.response.status_code == 503
        mitm_addon.response(denied)
        saved.rename(cache)
        flow = await admit(real_flow)
        json_response(flow, payload("before-catalog-recovery"))
        duplicate = read_usage(control)
        assert duplicate["observedResponses"] == 1
        assert duplicate["totals"] == before["totals"]
        flow = await admit(real_flow)
        json_response(flow, payload("after-catalog-recovery"))
        after = read_usage(control)
        assert after["observedResponses"] == 2
        assert after["totals"]["total"] == 140
        assert after["complete"] is True
        assert path.read_bytes() == original_registry
