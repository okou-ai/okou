"""Firewall base URL parsing, normalization, validation, and matching."""

import ipaddress
from typing import NamedTuple
from urllib.parse import urlsplit

from authority_utils import (
    IPV6_VERSION,
    authority_has_empty_port,
    has_ascii_space_or_control,
    is_default_scheme_port,
    percent_decode_host,
)
from firewall_matching.patterns import (
    ParsedSegment,
    SegmentError,
    SegmentLiteral,
    SegmentParam,
    _match_compiled_host,
    _match_compiled_path_prefix_text,
    _parse_segment,
    _split_path_segments,
)
from host_normalization import (
    is_ipv4_number_component,
    normalize_hostname_separators,
    normalize_idna_hostname,
    normalize_idna_label,
    translate_idna_dot_separators,
)
from path_security import has_unsafe_url_path
from runtime_url_parsing import split_runtime_url
from url_syntax import (
    has_raw_whitespace,
    has_unsafe_runtime_url_syntax,
    has_unsafe_url_codepoint,
    strip_optional_terminal_slash,
)

_MIN_HOST_SEGMENTS = 2
_MAX_IPV4_HOST_SEGMENTS = 4
_ASCII_MAX = 0x7F
_FORBIDDEN_AUTHORITY_HOST_CHARS = frozenset("#%/<>?@[\\]^|[]")
_FORBIDDEN_RUNTIME_AUTHORITY_HOST_CHARS = _FORBIDDEN_AUTHORITY_HOST_CHARS | frozenset("{}")
_PERCENT_DECODED_AUTHORITY_SYNTAX_CHARS = frozenset("{}*.\u3002\uff0e\uff61")
_VALID_BASE_SCHEMES = frozenset(("http", "https"))
_BASE_LITERAL_SEGMENT_SCORE = 1_000
_BASE_MIXED_PARAM_SEGMENT_SCORE = 100
_BASE_PLAIN_PARAM_SEGMENT_SCORE = 10
_BASE_PLUS_GREEDY_SEGMENT_SCORE = 1
_BASE_ROOT_PATH_SCORE = 1
_BASE_STATIC_SCORE_BONUS = 1


class _BaseUrlParts(NamedTuple):
    scheme: str
    hostname: str
    port: int | None
    path: str
    host_malformed: bool
    has_userinfo: bool
    port_malformed: bool

    @property
    def authority(self) -> str:
        if self.port is None:
            return self.hostname
        return f"{self.hostname}:{self.port}"


class _BaseSpecificity(NamedTuple):
    path: int
    authority: int
    static_bonus: int


class _CompiledBase(NamedTuple):
    raw: str
    parts: _BaseUrlParts
    has_params: bool
    specificity: _BaseSpecificity
    has_query_or_fragment: bool
    raw_syntax_malformed: bool
    param_parse_malformed: bool
    host_segments: tuple[ParsedSegment, ...]
    path_segments: tuple[ParsedSegment, ...]


class _CompiledFirewallConfigBase(NamedTuple):
    base: _CompiledBase
    malformed: bool


class _RawAuthorityHost(NamedTuple):
    hostname: str
    bracketed: bool


def _has_base_url_params(base: str) -> bool:
    return "{" in base and "}" in base


def _has_invalid_authority_host_chars(host: str, *, allow_host_params: bool = False) -> bool:
    forbidden_chars = (
        _FORBIDDEN_AUTHORITY_HOST_CHARS
        if allow_host_params
        else _FORBIDDEN_RUNTIME_AUTHORITY_HOST_CHARS
    )
    return has_ascii_space_or_control(host) or any(char in forbidden_chars for char in host)


def _percent_decode_authority_host(host: str) -> tuple[str, bool]:
    if "%" not in host:
        return host, False

    decoded = percent_decode_host(host, syntax_chars=_PERCENT_DECODED_AUTHORITY_SYNTAX_CHARS)
    if decoded.invalid_encoding:
        return decoded.value, True
    if decoded.decoded_syntax:
        return translate_idna_dot_separators(decoded.value), True
    if ":" in decoded.value:
        return decoded.value, True
    return decoded.value, False


