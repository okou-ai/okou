"""Tests for upstream destination binding in server_connect()."""

import uuid
from typing import cast

import pytest
from mitmproxy import connection

import flow_metadata_keys as metadata_keys
import matching
import mitm_addon
import upstream_destination_binding
from tests.request_handler_helpers import (
    _single_firewall_sandbox,
    _write_github_firewall_registry,
    _write_registry,
)
from tests.upstream_connection_helpers import mark_connected_tls_upstream


def _record_authority_checks(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[str, int]]:
    calls: list[tuple[str, int]] = []
    original = matching.CompiledFirewallSet.matches_ordinary_credential_authority

    def counting_authority_check(
        compiled_firewalls: matching.CompiledFirewallSet,
        host: str,
        port: int,
    ) -> bool:
        calls.append((host, port))
        return original(compiled_firewalls, host, port)

    monkeypatch.setattr(
        matching.CompiledFirewallSet,
        "matches_ordinary_credential_authority",
        counting_authority_check,
    )
    return calls


class _Server:
    def __init__(
        self,
        *,
        address: tuple[str, int] = ("203.0.113.10", 443),
        peername: tuple[str, int] | None = None,
        connected: bool = False,
        server_id: str | None = None,
    ) -> None:
        self.id = server_id or str(uuid.uuid4())
        self.address = address
        self.peername = peername
        self.connected = connected
        self.error: str | None = None


class _Client:
    def __init__(
        self,
        *,
        client_ip: str = "10.200.0.5",
        sni: str = "api.github.com",
        sockname: tuple[str, int] = ("127.0.0.1", 8080),
    ) -> None:
        self.id = str(uuid.uuid4())
        self.peername: tuple[str, int] = (client_ip, 12345)
        self.sockname = sockname
        self.sni = sni


class _ServerConnectData:
    def __init__(self, *, client: object, server: _Server | connection.Server) -> None:
        self.client = client
        self.server = server


def _data(
    *,
    client_ip: str = "10.200.0.5",
    sni: str = "api.github.com",
    address: tuple[str, int] = ("203.0.113.10", 443),
    server_peername: tuple[str, int] | None = None,
    server_connected: bool = False,
    client_sockname: tuple[str, int] = ("127.0.0.1", 8080),
) -> _ServerConnectData:
    return _ServerConnectData(
        client=_Client(client_ip=client_ip, sni=sni, sockname=client_sockname),
        server=_Server(address=address, peername=server_peername, connected=server_connected),
    )


