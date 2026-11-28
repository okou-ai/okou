"""Shared request-handler registry helpers."""

import json
from pathlib import Path


def _write_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    sandbox_info: dict[str, object],
) -> Path:
    path = tmp_path / "registry.json"
    replacement_path = tmp_path / "registry.next.json"
    replacement_path.write_text(json.dumps({"sandboxes": {client_ip: sandbox_info}}))
    replacement_path.replace(path)
    return path


def _single_firewall_sandbox(
    tmp_path: Path,
    *,
    run_id: str = "run-conn-1",
    sandbox_marker: str = "tok-conn",
    firewall_name: str = "github",
    api_entry: dict[str, object],
    network_policy: dict[str, object] | None,
    billable_firewalls: list[str] | None = None,
    custom_connector_id: str | None = None,
    source_id: str | None = None,
    sandbox_fields: dict[str, object] | None = None,
) -> dict[str, object]:
    firewall_entry: dict[str, object] = {
        "kind": "inline",
        "firewall": {"name": firewall_name, "apis": [api_entry]},
    }
    if custom_connector_id is not None:
        firewall_entry["customConnectorId"] = custom_connector_id
    if source_id is not None:
        firewall_entry["sourceId"] = source_id
    sandbox_info: dict[str, object] = {
        "runId": run_id,
        "cliAgentType": "claude-code",
        "billableFirewalls": billable_firewalls or [],
        "sandboxToken": sandbox_marker,
        "firewallToken": "host-firewall-token",
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "firewalls": [firewall_entry],
    }
    if network_policy is not None:
        sandbox_info["networkPolicies"] = {firewall_name: network_policy}
    if custom_connector_id is not None:
        sandbox_info["connectorRoutingVariables"] = {f"custom:{custom_connector_id}": {}}
    if sandbox_fields is not None:
        sandbox_info.update(sandbox_fields)
    return sandbox_info


def _shared_route_sandbox(
    tmp_path: Path,
    *,
    reverse: bool = False,
    primary_name: str = "primary",
) -> dict[str, object]:
    """Build two credential owners for the same exact route."""

    def firewall(name: str, token: str, permission: str) -> dict[str, object]:
        return {
            "kind": "inline",
            "firewall": {
                "name": name,
                "placeholders": {token: f"fixture-{token}"},
                "apis": [
                    {
                        "base": "https://shared.example.com",
                        "auth": {
                            "headers": {"Authorization": f"Bearer ${{{{ secrets.{token} }}}}"}
                        },
                        "permissions": [
                            {
                                "name": permission,
                                "rules": ["GET /items/{id}"],
                            }
                        ],
                    }
                ],
            },
        }

    firewalls = [
        firewall(primary_name, "PRIMARY_TOKEN", "items-read"),
        firewall("auditor", "AUDITOR_TOKEN", "audit-read"),
    ]
    if reverse:
        firewalls.reverse()
    return {
        "runId": "run-shared-route",
        "billableFirewalls": [],
        "cliAgentType": "claude-code",
        "sandboxToken": "tok-shared-route",
        "firewallToken": "host-firewall-token",
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
        "captureNetworkBodies": True,
        "firewalls": firewalls,
        "networkPolicies": {
            primary_name: {
                "allow": ["items-read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            "auditor": {
                "allow": ["audit-read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        },
    }


def _sandbox_without_firewalls(
    tmp_path: Path,
    *,
    run_id: str = "run-conn-1",
    sandbox_marker: str = "tok-conn",
    sandbox_fields: dict[str, object] | None = None,
) -> dict[str, object]:
    sandbox_info: dict[str, object] = {
        "runId": run_id,
        "billableFirewalls": [],
        "cliAgentType": "claude-code",
        "sandboxToken": sandbox_marker,
        "firewallToken": "host-firewall-token",
        "networkLogPath": str(tmp_path / "net.jsonl"),
        "proxyLogPath": str(tmp_path / "proxy.jsonl"),
    }
    if sandbox_fields is not None:
        sandbox_info.update(sandbox_fields)
    return sandbox_info


def _write_github_firewall_registry(
    tmp_path: Path,
    *,
    client_ip: str = "10.200.0.5",
    base: str = "https://api.github.com",
    source_id: str | None = None,
    sandbox_fields: dict[str, object] | None = None,
) -> Path:
    return _write_registry(
        tmp_path,
        client_ip=client_ip,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": base,
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"}},
                "permissions": [{"name": "full-access", "rules": ["ANY /{path+}"]}],
            },
            network_policy={
                "allow": ["full-access"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            },
            source_id=source_id,
            sandbox_fields=sandbox_fields,
        ),
    )
