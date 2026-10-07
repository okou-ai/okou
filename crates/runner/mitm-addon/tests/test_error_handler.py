"""Tests for the mitm addon error hook."""

import json
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from mitmproxy.flow import Error
from mitmproxy.test import tutils

import auth_base_forwarder
import flow_metadata_keys as metadata_keys
import http_network_log
import mitm_addon
import request_classification
import request_streaming
import upstream_destination_binding
import usage
from tests.connector_diagnostic_helpers import (
    record_connector_diagnostic_requestheaders_context,
    write_connector_diagnostic_capture_registry,
)
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.request_handler_helpers import (
    _sandbox_without_firewalls,
    _single_firewall_sandbox,
    _write_registry,
)
from tests.timestamp_helpers import assert_utc_millisecond_timestamp
from tests.upstream_connection_helpers import seed_server_binding


class TestErrorHandler:
    def test_error_preserves_upstream_binding_until_server_disconnect(self, real_flow, mitm_ctx):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.github.com",
            path="/repos/octocat/hello",
        )
        seed_server_binding(
            flow.server_conn,
            client=flow.client_conn,
            host="api.github.com",
            port=443,
            kinds=frozenset(("connector_auth",)),
            original_address=("api.github.com", 443),
        )

        with mitm_ctx():
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.server_conn.id in upstream_destination_binding.binding_snapshot_for_tests()

        mitm_addon.server_disconnected(SimpleNamespace(server=flow.server_conn))

        assert upstream_destination_binding.binding_snapshot_for_tests() == {}

    def test_error_releases_header_phase_auth_base_admission(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(
            tmp_path,
            sandbox_info=_single_firewall_sandbox(
                tmp_path,
                firewall_name="webhook",
                api_entry={
                    "base": "https://placeholder.example.com",
                    "auth": {"headers": {}, "base": "${{ secrets.WEBHOOK_URL }}"},
                    "permissions": [{"name": "send", "rules": ["POST /"]}],
                },
                network_policy={
                    "allow": ["send"],
                    "deny": [],
                    "ask": [],
                    "unknownPolicy": "deny",
                },
            ),
        )
        declared_size = mitm_addon.STREAM_BUFFER_LIMIT + 1
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="placeholder.example.com",
            method="POST",
            path="/",
            request_headers=headers(
                ("Host", "placeholder.example.com"),
                ("Content-Length", str(declared_size)),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            mitm_addon.requestheaders(flow)
            assert auth_base_forwarder.forward_request_admission_state_for_tests() == (
                1,
                declared_size,
            )
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert auth_base_forwarder.forward_request_admission_state_for_tests() == (0, 0)
        assert metadata_keys.AUTH_BASE_FORWARD_ADMISSION not in flow.metadata

    async def test_connector_candidate_error_keeps_original_connection_error(
        self, tmp_path, real_flow, mitm_ctx
    ):
        reg_path = write_connector_diagnostic_capture_registry(tmp_path)
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
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert "firewall_error" not in entry
        assert "connector_diagnostic_slug" not in entry

        [proxy_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert proxy_entry["type"] == "connection_error"

    def test_streamed_connector_candidate_error_before_request_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx
    ):
        reg_path = write_connector_diagnostic_capture_registry(tmp_path)
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            request_chunk = record_connector_diagnostic_requestheaders_context(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["request_size"] == len(request_chunk)
        assert entry["error"] == "connection reset by peer"
        assert "firewall_error" not in entry
        assert "connector_diagnostic_slug" not in entry
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata

    def test_header_phase_connector_diagnostic_error_keeps_connection_error(
        self, tmp_path, real_flow, mitm_ctx
    ):
        reg_path = write_connector_diagnostic_capture_registry(tmp_path)
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            record_connector_diagnostic_requestheaders_context(flow)
            flow.response = tutils.tresp(
                status_code=401,
                headers=header_map({"content-type": "text/plain"}),
                content=b"upstream auth error",
            )
            mitm_addon.responseheaders(flow)
            assert response_stream(flow)(b"partial upstream body") == ()
            flow.response.trailers = header_map({"x-upstream-trailer": "discarded"})
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is not None
        assert flow.response.status_code == 401
        assert flow.response.trailers is None
        assert flow.response.stream is False
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert entry["firewall_error"] == "connector_not_configured_for_run"
        assert entry["connector_diagnostic_slug"] == "fal"

        [proxy_entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert proxy_entry["type"] == "connection_error"

    def test_streamed_authenticated_connector_candidate_error_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(
            tmp_path,
            sandbox_info=_sandbox_without_firewalls(
                tmp_path, sandbox_fields={"captureNetworkBodies": True}
            ),
        )
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
            request_headers=headers(
                ("Host", "fal.run"),
                ("Authorization", "Key user-provided"),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            mitm_addon.requestheaders(flow)
            stream = flow.request.stream
            assert callable(stream)
            assert stream(b"partial request") == b"partial request"
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["request_size"] == len(b"partial request")
        assert entry["error"] == "connection reset by peer"
        assert entry["request_headers"] == {
            "Host": "***",
            "Authorization": "***",
        }
        assert entry["request_body"] == "partial request"
        assert entry["request_body_encoding"] == "utf-8"
        assert entry["request_body_truncated"] is True
        assert "firewall_error" not in entry
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert request_classification.REQUEST_CLASSIFICATION_METADATA_KEY not in flow.metadata
        assert flow.request.stream is False

    def test_error_captures_partial_streamed_response_before_cleanup(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = real_flow(
            with_response=False,
            host="api.example.com",
        )
        log_path = tmp_path / "network.jsonl"
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.CAPTURE_BODY] = True
        http_network_log.set_target(
            flow,
            url="https://api.example.com/",
            host="api.example.com",
            port=443,
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": "text/plain",
                    "set-cookie": "session=secret",
                }
            ),
        )

        mitm_addon.responseheaders(flow)
        assert response_stream(flow)(b"partial response") == b"partial response"
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.error(flow)

        [entry] = read_jsonl_entries_after_flush(log_path)
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert entry["response_headers"] == {
            "content-type": "text/plain",
            "set-cookie": "***",
        }
        assert entry["response_body"] == "partial response"
        assert entry["response_body_encoding"] == "utf-8"
        assert entry["response_body_truncated"] is True
        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
        assert flow.response.stream is False

    async def test_browser_connector_candidate_error_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
            request_headers=headers(
                ("Host", "fal.run"),
                (
                    "User-Agent",
                    "Mozilla/5.0 AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
                ),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["browser_user_agent"] is True
        assert entry["error"] == "connection reset by peer"
        assert "firewall_error" not in entry

    async def test_authenticated_connector_candidate_error_keeps_original_error(
        self, tmp_path, real_flow, mitm_ctx, headers
    ):
        reg_path = _write_registry(tmp_path, sandbox_info=_sandbox_without_firewalls(tmp_path))
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="fal.run",
            path="/fal-ai/nano-banana-pro",
            method="POST",
            request_headers=headers(
                ("Host", "fal.run"),
                ("Authorization", "Key user-provided"),
            ),
        )

        with mitm_ctx(registry_path=str(reg_path), api_url="https://api.okou.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        assert flow.response is None
        [entry] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert "firewall_error" not in entry

    def test_cleans_up_start_time(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False)
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "net.jsonl")
        # Matches the request handler's invariant: original_url is set
        # alongside sandbox_run_id.
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://example.com/"
        http_network_log.set_target(
            flow,
            url="https://example.com/",
            host="example.com",
            port=443,
        )
        flow.error = Error("connection reset")
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()

        with mitm_ctx():
            mitm_addon.error(flow)

        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

    def test_error_releases_unfinished_json_streaming_state(self, tmp_path, real_flow, mitm_ctx):
        """Connection errors should drop unfinished JSON parser closures."""
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "net.jsonl")
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.anthropic.com/v1/messages"
        http_network_log.set_target(
            flow,
            url="https://api.anthropic.com/v1/messages",
            host="api.anthropic.com",
            port=443,
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:claude-code-oauth-token"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"model":"claude-sonnet-4-6","usage":')
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.response.stream is False
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
        assert metadata_keys.MODEL_PROVIDER_USAGE not in flow.metadata

    def test_error_without_run_id_releases_streaming_state(self, real_flow, mitm_ctx):
        """Early-returning error flows should still drop response parser closures."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets")
        flow.metadata[metadata_keys.FIREWALL_NAME] = "x"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.x.com/2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        assert "connector_response_finish" in flow.metadata
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.response.stream is False
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    def test_error_without_run_id_releases_request_stream_state(self, real_flow, mitm_ctx):
        """Early-returning error flows should still drop request stream closures."""
        flow = real_flow(with_response=False, host="api.example.com", method="POST")
        request_streaming.configure_request_stream(flow)
        stream = flow.request.stream
        assert callable(stream)
        stream(b"request-prefix")
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)

        assert flow.request.stream is False
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata

    def test_error_does_not_bill_partial_x_json_response(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor, usage_webhook_api
    ):
        """Interrupted non-stream JSON must not be billed via request-hint fallback."""
        flow = real_flow(with_response=False, host="api.x.com", path="/2/tweets?ids=1,2,3")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(tmp_path / "net.jsonl")
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = "test-token"
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.x.com/2/tweets?ids=1,2,3"
        http_network_log.set_target(
            flow,
            url="https://api.x.com/2/tweets?ids=1,2,3",
            host="api.x.com",
            port=443,
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "x"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.FIREWALL_PERMISSION] = "tweet.read"
        flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = "GET /2/tweets"
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json"}),
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'{"data":[{"id":"1"}')
        flow.error = Error("connection reset")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)

        assert webhook.request_count == 0
        assert flow.response.stream is False
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert "connector_response_finish" not in flow.metadata

    def test_skips_log_when_no_metadata(self, real_flow, mitm_ctx):
        flow = real_flow(with_response=False)
        flow.error = Error("connection reset")

        with mitm_ctx():
            mitm_addon.error(flow)  # Should not raise, no JSONL written

    def test_logs_error_to_jsonl(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="slack.com", path="/api/chat.postMessage")
        flow.request.method = "POST"
        log_path = str(tmp_path / "network.jsonl")
        raw_url = "https://slack.com/api/chat.postMessage?token=secret#frag"
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
        http_network_log.set_target(
            flow,
            url=raw_url,
            host="slack.com",
            port=443,
        )
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.error = Error("connection reset by peer")
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic() - 1.5

        with mitm_ctx():
            mitm_addon.error(flow)

        entries = read_jsonl_entries_after_flush(Path(log_path))
        assert len(entries) == 1
        entry = entries[0]
        assert entry["type"] == "http"
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "slack.com"
        assert entry["method"] == "POST"
        assert entry["url"] == raw_url
        assert entry["status"] == 0
        assert entry["response_size"] == 0
        assert entry["error"] == "connection reset by peer"
        assert entry["latency_ms"] > 0
        assert_utc_millisecond_timestamp(entry["timestamp"])
        assert flow.metadata[metadata_keys.ORIGINAL_URL] == raw_url
        assert {
            "request_headers",
            "request_headers_truncated",
            "request_body",
            "request_body_encoding",
            "request_body_truncated",
            "response_headers",
            "response_headers_truncated",
            "response_body",
            "response_body_encoding",
            "response_body_truncated",
        }.isdisjoint(entry)

    def test_error_log_omits_url_when_json_escaping_exceeds_line_budget(
        self, tmp_path, real_flow, mitm_ctx
    ):
        raw_url = "https://target.example.com/path?payload=" + ("\\" * 600_000)
        flow = real_flow(with_response=False, host="target.example.com")
        log_path = tmp_path / "network.jsonl"
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(log_path)
        flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        http_network_log.set_target(
            flow,
            url=raw_url,
            host="target.example.com",
            port=443,
        )
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.error(flow)

        serialized = read_jsonl_text_after_flush(log_path)
        entry = json.loads(serialized)
        assert len(raw_url) < 1_000_000
        assert len(serialized.encode()) <= 1_000_000
        assert entry["url"] == "[truncated]"
        assert entry["url_truncated"] is True
        assert entry["url_original_char_count"] == len(raw_url)

    async def test_request_classified_error_logs_network_target(
        self, registry_file, real_flow, mitm_ctx, headers
    ):
        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.1",
            host="203.0.113.10",
            port=8443,
            sni="api.anthropic.com",
            path="/v1/messages",
            request_headers=headers(("Host", "api.anthropic.com")),
        )

        with mitm_ctx(registry_path=str(registry_file), api_url="https://api.okou.ai"):
            await mitm_addon.request(flow)
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)

        [entry] = read_jsonl_entries_after_flush(registry_file.parent / "network.jsonl")
        assert entry["type"] == "http"
        assert entry["action"] == "ALLOW"
        assert entry["host"] == "api.anthropic.com"
        assert entry["port"] == 8443
        assert entry["url"] == "https://api.anthropic.com:8443/v1/messages"
        assert entry["status"] == 0
        assert entry["error"] == "connection reset by peer"
        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata

    def test_error_logs_typed_target_port_zero(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="request.example.com", port=9443)
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://target.example.com:0/path"
        http_network_log.set_target(
            flow,
            url="https://target.example.com:0/path",
            host="target.example.com",
            port=0,
        )
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.error(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["host"] == "target.example.com"
        assert entry["port"] == 0
        assert entry["url"] == "https://target.example.com:0/path"
        assert entry["error"] == "connection reset by peer"

    def test_missing_network_log_target_fails_error(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="fallback.example.com", port=9443)
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://invalid.example.com:bad/path"
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.HTTP_REQUEST_START_MONOTONIC] = time.monotonic()
        flow.error = Error("connection reset by peer")
        request_streaming.configure_request_stream(flow)

        with mitm_ctx(), pytest.raises(KeyError, match=metadata_keys.NETWORK_LOG_TARGET):
            mitm_addon.error(flow)

        assert metadata_keys.HTTP_REQUEST_START_MONOTONIC not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert flow.request.stream is False
        assert not Path(log_path).exists()

    def test_error_request_size_tracks_streamed_bytes_and_releases_request_stream_state(
        self, tmp_path, real_flow, mitm_ctx
    ):
        flow = real_flow(
            with_response=False,
            host="api.example.com",
            method="POST",
            request_body=b"should-be-ignored",
        )
        log_path = str(tmp_path / "network.jsonl")
        body = b"abcdef"

        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://api.example.com/"
        http_network_log.set_target(
            flow,
            url="https://api.example.com/",
            host="api.example.com",
            port=443,
        )
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.error = Error("connection reset by peer")

        request_streaming.configure_request_stream(flow)
        stream = flow.request.stream
        assert callable(stream)
        assert stream(body[:2]) == body[:2]
        assert stream(body[2:]) == body[2:]

        with mitm_ctx():
            mitm_addon.error(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["request_size"] == len(body)
        assert entry["error"] == "connection reset by peer"
        assert metadata_keys.REQUEST_STREAM_BUFFER not in flow.metadata
        assert metadata_keys.REQUEST_STREAM_BUFFER_STATE not in flow.metadata
        assert flow.request.stream is False

    def test_error_includes_firewall_context(self, tmp_path, real_flow, mitm_ctx):
        flow = real_flow(with_response=False, host="slack.com")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://slack.com/api/chat.postMessage"
        http_network_log.set_target(
            flow,
            url="https://slack.com/api/chat.postMessage",
            host="slack.com",
            port=443,
        )
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.FIREWALL_BASE] = "https://slack.com/api"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "slack"
        flow.metadata[metadata_keys.FIREWALL_PERMISSION] = "chat:write"
        flow.metadata[metadata_keys.FIREWALL_RULE_MATCH] = "POST /chat.postMessage"
        flow.error = Error("timed out")

        with mitm_ctx():
            mitm_addon.error(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["firewall_base"] == "https://slack.com/api"
        assert entry["firewall_name"] == "slack"
        assert "firewall_ref" not in entry
        assert entry["firewall_permission"] == "chat:write"
        assert entry["firewall_rule_match"] == "POST /chat.postMessage"
        assert entry["error"] == "timed out"

    def test_error_logs_warning_to_proxy_log_without_network_log(self, tmp_path, real_flow):
        flow = real_flow(with_response=False, host="slack.com")
        proxy_log = tmp_path / "proxy-run-abc-123.jsonl"
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log)
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://slack.com/api/test?api_key=secret#frag"
        flow.error = Error("connection reset by peer")

        mitm_addon.error(flow)

        assert jsonl_exists_after_flush(proxy_log)
        [entry] = read_jsonl_entries_after_flush(proxy_log)
        assert entry["message"] == "Error: connection reset by peer: https://slack.com/api/test"
        assert "api_key=secret" not in entry["message"]
        assert "#frag" not in entry["message"]

    def test_error_proxy_log_omits_retained_url_above_processing_limit(
        self, tmp_path, real_flow, mitm_ctx
    ):
        secret_userinfo = "proxy-error-user:proxy-error-password"
        raw_url = f"https://{secret_userinfo}@target.example.com/path/" + ("x" * 1_000_000)
        network_log_path = tmp_path / "network.jsonl"
        proxy_log_path = tmp_path / "proxy.jsonl"
        flow = real_flow(with_response=False, host="target.example.com")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = str(network_log_path)
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(proxy_log_path)
        flow.metadata[metadata_keys.ORIGINAL_URL] = raw_url
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        http_network_log.set_target(
            flow,
            url=raw_url,
            host="target.example.com",
            port=443,
        )
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.error(flow)

        [network_entry] = read_jsonl_entries_after_flush(network_log_path)
        assert network_entry["url"] == "[truncated]"
        [proxy_entry] = read_jsonl_entries_after_flush(proxy_log_path)
        assert proxy_entry["message"] == "Error: connection reset by peer: [truncated]"
        assert proxy_entry["type"] == "connection_error"
        assert proxy_entry["error"] == "connection reset by peer"
        assert proxy_entry["url_truncated"] is True
        assert proxy_entry["url_original_char_count"] == len(raw_url)
        serialized_proxy_entry = json.dumps(proxy_entry)
        assert secret_userinfo not in serialized_proxy_entry
        assert len(serialized_proxy_entry.encode()) < 1_000

    def test_error_without_network_log_reports_model_usage(
        self, tmp_path, real_flow, mitm_ctx, sync_usage_executor, usage_webhook_api
    ):
        """Integration: error() -> _maybe_report -> _enqueue -> _retry -> webhook.

        Verifies that error() hook delivers partial usage through loopback HTTP.
        """
        flow = real_flow(with_response=False, host="openrouter.ai")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-int-002"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://openrouter.ai/api/v1/responses"
        flow.metadata[metadata_keys.FIREWALL_ACTION] = "ALLOW"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openrouter-codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "claude-sonnet-4-6"
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = "tok-xyz"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "model": "claude-sonnet-4-6",
            "tokens.input": 80,
        }
        flow.error = Error("connection reset by peer")

        with usage_webhook_api() as webhook:
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 1
        requests_by_path = {request.path: request for request in webhook.requests}
        body = requests_by_path["/api/webhooks/agent/usage-event"].json_body()
        assert body["runId"] == "run-int-002"
        assert [
            {key: value for key, value in event.items() if key != "idempotencyKey"}
            for event in body["events"]
        ] == [
            {
                "kind": "model",
                "provider": "claude-sonnet-4-6",
                "category": "tokens.input",
                "quantity": 80,
            }
        ]
        billing_key = body["events"][0]["idempotencyKey"]
        uuid.UUID(billing_key)
        assert not (tmp_path / "network.jsonl").exists()
