"""Request-side response encoding negotiation for body-inspected flows."""

import re
from collections.abc import Iterable, Iterator
from decimal import Decimal, InvalidOperation
from typing import Final, Literal

from mitmproxy import http

import body_decoding
import http_header_syntax

_ACCEPT_ENCODING = "Accept-Encoding"
_RAW_ACCEPT_ENCODING: Final = b"accept-encoding"
# Accept an inclusive 64 KiB aggregate of matching raw values. This bounds
# addon-owned negotiation work after mitmproxy has parsed the request head.
_MAX_ACCEPT_ENCODING_VALUE_BYTES: Final = 64 * 1024
_IDENTITY = "identity"
_WILDCARD = "*"
_STREAM_DECODABLE_ENCODINGS = body_decoding.stream_decodable_content_encodings()
_INVALID_Q_VALUE = Decimal(-1)
_MIN_Q_VALUE = Decimal(0)
_MAX_Q_VALUE = Decimal(1)
_Q_VALUE_PATTERN = re.compile(r"(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)")
_HTTP_OWS_CHARS = " \t"

type ResponseEncodingNegotiationOutcome = Literal[
    "already_stream_decodable",
    "rewritten_stream_decodable",
    "preserved_client_constraints",
    "preserved_work_budget",
]


def normalize_accept_encoding_for_body_inspection(
    headers: http.Headers,
) -> ResponseEncodingNegotiationOutcome:
    """Best-effort restriction of Accept-Encoding for body inspection.

    The proxy inspects selected upstream responses for usage/billing.  For those
    requests, avoid negotiating encodings whose Python streaming decoders cannot
    provide the needed bounded-output behavior. Brotli participates under the
    documented soft output-limit contract in ``body_decoding``.

    The helper preserves explicit requester rejections. When ``identity`` and
    every supported compression coding are rejected, or the matching raw values
    exceed the parser's work budget, the original header remains unchanged and
    the actual response might not support bounded streaming inspection. Callers
    must use the response's ``Content-Encoding`` to decide whether incremental
    body inspection is available. The return value records whether the request
    was already safe, rewritten, or preserved and why.
    """
    if (
        http_header_syntax.header_value_budget_status(
            headers.fields,
            _RAW_ACCEPT_ENCODING,
            max_value_bytes=_MAX_ACCEPT_ENCODING_VALUE_BYTES,
            separator_bytes=0,
        )
        == "exceeded"
    ):
        return "preserved_work_budget"

    values = headers.get_all(_ACCEPT_ENCODING)
    if not values:
        headers[_ACCEPT_ENCODING] = _IDENTITY
        return "rewritten_stream_decodable"

    accepted_safe: dict[str, str | None] = {}
    rejected_safe: set[str] = set()
    identity_accepted = False
    identity_disallowed = False
    wildcard_disallows_identity = False
    wildcard_accepted = False
    wildcard_q_text: str | None = None
    wildcard_rejected = False

    for raw_value in values:
        for raw_coding in _iter_delimited(raw_value, ","):
            name, q_value, q_text = _parse_coding(raw_coding)
            if not name:
                continue

            accepted = q_value is None or q_value > _MIN_Q_VALUE

            if name == _IDENTITY:
                if accepted:
                    identity_accepted = True
                elif q_value == _MIN_Q_VALUE:
                    identity_disallowed = True
            elif name == _WILDCARD:
                if q_value == _MIN_Q_VALUE:
                    wildcard_disallows_identity = True
                    wildcard_rejected = True
                    wildcard_accepted = False
                    wildcard_q_text = None
                elif accepted and not wildcard_rejected and not wildcard_accepted:
                    wildcard_accepted = True
                    wildcard_q_text = q_text

            if name in _STREAM_DECODABLE_ENCODINGS:
                if q_value == _MIN_Q_VALUE:
                    rejected_safe.add(name)
                    accepted_safe.pop(name, None)
                elif accepted and name not in accepted_safe and name not in rejected_safe:
                    accepted_safe[name] = q_text

    identity_rejected = identity_disallowed or (
        wildcard_disallows_identity and not identity_accepted
    )

    if identity_rejected:
        _add_wildcard_safe_compression_encodings(
            accepted_safe,
            rejected_safe,
            wildcard_accepted,
            wildcard_q_text,
        )

    if accepted_safe:
        if identity_rejected and _IDENTITY not in accepted_safe:
            # Removing "*" would otherwise make identity implicitly acceptable again.
            accepted_safe[_IDENTITY] = "0"
        rewritten = ", ".join(
            _format_coding(name, q_text) for name, q_text in accepted_safe.items()
        )
        if _set_if_changed(headers, values, rewritten):
            return "rewritten_stream_decodable"
        return "already_stream_decodable"

    if identity_rejected:
        return "preserved_client_constraints"

    if _set_if_changed(headers, values, _IDENTITY):
        return "rewritten_stream_decodable"
    return "already_stream_decodable"


