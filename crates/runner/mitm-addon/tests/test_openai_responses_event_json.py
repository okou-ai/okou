"""Tests for OpenAI Responses WebSocket event JSON usage extraction."""

import json

import pytest

import usage.openai_responses as openai_responses
from usage import extract_openai_responses_usage_from_event as _extract_usage_with_error
from usage import (
    inspect_openai_responses_client_event_json,
    inspect_openai_responses_event_json,
    merge_openai_responses_usage_result,
)
from usage.quantities import MAX_USAGE_QUANTITY


def extract_openai_responses_usage_from_event(
    event: openai_responses.OpenAIResponsesEvent,
) -> dict | None:
    usage_result, error = _extract_usage_with_error(event)
    assert error is None
    return usage_result


def test_extracts_usage_from_wrapped_response_completed_event():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "model": "gpt-5.6-sol",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "input_tokens_details": {
                        "cached_tokens": 25,
                        "cache_write_tokens": 30,
                    },
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_1",
        "model": "gpt-5.6-sol",
        "tokens.input": 45,
        "tokens.output": 40,
        "tokens.cache_read": 25,
        "tokens.cache_creation": 30,
    }


def test_client_inspector_classifies_late_response_create_without_retaining_payload():
    body = (
        b'{"padding":"'
        + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
        + b'","type":"response.create","generate":false,"input":"secret"}'
    )

    event = inspect_openai_responses_client_event_json(body)

    assert event.event_type is None
    assert event.request_kind == "create"
    assert event.is_prewarm is True


