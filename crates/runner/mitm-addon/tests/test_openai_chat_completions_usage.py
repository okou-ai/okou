"""Integration coverage for OpenAI-compatible Chat Completions usage."""

import json
from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

import brotli
import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
import usage
import usage.openai_chat_completions as openai_chat_completions
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import make_model_provider_flow
from usage.model_http import ModelHttpFailureEvidence
from usage.quantities import MAX_USAGE_QUANTITY


def _chat_completions_flow(
    tmp_path: Path,
    real_flow: Callable[..., http.HTTPFlow],
    *,
    content_type: str,
    billable: bool = True,
    cli_agent_type: str = "codex",
    original_url: str = "https://api.openai.com/v1/chat/completions",
) -> http.HTTPFlow:
    flow = make_model_provider_flow(
        real_flow,
        tmp_path,
        host="api.openai.com",
        path="/v1/chat/completions",
        method="POST",
        original_url=original_url,
        firewall_name="model-provider:openai-api-key",
        firewall_billable=billable,
        cli_agent_type=cli_agent_type,
        model_usage_provider="gpt-5.5",
    )
    flow.response = tutils.tresp(
        status_code=200,
        headers=header_map({"content-type": content_type}),
    )
    return flow


def _chat_payload(*, usage_payload: dict[str, object] | None = None) -> bytes:
    payload: dict[str, object] = {
        "id": "chatcmpl_1",
        "model": "gpt-5.5",
        "choices": [{"index": 0, "finish_reason": "stop"}],
    }
    if usage_payload is not None:
        payload["usage"] = usage_payload
    return json.dumps(payload, separators=(",", ":")).encode()


def _run_response(flow: http.HTTPFlow, usage_webhook_api):
    with usage_webhook_api() as webhook:
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")
    return webhook


class _RecordingFailureObserver:
    def __init__(self) -> None:
        self.observed: list[ModelHttpFailureEvidence] = []

    def needs_sse_event(self, event_name: str | None) -> bool:
        return True

    def observe(self, evidence: ModelHttpFailureEvidence) -> None:
        self.observed.append(evidence)

    def observe_json(self, evidence: ModelHttpFailureEvidence) -> None:
        raise AssertionError("unexpected JSON evidence")

    def finish(self) -> None:
        return None


def _track_chat_extractor_finishes() -> tuple[list[object], Callable[..., object]]:
    calls: list[object] = []
    original_finish = openai_chat_completions.JsonSelectiveExtractor.finish

    def finish(extractor):
        calls.append(extractor)
        return original_finish(extractor)

    return calls, finish


def _canonical_delta_with_size(size: int) -> bytes:
    prefix = (
        b'{"id":"chatcmpl_bound","object":"chat.completion.chunk",'
        b'"choices":[{"index":0,"delta":{"content":"'
    )
    suffix = b'"}}]}'
    assert size >= len(prefix) + len(suffix)
    return prefix + b"x" * (size - len(prefix) - len(suffix)) + suffix


