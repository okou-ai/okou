"""Exact request fields that carry a firewall's declared credential placeholders."""

from collections.abc import Callable
from typing import NamedTuple

from connector_template_syntax import iter_simple_references


class CredentialHints(NamedTuple):
    headers: frozenset[tuple[bytes, bytes]]
    query: frozenset[tuple[str, str]]

    def matches(
        self,
        headers: frozenset[tuple[bytes, bytes]],
        query_pairs: Callable[[], list[tuple[str, str]]],
    ) -> bool:
        return not self.headers.isdisjoint(headers) or (
            bool(self.query) and not self.query.isdisjoint(query_pairs())
        )


def _render_hint(template: str, placeholders: dict) -> str | None:
    references = tuple(iter_simple_references(template))
    if not references or template.count("${{") != len(references):
        return None
    parts: list[str] = []
    offset = 0
    for reference in references:
        value = placeholders.get(reference.name)
        if reference.namespace != "secrets" or not isinstance(value, str) or not value:
            return None
        parts.extend((template[offset : reference.start], value))
        offset = reference.end
    parts.append(template[offset:])
    return "".join(parts)


def _render_fields(fields: object, placeholders: dict) -> list[tuple[str, str]]:
    if not isinstance(fields, dict):
        return []
    rendered: list[tuple[str, str]] = []
    for name, template in fields.items():
        if not isinstance(name, str) or not isinstance(template, str):
            continue
        hint = _render_hint(template, placeholders)
        if hint is not None:
            rendered.append((name, hint))
    return rendered


def compile_credential_hints(auth: object, placeholders: object) -> CredentialHints:
    if not isinstance(auth, dict) or not isinstance(placeholders, dict) or not placeholders:
        return CredentialHints(frozenset(), frozenset())

    headers: set[tuple[bytes, bytes]] = set()
    for name, value in _render_fields(auth.get("headers"), placeholders):
        try:
            headers.add((name.lower().encode("ascii"), value.encode("utf-8")))
        except UnicodeError:
            continue
    return CredentialHints(
        frozenset(headers), frozenset(_render_fields(auth.get("query"), placeholders))
    )
