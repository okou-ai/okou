"""Exact integer contract for usage quantities."""

from typing import TypeGuard

MAX_USAGE_QUANTITY = (1 << 53) - 1


def is_usage_quantity(value: object) -> TypeGuard[int]:
    """Return whether a value is an exact nonnegative cross-layer quantity."""
    return (
        isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_USAGE_QUANTITY
    )


def is_positive_usage_quantity(value: object) -> TypeGuard[int]:
    """Return whether a valid usage quantity is greater than zero."""
    return is_usage_quantity(value) and value > 0