def test_extracts_usage_from_wrapped_response_done_event():
    body = json.dumps(
        {
            "type": "response.done",
            "response": {
                "id": "resp_2",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 7,
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_2",
        "model": "gpt-5.5",
        "tokens.input": 12,
        "tokens.output": 7,
    }


def test_extracts_usage_from_wrapped_response_incomplete_event():
    body = json.dumps(
        {
            "type": "response.incomplete",
            "response": {
                "id": "resp_incomplete",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 8000,
                    "output_tokens": 1024,
                    "input_tokens_details": {"cached_tokens": 2000},
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_incomplete",
        "model": "gpt-5.5",
        "tokens.input": 6000,
        "tokens.output": 1024,
        "tokens.cache_read": 2000,
    }


def test_extracts_usage_from_wrapped_response_failed_event():
    body = json.dumps(
        {
            "type": "response.failed",
            "response": {
                "id": "resp_failed",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 12000,
                    "output_tokens": 0,
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_failed",
        "model": "gpt-5.5",
        "tokens.input": 12000,
        "tokens.output": 0,
    }


def test_shared_inspection_returns_failure_only_evidence():
    body = (
        b'{"type":"response.failed","response":{"id":"failure-only",'
        b'"error":{"code":"service_unavailable"}}}'
    )
    event = inspect_openai_responses_event_json(body)

    inspection = openai_responses.inspect_openai_responses_server_event(
        event,
        include_lifecycle=False,
        include_usage=False,
        include_failure=True,
    )

    assert inspection.lifecycle is None
    assert inspection.usage is None
    assert inspection.usage_error is None
    assert inspection.failure == openai_responses.OpenAIResponsesServerFailureEvidence(
        event_type="response.failed",
        response_id="failure-only",
        failure_codes=("service_unavailable",),
        is_valid=True,
    )


def test_unusable_failure_code_does_not_discard_shared_usage():
    body = json.dumps(
        {
            "type": "response.failed",
            "response": {
                "id": "mixed-evidence",
                "model": "gpt-5.5",
                "usage": {"input_tokens": 12, "output_tokens": 3},
                "error": {"code": "x" * 129},
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    inspection = openai_responses.inspect_openai_responses_server_event(
        event,
        include_lifecycle=True,
        include_usage=True,
        include_failure=True,
    )

    assert inspection.usage == {
        "message_id": "mixed-evidence",
        "model": "gpt-5.5",
        "tokens.input": 12,
        "tokens.output": 3,
    }
    assert inspection.usage_error is None
    assert inspection.failure == openai_responses.OpenAIResponsesServerFailureEvidence(
        event_type="response.failed",
        response_id="mixed-evidence",
        failure_codes=(),
        is_valid=True,
    )


def test_invalid_usage_quantity_does_not_discard_shared_failure_evidence():
    body = json.dumps(
        {
            "type": "response.failed",
            "response": {
                "id": "usage-overflow",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": MAX_USAGE_QUANTITY + 1,
                    "output_tokens": 3,
                },
                "error": {"code": "service_unavailable"},
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    inspection = openai_responses.inspect_openai_responses_server_event(
        event,
        include_lifecycle=True,
        include_usage=True,
        include_failure=True,
    )

    assert inspection.usage is None
    assert inspection.usage_error == "integer value limit exceeded"
    assert inspection.failure == openai_responses.OpenAIResponsesServerFailureEvidence(
        event_type="response.failed",
        response_id="usage-overflow",
        failure_codes=("service_unavailable",),
        is_valid=True,
    )


def test_extracts_usage_from_flat_response_completed_event():
    body = json.dumps(
        {
            "type": "response.completed",
            "id": "resp_flat",
            "model": "gpt-5.3-codex",
            "usage": {
                "input_tokens": 50,
                "output_tokens": 20,
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_flat",
        "model": "gpt-5.3-codex",
        "tokens.input": 50,
        "tokens.output": 20,
    }


def test_extracts_zero_usage_quantities():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_zero",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "input_tokens_details": {
                        "cached_tokens": 0,
                        "cache_write_tokens": 0,
                    },
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_zero",
        "model": "gpt-5.5",
        "tokens.input": 0,
        "tokens.output": 0,
        "tokens.cache_read": 0,
        "tokens.cache_creation": 0,
    }


def test_returns_none_for_non_usage_event_type():
    body = json.dumps(
        {
            "type": "response.in_progress",
            "response": {"id": "resp_ignored", "model": "gpt-5.5"},
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) is None


def test_unknown_event_type_with_usage_extracts_usage():
    body = json.dumps(
        {
            "type": "response.future_terminal",
            "response": {
                "id": "resp_future",
                "model": "gpt-5.6",
                "usage": {
                    "input_tokens": 15,
                    "output_tokens": 9,
                    "input_tokens_details": {"cached_tokens": 4},
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_future",
        "model": "gpt-5.6",
        "tokens.input": 11,
        "tokens.output": 9,
        "tokens.cache_read": 4,
    }


def test_missing_type_with_usage_extracts_usage():
    body = json.dumps(
        {
            "response": {
                "id": "resp_missing_type",
                "model": "gpt-5.6",
                "usage": {
                    "input_tokens": 8,
                    "output_tokens": 3,
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert event.event_type is None
    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_missing_type",
        "model": "gpt-5.6",
        "tokens.input": 8,
        "tokens.output": 3,
    }


def test_known_non_usage_event_with_usage_fields_is_ignored():
    body = json.dumps(
        {
            "type": "response.output_text.delta",
            "response": {
                "model": "gpt-5.6",
                "usage": {"input_tokens": 15, "output_tokens": 9},
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) is None


def test_large_non_terminal_event_is_ignored():
    body = json.dumps(
        {
            "type": "response.output_text.delta",
            "delta": "x" * 4096,
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert event.event_type == "response.output_text.delta"
    assert extract_openai_responses_usage_from_event(event) is None


def test_large_documented_non_usage_event_skips_full_extractor(
    monkeypatch: pytest.MonkeyPatch,
):
    def reject_full_extractor(*_args: object, **_kwargs: object) -> None:
        pytest.fail("known non-usage event entered the full extractor")

    monkeypatch.setattr(
        openai_responses,
        "JsonSelectiveExtractor",
        reject_full_extractor,
    )
    body = (
        b'{"type":"response.output_item.done","item":{"content":"'
        + b"x" * (5 * 1024 * 1024)
        + b'"}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) is None


def test_non_terminal_prefilter_ignores_nested_types_and_payload_text():
    body = json.dumps(
        {
            "metadata": {
                "type": "response.completed",
                "items": [True, None, {"type": "response.failed"}],
            },
            "index": 3,
            "text": 'payload mentions "type":"response.completed"',
            "type": "response.output_text.delta",
            "delta": "ignored",
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert event.event_type == "response.output_text.delta"
    assert extract_openai_responses_usage_from_event(event) is None


def test_non_terminal_prefilter_handles_fractional_exponent_number_before_type():
    body = b'{"score":-2.5e+3,"type":"response.output_text.delta","delta":"ignored"}'
    event = inspect_openai_responses_event_json(body)

    assert event.event_type == "response.output_text.delta"
    assert extract_openai_responses_usage_from_event(event) is None


def test_duplicate_top_level_type_uses_first_type_boundary():
    body = (
        b'{"type":"response.output_text.delta",'
        b'"type":"response.completed",'
        b'"response":{"usage":{"input_tokens":1,"output_tokens":1}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert event.event_type == "response.output_text.delta"
    assert extract_openai_responses_usage_from_event(event) is None


def test_duplicate_top_level_unknown_type_keeps_first_type_boundary():
    body = (
        b'{"type":"response.future_terminal",'
        b'"type":"response.output_text.delta",'
        b'"response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "model": "gpt-5.6",
        "tokens.input": 9,
        "tokens.output": 4,
    }


def test_late_known_non_usage_event_type_is_ignored():
    body = (
        b'{"padding":"'
        + b"x" * (openai_responses._RESPONSES_EVENT_PREFILTER_MAX_BYTES + 1)
        + b'","type":"response.output_text.delta",'
        + b'"response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert event.event_type is None
    assert extract_openai_responses_usage_from_event(event) is None


def test_terminal_event_type_after_skipped_fields_still_extracts_usage():
    body = json.dumps(
        {
            "metadata": {
                "type": "response.output_text.delta",
                "items": [1, {"type": "response.failed"}],
            },
            "ready": True,
            "note": None,
            "type": "response.completed",
            "response": {
                "id": "resp_after_fields",
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": 12,
                    "output_tokens": 5,
                    "input_tokens_details": {"cached_tokens": 2},
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_after_fields",
        "model": "gpt-5.5",
        "tokens.input": 10,
        "tokens.output": 5,
        "tokens.cache_read": 2,
    }


def test_terminal_event_with_large_bulk_string_still_extracts_usage():
    body = (
        b'{"type":"response.completed","padding":"'
        + b"x" * (256 * 1024)
        + b'","response":{"id":"resp_bulk","model":"gpt-5.6",'
        b'"usage":{"input_tokens":9,"output_tokens":4}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "message_id": "resp_bulk",
        "model": "gpt-5.6",
        "tokens.input": 9,
        "tokens.output": 4,
    }


def test_non_string_type_falls_back_to_real_extractor():
    body = (
        b'{"type":123,"response":{"model":"gpt-5.6","usage":{"input_tokens":3,"output_tokens":2}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert event.event_type is None
    assert extract_openai_responses_usage_from_event(event) == {
        "model": "gpt-5.6",
        "tokens.input": 3,
        "tokens.output": 2,
    }


def test_oversized_type_falls_back_to_real_extractor():
    body = (
        b'{"type":"'
        + b"x" * 2048
        + b'","response":{"model":"gpt-5.6","usage":{"input_tokens":5,"output_tokens":1}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert event.event_type is None
    assert extract_openai_responses_usage_from_event(event) == {
        "model": "gpt-5.6",
        "tokens.input": 5,
        "tokens.output": 1,
    }


def test_oversized_unknown_type_with_usage_extracts_usage():
    body = (
        b'{"type":"'
        + b"x" * 2048
        + b'","response":{"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}}}'
    )
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "model": "gpt-5.6",
        "tokens.input": 9,
        "tokens.output": 4,
    }


def test_returns_none_for_malformed_json():
    event = inspect_openai_responses_event_json(b'{"type":"response.completed"')

    assert extract_openai_responses_usage_from_event(event) is None


def test_work_limit_rejects_partial_usage_and_returns_stable_error():
    body = (
        b'{"type":"response.completed","response":{"id":"resp_partial",'
        b'"model":"gpt-5.6","usage":{"input_tokens":9,"output_tokens":4}},'
        b'"padding":[' + b",".join([b"0"] * 40_000) + b"]}"
    )
    event = inspect_openai_responses_event_json(body)

    assert _extract_usage_with_error(event) == (None, "work_limit_exceeded")


def test_returns_none_for_usage_event_without_usage_quantities():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "id": "resp_without_usage",
                "model": "gpt-5.5",
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) is None


def test_returns_none_for_invalid_usage_quantities():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": -1,
                    "output_tokens": True,
                    "input_tokens_details": {"cached_tokens": "25"},
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) is None


def test_clamps_cached_tokens_to_total_input_tokens():
    body = json.dumps(
        {
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "input_tokens_details": {"cached_tokens": 99},
                },
            },
        }
    ).encode()
    event = inspect_openai_responses_event_json(body)

    assert extract_openai_responses_usage_from_event(event) == {
        "input_partition_incomplete": True,
        "tokens.input": 0,
        "tokens.output": 5,
        "tokens.cache_read": 10,
    }


def test_merge_preserves_positive_quantities_when_source_has_zero():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_creation": 30,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_1",
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.output": 0,
            "tokens.cache_read": 0,
            "tokens.cache_creation": 0,
        },
    )

    assert target == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 0,
        "tokens.cache_creation": 30,
    }


def test_merge_zero_only_source_does_not_relabel_existing_positive_usage():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
        "tokens.cache_creation": 30,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_empty",
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.output": 0,
            "tokens.cache_read": 0,
            "tokens.cache_creation": 0,
        },
    )

    assert target == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.input": 75,
        "tokens.output": 40,
        "tokens.cache_read": 25,
        "tokens.cache_creation": 30,
    }


def test_merge_stores_zero_quantities_when_target_is_missing_category():
    target = {}

    merge_openai_responses_usage_result(
        target,
        {
            "tokens.input": 0,
            "tokens.output": 0,
            "tokens.cache_read": 0,
            "tokens.cache_creation": 0,
        },
    )

    assert target == {
        "tokens.input": 0,
        "tokens.output": 0,
        "tokens.cache_read": 0,
        "tokens.cache_creation": 0,
    }


def test_merge_updates_with_positive_quantities():
    target = {
        "tokens.input": 0,
        "tokens.output": 0,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_2",
            "model": "gpt-5.5",
            "tokens.input": 12,
            "tokens.output": 7,
        },
    )

    assert target == {
        "message_id": "resp_2",
        "model": "gpt-5.5",
        "tokens.input": 12,
        "tokens.output": 7,
    }


def test_merge_allows_positive_corrections_to_lower_quantities():
    target = {
        "tokens.input": 20,
        "tokens.output": 12,
        "tokens.cache_read": 8,
        "tokens.cache_creation": 6,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "tokens.input": 10,
            "tokens.output": 7,
            "tokens.cache_read": 3,
            "tokens.cache_creation": 2,
        },
    )

    assert target == {
        "tokens.input": 10,
        "tokens.output": 7,
        "tokens.cache_read": 3,
        "tokens.cache_creation": 2,
    }


def test_merge_cache_creation_positive_usage_owns_metadata():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.output": 10,
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "resp_2",
            "model": "gpt-5.6-sol",
            "tokens.input": 0,
            "tokens.cache_creation": 7,
        },
    )

    assert target == {
        "message_id": "resp_2",
        "model": "gpt-5.6-sol",
        "tokens.input": 0,
        "tokens.output": 10,
        "tokens.cache_creation": 7,
    }


def test_merge_ignores_unknown_keys():
    target = {}

    merge_openai_responses_usage_result(
        target,
        {
            "tokens.input": 1,
            "unknown": "value",
        },
    )

    assert target == {"tokens.input": 1}


def test_merge_ignores_empty_metadata_strings():
    target = {
        "message_id": "resp_1",
        "model": "gpt-5.5",
    }

    merge_openai_responses_usage_result(
        target,
        {
            "message_id": "",
            "model": "",
            "tokens.output": 1,
        },
    )

    assert target == {
        "message_id": "resp_1",
        "model": "gpt-5.5",
        "tokens.output": 1,
    }