def _is_ascii(value: str) -> bool:
    return all(ord(char) <= _ASCII_MAX for char in value)


def _extract_raw_hostname(netloc: str) -> _RawAuthorityHost | None:
    authority = netloc.rsplit("@", maxsplit=1)[-1]
    if not authority:
        return None

    if authority.startswith("["):
        close_index = authority.find("]")
        if close_index == -1:
            return None
        rest = authority[close_index + 1 :]
        if rest and not rest.startswith(":"):
            return None
        return _RawAuthorityHost(authority[1:close_index], bracketed=True)

    if authority.count(":") == 1:
        host, _, _port = authority.rpartition(":")
        return _RawAuthorityHost(host, bracketed=False) if host else None
    return _RawAuthorityHost(authority, bracketed=False)


def _format_param_segment(parsed: SegmentParam) -> str:
    constraint = f":{parsed.constraint}" if parsed.constraint else ""
    return (
        f"{parsed.prefix.lower()}{{{parsed.name}{constraint}{parsed.greedy}}}"
        f"{parsed.suffix.lower()}"
    )


def _is_parameterized_ipv4_host(segments: list[ParsedSegment]) -> bool:
    minimum_segments = sum(
        not isinstance(segment, SegmentParam) or segment.greedy != "*" for segment in segments
    )
    if minimum_segments > _MAX_IPV4_HOST_SEGMENTS:
        return False

    has_numeric_literal = False
    for segment in segments:
        if isinstance(segment, SegmentLiteral):
            if not is_ipv4_number_component(segment.value):
                return False
            has_numeric_literal = True
        elif not isinstance(segment, SegmentParam) or any(
            char not in "0123456789" for char in segment.prefix + segment.suffix
        ):
            return False

    return has_numeric_literal


def _normalize_parameterized_authority_host(host: str) -> tuple[str, bool]:
    normalized = normalize_hostname_separators(host)
    labels: list[str] = []
    segments: list[ParsedSegment] = []
    malformed = False

    for label in normalized.split("."):
        parsed = _parse_segment(label)
        segments.append(parsed)
        if isinstance(parsed, SegmentLiteral):
            if "*" in parsed.value:
                labels.append(parsed.value.lower())
                malformed = True
                continue
            try:
                labels.append(normalize_idna_label(parsed.value))
            except UnicodeError, ValueError:
                labels.append(parsed.value.lower())
                malformed = True
            continue
        if isinstance(parsed, SegmentError):
            labels.append(label.lower())
            malformed = True
            continue

        if not _is_ascii(parsed.prefix) or not _is_ascii(parsed.suffix):
            malformed = True
        if "*" in parsed.prefix or "*" in parsed.suffix:
            malformed = True
        labels.append(_format_param_segment(parsed))

    return ".".join(labels), malformed or _is_parameterized_ipv4_host(segments)


