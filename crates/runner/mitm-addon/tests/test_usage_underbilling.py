"""Tests for usage underbilling log contracts."""

import json

from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.process_log_helpers import capture_addon_process_events
from usage.underbilling import log_usage_underbilling


def _captured_process_log(log) -> tuple[str, dict[str, object]]:
    message, fields = log.error.call_args.args
    assert isinstance(message, str)
    assert isinstance(fields, dict)
    return message, fields


def test_underbilling_writes_proxy_row_and_process_event(tmp_path):
    proxy_log_path = tmp_path / "proxy.jsonl"

    with capture_addon_process_events() as log:
        log_usage_underbilling(
            str(proxy_log_path),
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            type="usage_event",
            reason="wrong_reason",
            component="wrong_component",
            underbilling_class="confirmed",
            run_id="run-1",
            level="debug",
            message="wrong_message",
            timestamp="wrong_timestamp",
        )

    [entry] = read_jsonl_entries_after_flush(proxy_log_path)
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "expected_reason"
    assert entry["underbilling_class"] == "risk"
    assert entry["component"] == "mitm_addon"
    assert entry["run_id"] == "run-1"
    assert entry["level"] == "error"
    assert entry["message"] == "Usage underbilling signal"
    assert entry["timestamp"] != "wrong_timestamp"

    log.error.assert_called_once()
    message, fields = _captured_process_log(log)
    assert message == "Usage underbilling signal"
    assert fields == {
        "type": "usage_underbilling",
        "reason": "expected_reason",
        "underbilling_class": "risk",
        "component": "mitm_addon",
        "run_id": "run-1",
    }


def test_underbilling_log_without_proxy_path_uses_process_event(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            type="usage_event",
            reason="wrong_reason",
            component="wrong_component",
            underbilling_class="confirmed",
        )

    log.error.assert_called_once()
    message, fields = _captured_process_log(log)
    assert message == "Usage underbilling signal"
    assert fields == {
        "type": "usage_underbilling",
        "reason": "expected_reason",
        "underbilling_class": "risk",
        "component": "mitm_addon",
    }


def test_underbilling_process_event_preserves_context(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Cannot report usage event",
            "missing_reporting_context",
            "confirmed",
            type="usage_event",
            reason="wrong_reason",
            component="wrong_component",
            underbilling_class="risk",
            run_id="run-1",
            firewall_name="model-provider:anthropic",
            permission="messages:create",
            missing_sandbox_token=True,
            missing_api_url=False,
            dropped_webhook_batch_count=2,
            level="debug",
            message="wrong_message",
            timestamp="wrong_timestamp",
        )

    log.error.assert_called_once()
    message, fields = _captured_process_log(log)
    assert message == "Cannot report usage event"
    assert fields == {
        "type": "usage_underbilling",
        "reason": "missing_reporting_context",
        "underbilling_class": "confirmed",
        "component": "mitm_addon",
        "run_id": "run-1",
        "firewall_name": "model-provider:anthropic",
        "permission": "messages:create",
        "missing_sandbox_token": True,
        "missing_api_url": False,
        "dropped_webhook_batch_count": 2,
    }


def test_underbilling_process_event_sanitizes_url(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "X response unparseable",
            "unparseable_usage_response",
            "confirmed",
            url="https://user:pass@example.com/v1/search?token=secret#fragment",
        )

    _, fields = _captured_process_log(log)
    assert fields["url"] == "https://example.com/v1/search"


def test_underbilling_process_event_redacts_secret_strings_not_boolean_flags(mitm_ctx):
    sensitive_context = {
        "sandbox_token": "secret-token",
        "missing_sandbox_token": True,
        "authorization_header": "Bearer secret-token",
        "retained_retry_count": 3,
    }

    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Cannot report usage event",
            "missing_reporting_context",
            "confirmed",
            **sensitive_context,
        )

    _, fields = _captured_process_log(log)
    assert fields["sandbox_token"] == "[redacted]"
    assert fields["authorization_header"] == "[redacted]"
    assert fields["missing_sandbox_token"] is True
    assert fields["retained_retry_count"] == 3
    assert "secret-token" not in json.dumps(fields)


