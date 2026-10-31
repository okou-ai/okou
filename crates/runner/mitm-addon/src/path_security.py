"""URL path safety helpers."""

import unicodedata
import urllib.parse

from url_syntax import has_unsafe_url_codepoint

_COMPATIBILITY_NORMALIZATION_FORM = "NFKC"
_DOT_SEGMENTS = {".", ".."}
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")
_MAX_PERCENT_DECODE_PASSES = 5
_PERCENT_ESCAPE_LENGTH = 3
# UAX #15 stream-safe limit, measured after compatibility decomposition.
_MAX_CONSECUTIVE_NONSTARTERS = 30
# Match the addon's existing 64 KiB request-work scale. Character count bounds
# Python string processing without first scanning and allocating encoded bytes.
MAX_PATH_VALIDATION_CHARACTERS = 64 * 1024


def has_unsafe_path(path: str) -> bool:
    """Return True when a URL path exceeds the validation budget or may hide unsafe syntax."""
    if len(path) > MAX_PATH_VALIDATION_CHARACTERS:
        return True
    if "\\" in path:
        return True
    raw_segments = path.split("/")
    if path.isascii() and path.isprintable() and "%" not in path:
        return any(_path_part_is_dot_segment(segment) for segment in raw_segments)
    return any(_segment_has_unsafe_path(raw_segment) for raw_segment in raw_segments)


def has_unsafe_url_path(url: str) -> bool:
    """Return whether a raw absolute URL contains an unsafe path."""
    scheme_end = url.find("://")
    if scheme_end == -1:
        return False
    after_scheme = url[scheme_end + len("://") :]
    component_start = len(after_scheme)
    for delimiter in ("/", "?", "#"):
        delimiter_index = after_scheme.find(delimiter)
        if delimiter_index != -1:
            component_start = min(component_start, delimiter_index)
    if component_start == len(after_scheme) or after_scheme[component_start] != "/":
        return False
    path_and_after = after_scheme[component_start:]
    path_end = len(path_and_after)
    for delimiter in ("?", "#"):
        delimiter_index = path_and_after.find(delimiter)
        if delimiter_index != -1:
            path_end = min(path_end, delimiter_index)
    return has_unsafe_path(path_and_after[:path_end])


def _segment_has_unsafe_path(raw_segment: str) -> bool:
    segment = raw_segment
    for _ in range(_MAX_PERCENT_DECODE_PASSES):
        if _segment_has_unsafe_syntax(segment):
            return True

        decoded = _percent_decode_segment(segment)
        if decoded is None:
            return True
        if decoded == segment:
            return False
        segment = decoded

    if _segment_has_unsafe_syntax(segment):
        return True
    # A still-changing nested encoding can hide unsafe syntax just past the bound.
    decoded = _percent_decode_segment(segment)
    return decoded is None or decoded != segment


def _segment_has_unsafe_syntax(segment: str) -> bool:
    if _segment_has_unsafe_syntax_parts(segment):
        return True
    if _segment_exceeds_normalization_budget(segment):
        return True

    normalized = unicodedata.normalize(_COMPATIBILITY_NORMALIZATION_FORM, segment)
    return normalized != segment and (
        "%" in normalized or _segment_has_unsafe_syntax_parts(normalized)
    )


def _segment_exceeds_normalization_budget(segment: str) -> bool:
    if segment.isascii():
        return False

    nonstarters = 0
    for char in segment:
        # Decompose only one code point at a time: whole-segment NFKD would
        # already perform the potentially quadratic canonical reordering.
        # Raw combining classes miss expansions such as U+0F73 and U+FF9E.
        for decomposed in unicodedata.normalize("NFKD", char):
            if unicodedata.combining(decomposed):
                nonstarters += 1
                if nonstarters > _MAX_CONSECUTIVE_NONSTARTERS:
                    return True
            else:
                nonstarters = 0
    return False


def _segment_has_unsafe_syntax_parts(segment: str) -> bool:
    if has_unsafe_url_codepoint(segment):
        return True
    if "\\" in segment:
        return True
    if _path_part_is_dot_segment(segment):
        return True
    return any(_path_part_is_dot_segment(part) for part in segment.split("/"))


def _path_part_is_dot_segment(part: str) -> bool:
    return part in _DOT_SEGMENTS or part.partition(";")[0] in _DOT_SEGMENTS


def _percent_decode_segment(segment: str) -> str | None:
    index = segment.find("%")
    while index != -1:
        hex_start = index + 1
        hex_end = hex_start + 2
        hex_value = segment[hex_start:hex_end]
        if hex_end > len(segment) or not all(char in _HEX_DIGITS for char in hex_value):
            return None
        index = segment.find("%", index + _PERCENT_ESCAPE_LENGTH)

    try:
        return urllib.parse.unquote_to_bytes(segment).decode("utf-8")
    except UnicodeError:
        return None
