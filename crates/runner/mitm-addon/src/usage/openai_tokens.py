"""Shared OpenAI-compatible token normalization."""

from typing import NamedTuple

from .quantities import is_usage_quantity


class InputTokenPartition(NamedTuple):
    uncached_tokens: int | None
    cache_read_tokens: int | None
    cache_creation_tokens: int | None
    overlaps: bool


def partition_input_tokens(
    input_tokens: object,
    cached_tokens: object,
    cache_write_tokens: object,
) -> InputTokenPartition:
    """Partition input counts and report whether either cache count was clamped."""
    if not is_usage_quantity(input_tokens):
        return InputTokenPartition(None, None, None, False)

    remaining_input_tokens = input_tokens
    cached_input_tokens = None
    overlaps = False
    if is_usage_quantity(cached_tokens):
        cached_input_tokens = min(cached_tokens, remaining_input_tokens)
        remaining_input_tokens -= cached_input_tokens
        overlaps = cached_input_tokens < cached_tokens

    cache_creation_tokens = None
    if is_usage_quantity(cache_write_tokens):
        cache_creation_tokens = min(cache_write_tokens, remaining_input_tokens)
        remaining_input_tokens -= cache_creation_tokens
        overlaps = overlaps or cache_creation_tokens < cache_write_tokens

    return InputTokenPartition(
        remaining_input_tokens, cached_input_tokens, cache_creation_tokens, overlaps
    )