def _split_base_match_url(
    value: str,
    *,
    allow_query_fragment: bool = True,
    allow_malformed_authority: bool = False,
    allow_host_params: bool = False,
    allow_unsafe_runtime_url_syntax: bool = False,
    allow_runtime_backslash_syntax: bool = False,
) -> _BaseUrlParts | None:
    """Split a URL-like string for firewall base matching.

    Canonicalizes authority details that get_trusted_authority() also normalizes:
    trailing host dots are removed, default ports are omitted, and explicit ports
    are rendered as integers. Hostname and port remain separate so host parameters
    cannot consume port text. The returned path excludes query and fragment so callers
    can apply base-path prefix semantics without accidentally comparing query strings.

    ``allow_runtime_backslash_syntax`` only bypasses the early backslash gate.
    Compiled firewall matching uses this so a backslash-bearing request can
    still match a base URL and fail closed as ``unsafe_path`` instead of being
    treated as an unrelated no-match.
    """
    if not allow_unsafe_runtime_url_syntax and has_unsafe_runtime_url_syntax(
        value,
        allow_backslash=allow_runtime_backslash_syntax,
    ):
        return None

    try:
        parts = split_runtime_url(value)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    if not allow_query_fragment and (parts.query or parts.fragment):
        return None

    has_userinfo = parts.username is not None or parts.password is not None
    if authority_has_empty_port(parts.netloc):
        if not allow_malformed_authority:
            return None
        port_malformed = True
        port = None
    else:
        try:
            port = parts.port
        except ValueError:
            if not allow_malformed_authority:
                return None
            port_malformed = True
            port = None
        else:
            port_malformed = False
    if has_userinfo and not allow_malformed_authority:
        return None

    authority_result = _normalize_authority(
        parts.scheme,
        _extract_raw_hostname(parts.netloc),
        port,
        allow_host_params=allow_host_params,
    )
    if authority_result is None:
        return None
    hostname, normalized_port, host_malformed = authority_result
    if host_malformed and not allow_malformed_authority:
        return None

    return _BaseUrlParts(
        scheme=parts.scheme,
        hostname=hostname,
        port=normalized_port,
        path=parts.path,
        host_malformed=host_malformed,
        has_userinfo=has_userinfo,
        port_malformed=port_malformed,
    )


def _normalize_authority_host(
    raw_host: _RawAuthorityHost,
    *,
    allow_host_params: bool = False,
) -> tuple[str, bool]:
    host = raw_host.hostname
    decoded_host, percent_malformed = _percent_decode_authority_host(host)
    normalized = decoded_host
    if not normalized:
        return normalized, True
    if percent_malformed:
        return normalized.lower(), True
    if _has_invalid_authority_host_chars(normalized, allow_host_params=allow_host_params) or (
        "*" in normalized and not (allow_host_params and _has_base_url_params(normalized))
    ):
        return normalized.lower(), True
    if raw_host.bracketed:
        try:
            parsed_ip = ipaddress.ip_address(normalized)
        except ValueError:
            return normalized.lower(), True
        if parsed_ip.version != IPV6_VERSION:
            return normalized.lower(), True
        return f"[{parsed_ip.compressed.lower()}]", False
    if ":" in normalized:
        try:
            parsed_ip = ipaddress.ip_address(normalized)
        except ValueError:
            return normalized.lower(), True
        if parsed_ip.version != IPV6_VERSION:
            return normalized.lower(), True
        return f"[{parsed_ip.compressed.lower()}]", False
    try:
        if allow_host_params and _has_base_url_params(normalized):
            return _normalize_parameterized_authority_host(normalized)
        return normalize_idna_hostname(normalized), False
    except UnicodeError, ValueError:
        return normalized.lower(), True


def _normalize_authority(
    scheme: str,
    host: _RawAuthorityHost | None,
    port: int | None,
    *,
    allow_host_params: bool = False,
) -> tuple[str, int | None, bool] | None:
    if host is None:
        return None
    normalized_host, host_malformed = _normalize_authority_host(
        host,
        allow_host_params=allow_host_params,
    )
    normalized_port = None if port is None or is_default_scheme_port(scheme, port) else port
    return normalized_host, normalized_port, host_malformed


def _compile_base_segments_for_match(
    segments: list[str] | tuple[str, ...],
    *,
    greedy_allowed_index: int | None,
) -> tuple[tuple[ParsedSegment, ...], bool]:
    parsed: list[ParsedSegment] = []
    has_malformed_segment = False
    for index, segment in enumerate(segments):
        parsed_segment = _parse_segment(segment)
        if isinstance(parsed_segment, SegmentError):
            has_malformed_segment = True
            parsed.append(
                SegmentParam(
                    parsed_segment.prefix,
                    f"__malformed_base_segment_{index}",
                    parsed_segment.suffix,
                    "",
                )
            )
        elif (
            isinstance(parsed_segment, SegmentParam)
            and parsed_segment.greedy
            and (index != greedy_allowed_index or parsed_segment.prefix or parsed_segment.suffix)
        ):
            has_malformed_segment = True
            parsed.append(
                SegmentParam(
                    parsed_segment.prefix,
                    parsed_segment.name,
                    parsed_segment.suffix,
                    "",
                )
            )
        else:
            if isinstance(parsed_segment, SegmentParam) and parsed_segment.constraint:
                has_malformed_segment = True
            parsed.append(parsed_segment)
    return tuple(parsed), has_malformed_segment