def test_canonical_sse_deltas_skip_selective_extraction_across_framing_variants():
    observer = _RecordingFailureObserver()
    finish_calls, tracked_finish = _track_chat_extractor_finishes()
    stream = (
        b'data: {"id":"chatcmpl_text","object":"chat.completion.chunk",'
        b'"created":1,"model":"gpt-5.5","service_tier":null,'
        b'"choices":[{"index":0,"delta":{"content":"hello"},'
        b'"logprobs":null,"finish_reason":null}]}\n\n'
        b"event: chunk\n"
        b'data: {"object":"chat.completion.chunk",'
        b'"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        b'data: {"object":"chat.completion.chunk","choices":\n'
        b'data: [{"index":0,"delta":{"tool_calls":[]}},'
        b'{"index":1,"delta":{}}]}\n\n'
    )

    with patch.object(
        openai_chat_completions.JsonSelectiveExtractor,
        "finish",
        tracked_finish,
    ):
        scanner, parsed_usage = (
            openai_chat_completions.create_openai_chat_completions_sse_usage_extractor(
                failure_observer=observer
            )
        )
        chunk_sizes = (1, 2, 5, 13, 3, 8)
        offset = 0
        chunk_index = 0
        while offset < len(stream):
            chunk_size = chunk_sizes[chunk_index % len(chunk_sizes)]
            scanner(stream[offset : offset + chunk_size])
            offset += chunk_size
            chunk_index += 1
        scanner.finish()

    assert finish_calls == []
    assert parsed_usage == {}
    assert observer.observed == [
        ModelHttpFailureEvidence(has_choices=True, is_valid=True),
        ModelHttpFailureEvidence(event_name="chunk", has_choices=True, is_valid=True),
        ModelHttpFailureEvidence(has_choices=True, is_valid=True),
    ]


@pytest.mark.parametrize("include_usage", [True, False], ids=("usage", "observer-only"))
def test_discarded_failure_event_emits_invalid_evidence_and_recovers(include_usage):
    observer = _RecordingFailureObserver()
    parse_errors: list[tuple[str, str]] = []
    scanner, parsed_usage = (
        openai_chat_completions.create_openai_chat_completions_sse_usage_extractor(
            on_parse_error=lambda event, error: parse_errors.append((event, error)),
            include_usage=include_usage,
            failure_observer=observer,
        )
    )

    scanner(
        b"event: chunk\n"
        b'data: {"object":"chat.completion.chunk","padding":"'
        + b"x" * openai_chat_completions._CHAT_COMPLETIONS_SSE_FAST_PATH_MAX_BYTES
        + b"\n"
        + b"x" * 4097
        + b"\n\n"
        b"event: chunk\n"
        b'data: {"object":"chat.completion.chunk","choices":[{'
        b'"error":{"metadata":{"error_type":"provider_overloaded"}}}]}\n\n'
    )

    assert parsed_usage == {}
    assert parse_errors == ([("chunk", "sse event discarded")] if include_usage else [])
    assert observer.observed == [
        ModelHttpFailureEvidence(event_name="chunk"),
        ModelHttpFailureEvidence(
            event_name="chunk",
            failure_codes=("provider_overloaded",),
            has_error=True,
            has_choices=True,
            is_valid=True,
        ),
    ]


def test_sse_fast_path_bound_is_inclusive_and_overflow_replays_once():
    finish_calls, tracked_finish = _track_chat_extractor_finishes()
    exact = _canonical_delta_with_size(
        openai_chat_completions._CHAT_COMPLETIONS_SSE_FAST_PATH_MAX_BYTES
    )
    over = exact[:-1] + b',"usage":{"prompt_tokens":9,"completion_tokens":2}}'

    with patch.object(
        openai_chat_completions.JsonSelectiveExtractor,
        "finish",
        tracked_finish,
    ):
        scanner, parsed_usage = (
            openai_chat_completions.create_openai_chat_completions_sse_usage_extractor()
        )
        scanner(b"data: " + exact + b"\n\ndata: " + over + b"\n\n")
        scanner.finish()

    assert len(finish_calls) == 1
    assert parsed_usage == {
        "tokens.input": 9,
        "tokens.output": 2,
        "message_id": "chatcmpl_bound",
    }


@pytest.mark.parametrize(
    ("payload", "expected_error"),
    [
        (
            b'{"object":"chat.completion.chunk","provider":"compatible",'
            b'"choices":[{"index":0,"delta":{}}]}',
            None,
        ),
        (
            b'{"object":"chat.completion.chunk","object":"chat.completion.chunk",'
            b'"choices":[{"index":0,"delta":{}}]}',
            None,
        ),
        (
            b'{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"value":NaN}}]}',
            "expected json value",
        ),
        (
            b'{"object":"chat.completion.chunk",'
            + rb'"choices":[{"index":0,"delta":{"content":"\ud800"}}]}',
            None,
        ),
        (
            b'{"object":"chat.completion.chunk",'
            b'"choices":[{"index":0,"delta":{"value":' + b"9" * 129 + b"}}]}",
            "number limit exceeded",
        ),
        (
            b'{"object":"chat.completion.chunk",'
            b'"choices":[{"index":0,"delta":{"value":' + b"[" * 260 + b"0" + b"]" * 260 + b"}}]}",
            "max depth exceeded",
        ),
        (
            b'{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{}}]}x',
            "trailing data after root value",
        ),
        (
            b'{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{}}]',
            "incomplete json",
        ),
    ],
    ids=(
        "unknown-envelope-key",
        "duplicate-key",
        "non-standard-constant",
        "lone-surrogate",
        "oversized-number",
        "excessive-depth",
        "trailing-data",
        "malformed",
    ),
)
def test_ambiguous_sse_delta_falls_back_once(payload: bytes, expected_error: str | None):
    errors: list[tuple[str, str]] = []
    finish_calls, tracked_finish = _track_chat_extractor_finishes()

    with patch.object(
        openai_chat_completions.JsonSelectiveExtractor,
        "finish",
        tracked_finish,
    ):
        scanner, parsed_usage = (
            openai_chat_completions.create_openai_chat_completions_sse_usage_extractor(
                lambda event, error: errors.append((event, error))
            )
        )
        scanner(b"data: " + payload + b"\n\n")
        scanner.finish()

    assert len(finish_calls) == 1
    assert parsed_usage == {}
    assert errors == ([] if expected_error is None else [("eventless", expected_error)])


def test_escaped_usage_candidate_falls_back_and_reports_usage():
    payload = (
        b'{"id":"chatcmpl_escaped","object":"chat.completion.chunk","model":"gpt-5.5",'
        b'"choices":[{"index":0,"delta":{}}],'
        + rb'"\u0075sage":{"prompt_tokens":9,"completion_tokens":2}}'
    )
    finish_calls, tracked_finish = _track_chat_extractor_finishes()

    with patch.object(
        openai_chat_completions.JsonSelectiveExtractor,
        "finish",
        tracked_finish,
    ):
        scanner, parsed_usage = (
            openai_chat_completions.create_openai_chat_completions_sse_usage_extractor()
        )
        scanner(b"data: " + payload + b"\n\n")
        scanner.finish()

    assert len(finish_calls) == 1
    assert parsed_usage == {
        "tokens.input": 9,
        "tokens.output": 2,
        "model": "gpt-5.5",
        "message_id": "chatcmpl_escaped",
    }


@pytest.mark.parametrize(
    ("usage_members", "expected_usage"),
    [
        (
            b'"usage":{"prompt_tokens":9,"completion_tokens":2},"usage":null',
            {},
        ),
        (
            rb'"\u0075sage":null,"usage":{"prompt_tokens":9,"completion_tokens":2}',
            {
                "tokens.input": 9,
                "tokens.output": 2,
                "model": "gpt-5.5",
                "message_id": "chatcmpl_duplicate",
            },
        ),
    ],
    ids=("last-null-clears", "escaped-first-last-usage-wins"),
)
def test_duplicate_usage_candidates_keep_authoritative_last_member_semantics(
    usage_members: bytes,
    expected_usage: dict[str, object],
):
    payload = (
        b'{"id":"chatcmpl_duplicate","object":"chat.completion.chunk",'
        b'"model":"gpt-5.5","choices":[{"index":0,"delta":{}}],' + usage_members + b"}"
    )
    finish_calls, tracked_finish = _track_chat_extractor_finishes()

    with patch.object(
        openai_chat_completions.JsonSelectiveExtractor,
        "finish",
        tracked_finish,
    ):
        scanner, parsed_usage = (
            openai_chat_completions.create_openai_chat_completions_sse_usage_extractor()
        )
        scanner(b"data: " + payload + b"\n\n")
        scanner.finish()

    assert len(finish_calls) == 1
    assert parsed_usage == expected_usage


def test_fast_path_preserves_error_and_done_failure_evidence():
    observer = _RecordingFailureObserver()
    finish_calls, tracked_finish = _track_chat_extractor_finishes()
    canonical_delta = (
        b'{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"}}]}'
    )
    top_level_error = b'{"error":{"metadata":{"error_type":"provider_unavailable"}}}'
    escaped_error = (
        b'{"choices":[{'
        + rb'"\u0065rror":{"metadata":{"error_type":"provider_overloaded"}}'
        + b"}]}"
    )

    with patch.object(
        openai_chat_completions.JsonSelectiveExtractor,
        "finish",
        tracked_finish,
    ):
        scanner, parsed_usage = (
            openai_chat_completions.create_openai_chat_completions_sse_usage_extractor(
                include_usage=False,
                failure_observer=observer,
            )
        )
        scanner(
            b"data: "
            + canonical_delta
            + b"\n\ndata: "
            + top_level_error
            + b"\n\ndata: "
            + escaped_error
            + b"\n\ndata: [DONE]\n\n"
        )
        scanner.finish()

    assert len(finish_calls) == 2
    assert parsed_usage == {}
    assert observer.observed == [
        ModelHttpFailureEvidence(has_choices=True, is_valid=True),
        ModelHttpFailureEvidence(
            failure_codes=("provider_unavailable",),
            has_error=True,
            is_valid=True,
        ),
        ModelHttpFailureEvidence(
            failure_codes=("provider_overloaded",),
            has_error=True,
            has_choices=True,
            is_valid=True,
        ),
        ModelHttpFailureEvidence(is_done=True, is_valid=True),
    ]


class TestOpenAIChatCompletionsUsage:
    @pytest.fixture(autouse=True)
    def _sync_usage_delivery(self, sync_usage_executor, usage_webhook_api):
        self._usage_webhook_api = usage_webhook_api

    def test_managed_sse_uses_top_level_usage_and_partitions_cache(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
            cli_agent_type="claude-code",
            original_url="https://api.openai.com/v1/chat/completions/?trace=1",
        )
        payload = {
            "id": "chatcmpl_1",
            "model": "gpt-5.5",
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 999,
                        "completion_tokens": 999,
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 20,
                "prompt_cache_hit_tokens": 40,
                "prompt_tokens_details": {
                    "cached_tokens": 10,
                    "cache_write_tokens": 15,
                },
            },
        }
        encoded = json.dumps(payload, separators=(",", ":")).encode()

        mitm_addon.responseheaders(flow)
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        callback = response_stream(flow)
        callback(b"data: " + encoded[:37])
        callback(encoded[37:] + b"\n\ndata: [DONE]\n\n")

        webhook = _run_response(flow, self._usage_webhook_api)

        events = webhook.usage_events()
        by_category = {event["category"]: event["quantity"] for event in events}
        assert len(events) == len(by_category)
        assert by_category == {
            "tokens.input": 25,
            "tokens.output": 20,
            "tokens.cache_read": 10,
            "tokens.cache_creation": 15,
        }

    def test_sse_uses_first_choice_and_legacy_cache_fallback(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        payload = {
            "id": "chatcmpl_2",
            "model": "gpt-5.5",
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 70,
                        "completion_tokens": 9,
                        "prompt_cache_hit_tokens": 20,
                    }
                },
                {
                    "usage": {
                        "prompt_tokens": 900,
                        "completion_tokens": 900,
                    }
                },
            ],
        }

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"data: "
            + json.dumps(payload, separators=(",", ":")).encode()
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 50,
            "tokens.output": 9,
            "tokens.cache_read": 20,
        }

    @pytest.mark.parametrize(
        "top_level_usage",
        [
            {},
            None,
            0,
            {"prompt_tokens": 0, "completion_tokens": 0},
        ],
        ids=("empty", "null", "non-object", "zero"),
    )
    def test_present_top_level_usage_blocks_positive_choice_fallback(
        self,
        tmp_path,
        real_flow,
        top_level_usage,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        payload = {
            "id": "chatcmpl_3",
            "model": "gpt-5.5",
            "usage": top_level_usage,
            "choices": [
                {
                    "usage": {
                        "prompt_tokens": 100,
                        "completion_tokens": 50,
                    }
                }
            ],
        }

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"data: "
            + json.dumps(payload, separators=(",", ":")).encode()
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    def test_sse_without_usage_stays_quiet(self, tmp_path, real_flow):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b"data: " + _chat_payload() + b"\n\ndata: [DONE]\n\n")

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0

    def test_long_sse_reports_final_usage_after_discarded_and_malformed_events(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        delta = (
            b'data: {"id":"chatcmpl_delta","object":"chat.completion.chunk",'
            b'"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'
        )

        finish_calls, tracked_finish = _track_chat_extractor_finishes()
        with patch.object(
            openai_chat_completions.JsonSelectiveExtractor,
            "finish",
            tracked_finish,
        ):
            mitm_addon.responseheaders(flow)
            callback = response_stream(flow)
            callback(
                b"data: "
                + _chat_payload(usage_payload={"prompt_tokens": 90, "completion_tokens": 40})
                + b"\n\n"
                + delta * 2_560
                + b'data: {"id":"chatcmpl_discarded"\n'
                + b"x" * 4_097
                + b"\n\n"
                + b'data: {"id":"chatcmpl_bad","usage":{"prompt_tokens":30}\n\n'
            )
            final_payload = {
                "id": "chatcmpl_final",
                "model": "gpt-5.5",
                "choices": [
                    {
                        "usage": {
                            "prompt_tokens": 30,
                            "completion_tokens": 5,
                        }
                    }
                ],
            }
            callback(
                b"data: "
                + json.dumps(final_payload, separators=(",", ":")).encode()
                + b"\n\ndata: [DONE]\n\n"
            )

            webhook = _run_response(flow, self._usage_webhook_api)

        assert len(finish_calls) == 3
        expected_quantities = {
            "tokens.input": 30,
            "tokens.output": 5,
        }
        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == (
            expected_quantities
        )
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert [warning["error"] for warning in warnings] == [
            "sse event discarded",
            "incomplete json",
        ]

    def test_repeated_sse_parse_errors_bound_diagnostics_and_recover(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        malformed_events: list[bytes] = []
        for index in range(6):
            malformed_events.extend(
                (
                    f"event: malformed-{index}\ndata: x\n\n".encode(),
                    f"event: discarded-{index}\n".encode()
                    + b'data: {"id":"chatcmpl_discarded"\n'
                    + b"x" * 4_097
                    + b"\n\n",
                )
            )
        recovered_usage = (
            b"data: "
            + _chat_payload(usage_payload={"prompt_tokens": 7, "completion_tokens": 2})
            + b"\n\ndata: [DONE]\n\n"
        )

        with (
            patch.object(
                response_streaming,
                "log_proxy_entry",
                wraps=response_streaming.log_proxy_entry,
            ) as serialize_diagnostic,
            patch.object(
                response_streaming.run_usage,
                "mark",
                wraps=response_streaming.run_usage.mark,
            ) as mark_run_usage,
        ):
            mitm_addon.responseheaders(flow)
            callback = response_stream(flow)
            for event in malformed_events:
                assert callback(event) == event
            assert callback(recovered_usage) == recovered_usage

            webhook = _run_response(flow, self._usage_webhook_api)

        assert serialize_diagnostic.call_count == 4
        mark_run_usage.assert_called_once_with(flow, "parse_error")
        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 7,
            "tokens.output": 2,
        }
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert [warning["event"] for warning in warnings] == [
            "malformed-0",
            "discarded-0",
            "malformed-1",
            "discarded-1",
        ]
        assert [warning["error"] for warning in warnings[1::2]] == [
            "sse event discarded",
            "sse event discarded",
        ]
        assert len({warning["error"] for warning in warnings}) == 2

    def test_malformed_sse_fails_closed_with_chat_protocol_diagnostic(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(b'data: {"id":"chatcmpl_bad","usage":{"prompt_tokens":30}\n\n')

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "incomplete json"

    @pytest.mark.parametrize(
        "input_tokens",
        [MAX_USAGE_QUANTITY + 1, int("9" * 64)],
        ids=("above-safe-integer", "maximum-width-integer"),
    )
    def test_out_of_range_sse_quantity_fails_closed_with_bounded_diagnostic(
        self,
        tmp_path,
        real_flow,
        input_tokens,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        response_stream(flow)(
            b"data: "
            + _chat_payload(
                usage_payload={
                    "prompt_tokens": input_tokens,
                    "completion_tokens": 5,
                }
            )
            + b"\n\ndata: [DONE]\n\n"
        )

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "integer value limit exceeded"

    def test_malformed_sse_clears_prior_usage_before_terminal_reporting(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        callback(
            b"data: "
            + _chat_payload(usage_payload={"prompt_tokens": 30, "completion_tokens": 5})
            + b"\n\n"
        )
        callback(b'data: {"id":"chatcmpl_bad","usage":{"prompt_tokens":30}\n\n')

        webhook = _run_response(flow, self._usage_webhook_api)

        assert webhook.request_count == 0
        assert webhook.usage_events() == []
        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "incomplete json"

    @pytest.mark.parametrize("recover", [False, True], ids=("no-recovery", "recovery"))
    @pytest.mark.parametrize("padding_size", [0, 1_025], ids=("buffered", "selective"))
    @pytest.mark.parametrize("chunking", ["whole", "one-byte", "split", "control-boundary"])
    def test_discarded_sse_invalidates_prior_usage_before_terminal_reporting(
        self,
        tmp_path,
        real_flow,
        recover,
        padding_size,
        chunking,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="text/event-stream",
        )
        prefix = (
            b"data: "
            + _chat_payload(usage_payload={"prompt_tokens": 90, "completion_tokens": 40})
            + b"\n\n"
            + b'data: {"id":"chatcmpl_discarded","private":"do-not-log-'
            + b"p" * padding_size
            + b'","usage":{"prompt_tokens":30}\n'
        )
        stream = prefix + b"x" * 4_097 + b"\n\n"
        if recover:
            stream += (
                b"data: "
                + _chat_payload(usage_payload={"prompt_tokens": 7, "completion_tokens": 2})
                + b"\n\n"
            )
        stream += b"data: [DONE]\n\n"

        if chunking == "control-boundary":
            boundary = len(prefix) + 4_096
            chunks = [stream[:boundary], stream[boundary : boundary + 1], stream[boundary + 1 :]]
        else:
            chunk_size = {"whole": len(stream), "one-byte": 1, "split": 17}[chunking]
            chunks = [
                stream[offset : offset + chunk_size] for offset in range(0, len(stream), chunk_size)
            ]

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        for chunk in chunks:
            assert callback(chunk) == chunk
        assert callback(b"") == b""

        webhook = _run_response(flow, self._usage_webhook_api)

        if recover:
            assert webhook.request_count == 1
            events = webhook.usage_events()
            assert len(events) == 2
            assert {event["category"]: event["quantity"] for event in events} == {
                "tokens.input": 7,
                "tokens.output": 2,
            }
        else:
            assert webhook.request_count == 0
            assert webhook.usage_events() == []

        warnings = [
            entry
            for entry in read_jsonl_entries_after_flush(
                Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
            )
            if entry.get("message") == "Model provider SSE usage extraction failed"
        ]
        assert len(warnings) == 1
        assert warnings[0]["usage_protocol"] == "openai_chat_completions_sse"
        assert warnings[0]["event"] == "eventless"
        assert warnings[0]["error"] == "sse event discarded"
        assert "do-not-log-" not in json.dumps(warnings)
        assert "x" * 4_097 not in json.dumps(warnings)

    @pytest.mark.parametrize("nested_usage", [False, True], ids=("top-level", "choice"))
    def test_non_streaming_json_reports_usage_without_buffering(
        self,
        tmp_path,
        real_flow,
        nested_usage,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        usage_payload: dict[str, object] = {
            "prompt_tokens": 30,
            "completion_tokens": 5,
        }
        payload = _chat_payload(usage_payload=None if nested_usage else usage_payload)
        if nested_usage:
            decoded = json.loads(payload)
            decoded["choices"][0]["usage"] = usage_payload
            payload = json.dumps(decoded, separators=(",", ":")).encode()

        mitm_addon.responseheaders(flow)
        callback = response_stream(flow)
        midpoint = len(payload) // 2
        callback(payload[:midpoint])
        callback(payload[midpoint:])
        assert metadata_keys.STREAM_BUFFER not in flow.metadata

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 30,
            "tokens.output": 5,
        }

    def test_non_streaming_priority_response_uses_fast_pricing_categories(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER] = "gpt-5.6-luna"
        payload = json.dumps(
            {
                "id": "chatcmpl_fast",
                "model": "gpt-5.6-luna",
                "service_tier": "priority",
                "choices": [{"index": 0, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 30, "completion_tokens": 5},
            },
            separators=(",", ":"),
        ).encode()

        mitm_addon.responseheaders(flow)
        response_stream(flow)(payload)

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input.fast": 30,
            "tokens.output.fast": 5,
        }

    def test_brotli_json_uses_streaming_parser(
        self,
        tmp_path,
        real_flow,
    ):
        flow = _chat_completions_flow(
            tmp_path,
            real_flow,
            content_type="application/json",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": "application/json", "content-encoding": "br"}),
        )
        body = _chat_payload(usage_payload={"prompt_tokens": 30, "completion_tokens": 5})
        compressed = brotli.compress(body)

        mitm_addon.responseheaders(flow)
        assert "model_json_usage_finish" in flow.metadata
        midpoint = len(compressed) // 2
        assert response_stream(flow)(compressed[:midpoint]) == compressed[:midpoint]
        assert response_stream(flow)(compressed[midpoint:]) == compressed[midpoint:]
        assert metadata_keys.STREAM_BUFFER not in flow.metadata

        webhook = _run_response(flow, self._usage_webhook_api)

        assert {event["category"]: event["quantity"] for event in webhook.usage_events()} == {
            "tokens.input": 30,
            "tokens.output": 5,
        }
