"""Tests for OpenAI Responses non-SSE JSON usage extraction."""

import json

import pytest

from usage import create_model_json_response_inspector


def _openai_responses_json_inspector():
    return create_model_json_response_inspector(
        "openai_responses",
        include_usage=True,
        include_failure=False,
    )


def _inspect_openai_responses_json(body: bytes) -> tuple[dict | None, str | None]:
    inspector = _openai_responses_json_inspector()
    inspector.feed(body)
    inspection = inspector.finish()
    return inspection.usage, inspection.usage_error


class TestOpenAIResponsesModelJsonResponseInspector:
    """Tests for OpenAI Responses usage through the shared JSON inspector."""

    def test_extracts_model_tokens_and_cache_details(self):
        body = json.dumps(
            {
                "id": "resp_123",
                "model": "gpt-5.6-sol",
                "service_tier": "priority",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "input_tokens_details": {
                        "cached_tokens": 25,
                        "cache_write_tokens": 30,
                    },
                    "output_tokens_details": {"reasoning_tokens": 10},
                },
            }
        ).encode()
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result is not None
        assert result == {
            "message_id": "resp_123",
            "model": "gpt-5.6-sol",
            "service_tier": "priority",
            "tokens.input": 45,
            "tokens.output": 40,
            "tokens.cache_read": 25,
            "tokens.cache_creation": 30,
        }
        assert "reasoning_tokens" not in result

    def test_missing_cached_input_details_does_not_emit_cache_read(self):
        body = b'{"model":"gpt-5.5","usage":{"input_tokens":10,"output_tokens":5}}'
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result is not None
        assert result == {
            "model": "gpt-5.5",
            "tokens.input": 10,
            "tokens.output": 5,
        }
        assert "tokens.cache_read" not in result

    def test_ignores_invalid_usage_quantities(self):
        body = json.dumps(
            {
                "model": "gpt-5.5",
                "usage": {
                    "input_tokens": -1,
                    "output_tokens": True,
                    "input_tokens_details": {
                        "cached_tokens": "25",
                        "cache_write_tokens": 3,
                    },
                },
            }
        ).encode()
        result, error = _inspect_openai_responses_json(body)
        assert result is None
        assert error is None

    def test_invalid_cached_input_does_not_suppress_valid_input(self):
        body = (
            b'{"model":"gpt-5.5","usage":{"input_tokens":10,'
            b'"input_tokens_details":{"cached_tokens":"bad"}}}'
        )
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result is not None
        assert result == {
            "model": "gpt-5.5",
            "tokens.input": 10,
        }
        assert "tokens.cache_read" not in result

    def test_cache_write_without_cache_read_is_reportable(self):
        body = (
            b'{"id":"resp_cache_write","model":"gpt-5.6-sol",'
            b'"usage":{"input_tokens":10,'
            b'"input_tokens_details":{"cache_write_tokens":10}}}'
        )
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result == {
            "message_id": "resp_cache_write",
            "model": "gpt-5.6-sol",
            "tokens.input": 0,
            "tokens.cache_creation": 10,
        }

    @pytest.mark.parametrize("cache_write_tokens", [-1, True, "25", 1.5])
    def test_invalid_cache_write_does_not_suppress_valid_input(self, cache_write_tokens: object):
        body = json.dumps(
            {
                "model": "gpt-5.6-sol",
                "usage": {
                    "input_tokens": 10,
                    "input_tokens_details": {
                        "cached_tokens": 2,
                        "cache_write_tokens": cache_write_tokens,
                    },
                },
            }
        ).encode()
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result == {
            "model": "gpt-5.6-sol",
            "tokens.input": 8,
            "tokens.cache_read": 2,
        }

    def test_cache_write_tokens_are_clamped_to_input_remaining_after_cache_read(self):
        body = (
            b'{"model":"gpt-5.6-sol","usage":{"input_tokens":10,'
            b'"input_tokens_details":{"cached_tokens":8,"cache_write_tokens":5}}}'
        )
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result == {
            "input_partition_incomplete": True,
            "model": "gpt-5.6-sol",
            "tokens.input": 0,
            "tokens.cache_read": 8,
            "tokens.cache_creation": 2,
        }

    def test_cached_input_tokens_are_clamped_to_total_input(self):
        body = (
            b'{"model":"gpt-5.5","usage":{"input_tokens":5,'
            b'"input_tokens_details":{"cached_tokens":7}}}'
        )
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result == {
            "input_partition_incomplete": True,
            "model": "gpt-5.5",
            "tokens.input": 0,
            "tokens.cache_read": 5,
        }

    def test_extracts_usage_with_large_unselected_output(self):
        body = json.dumps(
            {
                "id": "resp_large",
                "model": "gpt-5.5",
                "output": [
                    {
                        "content": [
                            {
                                "type": "output_text",
                                "text": "x" * (100 * 1024),
                            }
                        ]
                    }
                ],
                "usage": {
                    "input_tokens": 20,
                    "output_tokens": 9,
                    "input_tokens_details": {"cached_tokens": 6},
                },
            }
        ).encode()
        result, error = _inspect_openai_responses_json(body)
        assert error is None
        assert result == {
            "message_id": "resp_large",
            "model": "gpt-5.5",
            "tokens.input": 14,
            "tokens.output": 9,
            "tokens.cache_read": 6,
        }

    def test_protocol_shaped_output_with_many_items_stays_within_work_limit(self):
        output_item = (
            b'{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}'
        )
        body = (
            b'{"id":"resp_many","model":"gpt-5.6-sol","output":['
            + b",".join([output_item] * 700)
            + b'],"usage":{"input_tokens":20,"output_tokens":9}}'
        )

        result, error = _inspect_openai_responses_json(body)

        assert error is None
        assert result == {
            "message_id": "resp_many",
            "model": "gpt-5.6-sol",
            "tokens.input": 20,
            "tokens.output": 9,
        }

    def test_work_limit_discards_partial_document_and_next_extractor_recovers(self):
        inspector = _openai_responses_json_inspector()
        dense_array = b",".join([b"0"] * 40_000)
        inspector.feed(
            b'{"id":"resp_partial","model":"gpt-5.6-sol",'
            b'"usage":{"input_tokens":20,"output_tokens":9},"padding":['
        )
        midpoint = len(dense_array) // 2
        inspector.feed(dense_array[:midpoint])
        inspector.feed(dense_array[midpoint:])
        inspector.feed(b"]}")

        inspection = inspector.finish()
        assert inspection.usage is None
        assert inspection.usage_error == "work limit exceeded"

        next_inspector = _openai_responses_json_inspector()
        next_inspector.feed(
            b'{"id":"resp_recovered","model":"gpt-5.6-sol",'
            b'"usage":{"input_tokens":8,"output_tokens":3}}'
        )

        next_inspection = next_inspector.finish()
        assert next_inspection.usage == {
            "message_id": "resp_recovered",
            "model": "gpt-5.6-sol",
            "tokens.input": 8,
            "tokens.output": 3,
        }
        assert next_inspection.usage_error is None