def _compiled_base_params_are_valid(base: _CompiledBase) -> bool:
    """Mirror connector validateBaseUrl() invariants for parameterized bases."""
    if not base.has_params:
        return True

    host_segments = tuple(reversed(base.host_segments))
    if len(host_segments) < _MIN_HOST_SEGMENTS:
        return False

    param_names: set[str] = set()
    has_static_host_segment = False
    for index, segment in enumerate(host_segments):
        if isinstance(segment, SegmentLiteral):
            has_static_host_segment = True
            continue
        if isinstance(segment, SegmentError):
            return False

        if segment.constraint or segment.name in param_names:
            return False
        param_names.add(segment.name)

        if segment.greedy and index != 0:
            return False
        if segment.greedy and (segment.prefix or segment.suffix):
            return False

    if not has_static_host_segment:
        return False

    for segment in base.path_segments:
        if isinstance(segment, SegmentLiteral):
            continue
        if isinstance(segment, SegmentError):
            return False

        if segment.constraint or segment.greedy:
            return False
        if segment.name in param_names:
            return False
        param_names.add(segment.name)

    return True


def _compile_firewall_config_base(raw_base: str) -> _CompiledFirewallConfigBase | None:
    base = _compile_base(raw_base)
    if base is None:
        return None
    return _CompiledFirewallConfigBase(
        base,
        base.has_query_or_fragment
        or base.raw_syntax_malformed
        or base.param_parse_malformed
        or base.parts.host_malformed
        or base.parts.has_userinfo
        or base.parts.port_malformed
        or has_unsafe_url_path(raw_base)
        or not _compiled_base_params_are_valid(base),
    )


def firewall_base_config_is_valid(raw_base: str) -> bool:
    """Return whether a firewall base URL is valid for runtime matching."""
    compiled_config_base = _compile_firewall_config_base(raw_base)
    return compiled_config_base is not None and not compiled_config_base.malformed


def static_firewall_base_config_key(raw_base: str) -> str | None:
    """Return the normalized key used to compare valid static firewall bases."""
    if _has_base_url_params(raw_base) or not firewall_base_config_is_valid(raw_base):
        return None
    parts = _split_base_match_url(
        strip_optional_terminal_slash(raw_base),
        allow_malformed_authority=True,
        allow_unsafe_runtime_url_syntax=True,
    )
    if parts is None:
        return None
    return f"{parts.scheme.lower()}://{parts.authority}{parts.path}"


def static_firewall_base_authority_key(raw_base: str) -> str | None:
    """Return the normalized authority key used to prefilter static firewall bases."""
    if _has_base_url_params(raw_base) or not firewall_base_config_is_valid(raw_base):
        return None
    parts = _split_base_match_url(
        strip_optional_terminal_slash(raw_base),
        allow_malformed_authority=True,
        allow_unsafe_runtime_url_syntax=True,
    )
    return parts.authority.lower() if parts is not None else None


def match_url_authority_key(url: str) -> str | None:
    """Return the normalized request authority key used by base URL matching."""
    parts = _split_base_match_url(
        url,
        allow_runtime_backslash_syntax="\\" in url,
    )
    return parts.authority.lower() if parts is not None else None


