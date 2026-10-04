"""Sanitizers for values written to persistent network logs."""

import urllib.parse

from runtime_url_parsing import split_runtime_url, strip_url_query_and_fragment

_URLSPLIT_LEADING_STRIP_CHARACTERS = "".join(chr(codepoint) for codepoint in range(0x21))
_URLSPLIT_REMOVABLE_CHARACTERS = "\t\r\n"
_SPECIAL_URL_SCHEMES = ("http", "https")
_SPECIAL_URL_SEPARATORS = "/\\"
_MALFORMED_AUTHORITY_PREFIX_CHARACTERS = f"{_SPECIAL_URL_SEPARATORS} \v\f"


def _normalize_for_urlsplit(value: str) -> str:
    """Apply current URL preprocessing consistently on Python 3.10+."""
    value = value.lstrip(_URLSPLIT_LEADING_STRIP_CHARACTERS)
    for character in _URLSPLIT_REMOVABLE_CHARACTERS:
        value = value.replace(character, "")
    return value


def _sanitize_netloc_for_network_log(netloc: str) -> str:
    if "@" not in netloc:
        return netloc
    return netloc.rsplit("@", 1)[1]


def _sanitize_url_text_fallback_for_network_log(value: str) -> str:
    scheme, scheme_sep, rest = value.partition("://")
    if scheme_sep:
        netloc, sep, path = rest.partition("/")
        return f"{scheme}{scheme_sep}{_sanitize_netloc_for_network_log(netloc)}{sep}{path}"
    if value.startswith("//"):
        netloc, sep, path = value[2:].partition("/")
        return f"//{_sanitize_netloc_for_network_log(netloc)}{sep}{path}"
    return value


def _sanitize_malformed_authority_for_network_log(
    value: str, parts: urllib.parse.SplitResult
) -> str | None:
    # A mixed separator run can leave separators or retained whitespace in
    # netloc while the actual authority-like segment lands in path.
    if parts.netloc.strip(_MALFORMED_AUTHORITY_PREFIX_CHARACTERS):
        return None

    has_special_scheme = parts.scheme in _SPECIAL_URL_SCHEMES
    is_protocol_relative = not parts.scheme and value.startswith("//")
    if not has_special_scheme and not is_protocol_relative:
        return None

    # SP, VT, and FF survive urlsplit preprocessing when embedded after the
    # scheme. Treat them only as part of the leading malformed separator run.
    authority_path = parts.path.lstrip(_MALFORMED_AUTHORITY_PREFIX_CHARACTERS)
    cut_points = [
        index
        for separator in _SPECIAL_URL_SEPARATORS
        if (index := authority_path.find(separator)) != -1
    ]
    if cut_points:
        path_start = min(cut_points)
        authority = authority_path[:path_start]
        path = authority_path[path_start:].replace("\\", "/")
    else:
        authority = authority_path
        path = ""

    if "@" not in authority:
        return None

    netloc = _sanitize_netloc_for_network_log(authority)
    return urllib.parse.urlunsplit((parts.scheme, netloc, path, "", ""))


def _sanitize_retained_url_for_network_log(retained_value: str) -> str:
    normalized_value = _normalize_for_urlsplit(retained_value)
    try:
        parts = split_runtime_url(normalized_value)
    except ValueError:
        return _sanitize_url_text_fallback_for_network_log(normalized_value)

    malformed_authority_url = _sanitize_malformed_authority_for_network_log(normalized_value, parts)
    if malformed_authority_url is not None:
        return malformed_authority_url

    netloc = _sanitize_netloc_for_network_log(parts.netloc)
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, "", ""))


def _bounded_retained_url(value: str, max_characters: int) -> str | None:
    if len(value) <= max_characters:
        return strip_url_query_and_fragment(value)

    search_end = max_characters + 1
    query_start = value.find("?", 0, search_end)
    fragment_start = value.find("#", 0, query_start if query_start >= 0 else search_end)
    if fragment_start >= 0:
        return value[:fragment_start]
    if query_start >= 0:
        return value[:query_start]
    return None


def sanitize_url_for_network_log(value: str) -> str:
    """Return a URL string without credentials or query data for diagnostics.

    Runtime metadata can keep raw URLs because firewall/auth and connector
    billing may need query parameters. Captured URL-bearing headers and proxy
    diagnostics do not, so this sanitizer discards query and fragment contents
    before URL preprocessing and parsing. Top-level HTTP network entries instead
    use ``sanitize_request_url_for_network_log`` to retain the complete request
    URL. This sanitizer also removes userinfo from malformed HTTP(S) authority
    positions, but it still preserves ordinary paths for request diagnostics. It
    is not a general sanitizer for arbitrary captured header values or path
    contents.
    """
    retained_value = strip_url_query_and_fragment(value)
    return _sanitize_retained_url_for_network_log(retained_value)


def sanitize_url_for_network_log_with_retained_limit(value: str, max_characters: int) -> str | None:
    """Sanitize a URL only when its retained query-free value fits the limit.

    Raw inputs above the limit search for query and fragment delimiters only
    through the first ``max_characters + 1`` characters.  A delimiter within
    that window proves the retained value is bounded; otherwise no raw prefix
    is returned or processed.
    """
    retained_value = _bounded_retained_url(value, max_characters)
    if retained_value is None:
        return None
    return _sanitize_retained_url_for_network_log(retained_value)


def sanitize_request_url_for_network_log(value: str) -> str:
    """Preserve a complete request URL while removing URL userinfo."""
    retained_value = strip_url_query_and_fragment(value)
    suffix = value[len(retained_value) :]
    return f"{sanitize_url_for_network_log(retained_value)}{suffix}"
