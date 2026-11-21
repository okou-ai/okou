"""Warning admission for a single model response or WebSocket flow."""


class ParseErrorWarningBudget:
    """Retain the first four parse-error warning attempts."""

    __slots__ = ("_remaining",)
    _LIMIT = 4

    def __init__(self) -> None:
        self._remaining = self._LIMIT

    @property
    def is_unused(self) -> bool:
        return self._remaining == self._LIMIT

    def take(self) -> bool:
        """Spend an attempt before the caller prepares or emits the warning."""
        if self._remaining == 0:
            return False
        self._remaining -= 1
        return True
