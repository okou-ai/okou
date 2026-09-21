"""Focused AWS-aware rules for the standard compiled firewall matcher."""

from collections.abc import Iterable

import matching
from tests.aws_sigv4_helpers import (
    aws_sigv4_authorization,
    aws_sigv4_header_auth_headers,
)
from tests.firewall_helpers import firewall_api, firewall_permission, wrap_firewalls

_AWS_AUTH = {
    "awsSigv4": {
        "accessKeyId": "${{ secrets.AWS_ACCESS_KEY_ID }}",
        "secretAccessKey": "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
    }
}


def _headers(
    *,
    host: str,
    service: str,
    content_type: str | None = None,
    extra: Iterable[tuple[str, str]] = (),
) -> tuple[tuple[str, str], ...]:
    return tuple(
        aws_sigv4_header_auth_headers(
            host=host,
            authorization=aws_sigv4_authorization(service=service),
            content_type=content_type,
            extra_headers=tuple(extra),
        )
    )


def _match(
    *,
    base: str,
    permissions: list[dict[str, object]],
    url: str,
    method: str,
    headers: tuple[tuple[str, str], ...],
    body: bytes | None = None,
    allow: Iterable[str] = (),
    deny: Iterable[str] = (),
    unknown_policy: str = "ask",
    indexed: bool = True,
) -> object | None:
    firewalls = wrap_firewalls(
        [firewall_api(base, permissions, auth=_AWS_AUTH)],
        name="aws",
    )
    policies = {
        "aws": {
            "allow": list(allow),
            "deny": list(deny),
            "ask": [],
            "unknownPolicy": unknown_policy,
        }
    }
    matcher = (
        matching.match_compiled_firewall_request
        if indexed
        else matching._match_compiled_firewall_request_linear
    )
    return matcher(
        url,
        method,
        matching.compile_firewalls(firewalls),
        policies,
        request_context=matching.FirewallRequestContext(headers=headers, body=body),
    )


def _assert_allowed(result: object, permission: str) -> None:
    assert isinstance(result, matching.FirewallAllow)
    assert result.permission == permission


def _assert_unknown(result: object) -> None:
    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "unknown_endpoint"
    assert result.permissions == ()


def test_query_action_distinguishes_ec2_permissions_with_index_parity() -> None:
    permissions = [
        firewall_permission(
            "describe-instances",
            "POST / AWS sigv4=ec2 action=DescribeInstances",
        ),
        firewall_permission(
            "start-instances",
            "POST / AWS sigv4=ec2 action=StartInstances",
        ),
    ]
    args = {
        "base": "https://ec2.amazonaws.com",
        "permissions": permissions,
        "url": ("https://ec2.amazonaws.com/?Action=DescribeInstances&Version=2016-11-15"),
        "method": "POST",
        "headers": _headers(host="ec2.amazonaws.com", service="ec2"),
        "allow": ("describe-instances",),
    }

    indexed = _match(**args)
    linear = _match(**args, indexed=False)

    _assert_allowed(indexed, "describe-instances")
    assert indexed == linear


def test_query_action_inspects_form_body_at_most_once(monkeypatch) -> None:
    permissions = [
        firewall_permission(
            f"action-{index}",
            f"POST / AWS sigv4=ec2 action=Action{index}",
        )
        for index in range(256)
    ]
    inspection_count = 0
    original = matching._form_action_values

    def counting_form_action_values(headers, body):
        nonlocal inspection_count
        inspection_count += 1
        return original(headers, body)

    monkeypatch.setattr(matching, "_form_action_values", counting_form_action_values)

    result = _match(
        base="https://ec2.amazonaws.com",
        permissions=permissions,
        url="https://ec2.amazonaws.com/?Action=Action255",
        method="POST",
        headers=_headers(host="ec2.amazonaws.com", service="ec2"),
        allow=("action-255",),
    )

    _assert_allowed(result, "action-255")
    assert inspection_count == 1


def test_form_action_matches_iam_and_uninspectable_body_fails_closed() -> None:
    body = b"Action=ListUsers&Version=2010-05-08"
    permissions = [
        firewall_permission(
            "list-users",
            "POST / AWS sigv4=iam action=ListUsers",
        )
    ]
    headers = _headers(
        host="iam.amazonaws.com",
        service="iam",
        content_type="application/x-www-form-urlencoded; charset=utf-8",
        extra=(("Content-Length", str(len(body))),),
    )

    allowed = _match(
        base="https://iam.amazonaws.com",
        permissions=permissions,
        url="https://iam.amazonaws.com/",
        method="POST",
        headers=headers,
        body=body,
        allow=("list-users",),
    )
    missing_body = _match(
        base="https://iam.amazonaws.com",
        permissions=permissions,
        url="https://iam.amazonaws.com/",
        method="POST",
        headers=headers,
        allow=("list-users",),
    )

    _assert_allowed(allowed, "list-users")
    _assert_unknown(missing_body)


def test_conflicting_query_and_form_actions_fail_closed() -> None:
    body = b"Action=DeleteUser&Version=2010-05-08"
    permissions = [
        firewall_permission(
            "list-users",
            "POST / AWS sigv4=iam action=ListUsers",
        )
    ]
    headers = _headers(
        host="iam.amazonaws.com",
        service="iam",
        content_type="application/x-www-form-urlencoded",
        extra=(("Content-Length", str(len(body))),),
    )

    result = _match(
        base="https://iam.amazonaws.com",
        permissions=permissions,
        url="https://iam.amazonaws.com/?Action=ListUsers",
        method="POST",
        headers=headers,
        body=body,
        allow=("list-users",),
    )

    _assert_unknown(result)


