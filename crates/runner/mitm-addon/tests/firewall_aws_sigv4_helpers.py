"""AWS SigV4 firewall-auth integration helpers for mitm-addon tests."""

import copy
from collections.abc import Mapping, Sequence
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Protocol, TypedDict

from mitmproxy import http

import auth
import firewall_auth_cache as auth_cache
import firewall_auth_client as auth_client
import flow_metadata_keys as metadata_keys
import matching
from aws_sigv4 import AwsSigV4Credentials
from request_authority import get_trusted_authority
from tests.auth_endpoint_helpers import FakeAuthEndpoint, firewall_auth_success_response
from tests.auth_state_helpers import auth_cache_key, set_cached_headers
from tests.aws_sigv4_helpers import (
    DEFAULT_AWS_REGION,
    DEFAULT_SIGV4_TIMESTAMP,
    RESOLVED_AWS_ACCESS_KEY_ID,
    RESOLVED_AWS_SECRET_ACCESS_KEY,
    RESOLVED_AWS_SESSION_TOKEN,
    STS_FORM_BODY,
    STS_HOST,
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
    aws_sigv4_presigned_query_path,
    resolved_aws_sigv4_credentials,
)
from tests.firewall_auth_helpers import handle_firewall_request_without_upstream_admission

DEFAULT_SANDBOX_AUTH_KEY = "sandbox-token"
FAR_FUTURE_EXPIRES_AT = 9_999_999_999


class _RealFlowFactory(Protocol):
    def __call__(
        self,
        *,
        host: str = ...,
        path: str = ...,
        method: str = ...,
        request_body: bytes | None = ...,
        request_headers: http.Headers | None = ...,
        with_response: bool = ...,
    ) -> http.HTTPFlow:
        raise NotImplementedError


class _HeaderFactory(Protocol):
    def __call__(self, *pairs: tuple[str, str]) -> http.Headers:
        raise NotImplementedError


class _MitmContextFactory(Protocol):
    def __call__(self, *, api_url: str = ...) -> AbstractContextManager[object]:
        raise NotImplementedError


class AwsAuthConfigBase(TypedDict):
    headers: dict[str, str]
    awsSigv4: dict[str, str]


class AwsAuthConfig(AwsAuthConfigBase, total=False):
    base: str
    query: dict[str, str]


class AwsApiEntryBase(TypedDict):
    base: str
    auth: AwsAuthConfig


class AwsApiEntry(AwsApiEntryBase, total=False):
    id: str


class AwsSandboxInfoBase(TypedDict):
    runId: str
    sandboxToken: str
    encryptedSecrets: str
    networkLogPath: str
    billableFirewalls: list[str]
    vars: dict[str, str]


class AwsSandboxInfo(AwsSandboxInfoBase, total=False):
    secretConnectorMap: dict[str, str]
    secretConnectorMetadataMap: dict[str, object]


def _aws_sigv4_auth_config(*, include_session_token: bool = True) -> dict[str, str]:
    config = {
        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
    }
    if include_session_token:
        config["sessionToken"] = "${{ secrets.AWS_SESSION_TOKEN }}"
    return config


def aws_api_entry(
    *,
    api_id: str | None = None,
    base: str = f"https://{STS_HOST}",
    auth_base: str | None = None,
    auth_headers: Mapping[str, str] | None = None,
    auth_query: Mapping[str, str] | None = None,
    include_session_token: bool = True,
) -> AwsApiEntry:
    auth_config: AwsAuthConfig = {
        "headers": dict(auth_headers) if auth_headers is not None else {},
        "awsSigv4": _aws_sigv4_auth_config(include_session_token=include_session_token),
    }
    if auth_base is not None:
        auth_config["base"] = auth_base
    if auth_query is not None:
        auth_config["query"] = dict(auth_query)
    api_entry: AwsApiEntry = {
        "base": base,
        "auth": auth_config,
    }
    if api_id is not None:
        api_entry["id"] = api_id
    return api_entry


