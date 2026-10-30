"""Low-level firewall segment, host, and path pattern matching."""

from collections.abc import Iterator
from typing import NamedTuple

_SEGMENT_ERROR_HINT = 'use "{name}", "prefix{name}", "{name}suffix", or "prefix{name}suffix"'

# A segment with two or more ``{`` braces contains more than one parameter,
# which the grammar rejects — detected once here rather than scattering the
# literal ``2`` across the parser.
_MULTI_PARAM_BRACE_COUNT = 2


class SegmentLiteral(NamedTuple):
    value: str


class SegmentParam(NamedTuple):
    prefix: str
    name: str
    suffix: str
    greedy: str
    constraint: str = ""


class SegmentError(NamedTuple):
    reason: str
    prefix: str = ""
    suffix: str = ""


ParsedSegment = SegmentLiteral | SegmentParam | SegmentError


class CompiledPathPattern(NamedTuple):
    segments: tuple[ParsedSegment, ...]


def _is_invalid_greedy_param(
    pattern_index: int,
    last_pattern_index: int,
    prefix: str,
    suffix: str,
) -> bool:
    return pattern_index != last_pattern_index or bool(prefix) or bool(suffix)


def _segment_outer_literal_scope(seg: str) -> tuple[str, str]:
    """Return literals that are structurally outside a segment's brace envelope."""
    prefix, open_brace, _ = seg.partition("{")
    if not open_brace or "}" in prefix:
        prefix = ""

    _, close_brace, suffix = seg.rpartition("}")
    if not close_brace or "{" in suffix:
        suffix = ""

    return prefix, suffix


