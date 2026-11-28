"""Connector auth-template syntax shared by runner consumers."""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Final, Literal

TemplateReferenceNamespace = Literal["secrets", "vars"]
_TEMPLATE_IDENTIFIER: Final = r"[a-zA-Z_][a-zA-Z0-9_]*"

# Keep this character class aligned with JavaScript regular-expression ``\s``
# in the TypeScript connector contract. Python ``\s`` has different semantics.
_ECMASCRIPT_WHITESPACE: Final = (
    r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a"
    r"\u2028\u2029\u202f\u205f\u3000\ufeff]"
)
_SIMPLE_REFERENCE_PATTERN: Final = re.compile(
    r"\$\{\{"
    rf"{_ECMASCRIPT_WHITESPACE}*"
    r"(?P<namespace>secrets|vars)\."
    rf"(?P<name>{_TEMPLATE_IDENTIFIER})"
    rf"{_ECMASCRIPT_WHITESPACE}*"
    r"\}\}"
)


# basic() uses ASCII whitespace and unescaped double-quoted literals.
_BASIC_WHITESPACE: Final = r"[\u0009-\u000d\u0020]*+"


def _basic_argument_pattern(argument: str) -> str:
    return (
        rf'{_BASIC_WHITESPACE}(?:(?:"(?P<{argument}_literal>[^"\\]*+)"|'
        rf"(?P<{argument}_namespace>secrets|vars)\.(?P<{argument}_name>{_TEMPLATE_IDENTIFIER}))"
        rf"{_BASIC_WHITESPACE})?"
    )


_BASIC_AUTH_PATTERN: Final = re.compile(
    r"\$\{\{"
    rf"{_BASIC_WHITESPACE}basic\("
    rf"{_basic_argument_pattern('first')},{_basic_argument_pattern('second')}\)"
    rf"{_BASIC_WHITESPACE}"
    r"\}\}"
)


@dataclass(frozen=True, slots=True)
class SimpleTemplateReference:
    namespace: TemplateReferenceNamespace
    name: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class BasicAuthArgument:
    namespace: TemplateReferenceNamespace | None
    value: str


@dataclass(frozen=True, slots=True)
class BasicAuthTemplate:
    start: int
    end: int
    username: BasicAuthArgument
    password: BasicAuthArgument


def iter_simple_references(value: str) -> Iterator[SimpleTemplateReference]:
    """Yield simple secret and variable references in source order."""
    for match in _SIMPLE_REFERENCE_PATTERN.finditer(value):
        raw_namespace = match.group("namespace")
        namespace: TemplateReferenceNamespace = "secrets" if raw_namespace == "secrets" else "vars"
        yield SimpleTemplateReference(
            namespace=namespace,
            name=match.group("name"),
            start=match.start(),
            end=match.end(),
        )


def _basic_argument(match: re.Match[str], argument: str) -> BasicAuthArgument:
    namespace = match.group(f"{argument}_namespace")
    if namespace in ("secrets", "vars"):
        return BasicAuthArgument(
            "secrets" if namespace == "secrets" else "vars",
            match.group(f"{argument}_name"),
        )
    return BasicAuthArgument(None, match.group(f"{argument}_literal") or "")


def iter_basic_auth_templates(value: str) -> Iterator[BasicAuthTemplate]:
    """Yield basic() templates using the TypeScript connector contract's grammar."""
    for match in _BASIC_AUTH_PATTERN.finditer(value):
        yield BasicAuthTemplate(
            match.start(),
            match.end(),
            _basic_argument(match, "first"),
            _basic_argument(match, "second"),
        )