def _compiled_base_is_invalid_for_match_base_url(base: _CompiledBase) -> bool:
    # Direct base matching intentionally has narrower semantics than firewall
    # config validation, where malformed-but-compilable bases fail closed.
    return (
        base.has_query_or_fragment
        or has_unsafe_runtime_url_syntax(base.raw)
        or base.param_parse_malformed
        or base.parts.host_malformed
        or base.parts.has_userinfo
        or base.parts.port_malformed
    )


def _score_base_literal_segment(segment: str) -> int:
    return _BASE_LITERAL_SEGMENT_SCORE + len(segment)


def _score_base_pattern_segment(segment: ParsedSegment) -> int:
    if isinstance(segment, SegmentLiteral):
        return _score_base_literal_segment(segment.value)
    if isinstance(segment, SegmentError):
        return 0

    literal_chars = len(segment.prefix) + len(segment.suffix)
    if segment.prefix or segment.suffix:
        return _BASE_MIXED_PARAM_SEGMENT_SCORE + literal_chars
    if segment.greedy == "+":
        return _BASE_PLUS_GREEDY_SEGMENT_SCORE
    if segment.greedy == "*":
        return 0
    return _BASE_PLAIN_PARAM_SEGMENT_SCORE


def _score_base_segments(segments: tuple[ParsedSegment, ...]) -> int:
    return sum(_score_base_pattern_segment(segment) for segment in segments)


def _split_base_authority_segments(authority: str) -> tuple[str, ...]:
    if authority.startswith("["):
        return (authority,)
    return tuple(authority.split(".")) if authority else ()


def _score_static_base_segments(segments: tuple[str, ...]) -> int:
    return sum(_score_base_literal_segment(segment) for segment in segments)


def _score_static_base_path(path: str) -> int:
    if path == "":
        return 0
    if path == "/":
        return _BASE_ROOT_PATH_SCORE
    return _score_static_base_segments(tuple(_split_path_segments(path)))


def _score_base_path(path: str, path_segments: tuple[ParsedSegment, ...]) -> int:
    if path == "":
        return 0
    if path == "/":
        return _BASE_ROOT_PATH_SCORE
    return _score_base_segments(path_segments)


def _base_specificity(
    *,
    parts: _BaseUrlParts,
    has_params: bool,
    host_segments: tuple[ParsedSegment, ...],
    path_segments: tuple[ParsedSegment, ...],
) -> _BaseSpecificity:
    if has_params:
        authority_score = _score_base_segments(host_segments)
        path_score = _score_base_path(parts.path, path_segments)
        static_bonus = 0
    else:
        authority_score = _score_static_base_segments(
            _split_base_authority_segments(parts.authority)
        )
        path_score = _score_static_base_path(parts.path)
        static_bonus = _BASE_STATIC_SCORE_BONUS

    return _BaseSpecificity(path_score, authority_score, static_bonus)


def _compile_base(raw_base: str) -> _CompiledBase | None:
    base = strip_optional_terminal_slash(raw_base)
    if not base:
        return None

    has_params = _has_base_url_params(base)
    try:
        parsed = urlsplit(base)
    except ValueError:
        return None
    raw_syntax_malformed = (
        "\\" in base
        or has_raw_whitespace(base)
        or has_unsafe_url_codepoint(base)
        or parsed.scheme.lower() not in _VALID_BASE_SCHEMES
    )

    has_query_or_fragment = bool(parsed.query or parsed.fragment)
    parts = _split_base_match_url(
        base,
        allow_malformed_authority=True,
        allow_host_params=has_params,
        allow_unsafe_runtime_url_syntax=True,
    )
    if parts is None:
        return None

    host_segments: tuple[ParsedSegment, ...] = ()
    path_segments: tuple[ParsedSegment, ...] = ()
    param_parse_malformed = False
    if has_params:
        raw_host_segments = tuple(reversed(parts.hostname.split(".")))
        compiled_host, host_parse_malformed = _compile_base_segments_for_match(
            raw_host_segments,
            greedy_allowed_index=len(raw_host_segments) - 1,
        )
        host_segments = compiled_host
        raw_path_segments = tuple(_split_path_segments(parts.path))
        compiled_path, path_parse_malformed = _compile_base_segments_for_match(
            raw_path_segments,
            greedy_allowed_index=len(raw_path_segments) - 1,
        )
        path_segments = compiled_path
        param_parse_malformed = host_parse_malformed or path_parse_malformed

    return _CompiledBase(
        base,
        parts,
        has_params,
        _base_specificity(
            parts=parts,
            has_params=has_params,
            host_segments=host_segments,
            path_segments=path_segments,
        ),
        has_query_or_fragment,
        raw_syntax_malformed,
        param_parse_malformed,
        host_segments,
        path_segments,
    )