def _parse_segment(seg: str) -> ParsedSegment:
    """Parse a single host or path segment into an immutable result."""
    if seg.startswith("{{") and seg.endswith("}}") and ":" in seg:
        name, _, constraint = seg[2:-2].partition(":")
        if not name or constraint != "digits" or any(char in name for char in "{}+*"):
            return SegmentError(f'invalid parameter constraint in segment "{seg}"')
        return SegmentParam("", name, "", "", "digits")
    open_count = seg.count("{")
    close_count = seg.count("}")

    if open_count == 0 and close_count == 0:
        return SegmentLiteral(seg)
    if open_count != close_count:
        prefix, suffix = _segment_outer_literal_scope(seg)
        return SegmentError(
            f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}',
            prefix,
            suffix,
        )

    open1 = seg.find("{")
    close1 = seg.find("}")
    if close1 < open1:
        return SegmentError(f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    if open_count >= _MULTI_PARAM_BRACE_COUNT:
        prefix, suffix = _segment_outer_literal_scope(seg)
        open2 = seg.find("{", close1 + 1)
        if close1 + 1 == open2:
            return SegmentError(
                f'adjacent parameters in segment "{seg}" — only one parameter '
                f"per segment is allowed; {_SEGMENT_ERROR_HINT}",
                prefix,
                suffix,
            )
        return SegmentError(
            f'literal-separated parameters in segment "{seg}" — only one parameter '
            f"per segment is allowed; {_SEGMENT_ERROR_HINT}",
            prefix,
            suffix,
        )

    prefix = seg[:open1]
    content = seg[open1 + 1 : close1]
    suffix = seg[close1 + 1 :]

    if "{" in prefix or "}" in prefix or "{" in suffix or "}" in suffix:
        return SegmentError(f'unbalanced brace in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    greedy = ""
    name = content
    if len(content) > 0 and content[-1] in ("+", "*"):
        greedy = content[-1]
        name = content[:-1]

    if len(name) == 0:
        return SegmentError(f'empty parameter name in segment "{seg}" — {_SEGMENT_ERROR_HINT}')

    return SegmentParam(prefix, name, suffix, greedy)


def parse_segment(seg: str) -> dict:
    """Parse a single host or path segment into literal / param / error.

    Grammar mirrors turbo/packages/connectors/src/segment-parser.ts -
    keep both implementations in lockstep. Any change to accepted or
    rejected forms must land in both languages and the shared contract fixture
    at once:
    turbo/packages/connectors/src/__tests__/firewall-semantics-contract.json.
    One-brace parameter names remain opaque, including colons. The distinct
    {{name:digits}} envelope supports whole, non-greedy rule-path constraints.
    Callers validate the surrounding URL/rule syntax before parsing.

    Returns one of:
      {"kind": "literal", "value": seg}
      {"kind": "param", "prefix": str, "name": str, "suffix": str,
       "greedy": "" | "+" | "*", "constraint"?: "digits"}
      {"kind": "error", "reason": str}
    """
    parsed = _parse_segment(seg)
    if isinstance(parsed, SegmentLiteral):
        return {"kind": "literal", "value": parsed.value}
    if isinstance(parsed, SegmentParam):
        result = {
            "kind": "param",
            "prefix": parsed.prefix,
            "name": parsed.name,
            "suffix": parsed.suffix,
            "greedy": parsed.greedy,
        }
        if parsed.constraint:
            result["constraint"] = parsed.constraint
        return result
    return {"kind": "error", "reason": parsed.reason}


def _match_segment_literal(runtime: str, prefix: str, suffix: str) -> str | None:
    """Match runtime segment against a mixed pattern's literal prefix/suffix.

    Byte-exact comparison; the caller is responsible for case-folding
    `runtime`, `prefix`, and `suffix` when needed (e.g., host matching).
    Returns the captured middle on success, None if either the prefix/suffix
    don't match or the middle would be empty.
    """
    if not runtime.startswith(prefix):
        return None
    if not runtime.endswith(suffix):
        return None
    if len(runtime) <= len(prefix) + len(suffix):
        return None
    return runtime[len(prefix) : len(runtime) - len(suffix)]


def _segment_literal_matches(runtime: str, prefix: str, suffix: str) -> bool:
    if not runtime.startswith(prefix):
        return False
    if not runtime.endswith(suffix):
        return False
    return len(runtime) > len(prefix) + len(suffix)


def match_host(host: str, pattern: str) -> dict | None:
    """Match a hostname against a pattern. Returns extracted params or None.

    Segments are `.`-delimited. Since subdomains grow leftward, greedy params
    ({name+}, {name*}) must appear in the first (leftmost) position.

    - Literal segments must match exactly (case-insensitive).
    - {name} matches a single host segment, captured in lowercase.
    - prefix{name}suffix matches a host segment case-insensitively, with
      the non-empty middle captured into `name` in lowercase.
    - {name+} matches one or more leading host segments. Must be first.
      Captures preserve the input case supplied to match_host().
    - {name*} matches zero or more leading host segments. Must be first.
      Non-empty captures preserve the input case supplied to match_host().
    """
    pattern_segs = _compile_segments(tuple(reversed(pattern.split("."))))
    if pattern_segs is None or any(
        isinstance(segment, SegmentParam) and segment.constraint for segment in pattern_segs
    ):
        return None
    return _match_compiled_host(host, pattern_segs)


def match_path_prefix(path_segs: list[str], pattern_segs: list[str]) -> tuple[dict, int] | None:
    """Match pattern segments against the beginning of path segments.

    Unlike match_path(), does NOT require full path consumption.
    Terminal pure greedy params consume the remaining path so malformed
    firewall base scopes stay conservative. Mixed segments
    (prefix{name}suffix) are supported with non-empty middle capture.

    Returns (params, consumed_count) on match, None on no match.
    """
    compiled_pattern = _compile_segments(pattern_segs)
    if compiled_pattern is None or any(
        isinstance(segment, SegmentParam) and segment.constraint for segment in compiled_pattern
    ):
        return None
    return _match_compiled_path_prefix(path_segs, compiled_pattern)


def _iter_path_segments(path: str) -> Iterator[str]:
    """Yield path segments without normalizing repeated slashes."""
    if path in ("", "/"):
        return

    segment_start = 1 if path.startswith("/") else 0
    while True:
        segment_end = path.find("/", segment_start)
        if segment_end == -1:
            yield path[segment_start:]
            return
        yield path[segment_start:segment_end]
        segment_start = segment_end + 1


def _split_path_segments(path: str) -> list[str]:
    """Split path patterns and request paths without normalizing repeated slashes."""
    if path in ("", "/"):
        return []
    path_without_leading_slash = path[1:] if path.startswith("/") else path
    if path_without_leading_slash == "":
        return []
    return path_without_leading_slash.split("/")


def _split_path_prefix(path: str, segment_count: int) -> tuple[list[str], str]:
    """Split at most segment_count leading segments and return the remaining path."""
    if segment_count == 0:
        return [], path or "/"
    if path in ("", "/"):
        return [], "/"

    path_segs: list[str] = []
    segment_start = 1 if path.startswith("/") else 0
    while len(path_segs) < segment_count:
        segment_end = path.find("/", segment_start)
        if segment_end == -1:
            path_segs.append(path[segment_start:])
            return path_segs, "/"
        path_segs.append(path[segment_start:segment_end])
        segment_start = segment_end + 1

    return path_segs, path[segment_start - 1 :]


def _match_compiled_path_prefix_text(
    path: str,
    pattern_segs: tuple[ParsedSegment, ...],
) -> tuple[dict[str, str], str] | None:
    """Match a compiled prefix while splitting only its configured segment depth."""
    if pattern_segs and isinstance(pattern_segs[-1], SegmentParam) and pattern_segs[-1].greedy:
        leading_pattern_segs = pattern_segs[:-1]
        path_segs, remaining_path = _split_path_prefix(path, len(leading_pattern_segs))
        leading_result = _match_compiled_path_prefix(path_segs, leading_pattern_segs)
        if leading_result is None:
            return None

        params, _consumed = leading_result
        greedy_segment = pattern_segs[-1]
        greedy_value = remaining_path[1:] if remaining_path.startswith("/") else remaining_path
        if greedy_segment.greedy == "+" and not any(char != "/" for char in greedy_value):
            return None
        params[greedy_segment.name] = greedy_value
        return params, "/"

    path_segs, remaining_path = _split_path_prefix(path, len(pattern_segs))
    result = _match_compiled_path_prefix(path_segs, pattern_segs)
    if result is None:
        return None
    params, _consumed = result
    return params, remaining_path


def _has_non_empty_segment(path_segs: list[str], start: int) -> bool:
    return any(path_segs[index] != "" for index in range(start, len(path_segs)))


def match_path(path: str, pattern: str) -> dict | None:
    """Match a URL path against a rule pattern. Returns extracted params or None.

    - Literal segments must match exactly.
    - {name} matches a single non-empty path segment.
    - {{name:digits}} matches a single non-empty ASCII decimal segment.
    - prefix{name}suffix matches a segment that starts with `prefix` and
      ends with `suffix`, capturing the non-empty middle into `name`.
    - {name+} matches the rest of the path (one or more segments). Must be last.
    - {name*} matches the rest of the path (zero or more segments). Must be last.
    """
    path_segs = _split_path_segments(path)
    pattern_segs = _compile_segments(tuple(_split_path_segments(pattern)))
    if pattern_segs is None:
        return None
    return _match_compiled_path_segments(path_segs, pattern_segs)


def _compile_segments(segments: list[str] | tuple[str, ...]) -> tuple[ParsedSegment, ...] | None:
    parsed = tuple(_parse_segment(seg) for seg in segments)
    if any(isinstance(seg, SegmentError) for seg in parsed):
        return None
    return parsed


def compile_path_pattern(pattern: str) -> CompiledPathPattern | None:
    """Compile a URL path pattern for repeated matching.

    Compilation validates segment syntax only. It does not validate the complete firewall-rule
    grammar: greedy parameters must be terminal and occupy a whole segment, and parameter names
    must be unique. Callers validating firewall rules must also apply
    ``_compiled_rule_path_is_valid()`` (as ``matching._compile_rule()`` does).
    """
    segments = _compile_segments(tuple(_split_path_segments(pattern)))
    if segments is None:
        return None
    return CompiledPathPattern(segments)


def _compiled_rule_path_is_valid(pattern: CompiledPathPattern) -> bool:
    """Mirror connector validateRule() invariants not enforced by segment parsing."""
    param_names: set[str] = set()
    last_index = len(pattern.segments) - 1
    for index, segment in enumerate(pattern.segments):
        if isinstance(segment, SegmentLiteral):
            continue
        if isinstance(segment, SegmentError):
            return False

        if segment.name in param_names:
            return False
        param_names.add(segment.name)

        if segment.greedy and index != last_index:
            return False
        if segment.greedy and (segment.prefix or segment.suffix):
            return False
    return True


def _match_compiled_path_traversal(
    path_segs: list[str],
    pattern_segs: tuple[ParsedSegment, ...],
    *,
    capture_params: bool = True,
    match_constraints: bool = True,
) -> tuple[dict[str, str] | None, int] | None:
    params: dict[str, str] | None = {} if capture_params else None
    pi = 0

    last_pattern_index = len(pattern_segs) - 1
    for pattern_index, parsed in enumerate(pattern_segs):
        if isinstance(parsed, SegmentLiteral):
            if pi >= len(path_segs) or path_segs[pi] != parsed.value:
                return None
            pi += 1
            continue

        if isinstance(parsed, SegmentError):
            return None

        if parsed.greedy == "+":
            if _is_invalid_greedy_param(
                pattern_index,
                last_pattern_index,
                parsed.prefix,
                parsed.suffix,
            ):
                return None
            if pi >= len(path_segs) or not _has_non_empty_segment(path_segs, pi):
                return None
            if params is not None:
                params[parsed.name] = "/".join(path_segs[pi:])
            return params, len(path_segs)
        if parsed.greedy == "*":
            if _is_invalid_greedy_param(
                pattern_index,
                last_pattern_index,
                parsed.prefix,
                parsed.suffix,
            ):
                return None
            if params is not None:
                params[parsed.name] = "/".join(path_segs[pi:])
            return params, len(path_segs)
        if pi >= len(path_segs):
            return None

        runtime = path_segs[pi]
        if (
            match_constraints
            and parsed.constraint == "digits"
            and not (runtime.isascii() and runtime.isdigit())
        ):
            return None
        if parsed.prefix == "" and parsed.suffix == "":
            if runtime == "":
                return None
            if params is not None:
                params[parsed.name] = runtime
        else:
            if params is not None:
                captured = _match_segment_literal(runtime, parsed.prefix, parsed.suffix)
                if captured is None:
                    return None
                params[parsed.name] = captured
            elif not _segment_literal_matches(runtime, parsed.prefix, parsed.suffix):
                return None
        pi += 1

    return params, pi


def _match_compiled_path_segments(
    path_segs: list[str],
    pattern_segs: tuple[ParsedSegment, ...],
) -> dict[str, str] | None:
    result = _match_compiled_path_traversal(path_segs, pattern_segs)
    if result is None:
        return None

    params, consumed = result
    if consumed != len(path_segs):
        return None
    return params or {}


def _compiled_path_segments_match(
    path_segs: list[str],
    pattern_segs: tuple[ParsedSegment, ...],
) -> bool:
    result = _match_compiled_path_traversal(
        path_segs,
        pattern_segs,
        capture_params=False,
    )
    if result is None:
        return False

    _params, consumed = result
    return consumed == len(path_segs)


def match_compiled_path(path: str, pattern: CompiledPathPattern) -> dict | None:
    """Match a URL path against a compiled path pattern without revalidating it.

    A pattern accepted by ``compile_path_pattern()`` can still be invalid as a firewall rule. A
    non-terminal or mixed greedy parameter therefore returns ``None`` during matching, while
    duplicate parameter names can match with the later capture replacing the earlier value. Use
    the firewall-rule validator before treating a compiled pattern as a rule.
    """
    return _match_compiled_path_segments(_split_path_segments(path), pattern.segments)


def _match_compiled_path_prefix(
    path_segs: list[str],
    pattern_segs: tuple[ParsedSegment, ...],
) -> tuple[dict[str, str], int] | None:
    # Base ownership must remain conservative even for malformed constrained bases.
    result = _match_compiled_path_traversal(path_segs, pattern_segs, match_constraints=False)
    if result is None:
        return None

    params, consumed = result
    return params or {}, consumed


def _match_compiled_host(
    host: str,
    pattern_segs_reversed: tuple[ParsedSegment, ...],
) -> dict | None:
    host_segs_orig = host.split(".")
    host_segs_lower = [s.lower() for s in host_segs_orig]
    host_segs_orig = list(reversed(host_segs_orig))
    host_segs_lower = list(reversed(host_segs_lower))

    params: dict[str, str] = {}
    hi = 0
    last_pattern_index = len(pattern_segs_reversed) - 1
    for pattern_index, parsed in enumerate(pattern_segs_reversed):
        if isinstance(parsed, SegmentLiteral):
            if hi >= len(host_segs_lower) or host_segs_lower[hi] != parsed.value.lower():
                return None
            hi += 1
            continue

        if isinstance(parsed, SegmentError):
            return None

        if parsed.greedy == "+":
            if _is_invalid_greedy_param(
                pattern_index,
                last_pattern_index,
                parsed.prefix,
                parsed.suffix,
            ):
                return None
            if hi >= len(host_segs_orig):
                return None
            remaining = list(reversed(host_segs_orig[hi:]))
            params[parsed.name] = ".".join(remaining)
            return params
        if parsed.greedy == "*":
            if _is_invalid_greedy_param(
                pattern_index,
                last_pattern_index,
                parsed.prefix,
                parsed.suffix,
            ):
                return None
            remaining = list(reversed(host_segs_orig[hi:]))
            params[parsed.name] = ".".join(remaining)
            return params
        if hi >= len(host_segs_orig):
            return None
        if parsed.prefix == "" and parsed.suffix == "":
            params[parsed.name] = host_segs_lower[hi]
        else:
            captured = _match_segment_literal(
                host_segs_lower[hi],
                parsed.prefix.lower(),
                parsed.suffix.lower(),
            )
            if captured is None:
                return None
            params[parsed.name] = captured
        hi += 1

    if hi != len(host_segs_orig):
        return None
    return params