def _iter_delimited(value: str, delimiter: str, *, start: int = 0) -> Iterator[str]:
    while True:
        end = value.find(delimiter, start)
        if end == -1:
            yield value[start:]
            return
        yield value[start:end]
        start = end + len(delimiter)


def _parse_coding(raw_coding: str) -> tuple[str, Decimal | None, str | None]:
    parameter_separator = raw_coding.find(";")
    if parameter_separator == -1:
        name = raw_coding.strip(_HTTP_OWS_CHARS).lower()
        return name, None, None
    name = raw_coding[:parameter_separator].strip(_HTTP_OWS_CHARS).lower()
    q_value, q_text = _parse_q_value(
        _iter_delimited(raw_coding, ";", start=parameter_separator + 1)
    )
    return name, q_value, q_text


def _parse_q_value(parameters: Iterable[str]) -> tuple[Decimal | None, str | None]:
    saw_q_value = False
    parsed_q_value: Decimal | None = None
    parsed_q_text: str | None = None
    for parameter in parameters:
        parameter = parameter.strip(_HTTP_OWS_CHARS)
        if not parameter:
            return _INVALID_Q_VALUE, None
        key, separator, value = parameter.partition("=")
        if not separator or key.strip(_HTTP_OWS_CHARS).lower() != "q":
            return _INVALID_Q_VALUE, None
        if saw_q_value:
            return _INVALID_Q_VALUE, None
        saw_q_value = True
        q_text = value.strip(_HTTP_OWS_CHARS)
        if not _Q_VALUE_PATTERN.fullmatch(q_text):
            return _INVALID_Q_VALUE, None
        try:
            q_value = Decimal(q_text)
        except InvalidOperation:
            return _INVALID_Q_VALUE, None
        if not q_value.is_finite() or q_value < _MIN_Q_VALUE or q_value > _MAX_Q_VALUE:
            return _INVALID_Q_VALUE, None
        parsed_q_value = q_value
        parsed_q_text = q_text
    return parsed_q_value, parsed_q_text


def _format_coding(name: str, q_text: str | None) -> str:
    if q_text is None:
        return name
    return f"{name};q={q_text}"


def _add_wildcard_safe_compression_encodings(
    accepted_safe: dict[str, str | None],
    rejected_safe: set[str],
    wildcard_accepted: bool,
    wildcard_q_text: str | None,
) -> None:
    if not wildcard_accepted:
        return
    for name in _STREAM_DECODABLE_ENCODINGS:
        if name == _IDENTITY:
            continue
        if name not in accepted_safe and name not in rejected_safe:
            accepted_safe[name] = wildcard_q_text


def _set_if_changed(headers: http.Headers, original_values: list[str], value: str) -> bool:
    if len(original_values) == 1 and original_values[0] == value:
        return False
    headers[_ACCEPT_ENCODING] = value
    return True