def _match_static_base_path_prefix(path: str, base_path: str) -> str | None:
    if base_path and not path.startswith(base_path):
        return None
    rest = path[len(base_path) :] if base_path else path
    if rest and rest[0] != "/":
        return None
    return rest or "/"


def _match_compiled_base_url_parts(
    url_parts: _BaseUrlParts,
    base: _CompiledBase,
) -> tuple[str, dict] | None:
    if not base.has_params:
        if url_parts.scheme.lower() != base.parts.scheme.lower():
            return None
        if url_parts.authority.lower() != base.parts.authority.lower():
            return None

        rel_path = _match_static_base_path_prefix(url_parts.path, base.parts.path)
        if rel_path is None:
            return None
        return rel_path, {}

    if url_parts.scheme.lower() != base.parts.scheme.lower():
        return None
    if url_parts.port != base.parts.port:
        return None

    host_params = _match_compiled_host(url_parts.hostname, base.host_segments)
    if host_params is None:
        return None

    base_path = base.parts.path
    clean_url_path = url_parts.path
    if base_path and base_path != "/":
        path_result = _match_compiled_path_prefix_text(clean_url_path, base.path_segments)
        if path_result is None:
            return None
        path_params, rel_path = path_result
        all_params = {**host_params, **path_params}
    else:
        # After removing one optional terminal slash, "/" still scopes a raw "//" base.
        rel_path = _match_static_base_path_prefix(clean_url_path, base_path)
        if rel_path is None:
            return None
        all_params = host_params

    return rel_path, all_params


def _split_https_authority_parts(host: str, port: int) -> _BaseUrlParts | None:
    raw_host = (
        _RawAuthorityHost(host[1:-1], bracketed=True)
        if host.startswith("[") and host.endswith("]")
        else _RawAuthorityHost(host, bracketed=False)
    )
    authority_result = _normalize_authority(
        "https",
        raw_host,
        port,
    )
    if authority_result is None:
        return None
    hostname, normalized_port, host_malformed = authority_result
    if host_malformed:
        return None
    return _BaseUrlParts(
        scheme="https",
        hostname=hostname,
        port=normalized_port,
        path="/",
        host_malformed=False,
        has_userinfo=False,
        port_malformed=False,
    )


def _match_compiled_base_authority(url_parts: _BaseUrlParts, base: _CompiledBase) -> bool:
    if url_parts.scheme.lower() != base.parts.scheme.lower():
        return False
    if not base.has_params:
        return url_parts.authority.lower() == base.parts.authority.lower()
    if url_parts.port != base.parts.port:
        return False
    return _match_compiled_host(url_parts.hostname, base.host_segments) is not None


def match_base_url(url: str, base: str) -> tuple[str, dict] | None:
    """Match a request URL against a (possibly parameterized) base URL.

    Returns (rel_path, params) on match, None on no match.
    - rel_path: the path after the base (for permission rule matching)
    - params: extracted parameters from the base URL
    """
    url_parts = _split_base_match_url(url)
    if url_parts is None:
        return None

    compiled_base = _compile_base(base)
    if compiled_base is None or _compiled_base_is_invalid_for_match_base_url(compiled_base):
        return None
    return _match_compiled_base_url_parts(url_parts, compiled_base)