def test_server_connect_retargets_credentialed_connector_host(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("api.github.com", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.github.com"
    assert binding.port == 443
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_server_connect_does_not_bind_parameterized_connector_to_undeclared_port(
    tmp_path,
    mitm_ctx,
):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://api.{domain}",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "read", "rules": ["GET /items"]}],
            },
            network_policy={
                "allow": ["read"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
        ),
    )
    data = _data(sni="api.example", address=("203.0.113.10", 8443))

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 8443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_connect_uses_tls_clienthello_sni_when_client_sni_is_empty(
    tmp_path,
    mitm_ctx,
    make_tls_data,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    tls_data = make_tls_data(
        client_ip="10.200.0.5",
        client_sni="",
        sni="api.github.com",
        server_connected=True,
    )
    data = _ServerConnectData(client=tls_data.context.client, server=_Server())

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        mitm_addon.server_connect(data)

    assert data.server.address == ("api.github.com", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))


def test_server_connect_preserves_clienthello_original_address(
    tmp_path,
    mitm_ctx,
    make_tls_data,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    tls_data = make_tls_data(
        client_ip="10.200.0.5",
        client_sni="",
        sni="api.github.com",
    )
    data = _ServerConnectData(client=tls_data.context.client, server=tls_data.context.server)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        mitm_addon.server_connect(data)

    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_server_connect_reuses_clienthello_binding_without_rechecking_authority(
    tmp_path,
    mitm_ctx,
    make_tls_data,
    monkeypatch,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    tls_data = make_tls_data(
        client_ip="10.200.0.5",
        client_sni="",
        sni="api.github.com",
    )
    data = _ServerConnectData(client=tls_data.context.client, server=tls_data.context.server)
    authority_checks = _record_authority_checks(monkeypatch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        mitm_addon.server_connect(data)

    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert authority_checks == [("api.github.com", 443)]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


def test_server_connect_wrong_kind_binding_still_checks_current_authority(
    tmp_path,
    mitm_ctx,
    make_tls_data,
    monkeypatch,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    tls_data = make_tls_data(
        client_ip="10.200.0.5",
        client_sni="",
        sni="api.github.com",
    )
    data = _ServerConnectData(client=tls_data.context.client, server=tls_data.context.server)
    authority_checks = _record_authority_checks(monkeypatch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.github.com"):
        mitm_addon.tls_clienthello(tls_data)

    api_binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert api_binding.kinds == frozenset(("api_allow",))

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    connector_binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert authority_checks == [("api.github.com", 443)]
    assert connector_binding.kinds == frozenset(("api_allow", "connector_auth"))


def test_server_connect_does_not_overwrite_clienthello_binding_after_address_changes(
    tmp_path,
    mitm_ctx,
    make_tls_data,
    monkeypatch,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    tls_data = make_tls_data(
        client_ip="10.200.0.5",
        client_sni="",
        sni="api.github.com",
    )
    data = _ServerConnectData(client=tls_data.context.client, server=tls_data.context.server)
    authority_checks = _record_authority_checks(monkeypatch)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.tls_clienthello(tls_data)
        data.server.address = ("203.0.113.99", 443)
        mitm_addon.server_connect(data)

    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert authority_checks == [
        ("api.github.com", 443),
        ("api.github.com", 443),
    ]
    assert data.server.address == ("203.0.113.99", 443)
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == ("203.0.113.10", 443)


@pytest.mark.parametrize(
    ("api_url", "port"),
    [
        pytest.param("https://api.okou.ai", 443, id="implicit-default-port"),
        pytest.param(
            "https://api.okou.ai:8443",
            8443,
            id="explicit-non-default-port",
        ),
    ],
)
def test_server_connect_retargets_api_allow_host(registry_file, mitm_ctx, api_url, port):
    data = _data(
        client_ip="10.200.0.1",
        sni="api.okou.ai",
        address=("203.0.113.10", port),
    )

    with mitm_ctx(registry_path=str(registry_file), api_url=api_url):
        mitm_addon.server_connect(data)

    assert data.server.address == ("api.okou.ai", port)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.okou.ai"
    assert binding.port == port
    assert binding.kinds == frozenset(("api_allow",))


def test_server_connect_does_not_bind_malformed_platform_api_url(
    registry_file,
    mitm_ctx,
    malformed_platform_api_url,
):
    data = _data(
        client_ip="10.200.0.1",
        sni="api.okou.ai",
    )

    with mitm_ctx(
        registry_path=str(registry_file),
        api_url=malformed_platform_api_url,
    ):
        mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_connect_treats_api_hostname_on_other_port_as_connector(
    tmp_path,
    mitm_ctx,
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="https://api.okou.ai:8443",
    )
    data = _data(
        sni="api.okou.ai",
        address=("203.0.113.10", 8443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("api.okou.ai", 8443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.okou.ai"
    assert binding.port == 8443
    assert binding.kinds == frozenset(("connector_auth",))


def test_server_connect_treats_api_origin_on_other_scheme_as_connector(
    tmp_path,
    mitm_ctx,
):
    reg_path = _write_github_firewall_registry(
        tmp_path,
        base="https://api.okou.ai:443",
    )
    data = _data(
        sni="api.okou.ai",
        address=("203.0.113.10", 443),
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="http://api.okou.ai:443"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("api.okou.ai", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.host == "api.okou.ai"
    assert binding.port == 443
    assert binding.kinds == frozenset(("connector_auth",))


def test_server_connect_does_not_prebind_platform_connector_auth(tmp_path, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="test-oauth",
            api_entry={
                "base": "https://api.okou.ai/api/test/oauth-provider",
                "auth": {"headers": {"Authorization": "Bearer x"}},
                "permissions": [{"name": "echo", "rules": ["GET /echo"]}],
            },
            network_policy={"allow": ["echo"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )
    data = _data(sni="api.okou.ai")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("api.okou.ai", 443)
    binding = upstream_destination_binding.binding_snapshot_for_tests()[data.server.id]
    assert binding.kinds == frozenset(("api_allow",))


def test_server_connect_does_not_bind_connected_api_edge_from_sni_only(registry_file, mitm_ctx):
    data = _data(
        client_ip="10.200.0.1",
        sni="pr-test-api.vm6.ai",
        address=("76.76.21.164", 443),
        server_peername=("76.76.21.164", 443),
        server_connected=True,
    )

    with mitm_ctx(registry_path=str(registry_file), api_url="https://pr-test-api.vm6.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("76.76.21.164", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_connect_does_not_bind_connected_connector_from_sni_only(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data(
        sni="api.github.com",
        address=("140.82.112.5", 443),
        server_peername=("140.82.112.5", 443),
        server_connected=True,
    )

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("140.82.112.5", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


async def test_server_connect_waits_for_tls_before_binding_connector_on_shared_ip(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, headers
):
    shared_address = ("198.18.20.34", 443)
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(
        with_response=False,
        client_ip="10.200.0.5",
        host=shared_address[0],
        sni="",
        path="/repos/okou-ai/okou",
        request_headers=headers(("Host", "api.github.com")),
    )
    data = _ServerConnectData(client=flow.client_conn, server=flow.server_conn)

    with (
        mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"),
        fake_firewall_headers(
            headers={"Authorization": "Bearer resolved-github-token"}
        ) as auth_fetch,
    ):
        mitm_addon.server_connect(data)

        assert flow.server_conn.address == shared_address
        assert upstream_destination_binding.binding_snapshot_for_tests() == {}

        flow.client_conn.sni = "api.github.com"
        mark_connected_tls_upstream(
            flow,
            sni="api.github.com",
            server_address=shared_address,
            peername=shared_address,
        )
        mitm_addon.requestheaders(flow)
        await mitm_addon.request(flow)

    auth_fetch.assert_awaited_once()
    assert flow.response is None
    assert flow.server_conn.address == shared_address
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
    assert flow.metadata[metadata_keys.FIREWALL_NAME] == "github"
    assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
    assert flow.request.headers["Authorization"] == "Bearer resolved-github-token"
    binding = upstream_destination_binding.binding_snapshot_for_tests()[flow.server_conn.id]
    assert binding.host == "api.github.com"
    assert binding.kinds == frozenset(("connector_auth",))
    assert binding.original_address == shared_address


def test_server_connect_does_not_retarget_auth_base_only_connector(tmp_path, mitm_ctx):
    reg_path = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            api_entry={
                "base": "https://placeholder.example.com",
                "auth": {"base": "${{ secrets.WEBHOOK_URL }}"},
                "permissions": [{"name": "send", "rules": ["ANY /"]}],
            },
            network_policy={"allow": ["send"], "deny": [], "ask": [], "unknownPolicy": "deny"},
        ),
    )
    data = _data(sni="placeholder.example.com")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_connect_ignores_unregistered_sandbox(registry_file, mitm_ctx):
    data = _data(client_ip="192.168.99.99")

    with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_connect_ignores_non_string_client_peer_host(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    client = _Client()
    client.peername = cast(tuple[str, int], (10, 12345))
    data = _ServerConnectData(client=client, server=_Server())

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_connect_ignores_invalid_sni(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data(sni="api.github.com..")

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.address == ("203.0.113.10", 443)
    assert upstream_destination_binding.binding_snapshot_for_tests() == {}


def test_server_disconnect_and_connect_error_clear_binding(tmp_path, mitm_ctx):
    reg_path = _write_github_firewall_registry(tmp_path)
    data = _data()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.id in upstream_destination_binding.binding_snapshot_for_tests()
    mitm_addon.server_disconnected(data)
    assert data.server.id not in upstream_destination_binding.binding_snapshot_for_tests()

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(data)

    assert data.server.id in upstream_destination_binding.binding_snapshot_for_tests()
    mitm_addon.server_connect_error(data)
    assert data.server.id not in upstream_destination_binding.binding_snapshot_for_tests()


def test_client_disconnect_preserves_binding_reassociated_by_server_connect(
    tmp_path,
    mitm_ctx,
):
    reg_path = _write_github_firewall_registry(tmp_path)
    server = connection.Server(address=("203.0.113.10", 443))
    first_client = connection.Client(
        peername=("10.200.0.5", 12345),
        sockname=("127.0.0.1", 8080),
        sni="api.github.com",
    )
    second_client = connection.Client(
        peername=("10.200.0.5", 12346),
        sockname=("127.0.0.1", 8080),
        sni="api.github.com",
    )
    first_data = _ServerConnectData(client=first_client, server=server)
    second_data = _ServerConnectData(client=second_client, server=server)

    with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
        mitm_addon.server_connect(first_data)
        mitm_addon.server_connect(second_data)

    expected_original_address = ("203.0.113.10", 443)
    assert (
        upstream_destination_binding.server_binding_original_address(server)
        == expected_original_address
    )

    mitm_addon.client_disconnected(first_client)

    assert (
        upstream_destination_binding.server_binding_original_address(server)
        == expected_original_address
    )

    mitm_addon.client_disconnected(second_client)

    assert not upstream_destination_binding.has_server_binding(server)