def test_json_target_requires_one_exact_header() -> None:
    target = "DynamoDB_20120810.GetItem"
    permissions = [
        firewall_permission(
            "get-item",
            f"POST / AWS sigv4=dynamodb target={target}",
        )
    ]
    base_headers = _headers(
        host="dynamodb.us-east-1.amazonaws.com",
        service="dynamodb",
        extra=(("X-Amz-Target", target),),
    )

    allowed = _match(
        base="https://dynamodb.us-east-1.amazonaws.com",
        permissions=permissions,
        url="https://dynamodb.us-east-1.amazonaws.com/",
        method="POST",
        headers=base_headers,
        allow=("get-item",),
    )
    duplicate = _match(
        base="https://dynamodb.us-east-1.amazonaws.com",
        permissions=permissions,
        url="https://dynamodb.us-east-1.amazonaws.com/",
        method="POST",
        headers=(*base_headers, ("x-amz-target", target)),
        allow=("get-item",),
    )

    _assert_allowed(allowed, "get-item")
    _assert_unknown(duplicate)


def test_s3_rest_query_selector_does_not_fall_through_to_base_operation() -> None:
    permissions = [
        firewall_permission(
            "get-object",
            "GET /{Bucket}/{Key+} AWS sigv4=s3",
        ),
        firewall_permission(
            "get-object-acl",
            "GET /{Bucket}/{Key+}?acl AWS sigv4=s3",
        ),
        firewall_permission(
            "get-object-version",
            "GET /{Bucket}/{Key+}?versionId=* AWS sigv4=s3",
        ),
    ]
    headers = _headers(host="s3.amazonaws.com", service="s3")

    acl = _match(
        base="https://s3.amazonaws.com",
        permissions=permissions,
        url="https://s3.amazonaws.com/bucket/key?acl",
        method="GET",
        headers=headers,
        allow=("get-object-acl",),
    )
    version = _match(
        base="https://s3.amazonaws.com",
        permissions=permissions,
        url="https://s3.amazonaws.com/bucket/key?versionId=v1",
        method="GET",
        headers=headers,
        allow=("get-object-version",),
    )
    unknown_selector = _match(
        base="https://s3.amazonaws.com",
        permissions=permissions,
        url="https://s3.amazonaws.com/bucket/key?torrent",
        method="GET",
        headers=headers,
        allow=("get-object",),
    )

    _assert_allowed(acl, "get-object-acl")
    _assert_allowed(version, "get-object-version")
    _assert_unknown(unknown_selector)


def test_s3_permission_selecting_headers_fail_closed() -> None:
    permissions = [
        firewall_permission(
            "put-object",
            "PUT /{Bucket}/{Key+} AWS sigv4=s3",
        )
    ]
    headers = _headers(
        host="s3.amazonaws.com",
        service="s3",
        extra=(("X-Amz-Copy-Source", "/source/key"),),
    )

    result = _match(
        base="https://s3.amazonaws.com",
        permissions=permissions,
        url="https://s3.amazonaws.com/bucket/key",
        method="PUT",
        headers=headers,
        allow=("put-object",),
    )

    _assert_unknown(result)


def test_aws_rule_requires_matching_valid_sigv4_service() -> None:
    permissions = [
        firewall_permission(
            "describe-instances",
            "POST / AWS sigv4=ec2 action=DescribeInstances",
        )
    ]
    result = _match(
        base="https://ec2.amazonaws.com",
        permissions=permissions,
        url="https://ec2.amazonaws.com/?Action=DescribeInstances",
        method="POST",
        headers=_headers(host="ec2.amazonaws.com", service="iam"),
        allow=("describe-instances",),
    )

    _assert_unknown(result)


def test_denied_duplicate_aws_semantic_identity_takes_priority() -> None:
    rule = "POST / AWS sigv4=ec2 action=DescribeInstances"
    permissions = [
        firewall_permission("describe-primary", rule),
        firewall_permission("describe-alias", rule),
    ]

    result = _match(
        base="https://ec2.amazonaws.com",
        permissions=permissions,
        url="https://ec2.amazonaws.com/?Action=DescribeInstances",
        method="POST",
        headers=_headers(host="ec2.amazonaws.com", service="ec2"),
        allow=("describe-primary",),
        deny=("describe-alias",),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "permission_denied"
    assert result.permissions == ("describe-alias",)


def test_aws_rule_on_non_sigv4_api_is_malformed_firewall_config() -> None:
    firewalls = wrap_firewalls(
        [
            firewall_api(
                "https://api.example.com",
                [
                    firewall_permission(
                        "describe-instances",
                        "POST / AWS sigv4=ec2 action=DescribeInstances",
                    )
                ],
            )
        ],
        name="aws",
    )
    result = matching.match_compiled_firewall_request(
        "https://api.example.com/?Action=DescribeInstances",
        "POST",
        matching.compile_firewalls(firewalls),
        {
            "aws": {
                "allow": ["describe-instances"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "allow",
            }
        },
        request_context=matching.FirewallRequestContext(
            headers=_headers(host="api.example.com", service="ec2")
        ),
    )

    assert isinstance(result, matching.FirewallBlock)
    assert result.reason == "malformed_firewall_config"
