"""Raw Content-Encoding work-boundary cases shared by its production consumers."""

import pytest

FIELD_LIMIT = 8 * 1024
VALUE_LIMIT = 8 * 1024

BUDGET_CASES = [
    pytest.param("fields", FIELD_LIMIT, True, id="exact-fields"),
    pytest.param("fields", FIELD_LIMIT + 1, False, id="excess-fields"),
    pytest.param("single", VALUE_LIMIT, True, id="exact-value"),
    pytest.param("single", VALUE_LIMIT + 1, False, id="excess-value"),
    pytest.param("single", 1024 * 1024, False, id="megabyte-value"),
    pytest.param("aggregate", VALUE_LIMIT, True, id="exact-aggregate-with-separator"),
    pytest.param("aggregate", VALUE_LIMIT + 1, False, id="excess-aggregate-with-separator"),
]


class TrackedEncodingValue(bytes):
    """Record full-value work without changing values or hiding caller behavior."""

    def __init__(self, value: bytes) -> None:
        self.inspections: list[str] = []

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        self.inspections.append("decode")
        return super().decode(encoding, errors)

    def strip(self, chars: bytes | None = None) -> bytes:
        self.inspections.append("strip")
        return super().strip(chars)

    def lower(self) -> bytes:
        self.inspections.append("lower")
        return super().lower()


def encoding_budget_fields(
    ordinary_fields: tuple[tuple[bytes, bytes], ...],
    encoding: str,
    budget: str,
    size: int,
) -> tuple[tuple[bytes, bytes], ...]:
    """Build an inclusive field count or folded-byte size with tracked values."""
    coding = encoding.encode()
    if budget == "fields":
        padding = ((b"X-Padding", b""),) * (size - len(ordinary_fields) - 1)
        values = (coding,)
    elif budget == "single":
        padding = ()
        values = (b" " * (size - len(coding)) + coding,)
    else:
        assert budget == "aggregate"
        padding = ()
        first_size = VALUE_LIMIT // 2
        values = (
            b" " * (first_size - len(coding)) + coding,
            b" " * (size - first_size - len(b", ")),
        )
    return (
        *ordinary_fields,
        *padding,
        *((b"cOnTeNt-EnCoDiNg", TrackedEncodingValue(value)) for value in values),
    )


def encoding_inspections(fields: tuple[tuple[bytes, bytes], ...]) -> list[str]:
    return [
        inspection
        for _, value in fields
        if isinstance(value, TrackedEncodingValue)
        for inspection in value.inspections
    ]
