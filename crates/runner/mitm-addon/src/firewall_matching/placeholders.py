"""Exact request fields that carry a firewall's declared credential placeholders."""

import base64
from collections.abc import Callable, Mapping
from typing import NamedTuple

from connector_template_syntax import (
    BasicAuthTemplate,
    SimpleTemplateReference,
    TemplateReferenceNamespace,
    iter_basic_auth_templates,
    iter_simple_references,
)


class _Variable(NamedTuple):
    name: str


class _BasicAuth(NamedTuple):
    username: str | _Variable
    password: str | _Variable


type _Template = tuple[str | _Variable | _BasicAuth, ...]


class CredentialHints(NamedTuple):
    headers: tuple[tuple[bytes, bytes | _Template], ...]
    query: tuple[tuple[str, str | _Template], ...]

    def matches(
        self,
        headers: frozenset[tuple[bytes, bytes]],
        query_pairs: Callable[[], frozenset[tuple[str, str]]],
        variables: Mapping[str, str] | None = None,
    ) -> bool:
        for name, hint in self.headers:
            header_value = hint if isinstance(hint, bytes) else _header_value(hint, variables)
            if header_value is not None and (name, header_value) in headers:
                return True
        if not self.query:
            return False
        pairs = query_pairs()
        for name, hint in self.query:
            query_value = hint if isinstance(hint, str) else _render_template(hint, variables)
            if query_value is not None and (name, query_value) in pairs:
                return True
        return False


def _compile_argument(
    namespace: TemplateReferenceNamespace | None,
    value: str,
    placeholders: Mapping[str, object],
) -> str | _Variable | None:
    if namespace is None:
        return value
    if namespace == "vars":
        return _Variable(value)
    placeholder = placeholders.get(value)
    return placeholder if isinstance(placeholder, str) and placeholder else None


def _compile_template(
    template: str, placeholders: Mapping[str, object], *, allow_basic: bool
) -> _Template | None:
    references: list[SimpleTemplateReference | BasicAuthTemplate] = list(
        iter_simple_references(template)
    )
    if allow_basic and "basic(" in template:
        references.extend(iter_basic_auth_templates(template))
        references.sort(key=lambda reference: reference.start)

    parts: list[str | _Variable | _BasicAuth] = []
    saw_placeholder = False
    offset = 0
    for reference in references:
        # Reference-like text inside a quoted Basic argument is literal.
        if reference.start < offset:
            continue
        literal = template[offset : reference.start]
        if "${{" in literal:
            return None
        part: str | _Variable | _BasicAuth | None
        if isinstance(reference, BasicAuthTemplate):
            username = _compile_argument(
                reference.username.namespace, reference.username.value, placeholders
            )
            password = _compile_argument(
                reference.password.namespace, reference.password.value, placeholders
            )
            if username is None or password is None:
                return None
            part = _BasicAuth(username, password)
            saw_placeholder |= "secrets" in (
                reference.username.namespace,
                reference.password.namespace,
            )
        else:
            part = _compile_argument(reference.namespace, reference.name, placeholders)
            if part is None:
                return None
            saw_placeholder |= reference.namespace == "secrets"
        parts.extend((literal, part))
        offset = reference.end
    tail = template[offset:]
    if not saw_placeholder or "${{" in tail:
        return None
    return (*parts, tail)


def _resolve_argument(value: str | _Variable, variables: Mapping[str, str] | None) -> str | None:
    if isinstance(value, str):
        return value
    return variables.get(value.name) if variables is not None else None


def _render_template(template: _Template, variables: Mapping[str, str] | None) -> str | None:
    parts = []
    for part in template:
        if isinstance(part, _BasicAuth):
            username = _resolve_argument(part.username, variables)
            password = _resolve_argument(part.password, variables)
            if not isinstance(username, str) or not isinstance(password, str):
                return None
            value = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
        else:
            value = _resolve_argument(part, variables)
            if not isinstance(value, str):
                return None
        parts.append(value)
    return "".join(parts)


def _header_value(template: _Template, variables: Mapping[str, str] | None) -> bytes | None:
    try:
        value = _render_template(template, variables)
        return value.encode() if value is not None else None
    except UnicodeError:
        return None


def _compile_fields(
    fields: object, placeholders: Mapping[str, object], *, allow_basic: bool
) -> list[tuple[str, _Template]]:
    if not isinstance(fields, dict):
        return []
    compiled = []
    for name, template in fields.items():
        if not isinstance(name, str) or not isinstance(template, str):
            continue
        hint = _compile_template(template, placeholders, allow_basic=allow_basic)
        if hint is not None:
            compiled.append((name, hint))
    return compiled


def compile_credential_hints(auth: object, placeholders: object) -> CredentialHints:
    if not isinstance(auth, dict) or not isinstance(placeholders, dict) or not placeholders:
        return CredentialHints((), ())

    headers: list[tuple[bytes, bytes | _Template]] = []
    for name, template in _compile_fields(auth.get("headers"), placeholders, allow_basic=True):
        try:
            header = name.lower().encode("ascii")
        except UnicodeError:
            continue
        value = _header_value(template, None)
        headers.append((header, value if value is not None else template))
    query: list[tuple[str, str | _Template]] = []
    for name, template in _compile_fields(auth.get("query"), placeholders, allow_basic=False):
        value = _render_template(template, None)
        query.append((name, value if value is not None else template))
    return CredentialHints(tuple(headers), tuple(query))
