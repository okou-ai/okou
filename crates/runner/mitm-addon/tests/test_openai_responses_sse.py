"""Tests for OpenAI Responses SSE usage extraction."""

import json

import pytest

import usage.openai_responses as openai_responses
from usage import (
    create_openai_responses_sse_usage_extractor,
)


class TestOpenAIResponsesSseUsageExtractor:
    """Tests for the OpenAI Responses streaming usage parser."""

    def test_extracts_usage_from_response_completed(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_1",'
            b'"model":"gpt-5.6-sol","service_tier":"priority",'
            b'"usage":{"input_tokens":100,'
            b'"output_tokens":40,"input_tokens_details":{"cached_tokens":25,'
            b'"cache_write_tokens":30},'
            b'"output_tokens_details":{"reasoning_tokens":10}}}}\n\n'
        )
        assert usage == {
            "message_id": "resp_1",
            "model": "gpt-5.6-sol",
            "service_tier": "priority",
            "tokens.input": 45,
            "tokens.output": 40,
            "tokens.cache_read": 25,
            "tokens.cache_creation": 30,
        }
        assert "reasoning_tokens" not in usage

    def test_extracts_usage_from_response_done(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.done\n"
            b'data: {"type":"response.done","response":{"id":"resp_2",'
            b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":7}}}\n\n'
        )
        assert usage["message_id"] == "resp_2"
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.input"] == 12
        assert usage["tokens.output"] == 7
        assert "tokens.cache_read" not in usage

    def test_extracts_usage_from_response_incomplete(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.incomplete\n"
            b'data: {"type":"response.incomplete","response":{"id":"resp_incomplete",'
            b'"model":"gpt-5.5","usage":{"input_tokens":8000,'
            b'"output_tokens":1024,"input_tokens_details":{"cached_tokens":2000}}}}\n\n'
        )
        assert usage == {
            "message_id": "resp_incomplete",
            "model": "gpt-5.5",
            "tokens.input": 6000,
            "tokens.output": 1024,
            "tokens.cache_read": 2000,
        }

    def test_extracts_usage_from_response_failed(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{"id":"resp_failed",'
            b'"model":"gpt-5.5","usage":{"input_tokens":12000,"output_tokens":0}}}\n\n'
        )
        assert usage == {
            "message_id": "resp_failed",
            "model": "gpt-5.5",
            "tokens.input": 12000,
            "tokens.output": 0,
        }

    def test_discarded_terminal_event_recovers_for_next_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()

        parse(
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{\n' + b"x" * 4097 + b"\n\n"
            b"event: response.failed\n"
            b'data: {"type":"response.failed","response":{"id":"resp_failed",'
            b'"model":"gpt-5.5","usage":{"input_tokens":12,"output_tokens":0}}}\n\n'
        )

        assert usage == {
            "message_id": "resp_failed",
            "model": "gpt-5.5",
            "tokens.input": 12,
            "tokens.output": 0,
        }

    @pytest.mark.parametrize(
        ("event_type", "event_prefix"),
        [
            pytest.param(
                "response.completed",
                b"event: response.completed\n",
                id="completed",
            ),
            pytest.param("response.done", b"event: response.done\n", id="done"),
            pytest.param(
                "response.incomplete",
                b"event: response.incomplete\n",
                id="incomplete",
            ),
            pytest.param("response.failed", b"event: response.failed\n", id="failed"),
            pytest.param("response.completed", b"", id="eventless"),
        ],
    )
    def test_reports_normalized_terminal_usage_snapshot(self, event_type, event_prefix):
        terminal_usage: list[dict] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            event_prefix
            + b'data: {"type":"'
            + event_type.encode()
            + b'","response":{"id":"resp_terminal","model":"gpt-5.6-sol",'
            b'"usage":{"input_tokens":100,"output_tokens":40,'
            b'"input_tokens_details":{"cached_tokens":25,'
            b'"cache_write_tokens":30}}}}\n\n'
        )

        expected = {
            "message_id": "resp_terminal",
            "model": "gpt-5.6-sol",
            "tokens.input": 45,
            "tokens.output": 40,
            "tokens.cache_read": 25,
            "tokens.cache_creation": 30,
        }
        assert usage == expected
        assert terminal_usage == [expected]

    def test_reports_named_terminal_snapshot_without_json_type(self):
        terminal_usage: list[dict] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":12,"output_tokens":7}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.5",
            "tokens.input": 12,
            "tokens.output": 7,
        }
        assert terminal_usage == [usage]

    @pytest.mark.parametrize(
        ("event_name", "data_type"),
        [
            pytest.param(
                "response.completed",
                "response.failed",
                id="conflicting-terminal",
            ),
            pytest.param(
                "response.future_usage",
                "response.future_usage",
                id="unknown",
            ),
        ],
    )
    def test_compatibility_usage_does_not_become_terminal_snapshot(self, event_name, data_type):
        terminal_usage: list[dict] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            b"event: "
            + event_name.encode()
            + b"\n"
            + b'data: {"type":"'
            + data_type.encode()
            + b'","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.5",
            "tokens.input": 9,
            "tokens.output": 4,
        }
        assert terminal_usage == []

    @pytest.mark.parametrize(
        "event_prefix",
        [
            pytest.param(b"event: response.completed\n", id="named"),
            pytest.param(b"", id="eventless"),
        ],
    )
    @pytest.mark.parametrize(
        "type_fields",
        [
            pytest.param(
                b'"type":"response.failed","type":"response.completed",',
                id="first-conflicts-with-last",
            ),
            pytest.param(
                b'"type":"response.completed","type":"response.failed",'
                b'"type":"response.completed",',
                id="middle-conflicts-with-matching-ends",
            ),
            pytest.param(
                b'"padding":"'
                + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
                + b'","type":"response.failed","type":"response.completed",',
                id="conflict-after-prefilter-bound",
            ),
            pytest.param(
                b'"padding":"'
                + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
                + b'","type":42,',
                id="invalid-type-after-prefilter-bound",
            ),
        ],
    )
    def test_conflicting_duplicate_terminal_types_do_not_report_snapshot(
        self, event_prefix, type_fields
    ):
        terminal_usage: list[dict] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            event_prefix + b"data: {" + type_fields + b'"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.5",
            "tokens.input": 9,
            "tokens.output": 4,
        }
        assert terminal_usage == []

    @pytest.mark.parametrize(
        "usage_json",
        [
            pytest.param(b'"usage":{"input_tokens":0,"output_tokens":0}', id="zero-only"),
            pytest.param(b'"id":"resp_metadata"', id="metadata-only"),
        ],
    )
    def test_terminal_event_without_positive_usage_does_not_report_snapshot(self, usage_json):
        terminal_usage: list[dict] = []
        parse, _usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            + usage_json
            + b"}}\n\n"
        )

        assert terminal_usage == []

    def test_incomplete_terminal_event_does_not_report_snapshot(self):
        terminal_usage: list[dict] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":9,"output_tokens":4}'
        )
        parse.finish()

        assert usage == {}
        assert terminal_usage == []

    def test_terminal_snapshot_excludes_earlier_unknown_usage(self):
        terminal_usage: list[dict] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_terminal_usage=terminal_usage.append
        )
        parse(
            b"event: response.future_usage\n"
            b'data: {"type":"response.future_usage","response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":99}}}\n\n'
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":10}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 99,
        }
        assert terminal_usage == [{"model": "gpt-5.5", "tokens.input": 10}]

    def test_work_limit_discards_partial_event_and_recovers(self):
        parse_errors: list[tuple[str, str]] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=lambda event, error: parse_errors.append((event, error))
        )
        dense_array = b",".join([b"0"] * 40_000)
        midpoint = len(dense_array) // 2

        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_partial",'
            b'"model":"gpt-5.6-sol","usage":{"input_tokens":20,"output_tokens":9}},'
            b'"padding":[' + dense_array[:midpoint] + b"\n"
        )
        parse(b"data: " + dense_array[midpoint:] + b"]}\n\n")

        assert usage == {}
        assert parse_errors == [("response.completed", "work limit exceeded")]

        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.completed","response":{"id":"resp_recovered",'
            b'"model":"gpt-5.6-sol","usage":{"input_tokens":8,"output_tokens":3}}}\n\n'
        )

        assert usage == {
            "message_id": "resp_recovered",
            "model": "gpt-5.6-sol",
            "tokens.input": 8,
            "tokens.output": 3,
        }
        assert parse_errors == [("response.completed", "work limit exceeded")]

    def test_ignores_response_in_progress(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.in_progress\n"
            b'data: {"type":"response.in_progress","response":{"id":"resp_ignored",'
            b'"model":"gpt-5.5","usage":{"input_tokens":10,"output_tokens":4}}}\n\n'
        )
        assert usage == {}

    def test_skips_full_extractor_for_large_documented_non_usage_event(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        def reject_full_extractor(*_args: object, **_kwargs: object) -> None:
            pytest.fail("known non-usage event entered the full extractor")

        monkeypatch.setattr(
            openai_responses,
            "JsonSelectiveExtractor",
            reject_full_extractor,
        )
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.output_item.done\n"
            b'data: {"type":"response.output_item.done","item":{"content":"'
            + b"x" * (5 * 1024 * 1024)
            + b'"}}\n\n'
        )

        assert usage == {}

    def test_accepts_data_level_type_without_event_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.completed","response":{"model":"gpt-5.6-luna",'
            b'"usage":{"input_tokens":3}}}\n\n'
        )
        assert usage["model"] == "gpt-5.6-luna"
        assert usage["tokens.input"] == 3

    @pytest.mark.parametrize("prefix", [b"", b"\xef\xbb\xbf"])
    def test_leading_bom_preserves_eventless_usage_and_diagnostics(self, prefix: bytes):
        parse_errors: list[tuple[str, str]] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=lambda event, error: parse_errors.append((event, error))
        )

        parse(
            prefix + b'data: {"type":"response.completed","response":{"id":"resp_bom",'
            b'"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "message_id": "resp_bom",
            "model": "gpt-5.6",
            "tokens.input": 9,
            "tokens.output": 4,
        }
        assert parse_errors == []

    def test_eventless_unknown_event_type_with_usage_extracts_usage(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.future_terminal","response":{"id":"resp_future",'
            b'"model":"gpt-5.6","usage":{"input_tokens":11,"output_tokens":7}}}\n\n'
        )

        assert usage == {
            "message_id": "resp_future",
            "model": "gpt-5.6",
            "tokens.input": 11,
            "tokens.output": 7,
        }

    def test_named_unknown_event_type_with_usage_extracts_usage(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.future_terminal\n"
            b'data: {"type":"response.future_terminal","response":{"model":"gpt-5.6",'
            b'"usage":{"output_tokens":12}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.6",
            "tokens.output": 12,
        }

    def test_named_unknown_event_with_known_non_usage_type_is_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.future_terminal\n"
            b'data: {"type":"response.output_text.delta","response":{"model":"gpt-5.6",'
            b'"usage":{"output_tokens":12}}}\n\n'
        )

        assert usage == {}

    def test_named_unknown_event_with_large_known_non_usage_type_recovers_for_next_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        large_delta = b'{"type":"response.output_text.delta","delta":"' + b"x" * 100_000 + b'"}'

        parse(b"event: response.future_delta\n")
        parse(b"data: " + large_delta + b"\n\n")

        assert usage == {}

        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5","usage":{"output_tokens":6}}}\n\n'
        )

        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 6

    def test_named_terminal_event_with_known_non_usage_type_is_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"type":"response.output_text.delta","response":{"model":"gpt-5.6",'
            b'"usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {}

    @pytest.mark.parametrize(
        "event_prefix",
        [
            pytest.param(b"", id="eventless"),
            pytest.param(b"event: response.completed\n", id="named"),
        ],
    )
    @pytest.mark.parametrize("with_parse_error_callback", [False, True])
    def test_oversized_type_does_not_change_usage_with_parse_error_callback(
        self, event_prefix, with_parse_error_callback
    ):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error if with_parse_error_callback else None
        )
        parse(
            event_prefix
            + b'data: {"type":"'
            + b"x" * 2048
            + b'","response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.6",
            "tokens.input": 9,
            "tokens.output": 4,
        }
        assert parse_errors == []

    def test_eventless_duplicate_unknown_type_keeps_first_type_boundary(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.future_terminal",'
            b'"type":"response.output_text.delta",'
            b'"response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.6",
            "tokens.input": 9,
            "tokens.output": 4,
        }

    def test_eventless_late_known_non_usage_type_is_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"padding":"'
            + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
            + b'","type":"response.output_text.delta",'
            + b'"response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}'
            + b"\n\n"
        )

        assert usage == {}

    def test_named_late_known_non_usage_type_is_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"padding":"'
            + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
            + b'","type":"response.output_text.delta",'
            + b'"response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}'
            + b"\n\n"
        )

        assert usage == {}

    def test_named_duplicate_unknown_type_keeps_first_type_boundary(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.future_terminal\n"
            b'data: {"type":"response.future_terminal",'
            b'"type":"response.output_text.delta",'
            b'"response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "model": "gpt-5.6",
            "tokens.input": 9,
            "tokens.output": 4,
        }

    def test_named_unknown_malformed_event_does_not_report_parse_error(self):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error
        )
        parse(
            b"event: response.future_terminal\n"
            b'data: {"type":"response.future_terminal","response":{"model":"gpt'
        )
        parse.finish()

        assert usage == {}
        assert parse_errors == []

    def test_known_non_usage_eventless_usage_fields_are_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.output_text.delta","response":{"model":"gpt-5.6",'
            b'"usage":{"input_tokens":11,"output_tokens":7}}}\n\n'
        )

        assert usage == {}

    def test_eventless_large_non_terminal_delta_recovers_for_next_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        delta_payload = b'{"type":"response.output_text.delta","delta":"' + b"x" * 100_000 + b'"}'

        parse(
            b"data: "
            + delta_payload
            + b"\n\n"
            + b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            + b'"usage":{"output_tokens":9}}}\n\n'
        )

        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 9

    def test_eventless_terminal_type_split_across_chunks_extracts_usage(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b'data: {"type":"response.comp')
        parse(
            b'leted","response":{"id":"resp_split","model":"gpt-5.5",'
            b'"usage":{"input_tokens":6,"output_tokens":4}}}\n\n'
        )

        assert usage == {
            "message_id": "resp_split",
            "model": "gpt-5.5",
            "tokens.input": 6,
            "tokens.output": 4,
        }

    def test_eventless_non_terminal_type_split_across_chunks_recovers(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b'data: {"type":"response.output_text.')
        parse(
            b'delta","delta":"ignored"}\n\n'
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":5}}}\n\n'
        )

        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 5

    @pytest.mark.parametrize(
        "event_prefix",
        [
            pytest.param(b"", id="eventless"),
            pytest.param(b"event: response.completed\n", id="named"),
        ],
    )
    def test_tiny_chunks_probe_late_terminal_type_once(self, event_prefix, monkeypatch):
        metadata = b",".join(f'"key_{index}":{index}'.encode() for index in range(250))
        payload = (
            b"{"
            + metadata
            + b',"type":"response.completed","response":{"model":"gpt-5.6",'
            + b'"usage":{"output_tokens":17}}}'
        )
        assert len(payload) < openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES

        real_probe = openai_responses._probe_responses_event_type
        probed_prefixes: list[bytes] = []

        def track_probe(body: bytes):
            probed_prefixes.append(body)
            return real_probe(body)

        monkeypatch.setattr(
            openai_responses,
            "_probe_responses_event_type",
            track_probe,
        )
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(event_prefix + b"data: ")
        for byte in payload:
            parse(bytes((byte,)))
        parse(b"\n\n")

        assert usage == {"model": "gpt-5.6", "tokens.output": 17}
        assert probed_prefixes == [payload]

    @pytest.mark.parametrize(
        ("event_prefix", "payload"),
        [
            pytest.param(
                b"",
                b'{"type":"response.output_text.delta","delta":"hello"}',
                id="eventless-event-end",
            ),
            pytest.param(
                b"event: vendor.delta\n",
                b'{"type":"response.output_text.delta","padding":"'
                + b"x" * openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES
                + b'"}',
                id="named-prefix-cap",
            ),
            pytest.param(
                b"event: vendor.delta\n",
                b'{"type":"response.output_text.delta","delta":"hello"}',
                id="named-event-end",
            ),
            pytest.param(
                b"",
                b'{"type":"response.output_text.delta","padding":"'
                + b"x" * openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES
                + b'"}',
                id="eventless-prefix-cap",
            ),
        ],
    )
    def test_known_non_usage_prefix_is_probed_once_and_discarded(
        self, event_prefix, payload, monkeypatch
    ):
        real_probe = openai_responses._probe_responses_event_type
        probed_prefixes: list[bytes] = []

        def track_probe(body: bytes):
            probed_prefixes.append(body)
            return real_probe(body)

        monkeypatch.setattr(openai_responses, "_probe_responses_event_type", track_probe)
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(event_prefix + b"data: " + payload + b"\n\n")

        assert probed_prefixes == [payload[: openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES]]
        assert usage == {}

    def test_eventless_incomplete_terminal_reports_parse_error(self):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error
        )
        parse(b'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt')
        parse.finish()

        assert usage == {}
        assert len(parse_errors) == 1
        event, error = parse_errors[0]
        assert event == "response.completed"
        assert isinstance(error, str)
        assert error

    def test_eventless_incomplete_non_terminal_stays_quiet(self):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error
        )
        parse(b'data: {"type":"response.output_text.delta","delta":"hello')
        parse.finish()

        assert usage == {}
        assert parse_errors == []

    def test_eventless_incomplete_terminal_after_prefix_bound_reports_parse_error(self):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error
        )
        parse(
            b'data: {"padding":"'
            + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
            + b'","type":"response.completed","response":{"model":"gpt'
        )
        parse.finish()

        assert usage == {}
        assert len(parse_errors) == 1
        event, error = parse_errors[0]
        assert event == "response.completed"
        assert isinstance(error, str)
        assert error

    def test_eventless_incomplete_non_terminal_after_prefix_bound_stays_quiet(self):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error
        )
        parse(
            b'data: {"padding":"'
            + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
            + b'","type":"response.output_text.delta","delta":"hello'
        )
        parse.finish()

        assert usage == {}
        assert parse_errors == []

    def test_eventless_incomplete_duplicate_type_does_not_use_stale_terminal_type(self):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=record_parse_error
        )
        parse(
            b'data: {"type":"response.completed","type":"response.output_text.delta","delta":"hello'
        )
        parse.finish()

        assert usage == {}
        assert parse_errors == []

    def test_eventless_type_after_prefix_bound_falls_back_to_full_extraction(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"padding":"'
            + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
            + b'","type":"response.completed","response":{"model":"gpt-5.5",'
            + b'"usage":{"output_tokens":8}}}\n\n'
        )

        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 8

    def test_finish_flushes_response_completed_without_blank_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":4}}}'
        )
        parse.finish()
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 4

    def test_finish_flushes_eventless_response_completed_without_blank_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":14}}}'
        )
        parse.finish()
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 14

    def test_accepts_sse_fields_without_optional_space(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event:response.completed\n"
            b'data:{"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":5}}}\n\n'
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 5

    def test_accepts_event_name_after_data_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":4}}}\n'
            b"event: response.completed\n\n"
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 4

    def test_handles_chunked_event_and_data_prefix(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.completed")
        parse(b"\nda")
        parse(b"ta")
        parse(b": ")
        parse(
            b'{"response":{"id":"resp_chunked","model":"gpt-5.5",'
            b'"usage":{"input_tokens":8,"output_tokens":3}}}\n\n'
        )
        assert usage["message_id"] == "resp_chunked"
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.input"] == 8
        assert usage["tokens.output"] == 3

    def test_crlf_line_endings(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\r\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":10,"output_tokens":4}}}\r\n'
            b"\r\n"
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.input"] == 10
        assert usage["tokens.output"] == 4

    def test_multidata_response_completed_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"response":\n'
            b'data: {"model":"gpt-5.5","usage":{"output_tokens":4}}}\n\n'
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 4

    def test_multidata_eventless_response_completed_event(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b'data: {"type":"response.completed",\n'
            b'data: "response":{"model":"gpt-5.5","usage":{"output_tokens":15}}}\n\n'
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 15

    def test_skips_large_irrelevant_events_without_buffering(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.output_text.delta\n")
        parse(b"data: " + b"x" * 100_000)
        parse(b"y" * 100_000 + b"\n\n")
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.2",'
            b'"usage":{"output_tokens":9}}}\n\n'
        )
        assert usage["model"] == "gpt-5.2"
        assert usage["tokens.output"] == 9

    def test_skip_recovery_same_chunk(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.output_text.delta\n")
        parse(
            b'data: {"delta":"ignored"}\n\n'
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"output_tokens":6}}}\n\n'
        )
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.output"] == 6

    def test_extracts_usage_from_large_response_completed_data_line(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(b"event: response.completed\n")
        parse(
            b'data: {"type":"response.completed","response":{"id":"resp_big",'
            b'"model":"gpt-5.5","output":[{"content":[{"type":"output_text","text":"'
            + b"x"
            * 100_000
        )
        parse(
            b'"}]}],"usage":{"input_tokens":100,"output_tokens":40,'
            b'"input_tokens_details":{"cached_tokens":25}}}}\n\n'
        )
        assert usage == {
            "message_id": "resp_big",
            "model": "gpt-5.5",
            "tokens.input": 75,
            "tokens.output": 40,
            "tokens.cache_read": 25,
        }

    def test_long_malformed_control_line_does_not_block_recovery(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"x" * 5000
            + b"\n"
            + b"event: response.completed\n"
            + b'data: {"response":{"model":"gpt-5.2",'
            + b'"usage":{"output_tokens":11}}}\n\n'
        )
        assert usage["model"] == "gpt-5.2"
        assert usage["tokens.output"] == 11

    @pytest.mark.parametrize("with_parse_error_callback", [False, True])
    def test_malformed_usage_event_recovers_for_next_event(self, with_parse_error_callback):
        parse_errors: list[tuple[str, str]] = []

        def record_parse_error(event: str, error: str) -> None:
            parse_errors.append((event, error))

        if with_parse_error_callback:
            parse, usage = create_openai_responses_sse_usage_extractor(
                on_parse_error=record_parse_error
            )
        else:
            parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b"data: {invalid json}\n\n"
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5",'
            b'"usage":{"input_tokens":13,"output_tokens":8}}}\n\n'
        )
        if with_parse_error_callback:
            assert len(parse_errors) == 1
            event, error = parse_errors[0]
            assert event == "response.completed"
            assert isinstance(error, str)
            assert error
        else:
            assert parse_errors == []
        assert usage["model"] == "gpt-5.5"
        assert usage["tokens.input"] == 13
        assert usage["tokens.output"] == 8

    @pytest.mark.parametrize(
        "event_prefix",
        [
            pytest.param(b"", id="eventless"),
            pytest.param(b"event: response.completed\n", id="named"),
        ],
    )
    @pytest.mark.parametrize("payload_size", [4095, 4096, 4097])
    @pytest.mark.parametrize(
        "chunk_size", [pytest.param(1, id="tiny"), pytest.param(16_384, id="whole")]
    )
    @pytest.mark.parametrize("zero_usage", [False, True])
    def test_terminal_usage_at_prefix_boundary(
        self, event_prefix, payload_size, chunk_size, zero_usage
    ):
        terminal_usage: list[dict] = []
        observations: list[tuple[dict, bool]] = []
        parse_errors: list[tuple[str, str]] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=lambda event, error: parse_errors.append((event, error)),
            on_terminal_usage=terminal_usage.append,
            on_observation=lambda observed, terminal: observations.append(
                (dict(observed), terminal)
            ),
        )
        input_tokens, output_tokens = (0, 0) if zero_usage else (8, 3)
        response = {
            "id": "resp_boundary",
            "model": "gpt-5.5",
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
        }
        prefix = b'{"type":"response.completed","padding":"'
        suffix = b'","response":' + json.dumps(response, separators=(",", ":")).encode() + b"}"
        payload = prefix + b"x" * (payload_size - len(prefix) - len(suffix)) + suffix
        assert len(payload) == payload_size
        stream = event_prefix + b"data: " + payload + b"\n\n"
        for offset in range(0, len(stream), chunk_size):
            parse(stream[offset : offset + chunk_size])
        parse.finish()

        expected = {
            "message_id": "resp_boundary",
            "model": "gpt-5.5",
            "tokens.input": input_tokens,
            "tokens.output": output_tokens,
        }
        assert usage == expected
        assert observations == [(expected, True)]
        assert terminal_usage == ([] if zero_usage else [expected])
        assert parse_errors == []

    @pytest.mark.parametrize(
        ("event_prefix", "next_event_prefix"),
        [
            pytest.param(b"", b"event: response.completed\n", id="eventless-to-named"),
            pytest.param(b"event: response.completed\n", b"", id="named-to-eventless"),
        ],
    )
    @pytest.mark.parametrize("payload_size", [4095, 4096, 4097])
    @pytest.mark.parametrize(
        "chunk_size", [pytest.param(1, id="tiny"), pytest.param(16_384, id="whole")]
    )
    def test_non_usage_prefix_boundary_recovers_for_different_framing(
        self, event_prefix, next_event_prefix, payload_size, chunk_size
    ):
        terminal_usage: list[dict] = []
        observations: list[tuple[dict, bool]] = []
        parse_errors: list[tuple[str, str]] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=lambda event, error: parse_errors.append((event, error)),
            on_terminal_usage=terminal_usage.append,
            on_observation=lambda observed, terminal: observations.append(
                (dict(observed), terminal)
            ),
        )
        prefix = b'{"type":"response.output_text.delta","padding":"'
        suffix = b'","response":{"model":"ignored","usage":{"output_tokens":99}}}'
        payload = prefix + b"x" * (payload_size - len(prefix) - len(suffix)) + suffix
        assert len(payload) == payload_size
        stream = (
            event_prefix
            + b"data: "
            + payload
            + b"\n\n"
            + next_event_prefix
            + b'data: {"type":"response.completed","response":{"model":"gpt-5.5",'
            + b'"usage":{"output_tokens":3}}}\n\n'
        )
        for offset in range(0, len(stream), chunk_size):
            parse(stream[offset : offset + chunk_size])
        parse.finish()

        expected = {"model": "gpt-5.5", "tokens.output": 3}
        assert usage == expected
        assert observations == [(expected, True)]
        assert terminal_usage == [expected]
        assert parse_errors == []

    @pytest.mark.parametrize(
        ("event_name", "captured", "terminal"),
        [
            pytest.param(b"response.completed", True, True, id="terminal"),
            pytest.param(b"vendor.usage", True, False, id="unknown"),
            pytest.param(b"response.output_text.delta", False, False, id="non-usage"),
        ],
    )
    @pytest.mark.parametrize("padding_size", [0, 4096])
    @pytest.mark.parametrize(
        "chunk_size", [pytest.param(1, id="tiny"), pytest.param(16_384, id="whole")]
    )
    @pytest.mark.parametrize(
        "ending", [pytest.param(b"\n\n", id="blank-line"), pytest.param(b"", id="finish")]
    )
    def test_final_event_name_after_multiline_data_preserves_callbacks(
        self, event_name, captured, terminal, padding_size, chunk_size, ending
    ):
        terminal_usage: list[dict] = []
        observations: list[tuple[dict, bool]] = []
        parse_errors: list[tuple[str, str]] = []
        parse, usage = create_openai_responses_sse_usage_extractor(
            on_parse_error=lambda event, error: parse_errors.append((event, error)),
            on_terminal_usage=terminal_usage.append,
            on_observation=lambda observed, is_terminal: observations.append(
                (dict(observed), is_terminal)
            ),
        )
        stream = (
            b'data: {"padding":"'
            + b"x" * padding_size
            + b'",\n'
            + b'data: "response":{"model":"gpt-5.5","usage":{"output_tokens":4}}}\n'
            + b"event: "
            + event_name
            + ending
        )
        for offset in range(0, len(stream), chunk_size):
            parse(stream[offset : offset + chunk_size])
        parse.finish()

        expected = {"model": "gpt-5.5", "tokens.output": 4}
        assert usage == (expected if captured else {})
        assert observations == ([(expected, terminal)] if captured else [])
        assert terminal_usage == ([expected] if terminal else [])
        assert parse_errors == []

    def test_invalid_usage_quantities_ignored(self):
        parse, usage = create_openai_responses_sse_usage_extractor()
        parse(
            b"event: response.completed\n"
            b'data: {"response":{"model":"gpt-5.5","usage":{'
            b'"input_tokens":-1,"output_tokens":true,'
            b'"input_tokens_details":{"cached_tokens":"25"}}}}\n\n'
        )
        assert usage == {"model": "gpt-5.5"}
