"""Full-document managed policy without materializing prompt strings."""

import math

from usage.json_selective import JsonSelectiveExtractor, JsonValueKind, Path

_TOOL_ITEM_PATH_SIZE = 2
_TOOL_TYPE_PATH_SIZE = 3
# Captured policy values are ASCII. Every character can legally arrive as
# six raw JSON bytes (\uXXXX), including ordinary ASCII letters and slashes.
_JSON_ESCAPE_WIDTH = 6
_FUNCTION_TOOL = "function"


class PolicyError(ValueError):
    """Fixed, content-free policy rejection reason."""


class PolicyJsonValidator:
    def __init__(
        self,
        *,
        preset: str,
        service_tier: str | None,
        fields: frozenset[str],
        max_depth: int,
        max_work: int,
    ) -> None:
        self._preset = preset
        self._tier = service_tier
        self._fields = fields
        self._objects: list[set[str]] = []
        self._model_seen = False
        self._tier_seen = False
        self._tool_type_seen = False
        self._parser = JsonSelectiveExtractor(
            observer=self,
            max_depth=max_depth,
            max_work_units=max_work,
            max_key_bytes=4096,
            max_number_bytes=4300,
        )

    def start(self, path: Path, kind: JsonValueKind) -> int | None:
        if not path and kind != "object":
            raise PolicyError("json_object")
        if path == ("model",):
            if kind != "string":
                raise PolicyError("model")
            return len(self._preset) * _JSON_ESCAPE_WIDTH
        if path == ("service_tier",):
            if self._tier is None or kind != "string":
                raise PolicyError("service_tier")
            return len(self._tier) * _JSON_ESCAPE_WIDTH
        if path == ("tools",) and kind != "array":
            raise PolicyError("server_tools")
        if len(path) == _TOOL_ITEM_PATH_SIZE and path[0] == "tools":
            if kind != "object":
                raise PolicyError("server_tools")
            self._tool_type_seen = False
        if len(path) == _TOOL_TYPE_PATH_SIZE and path[0] == "tools" and path[2] == "type":
            if kind != "string":
                raise PolicyError("server_tools")
            return len(_FUNCTION_TOOL) * _JSON_ESCAPE_WIDTH
        if kind == "object":
            self._objects.append(set())
        return None

    def member(self, path: Path, key: str) -> None:
        keys = self._objects[-1]
        if key in keys:
            raise PolicyError("duplicate_json_key")
        keys.add(key)
        if not path and key not in self._fields:
            raise PolicyError("request_fields")

    def scalar(self, path: Path, value: object) -> None:
        if isinstance(value, float) and not math.isfinite(value):
            raise PolicyError("json_number")
        if path == ("model",):
            if value != self._preset:
                raise PolicyError("model")
            self._model_seen = True
        elif path == ("service_tier",):
            if value != self._tier:
                raise PolicyError("service_tier")
            self._tier_seen = True
        elif len(path) == _TOOL_TYPE_PATH_SIZE and path[0] == "tools" and path[2] == "type":
            if value != _FUNCTION_TOOL:
                raise PolicyError("server_tools")
            self._tool_type_seen = True

    def end(self, path: Path, kind: str) -> None:
        if kind == "object":
            self._objects.pop()
            if (
                len(path) == _TOOL_ITEM_PATH_SIZE
                and path[0] == "tools"
                and not self._tool_type_seen
            ):
                raise PolicyError("server_tools")

    def feed(self, chunk: bytes) -> None:
        self._parser.feed(chunk)
        if not self._parser.accepts_more_input():
            self._check_syntax()

    def _check_syntax(self) -> None:
        result = self._parser.finish()
        if not result.complete:
            reason = {
                "work limit exceeded": "json_work",
                "max depth exceeded": "json_depth",
                "number limit exceeded": "json_number",
                "key limit exceeded": "json_key",
            }.get(result.error or "", "json")
            raise PolicyError(reason)

    def finish(self) -> None:
        self._check_syntax()
        if not self._model_seen:
            raise PolicyError("model")
        if self._tier is not None and not self._tier_seen:
            raise PolicyError("service_tier")