def aws_allow(
    api_entry: Mapping[str, object] | None = None,
    *,
    firewall_name: str = "aws",
    permission: str = "identity",
    params: Mapping[str, str] | None = None,
    rule: str = "POST /",
    rel_path: str = "/",
) -> matching.FirewallAllow:
    resolved_api_entry = aws_api_entry(api_id="run-1:0") if api_entry is None else api_entry
    return matching.FirewallAllow(
        copy.deepcopy(dict(resolved_api_entry)),
        firewall_name,
        permission,
        {} if params is None else dict(params),
        rule,
        rel_path,
    )


def aws_sandbox_info(
    tmp_path: Path,
    *,
    run_id: str = "run-1",
    sandbox_token: str | None = None,
    encrypted_secrets: str = "iv:tag:data",
    region: str = DEFAULT_AWS_REGION,
    billable_firewalls: Sequence[str] | None = None,
    secret_connector_map: Mapping[str, str] | None = None,
    secret_connector_metadata_map: Mapping[str, object] | None = None,
) -> AwsSandboxInfo:
    sandbox_info: AwsSandboxInfo = {
        "runId": run_id,
        "sandboxToken": DEFAULT_SANDBOX_AUTH_KEY if sandbox_token is None else sandbox_token,
        "encryptedSecrets": encrypted_secrets,
        "networkLogPath": str(tmp_path / "network.jsonl"),
        "billableFirewalls": [] if billable_firewalls is None else list(billable_firewalls),
        "vars": {"AWS_REGION": region},
    }
    if secret_connector_map is not None:
        sandbox_info["secretConnectorMap"] = dict(secret_connector_map)
    if secret_connector_metadata_map is not None:
        sandbox_info["secretConnectorMetadataMap"] = copy.deepcopy(
            dict(secret_connector_metadata_map)
        )
    return sandbox_info


def aws_auth_response(
    *,
    include_session_token: bool = True,
    access_key_id: str = RESOLVED_AWS_ACCESS_KEY_ID,
    secret_access_key: str = RESOLVED_AWS_SECRET_ACCESS_KEY,
    session_token: str = RESOLVED_AWS_SESSION_TOKEN,
    headers: Mapping[str, str] | None = None,
    query: Mapping[str, str] | None = None,
) -> dict[str, object]:
    aws_sigv4 = {
        "accessKeyId": access_key_id,
        "secretAccessKey": secret_access_key,
    }
    resolved_secrets = [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    ]
    refreshed_connectors: list[str] = []
    refreshed_secrets: list[str] = []
    if include_session_token:
        aws_sigv4["sessionToken"] = session_token
        resolved_secrets.append("AWS_SESSION_TOKEN")
        refreshed_connectors.append("aws")
        refreshed_secrets.append("AWS_SESSION_TOKEN")

    response = firewall_auth_success_response(
        headers if headers is not None else {},
        expires_at=FAR_FUTURE_EXPIRES_AT,
        resolved_secrets=resolved_secrets,
        refreshed_connectors=refreshed_connectors,
        refreshed_secrets=refreshed_secrets,
    )
    response["awsSigv4"] = aws_sigv4
    if query is not None:
        response["query"] = dict(query)
    return response


def prepare_firewall_request(
    flow: http.HTTPFlow,
    *,
    original_url: str | None = None,
    run_id: str = "run-1",
) -> None:
    flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        get_trusted_authority(flow).url if original_url is None else original_url
    )


def make_sts_header_sigv4_flow(
    real_flow: _RealFlowFactory,
    headers: _HeaderFactory,
    *,
    host: str = STS_HOST,
    path: str = "/",
    method: str = "POST",
    request_body: bytes | None = None,
    authorization: str | None = None,
    signed_headers: str = "host;x-amz-date",
    amz_date: str | None = DEFAULT_SIGV4_TIMESTAMP,
    extra_headers: Sequence[tuple[str, str]] = (),
) -> http.HTTPFlow:
    return real_flow(
        with_response=False,
        host=host,
        path=path,
        method=method,
        request_body=STS_FORM_BODY if request_body is None else request_body,
        request_headers=headers(
            *aws_sigv4_header_auth_headers(
                host=host,
                amz_date=amz_date,
                extra_headers=extra_headers,
                authorization=(
                    aws_sigv4_authorization(signed_headers=signed_headers)
                    if authorization is None
                    else authorization
                ),
            )
        ),
    )


