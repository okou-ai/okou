"""Strict configuration limits shared by bounded JSON parsers."""


def validate_positive_int(name: str, value: int) -> None:
    """Require a positive integer limit without accepting booleans."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
