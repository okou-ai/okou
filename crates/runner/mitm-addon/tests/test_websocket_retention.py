"""Tests for registered WebSocket message retention and cleanup."""

import pytest
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_websocket_usage
import usage
import websocket_retention
from tests.deferred_callback_helpers import (
    ScheduledCallback,
    capture_deferred_callbacks,
    run_deferred_callbacks,
)
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
)
from tests.model_provider_websocket_helpers import (
    append_websocket_message,
    capture_openai_responses_extractor_feeds,
    openai_websocket_usage_frame,
)
from tests.usage_helpers import assert_usage_event_rows


@pytest.fixture
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledCallback]:
    return capture_deferred_callbacks(monkeypatch)


class TestModelProviderWebSocketRetentionWithUsageDelivery:
    """Retention and cleanup tests that also verify delivered usage."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_model_websocket_deferred_trim_keeps_latest_server_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        old_client = append_websocket_message(flow, from_client=True, content=b"client-old")
        old_server = append_websocket_message(flow, from_client=False, content=b"server-old")
        latest_server = append_websocket_message(
            flow,
            from_client=False,
            content=openai_websocket_usage_frame("resp_ws_latest"),
        )
        assert flow.websocket is not None
        messages = flow.websocket.messages

        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            usage.flush_usage_events(trigger="test")

        assert messages == [old_client, old_server, latest_server]
        assert model_provider_usage_sources(flow) == {}
        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 10),
                ("gpt-5.5", "tokens.output", 4),
            ],
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert len(deferred_websocket_trim_scheduler) == 1

        run_deferred_callbacks(deferred_websocket_trim_scheduler)

        assert flow.websocket.messages is messages
        assert flow.websocket.messages == [latest_server]

    def test_model_websocket_deferred_trim_coalesces_and_keeps_latest_at_callback(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        first_server = append_websocket_message(
            flow,
            from_client=False,
            content=openai_websocket_usage_frame(
                "resp_ws_first",
                input_tokens=1,
                output_tokens=1,
            ),
        )
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            assert len(deferred_websocket_trim_scheduler) == 1

            latest_server = append_websocket_message(
                flow,
                from_client=False,
                content=openai_websocket_usage_frame("resp_ws_latest"),
            )
            mitm_addon.websocket_message(flow)
            usage.flush_usage_events(trigger="test")

        assert len(deferred_websocket_trim_scheduler) == 1
        assert flow.websocket is not None
        assert flow.websocket.messages == [first_server, latest_server]

        run_deferred_callbacks(deferred_websocket_trim_scheduler)

        assert flow.websocket.messages == [latest_server]
        assert model_provider_usage_sources(flow) == {}
        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 1),
                ("gpt-5.5", "tokens.output", 1),
                ("gpt-5.5", "tokens.input", 10),
                ("gpt-5.5", "tokens.output", 4),
            ],
        )
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}

    def test_model_websocket_end_clears_final_retained_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        append_websocket_message(
            flow,
            from_client=False,
            content=openai_websocket_usage_frame("resp_ws_1"),
        )
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            assert len(deferred_websocket_trim_scheduler) == 1
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 10),
                ("gpt-5.5", "tokens.output", 4),
            ],
        )
        assert flow.websocket is not None
        assert flow.websocket.messages == []
        assert not model_websocket_usage.is_enabled(flow)

        run_deferred_callbacks(deferred_websocket_trim_scheduler)
        assert flow.websocket.messages == []

    def test_model_websocket_error_clears_final_retained_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        flow.error = Error("connection reset by peer")
        append_websocket_message(
            flow,
            from_client=False,
            content=openai_websocket_usage_frame("resp_ws_1"),
        )
        with self._usage_webhook_api() as webhook:
            mitm_addon.websocket_message(flow)
            assert len(deferred_websocket_trim_scheduler) == 1
            mitm_addon.error(flow)
            usage.flush_usage_events(trigger="test")

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 10),
                ("gpt-5.5", "tokens.output", 4),
            ],
        )
        assert flow.websocket is not None
        assert flow.websocket.messages == []
        assert not model_websocket_usage.is_enabled(flow)

        run_deferred_callbacks(deferred_websocket_trim_scheduler)
        assert flow.websocket.messages == []


class TestModelProviderWebSocketRetention:
    """Model retention tests without usage delivery."""

    def test_model_websocket_deferred_trim_keeps_latest_client_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        old_server = append_websocket_message(flow, from_client=False, content=b"server-old")
        latest_client = append_websocket_message(
            flow,
            from_client=True,
            content=openai_websocket_usage_frame("resp_ws_client"),
        )

        mitm_addon.websocket_message(flow)

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}
        assert len(deferred_websocket_trim_scheduler) == 1

        run_deferred_callbacks(deferred_websocket_trim_scheduler)

        assert flow.websocket is not None
        assert flow.websocket.messages == [latest_client]
        assert old_server not in flow.websocket.messages

    def test_model_websocket_deferred_trim_releases_large_completed_message(
        self,
        tmp_path,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(websocket_retention, "MAX_RETAINED_MESSAGE_BYTES", 4)
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        large_client = append_websocket_message(
            flow,
            from_client=True,
            content=b"large",
        )

        mitm_addon.websocket_message(flow)

        assert flow.websocket is not None
        assert flow.websocket.messages == [large_client]
        assert len(deferred_websocket_trim_scheduler) == 1

        run_deferred_callbacks(deferred_websocket_trim_scheduler)

        assert flow.websocket.messages == []


class TestRegisteredWebSocketRetention:
    @pytest.mark.parametrize("from_client", [True, False])
    def test_non_model_websocket_retention_is_bounded_during_sustained_traffic(
        self,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
        monkeypatch: pytest.MonkeyPatch,
        from_client: bool,
    ):
        flow = real_flow(with_response=False, host="example.com")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
        message_count = 32
        message_size = 4096
        total_bytes = 0
        retained_bytes = 0

        for index in range(message_count):
            content = f"message-{index}".encode().ljust(message_size, b"x")
            total_bytes += len(content)
            latest = append_websocket_message(
                flow,
                from_client=from_client,
                content=content,
            )
            assert flow.websocket is not None
            messages_before_trim = list(flow.websocket.messages)

            mitm_addon.websocket_message(flow)

            assert flow.websocket.messages == messages_before_trim
            assert len(deferred_websocket_trim_scheduler) == 1
            assert full_body_feeds == []

            run_deferred_callbacks(deferred_websocket_trim_scheduler)

            assert flow.websocket.messages == [latest]
            retained_bytes = sum(len(message.content) for message in flow.websocket.messages)
            assert retained_bytes == len(content)

        assert total_bytes == message_count * retained_bytes

    def test_unregistered_websocket_retention_is_unchanged(
        self,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = real_flow(with_response=False, host="example.com")
        first = append_websocket_message(flow, from_client=True, content=b"client")
        second = append_websocket_message(flow, from_client=False, content=b"server")

        mitm_addon.websocket_message(flow)

        assert deferred_websocket_trim_scheduler == []
        assert flow.websocket is not None
        assert flow.websocket.messages == [first, second]

    def test_unregistered_websocket_releases_only_large_messages(
        self,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(websocket_retention, "MAX_RETAINED_MESSAGE_BYTES", 4)
        flow = real_flow(with_response=False, host="example.com")
        first = append_websocket_message(flow, from_client=True, content=b"one")
        mitm_addon.websocket_message(flow)
        large = append_websocket_message(flow, from_client=False, content=b"large")
        mitm_addon.websocket_message(flow)
        latest = append_websocket_message(flow, from_client=True, content=b"two")
        mitm_addon.websocket_message(flow)

        assert len(deferred_websocket_trim_scheduler) == 1
        assert flow.websocket is not None
        assert flow.websocket.messages == [first, large, latest]

        run_deferred_callbacks(deferred_websocket_trim_scheduler)

        assert flow.websocket.messages == [first, latest]

    def test_non_model_websocket_end_clears_final_retained_message(
        self,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = real_flow(with_response=False, host="example.com")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        append_websocket_message(flow, from_client=False, content=b"server")

        mitm_addon.websocket_message(flow)
        assert len(deferred_websocket_trim_scheduler) == 1

        mitm_addon.websocket_end(flow)

        assert flow.websocket is not None
        assert flow.websocket.messages == []

        run_deferred_callbacks(deferred_websocket_trim_scheduler)
        assert flow.websocket.messages == []

    def test_non_model_websocket_error_clears_final_retained_message(
        self,
        real_flow,
        deferred_websocket_trim_scheduler: list[ScheduledCallback],
    ):
        flow = real_flow(with_response=False, host="example.com")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = ""
        flow.metadata[metadata_keys.ORIGINAL_URL] = "https://example.com/"
        flow.error = Error("connection reset by peer")
        append_websocket_message(flow, from_client=True, content=b"client")

        mitm_addon.websocket_message(flow)
        assert len(deferred_websocket_trim_scheduler) == 1

        mitm_addon.error(flow)

        assert flow.websocket is not None
        assert flow.websocket.messages == []

        run_deferred_callbacks(deferred_websocket_trim_scheduler)
        assert flow.websocket.messages == []
