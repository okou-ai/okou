"""Proxy registry admission request hook integration tests."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import registry
from tests.auth_state_helpers import auth_cache_key, has_auth_state
from tests.registry_helpers import write_multi_sandbox_registry
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


async def test_registry_unavailable_blocks_before_auth_injection(tmp_path, real_flow, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        client_ip="10.200.0.5",
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.github.com",
                "auth": {"headers": {"Authorization": "Bearer secret"}},
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
    registry.load_registry(str(reg_path))
    reg_path.unlink()
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert flow.request.headers.get("Authorization") is None
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "registry_unavailable"
    assert metadata_keys.FIREWALL_BASE not in flow.metadata


@pytest.mark.parametrize(
    ("run_id_value", "expected_reason", "expected_message"),
    [
        ("", "empty_run_id", "proxy registry sandbox entry runId must be non-empty"),
        ("  \t", "empty_run_id", "proxy registry sandbox entry runId must be non-empty"),
        (
            " run-abc ",
            "invalid_run_id",
            "proxy registry sandbox entry runId must not include leading or trailing whitespace",
        ),
        (None, "missing_run_id", "proxy registry sandbox entry is missing runId"),
        (123, "invalid_run_id", "proxy registry sandbox entry runId must be a string"),
    ],
)
async def test_invalid_registered_sandbox_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    run_id_value,
    expected_reason,
    expected_message,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    if run_id_value is None:
        del sandbox_info["runId"]
    else:
        sandbox_info["runId"] = run_id_value
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": expected_message,
        "reason": expected_reason,
    }
    auth_fetch.assert_not_called()
    assert not has_auth_state(auth_cache_key(run_id="", api_id="https://api.github.com"))
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


@pytest.mark.parametrize(
    ("field_present", "cli_agent_type", "expected_reason", "expected_message"),
    [
        (
            False,
            None,
            "missing_cli_agent_type",
            "proxy registry sandbox entry is missing cliAgentType",
        ),
        (
            True,
            "",
            "empty_cli_agent_type",
            "proxy registry sandbox entry cliAgentType must be non-empty",
        ),
        (
            True,
            None,
            "invalid_cli_agent_type",
            "proxy registry sandbox entry cliAgentType must be a string",
        ),
        (
            True,
            123,
            "invalid_cli_agent_type",
            "proxy registry sandbox entry cliAgentType must be a string",
        ),
    ],
)
async def test_invalid_cli_agent_type_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    field_present,
    cli_agent_type,
    expected_reason,
    expected_message,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    if field_present:
        sandbox_info["cliAgentType"] = cli_agent_type
    else:
        del sandbox_info["cliAgentType"]
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": expected_message,
        "reason": expected_reason,
    }
    auth_fetch.assert_not_called()
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.CLI_AGENT_TYPE not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


@pytest.mark.parametrize("cli_agent_type", ["claude-code", "codex", "custom-agent"])
async def test_valid_cli_agent_type_is_copied_to_request_metadata(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    cli_agent_type,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
        sandbox_fields={"cliAgentType": cli_agent_type},
    )
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(),
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == sandbox_info["runId"]
    assert flow.metadata[metadata_keys.CLI_AGENT_TYPE] == cli_agent_type


async def test_invalid_registered_sandbox_non_object_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    reg_path = tmp_path / "registry.json"
    reg_path.write_text(json.dumps({"sandboxes": {"10.200.0.5": "broken"}, "updatedAt": 0}))
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": "proxy registry sandbox entry must be an object",
        "reason": "invalid_sandbox_entry",
    }
    auth_fetch.assert_not_called()
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


@pytest.mark.parametrize(
    ("billable_firewalls", "include_field"),
    [
        pytest.param(None, False, id="missing"),
        pytest.param(None, True, id="null"),
        pytest.param("github", True, id="string"),
        pytest.param({}, True, id="object"),
        pytest.param(["github", 1], True, id="non-string-element"),
    ],
)
async def test_invalid_billable_firewalls_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    billable_firewalls,
    include_field,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    if include_field:
        sandbox_info["billableFirewalls"] = billable_firewalls
    else:
        del sandbox_info["billableFirewalls"]
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": "proxy registry sandbox entry billableFirewalls must be a list of strings",
        "reason": "invalid_billable_firewalls",
    }
    auth_fetch.assert_not_called()
    assert flow.request.headers.get("Authorization") is None
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


@pytest.mark.parametrize(
    ("sandbox_fields", "expected_reason", "expected_message"),
    [
        pytest.param(
            {"omittedBuiltinFirewalls": [1]},
            "invalid_omitted_intents",
            "proxy registry sandbox entry omittedBuiltinFirewalls must be a string list",
            id="omitted-intent-string-list",
        ),
        pytest.param(
            {"omittedCustomConnectorIds": ["connector-1", "connector-1"]},
            "invalid_omitted_intents",
            "proxy registry sandbox entry omittedCustomConnectorIds must be unique",
            id="omitted-intent-unique",
        ),
        pytest.param(
            {"connectorRoutingVariables": []},
            "invalid_connector_routing_variables",
            "proxy registry sandbox entry connectorRoutingVariables must be an object",
            id="routing-variables-object",
        ),
        pytest.param(
            {"connectorRoutingVariables": {"github": {}}},
            "invalid_connector_routing_variables",
            "proxy registry sandbox entry connectorRoutingVariables keys must identify a connector",
            id="routing-identity",
        ),
        pytest.param(
            {"connectorRoutingVariables": {"builtin:github": {"HOST": 1}}},
            "invalid_connector_routing_variables",
            "proxy registry sandbox entry connectorRoutingVariables values must be string maps",
            id="routing-variable-map",
        ),
    ],
)
async def test_invalid_routing_metadata_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    sandbox_fields,
    expected_reason,
    expected_message,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
        sandbox_fields=sandbox_fields,
    )
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": expected_message,
        "reason": expected_reason,
    }
    auth_fetch.assert_not_called()
    assert flow.request.headers.get("Authorization") is None
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.CLI_AGENT_TYPE not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_AUTH_CACHE_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


@pytest.mark.parametrize(
    "firewalls",
    [0, 1, False, True, "", {}, {"name": "github"}, "broken"],
)
async def test_invalid_registered_sandbox_firewalls_shape_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
    firewalls,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    sandbox_info["firewalls"] = firewalls
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": "proxy registry sandbox entry firewalls must be a list",
        "reason": "invalid_firewalls",
    }
    auth_fetch.assert_not_called()
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


async def test_invalid_inline_apis_blocks_before_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    firewalls = sandbox_info["firewalls"]
    assert isinstance(firewalls, list)
    firewall_entry = firewalls[0]
    assert isinstance(firewall_entry, dict)
    firewall = firewall_entry["firewall"]
    assert isinstance(firewall, dict)
    firewall["apis"] = None
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is not None
    assert flow.response.status_code == 503
    assert json.loads(flow.response.content) == {
        "error": "invalid_registry_sandbox",
        "message": "inline firewall apis must be a list",
        "reason": "invalid_firewalls",
    }
    auth_fetch.assert_not_called()
    assert flow.request.headers.get("Authorization") is None
    assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert metadata_keys.FIREWALL_AUTH_CACHE_KEY not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "BLOCK"
    assert flow.metadata[metadata_keys.FIREWALL_ERROR] == "invalid_registry_sandbox"


async def test_uncompilable_inline_api_passes_through_without_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    api_entry = {
        "base": "https://api.github.com",
        "auth": {"headers": {"Authorization": "Bearer secret"}},
        "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
    }
    network_policy = {
        "allow": ["full-access"],
        "deny": [],
        "ask": [],
        "unknownPolicy": "allow",
    }
    registry_path = tmp_path / "registry.json"
    write_multi_sandbox_registry(
        registry_path,
        {
            "10.200.0.5": _single_firewall_sandbox(
                tmp_path,
                run_id="run-malformed",
                api_entry={**api_entry, "base": 123},
                network_policy=network_policy,
            ),
            "10.200.0.6": _single_firewall_sandbox(
                tmp_path,
                run_id="run-valid",
                api_entry=api_entry,
                network_policy=network_policy,
            ),
        },
    )
    malformed_flow = real_flow(with_response=False, client_ip="10.200.0.5", host="api.github.com")
    valid_flow = real_flow(with_response=False, client_ip="10.200.0.6", host="api.github.com")

    with (
        mitm_ctx(registry_path=str(registry_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        assert mitm_addon.requestheaders(malformed_flow) is None
        await mitm_addon.request(malformed_flow)
        auth_fetch.assert_not_awaited()
        await mitm_addon.request(valid_flow)

    assert malformed_flow.response is None
    assert malformed_flow.request.headers.get("Authorization") is None
    assert malformed_flow.metadata[metadata_keys.SANDBOX_RUN_ID] == "run-malformed"
    assert malformed_flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert metadata_keys.FIREWALL_BASE not in malformed_flow.metadata
    assert metadata_keys.FIREWALL_AUTH_CACHE_KEY not in malformed_flow.metadata
    assert valid_flow.response is None
    assert valid_flow.request.headers["Authorization"] == "Bearer x"
    auth_fetch.assert_awaited_once()


async def test_registered_sandbox_null_firewalls_passes_through_without_auth_injection(
    tmp_path,
    real_flow,
    mitm_ctx,
    fake_firewall_headers,
):
    sandbox_info = _single_firewall_sandbox(
        tmp_path,
        api_entry={
            "base": "https://api.github.com",
            "auth": {"headers": {"Authorization": "Bearer secret"}},
            "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
        },
        network_policy={
            "allow": ["full-access"],
            "deny": [],
            "ask": [],
            "unknownPolicy": "allow",
        },
    )
    sandbox_info["firewalls"] = None
    reg_path = _write_registry(tmp_path, client_ip="10.200.0.5", sandbox_info=sandbox_info)
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host="unconfigured.example.com")

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers() as auth_fetch,
    ):
        await mitm_addon.request(flow)

    assert flow.response is None
    auth_fetch.assert_not_called()
    assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == sandbox_info["runId"]
    assert metadata_keys.FIREWALL_BASE not in flow.metadata
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
