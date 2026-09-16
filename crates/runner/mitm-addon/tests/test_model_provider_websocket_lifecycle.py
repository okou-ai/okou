"""Tests for model-provider WebSocket terminal lifecycle behavior."""

import json
from pathlib import Path

import pytest
from mitmproxy import http
from mitmproxy.flow import Error
from mitmproxy.test import tutils
from wsproto.utilities import generate_accept_token

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_request_flow,
    make_openai_responses_websocket_response_headers,
)
from tests.model_provider_websocket_helpers import feed_websocket_server_message
from tests.pending_helpers import assert_pending
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


class _RawValueDecodeGuard(bytes):
    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        raise AssertionError("raw WebSocket value must not be decoded by lifecycle hooks")


_LARGE_RAW_VALUE = _RawValueDecodeGuard(b"\xff" * (1024 * 1024))
_WEBSOCKET_KEY = b"dGhlIHNhbXBsZSBub25jZQ=="
_WEBSOCKET_ACCEPT = b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


def _write_openai_model_websocket_registry(tmp_path: Path) -> Path:
    firewall_name = "model-provider:openai-api-key"
    return _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            run_id="run-abc-123",
            sandbox_marker="tok-xyz",
            firewall_name=firewall_name,
            api_entry={
                "base": "https://api.openai.com",
                "auth": {"headers": {"Authorization": "Bearer token"}},
                "permissions": [{"name": "responses", "rules": ["GET /v1/responses"]}],
            },
            network_policy={
                "allow": ["responses"],
                "deny": [],
                "ask": [],
                "unknownPolicy": "deny",
            },
            billable_firewalls=[firewall_name],
            sandbox_fields={
                "cliAgentType": "codex",
                "modelUsageProvider": "gpt-5.5",
            },
        ),
    )


