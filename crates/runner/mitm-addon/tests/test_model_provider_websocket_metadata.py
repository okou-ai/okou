"""Tests for model-provider WebSocket usage metadata."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.deferred_callback_helpers import (
    ScheduledCallback,
    capture_deferred_callbacks,
)
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
)
from tests.model_provider_websocket_helpers import (
    feed_websocket_server_message,
    openai_websocket_usage_frame,
)
from tests.usage_helpers import assert_usage_event_rows


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledCallback]:
    return capture_deferred_callbacks(monkeypatch)


class TestModelProviderWebSocketUsageMetadata:
    """Tests for WebSocket usage metadata parsing without webhook reporting."""

    def test_model_websocket_malformed_frame_preserves_prior_usage(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

        feed_websocket_server_message(flow, b'{"type":"response.completed"')

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "message_id": "resp_ws_1",
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 4,
        }

    def test_model_websocket_ignores_invalid_frames_with_non_dict_usage_metadata(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = "invalid"
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = "invalid"

        feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.in_progress",
                    "response": {"id": "resp_ws_1", "model": "gpt-5.5"},
                }
            ).encode(),
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == "invalid"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] == "invalid"

        feed_websocket_server_message(flow, b'{"type":"response.completed"')
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == "invalid"
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] == "invalid"


class TestModelProviderWebSocketUsageMetadataRecovery:
    """Tests for valid-frame recovery from malformed usage metadata."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_model_websocket_valid_frame_replaces_invalid_usage_sources_metadata(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES] = "invalid"

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_invalid_sources",
                    input_tokens=10,
                    output_tokens=4,
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert model_provider_usage_sources(flow) == {}
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