def test_underbilling_process_event_redacts_common_key_fields(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Cannot report usage event",
            "missing_reporting_context",
            "confirmed",
            api_key="api-key-value",
            access_key_id="access-key-value",
            private_key="private-key-value",
            credential_value="credential-value",
            bearer="bearer-value",
            jwt="jwt-value",
            sandbox_token_bytes=b"bytes-token-value",
            auth_header="short-auth-header-value",
            authentication_header="authentication-header-value",
            idempotency_key="diagnostic-key",
            input_tokens="42",
            tokenizer_name="usage-tokenizer",
            **{
                "api-key": "hyphen-api-key-value",
                "api key number": 123456,
                "spaced api key": "spaced-api-key-value",
                "access key number": 456789,
                "accessKeyId": "camel-access-key-value",
                "oauth_token": "oauth-token-value",
                "passwd": "passwd-value",
                "pwd": "pwd-value",
                "APIToken": "upper-api-token-value",
                "XApiKey": "prefixed-api-key-value",
                "AWSACCESSKEYID": "upper-compact-access-key-value",
                "github_accesstoken": "compact-access-token-value",
                "openai_apikey": "compact-api-key-value",
                "sessioncookie": "compact-cookie-value",
                "signedjwt": "compact-jwt-value",
                "dbpasswd": "compact-passwd-value",
                "bearerCredential": "compact-bearer-value",
                "private.key": "dotted-private-key-value",
                "privateKey": "camel-private-key-value",
                "ssh_privatekey": "compact-private-key-value",
            },
        )

    _, fields = _captured_process_log(log)
    redacted_fields = {
        "api_key",
        "access_key_id",
        "private_key",
        "credential_value",
        "bearer",
        "jwt",
        "passwd",
        "pwd",
        "auth_header",
        "authentication_header",
        "oauth_token",
        "sandbox_token_bytes",
        "api-key",
        "api key number",
        "spaced api key",
        "access key number",
        "accessKeyId",
        "private.key",
        "privateKey",
        "APIToken",
        "XApiKey",
        "AWSACCESSKEYID",
        "github_accesstoken",
        "openai_apikey",
        "sessioncookie",
        "signedjwt",
        "dbpasswd",
        "bearerCredential",
        "ssh_privatekey",
    }
    assert all(fields[name] == "[redacted]" for name in redacted_fields)
    assert fields["idempotency_key"] == "diagnostic-key"
    assert fields["input_tokens"] == "42"
    assert fields["tokenizer_name"] == "usage-tokenizer"
    serialized = json.dumps(fields)
    assert "api-key-value" not in serialized
    assert "access-key-value" not in serialized
    assert "private-key-value" not in serialized
    assert "credential-value" not in serialized
    assert "bearer-value" not in serialized
    assert "jwt-value" not in serialized
    assert "bytes-token-value" not in serialized


def test_underbilling_process_event_bounds_multiline_values(mitm_ctx):
    long_value = f"first line\n{'x' * 400}\nlast line"

    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            parse_error=long_value,
        )

    _, fields = _captured_process_log(log)
    parse_error = fields["parse_error"]
    assert isinstance(parse_error, str)
    assert log.error.call_count == 1
    assert parse_error.startswith("first line\n")
    assert parse_error.endswith("...")
    assert "last line" not in parse_error
    assert len(parse_error) == 256


def test_underbilling_process_event_preserves_structured_field_whitespace(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            parse_error="\t" * 129,
        )

    _, fields = _captured_process_log(log)
    assert fields["parse_error"] == "\t" * 129


def test_underbilling_process_event_bounds_non_scalar_values(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            debug_payload={"items": ["x" * 400] * 20},
        )

    _, fields = _captured_process_log(log)
    debug_payload = fields["debug_payload"]
    assert isinstance(debug_payload, str)
    assert "x" * 300 not in debug_payload
    assert len(debug_payload) <= 256


def test_underbilling_process_event_preserves_field_keys(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            **{"bad key\nname": "value with spaces"},
        )

    _, fields = _captured_process_log(log)
    assert fields["bad key\nname"] == "value with spaces"


def test_underbilling_process_event_escapes_nonstandard_whitespace_and_controls(
    mitm_ctx,
):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling signal",
            "expected_reason",
            "risk",
            parse_error="left\u00a0middle\f\x1b[31mright",
        )

    _, fields = _captured_process_log(log)
    assert fields["parse_error"] == "left\u00a0middle\f\x1b[31mright"


def test_underbilling_process_event_escapes_message_controls(mitm_ctx):
    with mitm_ctx() as log:
        log_usage_underbilling(
            "",
            "Usage underbilling\nsignal\twith\x1bcontrols",
            "expected_reason",
            "risk",
            run_id="run-1",
        )

    message, fields = _captured_process_log(log)
    assert fields["reason"] == "expected_reason"
    assert fields["run_id"] == "run-1"
    assert message == "Usage underbilling\\nsignal\\twith\\u001bcontrols"
    assert "\n" not in message
    assert "\t" not in message
    assert "\x1b" not in message