class TestModelProviderWebSocketLifecycle:
    """Tests for HTTP upgrade and terminal in-flight lifecycle behavior."""

    @pytest.mark.parametrize(
        "response_headers",
        [
            pytest.param(
                make_openai_responses_websocket_response_headers(),
                id="standard",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(
                    connection="Upgrade," + "x" * 10_000,
                ),
                id="connection-token-before-oversized-suffix",
            ),
            pytest.param(
                http.Headers(
                    [
                        (b"Upgrade", _RawValueDecodeGuard(b"websocket," + _LARGE_RAW_VALUE)),
                        (b"Upgrade", _LARGE_RAW_VALUE),
                        (b"Connection", _RawValueDecodeGuard(b"Upgrade," + _LARGE_RAW_VALUE)),
                        (b"Connection", _LARGE_RAW_VALUE),
                        (b"Sec-WebSocket-Accept", _WEBSOCKET_ACCEPT),
                    ]
                ),
                id="raw-early-tokens-ignore-suffixes-and-later-values",
            ),
            pytest.param(
                http.Headers(
                    [
                        (b"Upgrade", b"websocket"),
                        (b"Connection", b"upgrade"),
                        (
                            b"Sec-WebSocket-Accept",
                            _RawValueDecodeGuard(b" " * (8 * 1024 - 28) + _WEBSOCKET_ACCEPT),
                        ),
                    ]
                ),
                id="accept-at-inclusive-raw-byte-limit",
            ),
        ],
    )
    async def test_model_websocket_response_keeps_usage_flow_tracked_until_end(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        usage_webhook_server,
        sync_usage_executor,
        response_headers: http.Headers,
    ):
        """The HTTP 101 response hook must not complete the WebSocket usage lifecycle."""
        control_root = tmp_path / "delivery-control"
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = make_openai_responses_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            assert_pending(
                control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            flow.response = tutils.tresp(
                status_code=101,
                headers=response_headers,
            )
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)
            assert_pending(
                control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_1",
                            "model": "gpt-5.5",
                            "usage": {
                                "input_tokens": 50,
                                "output_tokens": 20,
                                "input_tokens_details": {"cached_tokens": 10},
                            },
                        },
                    }
                ).encode(),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        events = usage_webhook_server.usage_events()
        assert len(events) == 3
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 40,
            "tokens.output": 20,
            "tokens.cache_read": 10,
        }
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    async def test_non_websocket_switching_protocols_response_releases_usage_flow(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
    ):
        """A non-WebSocket 101 response is terminal and must not wait for websocket_end()."""
        control_root = tmp_path / "delivery-control"
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = real_flow(
            with_response=False,
            client_ip="10.200.0.5",
            host="api.openai.com",
            path="/v1/responses",
            method="GET",
        )

        with (
            mitm_ctx(registry_path=str(reg_path)),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            assert_pending(
                control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            flow.response = tutils.tresp(
                status_code=101,
                headers=http.Headers(upgrade="h2c"),
            )
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)

        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    @pytest.mark.parametrize(
        "response_headers",
        [
            pytest.param(
                make_openai_responses_websocket_response_headers(upgrade="h2c"),
                id="non-websocket-upgrade",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(connection=None),
                id="missing-connection-upgrade",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(accept="wrong"),
                id="wrong-accept",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(upgrade="x" * (8 * 1024 + 1)),
                id="upgrade-token-work-limit",
            ),
            pytest.param(
                make_openai_responses_websocket_response_headers(accept="x" * (8 * 1024 + 1)),
                id="accept-work-limit",
            ),
            pytest.param(
                http.Headers(
                    [
                        (b"Upgrade", b"websocket"),
                        (b"Connection", b"upgrade"),
                        (b"Sec-WebSocket-Accept", _LARGE_RAW_VALUE),
                    ]
                ),
                id="oversized-non-utf8-accept",
            ),
            pytest.param(
                http.Headers(
                    [
                        (b"Upgrade", b"websocket"),
                        (b"Connection", b"upgrade"),
                        (b"Sec-WebSocket-Accept", _RawValueDecodeGuard(_WEBSOCKET_ACCEPT)),
                        (b"Sec-WebSocket-Accept", _LARGE_RAW_VALUE),
                    ]
                ),
                id="duplicate-accept-with-oversized-non-utf8-value",
            ),
            pytest.param(
                http.Headers(
                    [
                        (b"Upgrade", _RawValueDecodeGuard(_LARGE_RAW_VALUE + b",websocket")),
                        (b"Connection", b"upgrade"),
                        (b"Sec-WebSocket-Accept", _WEBSOCKET_ACCEPT),
                    ]
                ),
                id="raw-upgrade-token-beyond-work-limit",
            ),
            pytest.param(
                http.Headers(
                    [
                        (b"Upgrade", b"websocket"),
                        (b"Connection", _RawValueDecodeGuard(_LARGE_RAW_VALUE + b",upgrade")),
                        (b"Sec-WebSocket-Accept", _WEBSOCKET_ACCEPT),
                    ]
                ),
                id="raw-connection-token-beyond-work-limit",
            ),
        ],
    )
    async def test_invalid_websocket_switching_protocols_response_releases_usage_flow(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        response_headers: http.Headers,
    ):
        """A malformed 101 WebSocket response must not wait for websocket_end()."""
        control_root = tmp_path / "delivery-control"
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = make_openai_responses_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path)),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            assert_pending(
                control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            flow.response = tutils.tresp(status_code=101, headers=response_headers)
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)

        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    @pytest.mark.parametrize(
        ("request_keys", "response_accept"),
        [
            pytest.param((_LARGE_RAW_VALUE,), _WEBSOCKET_ACCEPT, id="oversized-raw-request-key"),
            pytest.param(
                (_RawValueDecodeGuard(_WEBSOCKET_KEY), _LARGE_RAW_VALUE),
                _WEBSOCKET_ACCEPT,
                id="duplicate-raw-request-key",
            ),
            pytest.param(
                (_RawValueDecodeGuard(b"\xff" * 24),),
                generate_accept_token(b"\xff" * 24),
                id="non-ascii-key-even-with-matching-accept",
            ),
        ],
    )
    async def test_response_rechecks_raw_request_key_before_retaining_usage_flow(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        request_keys: tuple[bytes, ...],
        response_accept: bytes,
    ) -> None:
        control_root = tmp_path / "delivery-control"
        reg_path = _write_openai_model_websocket_registry(tmp_path)
        flow = make_openai_responses_websocket_request_flow(real_flow)

        with mitm_ctx(registry_path=str(reg_path)), fake_firewall_headers():
            await mitm_addon.request(flow)
            assert flow.metadata[metadata_keys.WEBSOCKET_UPGRADE_REQUEST] is True
            assert_pending(control_root, flows=1, buffered=0, reports=0)

            # Response confirmation owns its raw-key boundary even after the
            # request was classified; do not trust an earlier metadata marker.
            flow.request.headers.fields = tuple(
                (name, value)
                for name, value in flow.request.headers.fields
                if name.lower() != b"sec-websocket-key"
            ) + tuple((b"Sec-WebSocket-Key", value) for value in request_keys)
            response_headers = make_openai_responses_websocket_response_headers()
            response_headers["Sec-WebSocket-Accept"] = response_accept
            flow.response = tutils.tresp(status_code=101, headers=response_headers)
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)

        assert_pending(control_root, flows=0, buffered=0, reports=0)

    async def test_model_websocket_error_releases_usage_flow_after_upgrade(
        self,
        tmp_path,
        real_flow,
        mitm_ctx,
        fake_firewall_headers,
        usage_webhook_server,
        sync_usage_executor,
    ):
        """A WebSocket connection error after HTTP 101 is terminal for usage tracking."""
        control_root = tmp_path / "delivery-control"
        reg_path = _write_openai_model_websocket_registry(tmp_path)

        flow = make_openai_responses_websocket_request_flow(real_flow)

        with (
            mitm_ctx(registry_path=str(reg_path), api_url=usage_webhook_server.api_url),
            fake_firewall_headers(),
        ):
            await mitm_addon.request(flow)
            flow.response = tutils.tresp(
                status_code=101,
                headers=make_openai_responses_websocket_response_headers(),
            )
            mitm_addon.responseheaders(flow)
            mitm_addon.response(flow)
            assert_pending(
                control_root,
                flows=1,
                buffered=0,
                reports=0,
            )

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_error",
                            "model": "gpt-5.5",
                            "usage": {
                                "input_tokens": 10,
                                "output_tokens": 4,
                            },
                        },
                    }
                ).encode(),
            )
            flow.error = Error("connection reset by peer")
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        events = usage_webhook_server.usage_events()
        assert len(events) == 2
        by_category = {event["category"]: event["quantity"] for event in events}
        assert by_category == {
            "tokens.input": 10,
            "tokens.output": 4,
        }
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )
