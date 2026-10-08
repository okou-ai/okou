"""Generated invariants for auth.base query precedence and its pair budget."""

import random
import re
import urllib.parse
from dataclasses import dataclass

import pytest

import auth_base_rewrite

_SEED = 0x36580
_CASES = 256
_KEY_ALIASES = {
    "api_key": ("api_key", "api%5Fkey", "api%5fkey"),
    "api key": ("api+key", "api%20key"),
    "token": ("token", "to%6ben"),
    "region": ("region", "reg%69on"),
    "café": ("café", "caf%C3%A9"),
    "": ("",),
}
_URL_QUERY_SAFE = "/?%:@!$&'()*+,;="


@dataclass(frozen=True)
class _Pair:
    key: str
    raw: str


def _draw_pair(rng: random.Random, source: str) -> _Pair:
    if rng.randrange(5) == 0:
        return _Pair("", "")
    key = rng.choice(tuple(_KEY_ALIASES))
    raw_key = rng.choice(_KEY_ALIASES[key])
    if rng.randrange(5) == 0:
        return _Pair(key, raw_key)
    value = rng.choice((f"{source}-value", "", "é", "%2fpath", "+plus"))
    return _Pair(key, f"{raw_key}={value}")


def _render_query(rng: random.Random, pairs: list[_Pair]) -> str:
    if not pairs:
        return ""
    query = pairs[0].raw
    for pair in pairs[1:]:
        query += rng.choice(("&", ";")) + pair.raw
    return query


def _draw_case(rng: random.Random, index: int) -> tuple[list[_Pair], list[_Pair], dict[str, str]]:
    base_pairs = [_draw_pair(rng, "base") for _ in range(rng.randrange(8))]
    orig_pairs = [_draw_pair(rng, "client") for _ in range(rng.randrange(8))]
    seen_keys = list(dict.fromkeys(pair.key for pair in base_pairs + orig_pairs if pair.raw))
    resolved: dict[str, str] = {}
    for slot in range(rng.randrange(4)):
        if seen_keys and rng.randrange(4):
            key = rng.choice(seen_keys)
        else:
            key = rng.choice(tuple(_KEY_ALIASES))
        resolved[key] = f"resolved-{index}-{slot}"
    return base_pairs, orig_pairs, resolved


def _expected_nonempty_pairs(
    base_pairs: list[_Pair], orig_pairs: list[_Pair], resolved: dict[str, str]
) -> list[str]:
    # Derive survivors from generated provenance, not the production splitter or filter.
    kept_base = [pair for pair in base_pairs if pair.raw and pair.key not in resolved]
    blocked_client_keys = set(resolved) | {pair.key for pair in kept_base}
    kept_orig = [pair for pair in orig_pairs if pair.raw and pair.key not in blocked_client_keys]
    raw_pairs = [pair.raw for pair in kept_base + kept_orig]
    raw_pairs.extend(urllib.parse.urlencode(resolved).split("&") if resolved else ())
    return [urllib.parse.quote(pair, safe=_URL_QUERY_SAFE) for pair in raw_pairs]


def test_generated_query_precedence_and_preservation():
    rng = random.Random(_SEED)  # noqa: S311 - fixed seed makes test cases reproducible
    for index in range(_CASES):
        base_pairs, orig_pairs, resolved = _draw_case(rng, index)
        base_query = _render_query(rng, base_pairs)
        orig_query = _render_query(rng, orig_pairs)
        base = "https://example.com/hook" + (f"?{base_query}" if base_query else "")
        context = (
            f"seed={_SEED} case={index} base={base_query!r} "
            f"original={orig_query!r} resolved={resolved!r}"
        )
        try:
            url = auth_base_rewrite.build_rewrite_url(base, "/", orig_query, resolved)
        except Exception as exc:
            exc.add_note(context)
            raise
        actual_pairs = [
            pair for pair in re.split(r"[&;]", urllib.parse.urlsplit(url).query) if pair
        ]
        expected_pairs = _expected_nonempty_pairs(base_pairs, orig_pairs, resolved)
        assert actual_pairs == expected_pairs, context

        decoded_pairs = [
            (
                urllib.parse.unquote_plus(pair.partition("=")[0]),
                urllib.parse.unquote_plus(pair.partition("=")[2]),
            )
            for pair in actual_pairs
        ]
        for key, value in resolved.items():
            assert [pair for pair in decoded_pairs if pair[0] == key] == [(key, value)], context


def _mixed_separator_query(segment_count: int) -> str:
    segments = ["api%5Fkey=client", *([""] * (segment_count - 2)), "tail=visible"]
    return "".join(
        ("" if index == 0 else ("&" if index % 2 else ";")) + segment
        for index, segment in enumerate(segments)
    )


def test_query_pair_budget_counts_empty_and_shadowed_segments_before_filtering():
    limit = auth_base_rewrite.MAX_AUTH_BASE_QUERY_PAIRS
    base = "https://example.com/hook?api_key=base;region=us"
    resolved = {"api_key": "resolved"}

    exact_query = _mixed_separator_query(limit - 3)
    url = auth_base_rewrite.build_rewrite_url(base, "/", exact_query, resolved)
    assert url == "https://example.com/hook?region=us&tail=visible&api_key=resolved"

    over_query = _mixed_separator_query(limit - 2)
    with pytest.raises(auth_base_rewrite.AuthBaseQueryTooManyPairsError):
        auth_base_rewrite.build_rewrite_url(base, "/", over_query, resolved)