def make_sts_query_sigv4_flow(
    real_flow: _RealFlowFactory, *, path: str | None = None
) -> http.HTTPFlow:
    return real_flow(
        with_response=False,
        host=STS_HOST,
        path=aws_sigv4_presigned_query_path() if path is None else path,
        method="GET",
    )


async def handle_firewall_request_with_auth_endpoint(
    flow: http.HTTPFlow,
    tmp_path: Path,
    mitm_ctx: _MitmContextFactory,
    *,
    endpoint: FakeAuthEndpoint | None = None,
    auth_response: dict[str, object] | None = None,
    allow: matching.FirewallAllow | None = None,
    sandbox_info: AwsSandboxInfo | None = None,
) -> auth.FirewallAuthHandlingResult:
    resolved_endpoint = FakeAuthEndpoint() if endpoint is None else endpoint
    resolved_endpoint.queue_json_response(
        aws_auth_response() if auth_response is None else auth_response
    )
    resolved_sandbox_info = aws_sandbox_info(tmp_path) if sandbox_info is None else sandbox_info
    prepare_firewall_request(flow, run_id=resolved_sandbox_info["runId"])

    with resolved_endpoint.run(), mitm_ctx(api_url=resolved_endpoint.api_url):
        return await handle_firewall_request_without_upstream_admission(
            flow,
            aws_allow() if allow is None else allow,
            dict(resolved_sandbox_info),
        )


def assert_sigv4_failed_closed(
    result: auth.FirewallAuthHandlingResult,
    flow: http.HTTPFlow,
    message_fragment: str,
) -> None:
    assert result is auth.FirewallAuthHandlingResult.LOCAL_RESPONSE
    assert flow.response is not None
    assert flow.response.status_code == 502
    response = flow.response.json()
    assert response["error"] == "aws_sigv4_auth_failed"
    assert message_fragment in response["message"]


def _aws_auth_cache_key(
    tmp_path: Path,
    allow: matching.FirewallAllow | None = None,
    sandbox_info: AwsSandboxInfo | None = None,
) -> auth_cache.FirewallAuthCacheKey:
    resolved_allow = aws_allow() if allow is None else allow
    resolved_api_entry = resolved_allow.api_entry
    resolved_sandbox_info = aws_sandbox_info(tmp_path) if sandbox_info is None else sandbox_info
    auth_config = resolved_api_entry["auth"]
    auth_request = auth_client.FirewallAuthRequest(
        encrypted_secrets=resolved_sandbox_info["encryptedSecrets"],
        auth_headers=auth_config["headers"],
        sandbox_token=resolved_sandbox_info["sandboxToken"],
        auth_base=auth_config.get("base"),
        auth_query=auth_config.get("query"),
        auth_aws_sigv4=auth_config["awsSigv4"],
        secret_connector_map=resolved_sandbox_info.get("secretConnectorMap"),
        secret_connector_metadata_map=resolved_sandbox_info.get("secretConnectorMetadataMap"),
        vars_map=resolved_sandbox_info["vars"],
        firewall_billable=auth.is_billable_firewall(
            resolved_allow.name,
            dict(resolved_sandbox_info),
        ),
    )
    return auth_cache_key(
        run_id=resolved_sandbox_info["runId"],
        api_id=resolved_api_entry["id"],
        auth_identity=auth._build_firewall_auth_identity(
            firewall_name=resolved_allow.name,
            firewall_base=resolved_api_entry["base"],
            auth_request=auth_request,
        ).auth_identity,
    )


def cache_aws_sigv4_credentials(
    tmp_path: Path,
    *,
    allow: matching.FirewallAllow | None = None,
    sandbox_info: AwsSandboxInfo | None = None,
    credentials: AwsSigV4Credentials | None = None,
    headers: Mapping[str, str] | None = None,
    query: Mapping[str, str] | None = None,
    expires_at: object = None,
) -> None:
    set_cached_headers(
        _aws_auth_cache_key(tmp_path, allow=allow, sandbox_info=sandbox_info),
        headers=dict(headers) if headers is not None else {},
        expires_at=expires_at,
        query=dict(query) if query is not None else None,
        aws_sigv4=(resolved_aws_sigv4_credentials() if credentials is None else credentials),
    )
