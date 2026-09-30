"""Tests for model-provider WebSocket usage aggregation and tiering."""

import json
import uuid
from pathlib import Path

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import (
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
    model_usage_source_entries,
)
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_server_message,
    openai_websocket_usage_frame,
)
from tests.usage_helpers import assert_usage_event_rows


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


def _openai_websocket_zero_usage_frame(response_id: str, *, model: str | None = "gpt-5.5") -> bytes:
    response: dict = {
        "id": response_id,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }
    if model is not None:
        response["model"] = model
    return json.dumps(
        {
            "type": "response.completed",
            "response": response,
        }
    ).encode()


def _pressure_model_usage_tier_state(flow: http.HTTPFlow, *, response_count: int = 100) -> None:
    for index in range(response_count):
        feed_websocket_server_message(
            flow,
            _openai_websocket_zero_usage_frame(f"resp_ws_pressure_{index}"),
        )


class TestModelProviderWebSocketUsageAggregation:
    """Tests for per-response WebSocket usage reconciliation and tiering."""

    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def _run_websocket_messages_and_end(self, flow: http.HTTPFlow, *messages: bytes):
        with self._usage_webhook_api() as webhook:
            for message in messages:
                feed_websocket_server_message(flow, message)
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")
        return webhook

    def test_full_pipeline_model_websocket_reports_multiple_response_ids(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
            ),
            openai_websocket_usage_frame(
                "resp_ws_2",
                input_tokens=3,
                output_tokens=2,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
            ("gpt-5.5", "tokens.input", 3),
            ("gpt-5.5", "tokens.output", 2),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_late_same_id_frame_after_release_is_duplicate(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=20,
                output_tokens=12,
            ),
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=7,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        source_entries = model_usage_source_entries(flow)
        assert len(source_entries) == 2
        first_entry = next(
            entry for entry in source_entries if entry["usage"]["tokens.input"] == 20
        )
        repeated_entry = next(
            entry for entry in source_entries if entry["usage"]["tokens.input"] == 10
        )
        assert first_entry["source_id"] == repeated_entry["source_id"]
        assert first_entry["provider_response_id"] == "resp_ws_1"
        assert {event["source_idempotency_key"] for event in first_entry["usage_events"]} == {
            event["source_idempotency_key"] for event in repeated_entry["usage_events"]
        }
        assert all(event["buffer_accepted"] is True for event in first_entry["usage_events"])
        assert all(event["buffer_accepted"] is False for event in repeated_entry["usage_events"])

    def test_model_websocket_late_same_id_frame_can_add_new_category_after_release(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 20},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 12},
                    },
                }
            ).encode(),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_late_output_reuses_long_context_tier_for_duplicates(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_long_context",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 272_001},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_long_context",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 12},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_long_context",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 7},
                    },
                }
            ).encode(),
        )

        expected_billing_rows = [
            ("gpt-5.5", "tokens.input.long_context", 272_001),
            ("gpt-5.5", "tokens.output.long_context", 12),
        ]
        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            expected_billing_rows,
        )
        underbilling_entries = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("type") == "usage_underbilling"
        ]
        assert underbilling_entries == []

    def test_model_websocket_late_output_recovers_evicted_long_context_fast_tier(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_evicted",
                            "model": "gpt-5.5",
                            "service_tier": "priority",
                            "usage": {"input_tokens": 272_001},
                        },
                    }
                ).encode(),
            )
            _pressure_model_usage_tier_state(flow)

            tiers = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_TIERS]
            assert isinstance(tiers, dict)
            assert len(tiers) == 100
            assert "resp_ws_evicted" not in tiers

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.done",
                        "response": {
                            "id": "resp_ws_evicted",
                            "model": "gpt-5.5",
                            "usage": {"output_tokens": 12},
                        },
                    }
                ).encode(),
            )

            recovered = tiers["resp_ws_evicted"]
            assert len(tiers) == 100
            assert recovered.tier == "long_context"
            assert recovered.service_tier == "fast"
            assert recovered.committed is True

            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert metadata_keys.MODEL_PROVIDER_USAGE_TIERS not in flow.metadata
        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input.long_context.fast", 272_001),
                ("gpt-5.5", "tokens.output.long_context.fast", 12),
            ],
        )
        underbilling_entries = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("type") == "usage_underbilling"
        ]
        assert underbilling_entries == []

    def test_model_websocket_duplicate_output_recovers_evicted_source_category(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_evicted_duplicate",
                    input_tokens=20,
                    output_tokens=12,
                ),
            )
            _pressure_model_usage_tier_state(flow)

            tiers = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_TIERS]
            assert "resp_ws_evicted_duplicate" not in tiers

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.done",
                        "response": {
                            "id": "resp_ws_evicted_duplicate",
                            "model": "gpt-5.5",
                            "usage": {"output_tokens": 7},
                        },
                    }
                ).encode(),
            )

            recovered = tiers["resp_ws_evicted_duplicate"]
            assert recovered.tier == "base"
            assert recovered.service_tier == "standard"
            assert recovered.committed is True

            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 20),
                ("gpt-5.5", "tokens.output", 12),
            ],
        )
        duplicate_entry = next(
            entry
            for entry in model_usage_source_entries(flow)
            if entry["usage"] == {"tokens.output": 7}
        )
        [duplicate_event] = duplicate_entry["usage_events"]
        assert duplicate_event["category"] == "tokens.output"
        assert duplicate_event["buffer_accepted"] is False

    @pytest.mark.parametrize("intervening_responses", [99, 100])
    @pytest.mark.parametrize(
        "initial_output_tokens", [0, 12], ids=["late-output", "duplicate-output"]
    )
    @pytest.mark.parametrize(
        (
            "input_tokens",
            "service_tier",
            "replay_input_tokens",
            "replay_service_tier",
            "category_suffix",
        ),
        [
            pytest.param(20, "priority", 20, None, ".fast", id="fast-omitted-tier"),
            pytest.param(20, "ultrafast", 20, None, ".ultrafast", id="ultrafast-omitted-tier"),
            pytest.param(
                272_001,
                "priority",
                272_001,
                None,
                ".long_context.fast",
                id="long-context-fast-omitted-tier",
            ),
            pytest.param(20, "priority", 272_001, "default", ".fast", id="fast-changed-pricing"),
            pytest.param(
                272_001,
                "priority",
                20,
                "default",
                ".long_context.fast",
                id="long-context-fast-changed-pricing",
            ),
            pytest.param(20, "default", 272_001, "priority", "", id="base-changed-pricing"),
            pytest.param(
                272_001,
                "default",
                20,
                "priority",
                ".long_context",
                id="long-context-changed-pricing",
            ),
        ],
    )
    def test_model_websocket_input_replay_preserves_committed_pricing_at_eviction_boundary(
        self,
        tmp_path,
        real_flow,
        intervening_responses,
        initial_output_tokens,
        input_tokens,
        service_tier,
        replay_input_tokens,
        replay_service_tier,
        category_suffix,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        replay_response = {
            "id": "resp_ws_input_replay",
            "model": "gpt-5.5",
            "usage": {"input_tokens": replay_input_tokens, "output_tokens": 12},
        }
        if replay_service_tier is not None:
            replay_response["service_tier"] = replay_service_tier

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_input_replay",
                            "model": "gpt-5.5",
                            "service_tier": service_tier,
                            "usage": {
                                "input_tokens": input_tokens,
                                "output_tokens": initial_output_tokens,
                            },
                        },
                    }
                ).encode(),
            )
            usage.flush_usage_events(trigger="test")
            _pressure_model_usage_tier_state(flow, response_count=intervening_responses)
            feed_websocket_server_message(
                flow,
                json.dumps({"type": "response.done", "response": replay_response}).encode(),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", f"tokens.input{category_suffix}", input_tokens),
                ("gpt-5.5", f"tokens.output{category_suffix}", 12),
            ],
        )

    def test_model_websocket_zero_replay_keeps_recovered_pricing_committed(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_ws_zero_replay",
                            "model": "gpt-5.5",
                            "service_tier": "priority",
                            "usage": {"input_tokens": 272_001},
                        },
                    }
                ).encode(),
            )
            usage.flush_usage_events(trigger="test")
            _pressure_model_usage_tier_state(flow)
            feed_websocket_server_message(
                flow,
                _openai_websocket_zero_usage_frame("resp_ws_zero_replay"),
            )
            feed_websocket_server_message(
                flow,
                openai_websocket_usage_frame(
                    "resp_ws_zero_replay",
                    input_tokens=20,
                    output_tokens=12,
                ),
            )
            mitm_addon.websocket_end(flow)
            usage.flush_usage_events(trigger="test")

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input.long_context.fast", 272_001),
                ("gpt-5.5", "tokens.output.long_context.fast", 12),
            ],
        )

    def test_model_websocket_explicit_zero_input_selects_base_tier_for_late_output(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_zero_input",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 0},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_zero_input",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 12},
                    },
                }
            ).encode(),
        )

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [("gpt-5.5", "tokens.output", 12)],
        )

    def test_model_websocket_late_priority_output_commits_fast_tier(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_late_priority",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 0},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_late_priority",
                        "model": "gpt-5.5",
                        "service_tier": "priority",
                        "usage": {"output_tokens": 12},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_late_priority",
                        "model": "gpt-5.5",
                        "service_tier": "default",
                        "usage": {"output_tokens": 7},
                    },
                }
            ).encode(),
        )

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [("gpt-5.5", "tokens.output.fast", 12)],
        )
        output_entries = [
            entry
            for entry in model_usage_source_entries(flow)
            if entry["usage"].get("tokens.output") in (12, 7)
        ]
        assert len(output_entries) == 2
        for entry in output_entries:
            [event] = entry["usage_events"]
            assert event["category"] == "tokens.output.fast"
            assert event["buffer_accepted"] is (entry["usage"]["tokens.output"] == 12)

    def test_model_websocket_output_without_input_uses_conservative_billing_fallback(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_missing_input",
                        "model": "gpt-5.5",
                        "usage": {"output_tokens": 12},
                    },
                }
            ).encode(),
        )

        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [("gpt-5.5", "tokens.output.long_context", 12)],
        )
        [entry] = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("type") == "usage_underbilling"
        ]
        assert entry["reason"] == "model_long_context_tier_unresolved"
        assert entry["underbilling_class"] == "risk"
        assert entry["run_id"] == "run-abc-123"
        assert entry["provider"] == "gpt-5.5"
        assert entry["usage_billed"] is True
        assert entry["fallback_billing_tier"] == "long_context"
        assert entry["fallback_fast"] is False

    def test_model_websocket_tier_state_is_bounded_and_terminally_released(
        self,
        tmp_path,
        real_flow,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        for index in range(101):
            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": f"resp_ws_tier_{index}",
                            "model": "gpt-5.5",
                            "usage": {"input_tokens": 0},
                        },
                    }
                ).encode(),
            )

        tiers = flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_TIERS]
        assert isinstance(tiers, dict)
        assert len(tiers) == 100
        assert "resp_ws_tier_0" not in tiers
        assert tiers["resp_ws_tier_100"].tier == "base"
        assert tiers["resp_ws_tier_100"].service_tier == "standard"
        assert tiers["resp_ws_tier_100"].committed is False

        mitm_addon.websocket_end(flow)

        assert metadata_keys.MODEL_PROVIDER_USAGE_TIERS not in flow.metadata

    @pytest.mark.parametrize(
        (
            "input_tokens",
            "cached_tokens",
            "cache_write_tokens",
            "service_tier",
            "category_suffix",
        ),
        [
            pytest.param(100, 20, 30, None, "", id="base"),
            pytest.param(
                300_000,
                20_000,
                30_000,
                None,
                ".long_context",
                id="long-context",
            ),
            pytest.param(100, 20, 30, "priority", ".fast", id="fast"),
            pytest.param(
                300_000,
                20_000,
                30_000,
                "priority",
                ".long_context.fast",
                id="long-context-fast",
            ),
        ],
    )
    def test_model_websocket_late_same_id_snapshot_does_not_mix_input_partition(
        self,
        tmp_path,
        real_flow,
        input_tokens,
        cached_tokens,
        cache_write_tokens,
        service_tier,
        category_suffix,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.6-sol"
        mitm_addon.responseheaders(flow)
        first_response = {
            "id": "resp_ws_partition",
            "model": "gpt-5.6-sol",
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": 0,
                "input_tokens_details": {"cached_tokens": cached_tokens},
            },
        }
        if service_tier is not None:
            first_response["service_tier"] = service_tier

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": first_response,
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_partition",
                        "model": "gpt-5.6-sol",
                        "usage": {
                            "input_tokens": input_tokens,
                            "output_tokens": 40,
                            "input_tokens_details": {
                                "cached_tokens": cached_tokens,
                                "cache_write_tokens": cache_write_tokens,
                            },
                        },
                    },
                }
            ).encode(),
        )

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category) == 3
        assert len({event["idempotencyKey"] for event in events}) == 3
        assert by_category == {
            f"tokens.input{category_suffix}": input_tokens - cached_tokens,
            f"tokens.output{category_suffix}": 40,
            f"tokens.cache_read{category_suffix}": cached_tokens,
        }
        for event in events:
            uuid.UUID(event["idempotencyKey"])
        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {}
        assert model_provider_usage_sources(flow) == {}

    def test_model_websocket_zero_frame_does_not_commit_base_tier(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 0, "output_tokens": 0},
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_1",
                        "usage": {"input_tokens": 272_001, "output_tokens": 12},
                    },
                }
            ).encode(),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input.long_context", 272_001),
            ("gpt-5.5", "tokens.output.long_context", 12),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_zero_frame_without_model_releases_source(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                _openai_websocket_zero_usage_frame("resp_ws_zero_no_model", model=None),
            )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        assert model_provider_usage_sources(flow) == {}

    def test_model_websocket_zero_frame_with_flow_model_releases_source(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-flow-model"
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            feed_websocket_server_message(
                flow,
                _openai_websocket_zero_usage_frame(
                    "resp_ws_zero_flow_model", model="gpt-frame-model"
                ),
            )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        assert model_provider_usage_sources(flow) == {}

    def test_model_websocket_zero_frames_are_bounded(self, tmp_path, real_flow):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            for index in range(70):
                feed_websocket_server_message(
                    flow,
                    _openai_websocket_zero_usage_frame(
                        f"resp_ws_zero_{index}", model=f"gpt-zero-{index}"
                    ),
                )
            usage.flush_usage_events(trigger="test")

        assert webhook.request_count == 0
        usage_sources = model_provider_usage_sources(flow)
        assert usage_sources == {}

    def test_model_websocket_flow_model_reports_later_positive_usage_without_zero_hint(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        with self._usage_webhook_api() as webhook:
            for index in range(70):
                feed_websocket_server_message(
                    flow,
                    _openai_websocket_zero_usage_frame(
                        f"resp_ws_zero_{index}", model=f"gpt-zero-{index}"
                    ),
                )

            assert "resp_ws_zero_0" not in model_provider_usage_sources(flow)

            feed_websocket_server_message(
                flow,
                json.dumps(
                    {
                        "type": "response.done",
                        "response": {
                            "id": "resp_ws_zero_0",
                            "usage": {"input_tokens": 20, "output_tokens": 12},
                        },
                    }
                ).encode(),
            )
            usage.flush_usage_events(trigger="test")

        usage_sources = model_provider_usage_sources(flow)
        assert "resp_ws_zero_0" not in usage_sources
        assert usage_sources == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_model_websocket_same_id_zero_after_positive_does_not_double_bill(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=20,
                output_tokens=12,
            ),
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=0,
                output_tokens=0,
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 20),
            ("gpt-5.5", "tokens.output", 12),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_full_pipeline_model_websocket_uses_context_model_for_response_ids(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
                model="gpt-5.5",
            ),
            openai_websocket_usage_frame(
                "resp_ws_2",
                input_tokens=3,
                output_tokens=2,
                model="gpt-5.6-luna",
            ),
        )

        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
            ("gpt-5.5", "tokens.input", 3),
            ("gpt-5.5", "tokens.output", 2),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)

    def test_full_pipeline_model_websocket_reports_id_and_missing_id_usage(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "model": "gpt-5.5",
                        "usage": {"input_tokens": 7, "output_tokens": 1},
                    },
                }
            ).encode(),
            openai_websocket_usage_frame(
                "resp_ws_1",
                input_tokens=10,
                output_tokens=4,
                model="gpt-5.5",
            ),
        )

        assert flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] == {
            "model": "gpt-5.5",
            "tokens.input": 7,
            "tokens.output": 1,
        }
        assert model_provider_usage_sources(flow) == {}
        expected_rows = [
            ("gpt-5.5", "tokens.input", 7),
            ("gpt-5.5", "tokens.output", 1),
            ("gpt-5.5", "tokens.input", 10),
            ("gpt-5.5", "tokens.output", 4),
        ]
        assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
        source_entries = model_usage_source_entries(flow)
        assert len(source_entries) == 2
        [source_preserving_entry] = [
            entry for entry in source_entries if entry["buffer_mode"] == "source"
        ]
        [aggregate_entry] = [
            entry for entry in source_entries if entry["buffer_mode"] == "aggregate"
        ]
        assert source_preserving_entry["provider_response_id"] == "resp_ws_1"
        assert aggregate_entry["provider_response_id"] is None
        assert aggregate_entry["source_id"] == flow.id
        assert aggregate_entry["transport"] == "websocket"
        webhook_usage_keys = {event["idempotencyKey"] for event in webhook.usage_events()}
        assert {
            event["source_idempotency_key"] for event in source_preserving_entry["usage_events"]
        }.issubset(webhook_usage_keys)
        assert {
            event["source_idempotency_key"] for event in aggregate_entry["usage_events"]
        }.isdisjoint(webhook_usage_keys)
        assert all(
            event["buffer_accepted"] is True
            for entry in source_entries
            for event in entry["usage_events"]
        )

    @pytest.mark.parametrize(
        "later_cache_write_tokens",
        [0, None],
        ids=["zero", "omitted"],
    )
    def test_model_websocket_missing_id_raw_snapshots_preserve_input_partition(
        self,
        tmp_path,
        real_flow,
        later_cache_write_tokens,
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)
        later_input_details = {"cached_tokens": 20}
        if later_cache_write_tokens is not None:
            later_input_details["cache_write_tokens"] = later_cache_write_tokens

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 0,
                            "input_tokens_details": {
                                "cached_tokens": 20,
                                "cache_write_tokens": 30,
                            },
                        },
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                            "input_tokens_details": later_input_details,
                        },
                    },
                }
            ).encode(),
        )

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category) == 4
        assert by_category == {
            "tokens.input": 50,
            "tokens.output": 40,
            "tokens.cache_read": 20,
            "tokens.cache_creation": 30,
        }
        assert (
            by_category["tokens.input"]
            + by_category["tokens.cache_read"]
            + by_category["tokens.cache_creation"]
            == 100
        )
        assert model_provider_usage_sources(flow) == {}

    def test_full_pipeline_model_websocket_zero_frame_preserves_billed_usage_and_id(
        self, tmp_path, real_flow
    ):
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(flow)

        webhook = self._run_websocket_messages_and_end(
            flow,
            json.dumps(
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_ws_1",
                        "model": "gpt-5.5",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 40,
                        },
                    },
                }
            ).encode(),
            json.dumps(
                {
                    "type": "response.done",
                    "response": {
                        "id": "resp_ws_empty",
                        "model": "gpt-5.6-luna",
                        "usage": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                            "input_tokens_details": {"cached_tokens": 0},
                        },
                    },
                }
            ).encode(),
        )

        assert model_provider_usage_sources(flow) == {}
        assert_usage_event_rows(
            webhook.usage_events(),
            "provider",
            [
                ("gpt-5.5", "tokens.input", 100),
                ("gpt-5.5", "tokens.output", 40),
            ],
        )
